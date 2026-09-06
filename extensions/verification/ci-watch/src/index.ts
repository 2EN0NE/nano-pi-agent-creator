import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai/compat';
import { execSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';
import { createConfigStore } from '@zenone/pi-config';
import type { ConfigStore } from '@zenone/pi-config';
import {
	Container,
	SelectList,
	Text,
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
	type Component,
} from '@earendil-works/pi-tui';
import type { SelectItem } from '@earendil-works/pi-tui';
import {
	decidePollStep,
	extractPushInfo,
	evaluateBranchRuns,
	evaluatePrChecks,
	isPrRef,
	isValidBranch,
	nextPollDelay,
	type CiCheckResult,
	type PollConfig,
	type PollResult,
	type PrCheck,
	type RunInfo,
} from './ci-logic';

const log = createLogger('ci-watch');

// 标题边框（ADR-0023）：把标题嵌入顶边框（`── 标题 ──...`），
// 替代 DynamicBorder(纯横线) + Text(独立标题) 的旧范式。
function titleBar(title: string, color: (s: string) => string): Component {
	return {
		render(width: number) {
			const inner = `── ${title.trim()} `;
			return [
				color(
					truncateToWidth(
						inner + '─'.repeat(Math.max(0, width - visibleWidth(inner))),
						width,
					),
				),
			];
		},
		invalidate() {},
	};
}

const MAX_ATTEMPTS = 3;
const DEFAULT_POLL_MIN_MS = 30_000;
const DEFAULT_POLL_MAX_MS = 60_000;
const DEFAULT_POLL_STEP_MS = 15_000;
/** 手动监控（面板/命令路径）最长等待：15 分钟 */
const MANUAL_MAX_WAIT_MS = 15 * 60 * 1000;
/** 自动监控（tool_result 触发）最长等待：10 分钟 */
const DEFAULT_AUTO_MAX_WAIT_MS = 10 * 60 * 1000;
/** 分支模式下轮询拉取的 run 数量上限 */
const RUNS_LIMIT = 20;

// ====================================================================
// 会话代际管理：防止"捕获的 ctx 在会话替换/重载后变 stale"导致崩溃
// ====================================================================
// session_shutdown 时递增代际 + abort 在途轮询；轮询结束后若代际变化，
// 说明会话已被替换/重载，此时不得再使用捕获的 ctx/pi（Pi 会抛
// "This extension ctx is stale"），只写日志安全退出。
let sessionGeneration = 0;
let monitoringAbort: AbortController | null = null;

/** 启动一次监控：中止上一个在途监控，返回本次的 AbortSignal */
function beginMonitoring(): AbortSignal {
	monitoringAbort?.abort();
	monitoringAbort = new AbortController();
	return monitoringAbort.signal;
}

function runGh(args: string, cwd: string): string {
	try {
		return execSync(`gh ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`gh ${args} failed: ${msg}`);
	}
}

/** Resolve input to a branch name — PR numbers resolved via gh, branch names returned as-is */
function resolveBranch(prOrBranch: string, cwd: string): string {
	if (isPrRef(prOrBranch)) {
		return runGh(`pr view ${prOrBranch} --json headRefName -q .headRefName`, cwd);
	}
	return prOrBranch;
}

/**
 * 获取某分支的最近 workflow runs。
 *
 * 使用 `gh run list --branch <name>`（gh CLI v2.12.0+ 支持，服务端按分支过滤），
 * 避免旧实现"全局 `-L N` 再按 headBranch 过滤"在活跃仓库里把目标分支的 run
 * 挤出窗口导致误判"该分支没有 run"。
 */
function getRunsForBranch(branch: string, cwd: string, limit: number = RUNS_LIMIT): RunInfo[] {
	try {
		const output = runGh(
			`run list --branch ${branch} -L ${limit} --json headBranch,headSha,databaseId,status,conclusion,name`,
			cwd,
		);
		const allRuns = JSON.parse(output) as Array<{
			headBranch: string;
			headSha: string;
			name: string;
			status: string;
			conclusion: string;
			databaseId: number;
		}>;
		return allRuns
			.filter((r) => r.headBranch === branch)
			.sort((a, b) => b.databaseId - a.databaseId); // 最新排前面
	} catch (e) {
		log.warn('getRunsForBranch failed', { branch, error: String(e) });
		return [];
	}
}

function getCiStatusFromPr(prNumber: string, cwd: string): CiCheckResult {
	try {
		const output = runGh(`pr checks ${prNumber} --json name,state,bucket`, cwd);
		const checks = JSON.parse(output) as PrCheck[];
		return evaluatePrChecks(checks);
	} catch (e) {
		return { status: 'error', failedRuns: [], logs: String(e) };
	}
}

/**
 * 分支模式：按 expectedSha 匹配目标 run 评估状态。
 * - expectedSha 提供（自动监控 push 后）：等待 headSha 匹配的新 run 出现，
 *   避免读到上一次 push 的旧 run 而误报。
 * - 未提供（手动监控分支）：评估最新 run。
 */
function getCiStatusFromBranch(
	branch: string,
	cwd: string,
	expectedSha?: string | null,
): CiCheckResult {
	try {
		if (!isValidBranch(branch)) {
			return { status: 'error', failedRuns: [], logs: `Invalid branch name: ${branch}` };
		}
		const runs = getRunsForBranch(branch, cwd, RUNS_LIMIT);
		const result = evaluateBranchRuns(runs, expectedSha);

		// 手动监控分支且该分支完全没有 run：区分"仓库无任何 run"与"分支无 run"
		if (result.noRunsFound && !expectedSha) {
			try {
				const repoOutput = runGh('run list -L 1 --json databaseId', cwd);
				const repoRuns = JSON.parse(repoOutput) as Array<{ databaseId: number }>;
				if (!repoRuns.length) {
					return {
						status: 'error',
						failedRuns: [],
						logs: '该仓库没有发现任何 GitHub Actions 运行。请确认 Actions 已启用（Settings > Actions > General）。',
					};
				}
			} catch {
				// repo 级检查失败时降级到 pending，防止因 gh API 波动误报
			}
		}
		return result;
	} catch (e) {
		return { status: 'error', failedRuns: [], logs: String(e) };
	}
}

/** 根据输入自动选择 PR 模式或分支模式 */
function getCiStatus(prOrBranch: string, cwd: string, expectedSha?: string | null): CiCheckResult {
	if (isPrRef(prOrBranch)) {
		return getCiStatusFromPr(prOrBranch, cwd);
	}
	return getCiStatusFromBranch(prOrBranch, cwd, expectedSha);
}

function getFailedLogs(prOrBranch: string, cwd: string): string {
	try {
		const branch = resolveBranch(prOrBranch, cwd);
		if (!isValidBranch(branch)) {
			throw new Error(`Invalid branch name: ${branch}`);
		}
		const runs = getRunsForBranch(branch, cwd, 10);
		const failedRun = runs.find((r) => r.conclusion === 'failure');

		if (!failedRun) return 'No failed run found in recent history.';

		const logs = runGh(`run view ${failedRun.databaseId} --log-failed`, cwd);
		const truncated = logs.split('\n').slice(-100).join('\n');
		return truncated;
	} catch (e) {
		return `Error fetching logs: ${String(e)}`;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		timer = setTimeout(() => {
			// 正常超时后移除 listener，避免长轮询期间在 signal 上累积未触发的 abort 监听
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
	});
}

// ====================================================================
// 共享轮询逻辑
// ====================================================================

/**
 * 轮询 CI 状态直到完成，返回结果。
 * 不涉及 LLM，纯代码实现。
 *
 * @param cwd        执行 gh 命令的 git 仓库根目录（通常为 ctx.cwd）
 * @param signal     中止信号（session_shutdown / 新监控启动时 abort）
 * @param expectedSha 分支模式专用：期望监控的 commit SHA（完整 40 位）。
 *                    push 后新 run 创建/索引有延迟（实测 5~30s），
 *                    提供此参数时轮询会等待 headSha 匹配的 run 出现，
 *                    避免读到上一次 push 的旧 run 状态而误报。
 */
async function pollCiCompletion(
	pr: string,
	pollConfig: PollConfig,
	maxWaitMs: number,
	refLabel: string,
	refShort: string,
	cwd?: string,
	signal?: AbortSignal,
	expectedSha?: string | null,
	onUpdate?: (msg: string) => void,
): Promise<PollResult> {
	let elapsed = 0;
	let currentDelay = pollConfig.minMs;
	let consecutiveEmptyPolls = 0;
	const maxEmptyPolls = 3;
	const workDir = cwd ?? process.cwd();

	while (!signal?.aborted) {
		const result = getCiStatus(pr, workDir, expectedSha);
		const decision = decidePollStep({
			status: result.status,
			noRunsFound: result.noRunsFound,
			expectedSha,
			consecutiveEmptyPolls,
			maxEmptyPolls,
			elapsed,
			maxWaitMs,
		});

		if (decision.action === 'return') {
			switch (decision.outcome) {
				case 'error':
					return { outcome: 'error', message: `检查 CI 出错：${result.logs}` };
				case 'no-runs':
					// 手动监控分支连续多次无 run（fast-fail）：恢复可操作的 [STOP] 指引
					return {
						outcome: 'error',
						message: `[STOP] ${refLabel} 在 ${maxEmptyPolls} 次检查后仍未发现 CI 运行。请确认分支名和 CI 触发条件。`,
					};
				case 'pass':
					return { outcome: 'pass', message: `[PASS] ${refLabel} CI 通过！` };
				case 'fail': {
					const logs = getFailedLogs(pr, workDir);
					return {
						outcome: 'fail',
						message: `[FAIL] ${refLabel} CI 失败。`,
						logs,
						failedRuns: result.failedRuns,
					};
				}
				case 'timeout':
					return {
						outcome: 'timeout',
						message: `[TIMEOUT] ${refLabel} CI 在 ${Math.round(maxWaitMs / 60000)} 分钟内未完成，请手动检查。`,
					};
				default:
					// 穷尽性保护：PollStepDecision 新增 outcome 时强制显式处理
					throw new Error(`Unexpected poll outcome: ${decision.outcome}`);
			}
		}

		consecutiveEmptyPolls = decision.consecutiveEmptyPolls;

		await sleep(currentDelay);
		elapsed += currentDelay;
		currentDelay = nextPollDelay(currentDelay, pollConfig);
		onUpdate?.(
			`[WAIT] ${refShort} CI 运行中...（已过 ${Math.round(elapsed / 1000)}s，下次检查 ${currentDelay / 1000}s 后）`,
		);
	}

	return { outcome: 'cancelled', message: 'CI 监控已取消。' };
}

// ====================================================================
// TUI 面板逻辑
// ====================================================================

export interface TuiState {
	autoMode: boolean;
	pollConfig: PollConfig;
	pollConfigExpanded: boolean;
	/** 上次选中的菜单项 value（用于面板重开时恢复选中，基于 value 而非 index） */
	menuValue: string | null;
	monitoringStatus: string | null;
	autoMaxWaitMs: number;
}

function makeCiWatchPanel(
	ctx: ExtensionCommandContext,
	state: TuiState,
	configStore: ConfigStore<{ pollConfig: PollConfig; autoMaxWaitMs?: number }> | null,
	ghAvailable: boolean,
	pi: ExtensionAPI,
): void {
	// 监控分支放在第一项（日常主力：main/dev 分支监控）
	const items: SelectItem[] = [
		{
			value: '__monitor_branch',
			label: '> 监控分支',
			description: '输入分支名来监控其 CI 状态',
		},
		{
			value: '__monitor_pr',
			label: '> 监控 PR',
			description: '输入 PR 编号来监控其 CI 状态',
		},
		{
			value: '__toggle_auto',
			label: `自动模式：${state.autoMode ? '开' : '关'}`,
			description: state.autoMode
				? '已开启——git push 后自动监控 CI'
				: '已关闭——推送后不会自动监控',
		},
	];

	// Polling config 行（带展开/折叠）
	if (state.pollConfigExpanded) {
		items.push({
			value: '__toggle_config',
			label: `轮询：${state.pollConfig.minMs / 1000}s - ${state.pollConfig.maxMs / 1000}s（步长 ${state.pollConfig.stepMs / 1000}s）[已展开]`,
			description: 'Ctrl+O 折叠  |  Enter 编辑',
		});
		items.push({
			value: '__config_min',
			label: `  最小值：${state.pollConfig.minMs / 1000}s`,
			description: '修改最小轮询间隔',
		});
		items.push({
			value: '__config_max',
			label: `  最大值：${state.pollConfig.maxMs / 1000}s`,
			description: '修改最大轮询间隔',
		});
		items.push({
			value: '__config_step',
			label: `  步长：${state.pollConfig.stepMs / 1000}s`,
			description: '修改轮询间隔步长',
		});
	} else {
		items.push({
			value: '__toggle_config',
			label: `轮询：${state.pollConfig.minMs / 1000}s - ${state.pollConfig.maxMs / 1000}s（步长 ${state.pollConfig.stepMs / 1000}s）`,
			description: 'Ctrl+O 展开配置详情',
		});
	}

	const statusText = ghAvailable
		? state.monitoringStatus
			? `状态：${state.monitoringStatus}`
			: '状态：空闲'
		: '状态：gh CLI 不可用';

	ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(titleBar('CI 监控', (s: string) => theme.fg('accent', theme.bold(s))));

		const selectList = new SelectList(items, Math.min(items.length + 1, 12), {
			selectedPrefix: (t) => theme.fg('accent', t),
			selectedText: (t) => theme.fg('accent', t),
			description: (t) => theme.fg('muted', t),
			scrollInfo: (t) => theme.fg('dim', t),
			noMatch: (t) => theme.fg('warning', t),
		});

		// 恢复上次选中的菜单项（基于 value，顺序调整不影响）
		if (state.menuValue) {
			const savedIndex = items.findIndex((i) => i.value === state.menuValue);
			if (savedIndex >= 0) {
				selectList.setSelectedIndex(savedIndex);
			}
		}

		selectList.onSelect = async (item) => {
			try {
				const value = item.value;
				done();
				await handlePanelAction(value, ctx, state, configStore, ghAvailable, pi);
				// 重新打开面板（除非是监控操作，监控完成后会通知用户）
				if (value !== '__monitor_pr' && value !== '__monitor_branch') {
					makeCiWatchPanel(ctx, state, configStore, ghAvailable, pi);
				}
			} catch (e) {
				// 防止面板异步操作（输入/监控）抛出的 rejection 变成 unhandled rejection 拖垮进程
				log.error('面板操作执行异常', { value: item.value, error: String(e) });
			}
		};
		selectList.onCancel = () => done();

		container.addChild(selectList);
		container.addChild(new Text(theme.fg('dim', statusText), 1, 0));
		container.addChild(
			new Text(theme.fg('dim', '上下导航  回车选择  esc关闭  ctrl+o 展开/折叠配置'), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (matchesKey(data, Key.ctrlShift('o'))) {
					state.pollConfigExpanded = !state.pollConfigExpanded;
					done();
					makeCiWatchPanel(ctx, state, configStore, ghAvailable, pi);
					return;
				}
				selectList.handleInput(data);
				const selected = selectList.getSelectedItem();
				if (selected) {
					state.menuValue = selected.value;
				}
				tui.requestRender();
				container.invalidate();
			},
		};
	});
}

async function handlePanelAction(
	value: string,
	ctx: ExtensionCommandContext,
	state: TuiState,
	configStore: ConfigStore<{ pollConfig: PollConfig; autoMaxWaitMs?: number }> | null,
	ghAvailable: boolean,
	pi: ExtensionAPI,
): Promise<void> {
	switch (value) {
		case '__monitor_pr': {
			if (!ghAvailable) {
				ctx.ui.notify('gh CLI 不可用，请先安装 gh。', 'error');
				return;
			}
			const prInput = await ctx.ui.input('请输入 PR 编号', '');
			if (!prInput || !prInput.trim()) return;
			const pr = prInput.trim();
			if (!isPrRef(pr)) {
				ctx.ui.notify('无效的 PR 编号，请输入纯数字。', 'error');
				return;
			}
			await startCiWatch(pr, ctx, state, pi);
			break;
		}
		case '__monitor_branch': {
			if (!ghAvailable) {
				ctx.ui.notify('gh CLI 不可用，请先安装 gh。', 'error');
				return;
			}
			// 自动检测当前分支作默认值
			let defaultBranch = '';
			try {
				defaultBranch = execSync('git branch --show-current', {
					encoding: 'utf-8',
					timeout: 5000,
				}).trim();
			} catch {
				/* ignore */
			}
			// 编辑心智：进入时提示当前值（pi 的 placeholder 不渲染，只能放标题）；
			// 空输入回车 = 使用当前分支（确认），escape = 取消
			const branchInput = await ctx.ui.input(
				defaultBranch
					? `请输入分支名（当前：${defaultBranch}，直接回车使用）`
					: '请输入分支名',
				defaultBranch,
			);
			if (branchInput === undefined) return; // escape/ctrl+c 取消
			const branch = branchInput.trim() || defaultBranch;
			if (!branch) return;
			if (!isValidBranch(branch)) {
				ctx.ui.notify(`无效的分支名：${branch}`, 'error');
				return;
			}
			await startCiWatch(branch, ctx, state, pi);
			break;
		}
		case '__toggle_auto': {
			state.autoMode = !state.autoMode;
			ctx.ui.notify(
				`自动模式：${state.autoMode ? '开' : '关'}`,
				state.autoMode ? 'info' : 'warning',
			);
			break;
		}
		case '__toggle_config': {
			state.pollConfigExpanded = !state.pollConfigExpanded;
			break;
		}
		case '__config_min': {
			const cur = state.pollConfig.minMs / 1000;
			const val = await ctx.ui.input(
				`最小轮询间隔（秒）（当前：${cur}，直接回车保留）`,
				String(cur),
			);
			if (!val || !val.trim()) return; // 空输入 = 保留原值
			const n = Number(val.trim());
			if (isNaN(n) || n < 1) {
				ctx.ui.notify('无效的值', 'error');
				return;
			}
			state.pollConfig.minMs = n * 1000;
			saveConfig(state, configStore);
			ctx.ui.notify(`最小轮询已设为 ${n}s`, 'info');
			break;
		}
		case '__config_max': {
			const cur = state.pollConfig.maxMs / 1000;
			const val = await ctx.ui.input(
				`最大轮询间隔（秒）（当前：${cur}，直接回车保留）`,
				String(cur),
			);
			if (!val || !val.trim()) return; // 空输入 = 保留原值
			const n = Number(val.trim());
			if (isNaN(n) || n < 1) {
				ctx.ui.notify('无效的值', 'error');
				return;
			}
			state.pollConfig.maxMs = n * 1000;
			saveConfig(state, configStore);
			ctx.ui.notify(`最大轮询已设为 ${n}s`, 'info');
			break;
		}
		case '__config_step': {
			const cur = state.pollConfig.stepMs / 1000;
			const val = await ctx.ui.input(
				`轮询间隔步长（秒）（当前：${cur}，直接回车保留）`,
				String(cur),
			);
			if (!val || !val.trim()) return; // 空输入 = 保留原值
			const n = Number(val.trim());
			if (isNaN(n) || n < 1) {
				ctx.ui.notify('无效的值', 'error');
				return;
			}
			state.pollConfig.stepMs = n * 1000;
			saveConfig(state, configStore);
			ctx.ui.notify(`轮询步长已设为 ${n}s`, 'info');
			break;
		}
	}
}

export function saveConfig(
	state: TuiState,
	configStore: ConfigStore<{ pollConfig: PollConfig; autoMaxWaitMs?: number }> | null,
): void {
	if (configStore) {
		configStore.save(
			{ pollConfig: state.pollConfig, autoMaxWaitMs: state.autoMaxWaitMs },
			'user',
		);
	}
}

// ====================================================================
// 监控启动 + 结果通知
// ====================================================================

/**
 * 通知监控结果。统一写日志（可观测），并区分：
 * - pass/fail → notify / sendUserMessage（通知 agent 处理）
 * - 其余（error/timeout/cancelled）→ notify
 */
function notifyResult(
	result: PollResult,
	refLabel: string,
	refShort: string,
	mode: '手动' | '自动',
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	const prefix = mode === '自动' ? '自动：' : '';

	if (result.outcome === 'pass') {
		log.info('CI 通过', { refLabel, mode });
		ctx.ui.notify(`[ci-watch] ${prefix}${refLabel} CI 通过！`, 'info');
	} else if (result.outcome === 'fail') {
		log.info('CI 失败', { refLabel, mode, failedRuns: result.failedRuns });
		pi.sendUserMessage(
			`[ci-watch] ${prefix}${refLabel} CI 失败。\n\n失败的检查项：${result.failedRuns?.join(', ')}\n\n--- 失败日志（最后 100 行） ---\n${result.logs}\n\n---\n请修复代码，并在提交前先本地验证（如类型检查、测试、格式化等），再 commit 和 push，然后${mode === '自动' ? ' /ci-watch' : '执行 /ci-watch'} ${refShort} 重新监控。`,
			{ deliverAs: 'followUp' },
		);
	} else {
		log.info('CI 监控结束', {
			refLabel,
			mode,
			outcome: result.outcome,
			message: result.message,
		});
		ctx.ui.notify(`[ci-watch] ${prefix}${result.message}`, 'error');
	}
}

async function startCiWatch(
	ref: string,
	ctx: ExtensionCommandContext,
	state: TuiState,
	pi: ExtensionAPI,
): Promise<void> {
	const myGen = sessionGeneration;
	const signal = beginMonitoring();
	const myController = monitoringAbort;
	const refLabel = isPrRef(ref) ? `PR ${ref}` : `分支 ${ref}`;
	const refShort = isPrRef(ref) ? `PR ${ref}` : ref;

	state.monitoringStatus = `正在监控 ${refLabel}...`;
	ctx.ui.notify(`[ci-watch] 开始监控 ${refLabel}...`, 'info');
	log.info('开始监控', { ref, label: refLabel });

	const result = await pollCiCompletion(
		ref,
		state.pollConfig,
		MANUAL_MAX_WAIT_MS,
		refLabel,
		refShort,
		ctx.cwd,
		signal,
	);

	// 会话被替换/重载：旧 ctx 已 stale，不得再使用，只写日志安全退出
	if (sessionGeneration !== myGen) {
		log.warn('会话已替换/重载，跳过 CI 结果通知', { ref });
		return;
	}
	// 监控已被更新的监控取代（手动 ↔ 自动并发）：不再触碰共享 UI 状态，
	// 避免旧监控把新监控设置的 monitoringStatus 清掉
	if (monitoringAbort !== myController) {
		log.warn('监控已被新的监控取代，跳过 CI 结果通知', { ref });
		return;
	}
	state.monitoringStatus = null;
	notifyResult(result, refLabel, refShort, '手动', ctx, pi);
}

export default function (pi: ExtensionAPI) {
	const state: TuiState = {
		autoMode: true,
		pollConfig: {
			minMs: DEFAULT_POLL_MIN_MS,
			maxMs: DEFAULT_POLL_MAX_MS,
			stepMs: DEFAULT_POLL_STEP_MS,
		},
		pollConfigExpanded: false,
		menuValue: null,
		monitoringStatus: null,
		autoMaxWaitMs: DEFAULT_AUTO_MAX_WAIT_MS,
	};

	// 从持久化存储加载配置
	let configStore: ConfigStore<{ pollConfig: PollConfig; autoMaxWaitMs?: number }> | null = null;
	try {
		configStore = createConfigStore<{ pollConfig: PollConfig; autoMaxWaitMs?: number }>({
			pluginName: 'ci-watch',
			defaults: { pollConfig: state.pollConfig, autoMaxWaitMs: state.autoMaxWaitMs },
		});
		const saved = configStore.get();
		if (saved.pollConfig) {
			state.pollConfig = saved.pollConfig;
		}
		if (typeof saved.autoMaxWaitMs === 'number') {
			state.autoMaxWaitMs = saved.autoMaxWaitMs;
		}
	} catch {
		// 配置加载失败时使用默认值
	}

	let ghAvailable = false;
	let ghChecked = false;

	// ====================================================================
	// session_shutdown：会话替换/重载前中止在途监控、递增代际
	// ====================================================================
	pi.on('session_shutdown', () => {
		sessionGeneration++;
		monitoringAbort?.abort();
		monitoringAbort = null;
		state.monitoringStatus = null;
	});

	// ====================================================================
	// session_start：检测 gh CLI
	// ====================================================================
	pi.on('session_start', async (_event, ctx) => {
		if (ghChecked) return;
		ghChecked = true;
		try {
			execSync('command -v gh', { encoding: 'utf-8', stdio: 'pipe' });
			ghAvailable = true;
			log.info('gh CLI 检测成功', { autoMode: state.autoMode });
			if (state.autoMode) {
				ctx.ui.notify('[ci-watch] 已检测到 gh CLI，自动监控已启用', 'info');
			}
		} catch {
			ghAvailable = false;
			state.autoMode = false;
			log.warn('未找到 gh CLI，自动监控已禁用');
			ctx.ui.notify(
				'[ci-watch] 未找到 gh CLI。请安装：brew install gh / apt install gh',
				'error',
			);
		}
	});

	// ====================================================================
	// 自动触发：检测 git push → 等待该次 push 触发的新 CI run
	// ====================================================================

	// 从推送输出中提取分支名
	pi.on('tool_result', async (event, ctx) => {
		if (!state.autoMode || !ghAvailable) return;
		if (event.toolName !== 'bash') return;

		const content = event.content;
		if (!Array.isArray(content)) return;

		const text = content
			.map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
			.join('');

		if (!/To github\.com/.test(text)) return;
		log.debug('bash 输出中检测到 GitHub push');

		const { branch, sha } = extractPushInfo(text);

		if (!branch) {
			if (/\[new tag\]/.test(text)) {
				// tag push 不触发分支 CI 监控
				log.info('检测到 tag push，跳过自动监控');
			} else {
				log.warn('无法从 push 输出确定分支，跳过自动监控', {
					excerpt: text.slice(0, 200),
				});
			}
			return;
		}
		log.debug('自动监控检测到分支', { branch });

		if (!isValidBranch(branch)) {
			log.warn('分支名包含不安全字符，跳过自动监控', { branch });
			return;
		}

		// 目标 SHA（完整 40 位）：优先用 push 输出里的短 SHA 补全，否则从本地分支解析
		let targetSha = sha ?? null;
		if (targetSha && targetSha.length < 40) {
			try {
				targetSha = execSync(`git rev-parse ${targetSha}`, {
					cwd: ctx.cwd,
					encoding: 'utf-8',
					timeout: 5000,
				}).trim();
			} catch {
				targetSha = null;
			}
		}
		if (!targetSha) {
			try {
				targetSha = execSync(`git rev-parse --verify refs/heads/${branch}`, {
					cwd: ctx.cwd,
					encoding: 'utf-8',
					timeout: 5000,
				}).trim();
			} catch (shaErr) {
				log.warn('无法解析分支 HEAD SHA，跳过自动监控', {
					branch,
					error: String(shaErr),
				});
				return;
			}
		}

		const myGen = sessionGeneration;
		const signal = beginMonitoring();
		const myController = monitoringAbort;

		// 分支存在 PR → PR 模式（轮询 pr checks，等待新 checks 注册）；
		// 无 PR（如直接推 main）→ 分支模式（等待 headSha 匹配的新 run 出现）
		let prOutput = '';
		try {
			prOutput = runGh(`pr list --head ${branch} --json number -q .[0].number`, ctx.cwd);
		} catch {
			prOutput = '';
		}

		const refLabel = prOutput ? `PR ${prOutput}` : `分支 ${branch}`;
		const refShort = prOutput ?? branch;

		log.info('触发 CI 自动监控', { branch, pr: prOutput, sha: targetSha });
		state.monitoringStatus = `正在监控 ${refLabel}（自动）...`;

		try {
			const result = await pollCiCompletion(
				prOutput || branch,
				state.pollConfig,
				state.autoMaxWaitMs,
				refLabel,
				refShort,
				ctx.cwd,
				signal,
				prOutput ? null : targetSha,
			);

			// 会话被替换/重载：旧 ctx/pi 已 stale，不得再使用
			if (sessionGeneration !== myGen) {
				log.warn('会话已替换/重载，跳过自动监控结果', { branch });
				return;
			}
			// 监控已被更新的监控取代：跳过通知，避免误导性"已取消"噪音干扰新监控
			if (monitoringAbort !== myController) {
				log.warn('自动监控已被新的监控取代，跳过结果通知', { branch });
				return;
			}
			notifyResult(result, refLabel, refShort, '自动', ctx, pi);
		} finally {
			// 无论正常/异常都清理状态；仅当自己仍是当前监控（避免并发互相覆盖）。
			// 异常不在此吞掉——向上传播由 extensionRunner.emit() 记录，此处只保证状态一致。
			if (monitoringAbort === myController) {
				state.monitoringStatus = null;
			}
		}
	});

	// ====================================================================
	// ci_watch 工具（LLM 通过 tool call 调用）
	// ====================================================================
	pi.registerTool({
		name: 'ci_watch',
		label: 'CI 监控',
		description:
			'监控 GitHub PR 或分支的 CI 状态，等待完成并报告结果。如果 CI 失败，返回失败日志供修复。支持 PR 编号（如 12）或分支名（如 main）。',
		promptSnippet: '监控 PR 或分支的 CI 状态，等待完成，如有失败则返回失败日志',
		promptGuidelines: [
			'在推送分支或打开 PR 后使用 ci_watch。支持 PR 编号或分支名。',
			'当 ci_watch 报告失败时：1) 读取失败日志并修复问题。2) 提交前必须先在本地运行验证（如类型检查、测试、格式化等），确认通过后再 commit 和 push。3) 调用 ci_watch 再次检查（最多 3 次尝试）。',
			'不要主动调用 ci_watch——只有用户明确要求监控 CI 时才调用。',
		],
		parameters: Type.Object({
			pr: Type.String({ description: '要监控的 PR 编号或分支名' }),
			attempt: Type.Optional(
				Type.Number({
					description: '当前修复尝试次数（1-3）。首次检查省略。',
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { pr } = params;
			const attempt = params.attempt ?? 1;
			const refLabel = isPrRef(pr) ? `PR ${pr}` : `Branch ${pr}`;
			const refShort = isPrRef(pr) ? `PR ${pr}` : pr;

			if (attempt > MAX_ATTEMPTS) {
				return {
					content: [
						{
							type: 'text',
							text: `[STOP] CI 在 ${MAX_ATTEMPTS} 次修复后仍然失败，需要人工介入。`,
						},
					],
					details: { status: 'max_attempts_reached', pr, attempts: MAX_ATTEMPTS },
				};
			}

			onUpdate?.({
				content: [
					{
						type: 'text',
						text: `等待 ${refLabel} CI 结果（第 ${attempt}/${MAX_ATTEMPTS} 次尝试）...`,
					},
				],
				details: {},
			});

			const result = await pollCiCompletion(
				pr,
				state.pollConfig,
				10 * 60 * 1000,
				refLabel,
				refShort,
				_ctx.cwd,
				signal,
				null,
				(msg: string) =>
					onUpdate?.({
						content: [{ type: 'text', text: msg }],
						details: {},
					}),
			);

			if (result.outcome === 'pass') {
				return {
					content: [{ type: 'text', text: result.message }],
					details: { status: 'pass', pr, attempt },
				};
			}

			if (result.outcome === 'fail') {
				return {
					content: [
						{
							type: 'text',
							text: `${result.message}\n\n失败的检查项：${result.failedRuns?.join(', ')}\n\n--- 失败日志（最后 100 行） ---\n${result.logs}\n\n---\n修复后，先本地验证（如类型检查、测试、格式化等），再 commit 和 push，然后 ci_watch attempt=${attempt + 1}。`,
						},
					],
					details: { status: 'fail', pr, attempt, failedChecks: result.failedRuns },
				};
			}

			return {
				content: [{ type: 'text', text: result.message }],
				details: { status: result.outcome, pr },
			};
		},
	});

	// ====================================================================
	// /ci-watch 命令：唯一入口
	//   - 无参数 → TUI 交互面板
	//   - 有参数 → 直接监控 PR/分支
	// ====================================================================
	pi.registerCommand('ci-watch', {
		description: '监控 CI。用法：/ci-watch <PR编号|分支名> 或 /ci-watch（打开交互面板）',
		handler: async (args, ctx) => {
			if (args?.trim()) {
				// 直接监控模式
				const ref = args.trim();
				if (!ghAvailable) {
					ctx.ui.notify('[ci-watch] gh CLI 不可用，请先安装 gh。', 'error');
					return;
				}
				if (!isPrRef(ref) && !isValidBranch(ref)) {
					ctx.ui.notify(
						`[ci-watch] 无效的引用：${ref}。请使用 PR 编号或分支名。`,
						'error',
					);
					return;
				}
				await startCiWatch(ref, ctx, state, pi);
				return;
			}

			// 无参数 → TUI 面板
			makeCiWatchPanel(ctx, state, configStore, ghAvailable, pi);
		},
	});
}
