import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { execSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';
import { createConfigStore } from '@zenone/pi-config';
import type { ConfigStore } from '@zenone/pi-config';
import { Container, SelectList, Text, matchesKey, Key } from '@earendil-works/pi-tui';
import type { SelectItem } from '@earendil-works/pi-tui';

const log = createLogger('ci-watch');

const MAX_ATTEMPTS = 3;
const DEFAULT_POLL_MIN_MS = 30_000;
const DEFAULT_POLL_MAX_MS = 60_000;
const DEFAULT_POLL_STEP_MS = 15_000;

interface CiCheckResult {
	status: 'pass' | 'fail' | 'pending' | 'error';
	/**
	 * 失败的检查/run 名称列表。
	 * - PR 模式：check 的 name（来自 `gh pr checks`）
	 * - 分支模式：workflow run 的 name（来自 `gh run list`）
	 */
	failedRuns: string[];
	logs: string;
	/**
	 * 分支模式专用：标记 pending 是因为分支还没有 run（可能是 CI 尚未触发），
	 * 区别于 run 正在执行中的 pending。轮询循环利用此字段对空 run 场景快速超时。
	 */
	noRunsFound?: boolean;
}

interface PollConfig {
	minMs: number;
	maxMs: number;
	stepMs: number;
}

interface PollResult {
	outcome: 'pass' | 'fail' | 'error' | 'timeout' | 'cancelled';
	message: string;
	logs?: string;
	failedRuns?: string[];
}

function nextPollDelay(current: number, config: PollConfig): number {
	const next = current + config.stepMs;
	if (next > config.maxMs) return config.minMs;
	return next;
}

function runGh(args: string, cwd: string): string {
	try {
		return execSync(`gh ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`gh ${args} failed: ${msg}`);
	}
}

/** Validate that a branch name contains only safe characters for shell interpolation. */
function isValidBranch(branch: string): boolean {
	return /^[a-zA-Z0-9_\-./]+$/.test(branch);
}

/** Check if input is a PR number (digits only) */
function isPrRef(input: string): boolean {
	return /^\d+$/.test(input);
}

/** Resolve input to a branch name — PR numbers resolved via gh, branch names returned as-is */
function resolveBranch(prOrBranch: string, cwd: string): string {
	if (isPrRef(prOrBranch)) {
		return runGh(`pr view ${prOrBranch} --json headRefName -q .headRefName`, cwd);
	}
	return prOrBranch;
}

/**
 * 兼容旧版 gh CLI：获取某分支的最近 workflow runs。
 *
 * gh CLI v2.12.0+ 支持 `run list --branch <name>`，但旧版不支持。
 * 为确保兼容所有版本，改为：
 *   gh run list -L <limit> --json headBranch,databaseId,status,conclusion,name
 * 然后 JavaScript 端按分支过滤。
 *
 * @param branch 要过滤的分支名
 * @param cwd gh 命令执行的 git 仓库目录
 * @param limit 最多拉取多少个 runs（默认为 20，兼容旧版 gh 需要更大值）
 */
function getRunsForBranch(
	branch: string,
	cwd: string,
	limit: number = 20,
): Array<{
	name: string;
	status: string;
	conclusion: string;
	databaseId: number;
}> {
	try {
		const output = runGh(
			`run list -L ${limit} --json headBranch,databaseId,status,conclusion,name`,
			cwd,
		);
		const allRuns = JSON.parse(output) as Array<{
			headBranch: string;
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
		const checks = JSON.parse(output) as Array<{ name: string; state: string; bucket: string }>;

		const pending = checks.some((c) => c.bucket === 'pending');
		if (pending) return { status: 'pending', failedRuns: [], logs: '' };

		const failed = checks.filter((c) => c.bucket === 'fail');
		if (failed.length === 0) return { status: 'pass', failedRuns: [], logs: '' };

		return { status: 'fail', failedRuns: failed.map((f) => f.name), logs: '' };
	} catch (e) {
		return { status: 'error', failedRuns: [], logs: String(e) };
	}
}

function getCiStatusFromBranch(branch: string, cwd: string): CiCheckResult {
	try {
		if (!isValidBranch(branch)) {
			return { status: 'error', failedRuns: [], logs: `Invalid branch name: ${branch}` };
		}
		const runs = getRunsForBranch(branch, cwd, 5);
		const latest = runs[0];
		if (!latest) {
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
			return {
				status: 'pending',
				failedRuns: [],
				logs: '',
				noRunsFound: true,
			};
		}
		if (latest.status !== 'completed') return { status: 'pending', failedRuns: [], logs: '' };
		if (latest.conclusion === 'success' || latest.conclusion === 'neutral') {
			return { status: 'pass', failedRuns: [], logs: '' };
		}
		return {
			status: 'fail',
			failedRuns: [latest.name ?? `run#${latest.databaseId}`],
			logs: '',
		};
	} catch (e) {
		return { status: 'error', failedRuns: [], logs: String(e) };
	}
}

/** 根据输入自动选择 PR 模式或分支模式 */
function getCiStatus(prOrBranch: string, cwd: string): CiCheckResult {
	if (isPrRef(prOrBranch)) {
		return getCiStatusFromPr(prOrBranch, cwd);
	}
	return getCiStatusFromBranch(prOrBranch, cwd);
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ====================================================================
// 共享轮询逻辑
// ====================================================================

/**
 * 轮询 CI 状态直到完成，返回结果。
 * 不涉及 LLM，纯代码实现。
 * @param cwd - 执行 gh 命令的 git 仓库根目录（通常为 ctx.cwd）
 */
async function pollCiCompletion(
	pr: string,
	pollConfig: PollConfig,
	maxWaitMs: number,
	refLabel: string,
	refShort: string,
	cwd?: string,
	signal?: AbortSignal,
	onUpdate?: (msg: string) => void,
): Promise<PollResult> {
	let elapsed = 0;
	let currentDelay = pollConfig.minMs;
	let consecutiveEmptyPolls = 0;
	const maxEmptyPolls = 3;
	const workDir = cwd ?? process.cwd();

	while (!signal?.aborted) {
		const result = getCiStatus(pr, workDir);

		if (result.status === 'error') {
			return { outcome: 'error', message: `检查 CI 出错：${result.logs}` };
		}

		if (result.status === 'pass') {
			return { outcome: 'pass', message: `[PASS] ${refLabel} CI passed!` };
		}

		if (result.status === 'fail') {
			const logs = getFailedLogs(pr, workDir);
			return {
				outcome: 'fail',
				message: `[FAIL] ${refLabel} CI failed.`,
				logs,
				failedRuns: result.failedRuns,
			};
		}

		// 分支模式：连续多次无 run → fast-fail
		if (result.noRunsFound) {
			consecutiveEmptyPolls++;
			if (consecutiveEmptyPolls >= maxEmptyPolls) {
				return {
					outcome: 'error',
					message: `[STOP] ${refLabel} has no CI runs after ${maxEmptyPolls} checks. Confirm branch name and CI trigger.`,
				};
			}
		} else {
			consecutiveEmptyPolls = 0;
		}

		if (elapsed >= maxWaitMs) {
			return {
				outcome: 'timeout',
				message: `[TIMEOUT] ${refLabel} CI not completed after ${Math.round(maxWaitMs / 60000)} min. Check manually.`,
			};
		}

		await sleep(currentDelay);
		elapsed += currentDelay;
		currentDelay = nextPollDelay(currentDelay, pollConfig);
		onUpdate?.(
			`[WAIT] ${refShort} CI running... (${Math.round(elapsed / 1000)}s elapsed, next check in ${currentDelay / 1000}s)`,
		);
	}

	return { outcome: 'cancelled', message: 'CI monitoring cancelled.' };
}

// ====================================================================
// TUI 面板逻辑
// ====================================================================

interface TuiState {
	autoMode: boolean;
	pollConfig: PollConfig;
	pollConfigExpanded: boolean;
	menuIndex: number;
	monitoringStatus: string | null;
}

function makeCiWatchPanel(
	ctx: ExtensionCommandContext,
	state: TuiState,
	configStore: ConfigStore<{ pollConfig: PollConfig }> | null,
	ghAvailable: boolean,
	pi: ExtensionAPI,
): void {
	const items: SelectItem[] = [
		{
			value: '__monitor_pr',
			label: '> Monitor PR',
			description: 'Enter a PR number to monitor its CI status',
		},
		{
			value: '__monitor_branch',
			label: '> Monitor Branch',
			description: 'Enter a branch name to monitor its CI status',
		},
		{
			value: '__toggle_auto',
			label: `Auto-mode: ${state.autoMode ? 'ON' : 'OFF'}`,
			description: state.autoMode
				? 'Enabled — auto-monitor CI after git push'
				: 'Disabled — no auto-monitoring after push',
		},
	];

	// Polling config 行（带展开/折叠）
	if (state.pollConfigExpanded) {
		items.push({
			value: '__toggle_config',
			label: `Polling: ${state.pollConfig.minMs / 1000}s - ${state.pollConfig.maxMs / 1000}s (step ${state.pollConfig.stepMs / 1000}s) [expanded]`,
			description: 'Ctrl+O to collapse  |  Enter to edit',
		});
		items.push({
			value: '__config_min',
			label: `  min: ${state.pollConfig.minMs / 1000}s`,
			description: 'Change minimum polling interval',
		});
		items.push({
			value: '__config_max',
			label: `  max: ${state.pollConfig.maxMs / 1000}s`,
			description: 'Change maximum polling interval',
		});
		items.push({
			value: '__config_step',
			label: `  step: ${state.pollConfig.stepMs / 1000}s`,
			description: 'Change polling interval step',
		});
	} else {
		items.push({
			value: '__toggle_config',
			label: `Polling: ${state.pollConfig.minMs / 1000}s - ${state.pollConfig.maxMs / 1000}s (step ${state.pollConfig.stepMs / 1000}s)`,
			description: 'Ctrl+O to expand config details',
		});
	}

	const statusText = ghAvailable
		? state.monitoringStatus
			? `Status: ${state.monitoringStatus}`
			: 'Status: idle'
		: 'Status: gh CLI not available';

	ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		container.addChild(new Text(theme.fg('accent', theme.bold('CI Watch')), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length + 1, 12), {
			selectedPrefix: (t) => theme.fg('accent', t),
			selectedText: (t) => theme.fg('accent', t),
			description: (t) => theme.fg('muted', t),
			scrollInfo: (t) => theme.fg('dim', t),
			noMatch: (t) => theme.fg('warning', t),
		});

		if (state.menuIndex > 0 && state.menuIndex < items.length) {
			selectList.setSelectedIndex(state.menuIndex);
		}

		selectList.onSelect = async (item) => {
			const value = item.value;
			done();
			await handlePanelAction(value, ctx, state, configStore, ghAvailable, pi);
			// 重新打开面板（除非是监控操作，监控完成后会通知用户）
			if (value !== '__monitor_pr' && value !== '__monitor_branch') {
				makeCiWatchPanel(ctx, state, configStore, ghAvailable, pi);
			}
		};
		let currentIndex = state.menuIndex;
		selectList.onCancel = () => done();

		container.addChild(selectList);
		container.addChild(new Text(theme.fg('dim', statusText), 1, 0));
		container.addChild(
			new Text(
				theme.fg('dim', 'up/down navigate  enter select  esc close  ctrl+o toggle config'),
				1,
				0,
			),
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
				currentIndex = selectList.getSelectedItem()
					? items.findIndex((i) => i.value === selectList.getSelectedItem()?.value)
					: currentIndex;
				state.menuIndex = currentIndex >= 0 ? currentIndex : state.menuIndex;
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
	configStore: ConfigStore<{ pollConfig: PollConfig }> | null,
	ghAvailable: boolean,
	pi: ExtensionAPI,
): Promise<void> {
	switch (value) {
		case '__monitor_pr': {
			if (!ghAvailable) {
				ctx.ui.notify('gh CLI not available. Install gh first.', 'error');
				return;
			}
			const prInput = await ctx.ui.input('Enter PR number', '');
			if (!prInput || !prInput.trim()) return;
			const pr = prInput.trim();
			if (!isPrRef(pr)) {
				ctx.ui.notify('Invalid PR number. Enter digits only.', 'error');
				return;
			}
			await startCiWatch(pr, ctx, state, pi);
			break;
		}
		case '__monitor_branch': {
			if (!ghAvailable) {
				ctx.ui.notify('gh CLI not available. Install gh first.', 'error');
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
			const branchInput = await ctx.ui.input('Enter branch name', defaultBranch);
			if (!branchInput || !branchInput.trim()) return;
			const branch = branchInput.trim();
			if (!isValidBranch(branch)) {
				ctx.ui.notify(`Invalid branch name: ${branch}`, 'error');
				return;
			}
			await startCiWatch(branch, ctx, state, pi);
			break;
		}
		case '__toggle_auto': {
			state.autoMode = !state.autoMode;
			ctx.ui.notify(
				`Auto-monitor: ${state.autoMode ? 'ON' : 'OFF'}`,
				state.autoMode ? 'info' : 'warning',
			);
			break;
		}
		case '__toggle_config': {
			state.pollConfigExpanded = !state.pollConfigExpanded;
			break;
		}
		case '__config_min': {
			const val = await ctx.ui.input(
				'Minimum polling interval (seconds)',
				String(state.pollConfig.minMs / 1000),
			);
			if (!val) return;
			const n = Number(val.trim());
			if (isNaN(n) || n < 1) {
				ctx.ui.notify('Invalid value', 'error');
				return;
			}
			state.pollConfig.minMs = n * 1000;
			saveConfig(state, configStore);
			ctx.ui.notify(`Min polling set to ${n}s`, 'info');
			break;
		}
		case '__config_max': {
			const val = await ctx.ui.input(
				'Maximum polling interval (seconds)',
				String(state.pollConfig.maxMs / 1000),
			);
			if (!val) return;
			const n = Number(val.trim());
			if (isNaN(n) || n < 1) {
				ctx.ui.notify('Invalid value', 'error');
				return;
			}
			state.pollConfig.maxMs = n * 1000;
			saveConfig(state, configStore);
			ctx.ui.notify(`Max polling set to ${n}s`, 'info');
			break;
		}
		case '__config_step': {
			const val = await ctx.ui.input(
				'Polling step (seconds)',
				String(state.pollConfig.stepMs / 1000),
			);
			if (!val) return;
			const n = Number(val.trim());
			if (isNaN(n) || n < 1) {
				ctx.ui.notify('Invalid value', 'error');
				return;
			}
			state.pollConfig.stepMs = n * 1000;
			saveConfig(state, configStore);
			ctx.ui.notify(`Polling step set to ${n}s`, 'info');
			break;
		}
	}
}

function saveConfig(
	state: TuiState,
	configStore: ConfigStore<{ pollConfig: PollConfig }> | null,
): void {
	if (configStore) {
		configStore.save({ pollConfig: state.pollConfig }, 'user');
	}
}

// ====================================================================
// 监控启动逻辑（带状态更新）
// ====================================================================

async function startCiWatch(
	ref: string,
	ctx: ExtensionCommandContext,
	state: TuiState,
	pi: ExtensionAPI,
): Promise<void> {
	const refLabel = isPrRef(ref) ? `PR ${ref}` : `Branch ${ref}`;
	const refShort = isPrRef(ref) ? `PR ${ref}` : ref;

	state.monitoringStatus = `Monitoring ${refLabel}...`;
	ctx.ui.notify(`[ci-watch] Monitoring ${refLabel}...`, 'info');

	const result = await pollCiCompletion(
		ref,
		state.pollConfig,
		15 * 60 * 1000,
		refLabel,
		refShort,
		ctx.cwd,
	);

	state.monitoringStatus = null;

	if (result.outcome === 'pass') {
		ctx.ui.notify(`[ci-watch] ${refLabel} CI passed!`, 'info');
	} else if (result.outcome === 'fail') {
		pi.sendUserMessage(
			`[ci-watch] ${refLabel} CI failed.\n\nFailed checks: ${result.failedRuns?.join(', ')}\n\n--- Failure logs (last 100 lines) ---\n${result.logs}\n\n---\nPlease fix and push, then use /ci-watch ${refShort} to re-monitor.`,
			{ deliverAs: 'followUp' },
		);
	} else {
		ctx.ui.notify(`[ci-watch] ${result.message}`, 'error');
	}
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
		menuIndex: 0,
		monitoringStatus: null,
	};

	// 从持久化存储加载配置
	let configStore: ConfigStore<{ pollConfig: PollConfig }> | null = null;
	try {
		configStore = createConfigStore<{ pollConfig: PollConfig }>({
			pluginName: 'ci-watch',
			defaults: { pollConfig: state.pollConfig },
		});
		const saved = configStore.get();
		if (saved.pollConfig) {
			state.pollConfig = saved.pollConfig;
		}
	} catch {
		// 配置加载失败时使用默认值
	}

	let ghAvailable = false;
	let ghChecked = false;

	// ====================================================================
	// session_start：检测 gh CLI
	// ====================================================================
	pi.on('session_start', async (_event, ctx) => {
		if (ghChecked) return;
		ghChecked = true;
		try {
			execSync('command -v gh', { encoding: 'utf-8', stdio: 'pipe' });
			ghAvailable = true;
			if (state.autoMode) {
				ctx.ui.notify('[ci-watch] gh CLI detected, auto-monitor enabled', 'info');
			}
		} catch {
			ghAvailable = false;
			state.autoMode = false;
			ctx.ui.notify(
				'[ci-watch] gh CLI not found. Install: brew install gh / apt install gh',
				'error',
			);
		}
	});

	// ====================================================================
	// 自动触发：检测 git push → 直接轮询 CI
	// ====================================================================

	// 从推送输出中提取分支名
	function extractBranch(text: string): string | null {
		const trackMatch = text.match(/branch '([^']+)' set up to track/);
		if (trackMatch) return trackMatch[1];
		const newBranchMatch = text.match(/\*\s+\[new branch\]\s+(\S+)\s*->\s*\S+/);
		if (newBranchMatch) return newBranchMatch[1];
		const existingMatch = text.match(/\S+\.\.\S+\s+(\S+)\s*->\s*\S+/);
		if (existingMatch) return existingMatch[1];
		return null;
	}

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

		let branch: string | null = extractBranch(text);

		if (!branch) {
			try {
				branch = execSync('git branch --show-current', {
					cwd: ctx.cwd,
					encoding: 'utf-8',
					timeout: 5000,
				}).trim();
			} catch (gitErr) {
				log.debug('git branch --show-current 兜底失败', { error: String(gitErr) });
			}
		}

		if (!branch) {
			log.debug('无法从 push 输出确定分支');
			return;
		}
		log.debug('自动监控检测到分支', { branch });

		if (!isValidBranch(branch)) {
			log.warn('分支名包含不安全字符，跳过自动监控', { branch });
			return;
		}

		try {
			const prOutput = runGh(
				`pr list --head ${branch} --json number -q .[0].number`,
				ctx.cwd,
			);

			const refLabel = prOutput ? `PR ${prOutput}` : `Branch ${branch}`;
			const refShort = prOutput ?? branch;

			if (prOutput) {
				let hasChecks = false;
				try {
					const checksOutput = runGh(`pr checks ${prOutput} --json name`, ctx.cwd);
					const checks = JSON.parse(checksOutput);
					if (Array.isArray(checks) && checks.length > 0) hasChecks = true;
				} catch (checksErr) {
					log.warn('检查 CI 状态失败，跳过自动监控', {
						pr: prOutput,
						error: String(checksErr),
					});
					return;
				}
				if (!hasChecks) {
					log.debug('该 PR 没有 CI 检查，跳过自动监控', { pr: prOutput });
					return;
				}
			} else {
				let hasRuns = false;
				try {
					const runs = getRunsForBranch(branch, ctx.cwd, 5);
					if (runs.length > 0) hasRuns = true;
				} catch (runsErr) {
					log.warn('检查分支 CI 状态失败，跳过自动监控', {
						branch,
						error: String(runsErr),
					});
					return;
				}
				if (!hasRuns) {
					log.debug('该分支没有 CI run，跳过自动监控', { branch });
					return;
				}
			}

			log.info('触发 CI 自动监控', { pr: prOutput, branch });
			state.monitoringStatus = `Monitoring ${refLabel} (auto)...`;

			// 直接轮询，不经过 LLM
			const result = await pollCiCompletion(
				prOutput ?? branch,
				state.pollConfig,
				10 * 60 * 1000,
				refLabel,
				refShort,
			);

			state.monitoringStatus = null;

			if (result.outcome === 'pass') {
				ctx.ui.notify(`[ci-watch] Auto: ${refLabel} CI passed!`, 'info');
			} else if (result.outcome === 'fail') {
				pi.sendUserMessage(
					`[ci-watch] Auto: ${refLabel} CI failed.\n\nFailed checks: ${result.failedRuns?.join(', ')}\n\n--- Failure logs (last 100 lines) ---\n${result.logs}\n\n---\nPlease fix and push, then use /ci-watch ${prOutput ?? branch} to re-monitor.`,
					{ deliverAs: 'followUp' },
				);
			} else {
				ctx.ui.notify(`[ci-watch] Auto: ${result.message}`, 'error');
			}
		} catch (autoErr) {
			log.warn('自动监控异常', { branch, error: String(autoErr) });
			state.monitoringStatus = null;
		}
	});

	// ====================================================================
	// ci_watch 工具（LLM 通过 tool call 调用）
	// ====================================================================
	pi.registerTool({
		name: 'ci_watch',
		label: 'CI Monitor',
		description:
			'Monitor CI status on a GitHub PR or branch, wait for completion, and report results. If CI fails, return failure logs for fixing. Supports PR number (e.g. 12) or branch name (e.g. main).',
		promptSnippet:
			'Monitor CI on a PR or branch, wait for completion, return failure logs if any',
		promptGuidelines: [
			'Use ci_watch after pushing a branch or opening a PR. Supports PR number or branch name.',
			'When ci_watch reports failure, read logs, fix issues, commit, push, then call ci_watch again (max 3 attempts).',
			'Do not call ci_watch proactively — only when the user explicitly asks to monitor CI.',
		],
		parameters: Type.Object({
			pr: Type.String({ description: 'PR number or branch name to monitor' }),
			attempt: Type.Optional(
				Type.Number({
					description: 'Current fix attempt count (1-3). Omit for first check.',
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
							text: `[STOP] CI still failing after ${MAX_ATTEMPTS} fix attempts. Manual intervention needed.`,
						},
					],
					details: { status: 'max_attempts_reached', pr, attempts: MAX_ATTEMPTS },
				};
			}

			onUpdate?.({
				content: [
					{
						type: 'text',
						text: `Waiting for ${refLabel} CI (attempt ${attempt}/${MAX_ATTEMPTS})...`,
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
							text: `${result.message}\n\nFailed checks: ${result.failedRuns?.join(', ')}\n\n--- Failure logs (last 100 lines) ---\n${result.logs}\n\n---\nFix issues, commit, push, then call ci_watch with attempt=${attempt + 1}.`,
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
		description: 'Monitor CI. Usage: /ci-watch <pr|branch> or /ci-watch (opens TUI panel)',
		handler: async (args, ctx) => {
			if (args?.trim()) {
				// 直接监控模式
				const ref = args.trim();
				if (!ghAvailable) {
					ctx.ui.notify('[ci-watch] gh CLI not available. Install gh first.', 'error');
					return;
				}
				if (!isPrRef(ref) && !isValidBranch(ref)) {
					ctx.ui.notify(
						`[ci-watch] Invalid ref: ${ref}. Use PR number or branch name.`,
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
