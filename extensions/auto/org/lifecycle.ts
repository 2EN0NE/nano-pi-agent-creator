// org — 成员进程生命周期（睡眠 / 唤醒）与上次会话记录（ADR-0040 D10/D11）
//
// 职责边界：
// - **睡眠**：人类在看板显式发起（杀停权限限人类，负责人不可发起）；
// - **唤醒**：人类在看板发起，或负责人派活时按 org 的 autoWake 开关自动发起；
// - 判定一律复用 presence 模块（socket 存活 = 在岗），不用 pid 判活（pid 会复用）。
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { orgDir, readOrg, runtimeFile } from './orgstore.js';
import { buildWakeArgs } from './launch-args.js';
import {
	assertSafeName,
	isSocketAlive,
	nowIso,
	readJson,
	realDir,
	writeJsonAtomic,
} from './util.js';
import { isPidAlive, readRuntime, type RuntimeRecord } from './presence.js';
import {
	capturePane,
	hasSession,
	killSession,
	newDetachedSession,
	paneDead,
	resolvePiCommand,
	setRemainOnExit,
	tmuxAvailable,
	tmuxSessionName,
} from './tmux.js';

const log = createLogger('org');

/** 停止后确认"真的停了"的等待上限（超过则如实回报失败，不让圆点撒谎） */
const STOP_VERIFY_TIMEOUT_MS = 3000;
/** 唤醒后确认在岗的默认等待上限（pi 冷启动含扩展加载，通常 1–3 秒） */
export const WAKE_VERIFY_TIMEOUT_MS = 15_000;

/**
 * 唤醒后「成员到底起来没有」的校验窗口上限（ADR-0051 审查 06）。
 *
 * 为何不是「存活 N 毫秒就算成功」：实测**启动即退**（未知 flag）发生在 1.6–2.3 秒
 * （pi 先加载扩展、再校验 flag），任何小于 2.5s 的存活判定都会把死亡判成成功。
 * 故这里用**精确信号**：窗口内要么在岗（socket 可连）→ 成功，要么 pane 退出 → 失败；
 * 窗口用尽而进程仍在 → 成功但标记「尚在启动」（不把慢启动误报为失败）。
 * 扩展多的环境启动更慢，默认留足 6s；测试与极慢环境可用 ORG_WAKE_VERIFY_MS 覆盖。
 */
const DEFAULT_WAKE_VERIFY_MS = 6000;
const WAKE_VERIFY_POLL_MS = 200;

function wakeVerifyWindowMs(): number {
	const raw = Number(process.env.ORG_WAKE_VERIFY_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WAKE_VERIFY_MS;
}

// ── 上次会话记录（<公司>/last-session/<成员>.json）────────────────────────────

/** 成员入睡时留下，供下次唤醒续接（ADR-0040 D11）。位置与 runtime/inbox/history 同构 */
export interface LastSessionRecord {
	sessionId: string;
	stoppedAt: string;
}

export function lastSessionFile(org: string, member: string): string {
	return path.join(orgDir(org), 'last-session', `${assertSafeName(member)}.json`);
}

export async function readLastSession(
	org: string,
	member: string,
): Promise<LastSessionRecord | null> {
	return readJson<LastSessionRecord>(lastSessionFile(org, member));
}

async function writeLastSession(
	org: string,
	member: string,
	rec: LastSessionRecord,
): Promise<void> {
	await writeJsonAtomic(lastSessionFile(org, member), rec);
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** 目录同一性（realpath 归一：mac /tmp → /private/tmp，尾斜杠等） */
export function sameDir(a: string, b: string): boolean {
	return realDir(a) === realDir(b);
}

// ── 睡眠（stop）─────────────────────────────────────────────────────────────

export interface StopOutcome {
	stopped: boolean;
	/** 走的是哪条停止路径：tmux 会话（我们拉起的）/ PID（人类手工启动的）/ 未在岗 */
	via: 'tmux' | 'pid' | 'none';
	/** 已落盘的 sessionId（供下次唤醒续接） */
	sessionId?: string;
	error?: string;
}

/**
 * 让成员睡眠（ADR-0040 D10）：
 * ① 确定停止方式（tmux 优先，否则 PID）并校验 PID 合法；
 * ② 落 `last-session`（此时已在能停的确定分支上；不依赖进程优雅退出——SIGKILL 时 clearRuntime 跑不到）；
 * ③ 发包停止 + 确认真的睡眠后才清 runtime，使看板立刻反映（不让圆点撒谎）。
 *
 * 自我豁免：目标目录 == 本进程目录时拒绝——停自己所在的 pi 等于自杀式操作，
 * 与唤醒侧的自我豁免同源（一目录 = 一员工）。
 */
export async function stopMember(
	org: string,
	member: string,
	opts: { selfDir: string },
): Promise<StopOutcome> {
	let targetDir = '';
	try {
		const orgFile = await readOrg(org);
		const target = orgFile.members.find((m) => m.name === member);
		if (!target)
			return { stopped: false, via: 'none', error: `成员 ${member} 不在组织 ${org} 中。` };
		targetDir = target.dir;
	} catch (e) {
		return { stopped: false, via: 'none', error: msg(e) };
	}
	if (sameDir(targetDir, opts.selfDir)) {
		return {
			stopped: false,
			via: 'none',
			error: `不能停掉自己所在的 pi（${member} 是本目录成员）。`,
		};
	}

	const runtime = await readRuntime(org, member);
	if (!runtime) {
		return { stopped: false, via: 'none', error: `成员 ${member} 当前不在岗（无需睡眠）。` };
	}
	const socketAlive = runtime.socketPath
		? await isSocketAlive(runtime.socketPath).catch(() => false)
		: false;
	// socket 不可连但进程仍在 = 陈旧 runtime（崩溃 / SIGKILL 残留；未在岗的普通 pi 已不写 runtime）：
	// 人类应能据实停掉它。
	if (!socketAlive && !isPidAlive(runtime.pid)) {
		return { stopped: false, via: 'none', error: `成员 ${member} 当前不在岗（无需睡眠）。` };
	}

	// ① 停：tmux 优先，否则 PID
	const sessionName = tmuxSessionName(org, member);
	const via: 'tmux' | 'pid' = (await hasSession(sessionName)) ? 'tmux' : 'pid';
	// pid 路径是外部可写 runtime 文件里的值：非法 pid（0/负/非整数）会命中当前进程组，
	// 拒绝发送以免误杀看板自己；这是边界，故返回错误而不是继续。
	// 校验须在写 last-session 之前——该分支停止动作未执行，不应留下「已睡眠」记录。
	if (via === 'pid' && !(Number.isInteger(runtime.pid) && runtime.pid > 1)) {
		return {
			stopped: false,
			via,
			sessionId: runtime.sessionId,
			error: `runtime 记录的 pid 非法（${runtime.pid}），拒绝发送停止信号（避免误伤当前进程组）。`,
		};
	}
	// pid 可能已被复用（陈旧 runtime / 崩溃残留）→ SIGTERM 不可撤销，故还须核对
	// runtime 自报目录与名册一致。tmux 路径按 (org, 成员) 命名，无此风险。
	if (via === 'pid' && runtime.dir && !sameDir(runtime.dir, targetDir)) {
		return {
			stopped: false,
			via,
			sessionId: runtime.sessionId,
			error: `runtime 记录的目录（${runtime.dir}）与名册（${targetDir}）不符，拒绝发送停止信号（疑似陈旧记录，pid 可能已被复用）。`,
		};
	}

	// ② 先落 last-session（确认能停之后、发包之前——不依赖进程优雅退出，SIGKILL 时 clearRuntime 跑不到）
	await writeLastSession(org, member, { sessionId: runtime.sessionId, stoppedAt: nowIso() });

	try {
		if (via === 'tmux') await killSession(sessionName);
		else process.kill(runtime.pid, 'SIGTERM');
	} catch (e) {
		return { stopped: false, via, sessionId: runtime.sessionId, error: `停止失败：${msg(e)}` };
	}
	log.info('成员入睡信号已发出', { org, member, via, pid: runtime.pid, sessionName });

	// ③ 确认真的停了
	const offline = await waitForOffline(runtime);
	if (!offline) {
		return {
			stopped: false,
			via,
			sessionId: runtime.sessionId,
			error: '已发出停止信号，但成员仍在响应——请检查后再试。',
		};
	}
	await fs.unlink(runtimeFile(org, member)).catch(() => {});
	return { stopped: true, via, sessionId: runtime.sessionId };
}

/** 等成员真正睡眠（socket 不可连且 pid 不存在） */
async function waitForOffline(
	runtime: RuntimeRecord,
	timeoutMs = STOP_VERIFY_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const sockAlive = runtime.socketPath
			? await isSocketAlive(runtime.socketPath, 300).catch(() => false)
			: false;
		if (!sockAlive && !isPidAlive(runtime.pid)) return true;
		if (Date.now() >= deadline) return false;
		await sleep(150);
	}
}

// ── 唤醒（wake）────────────────────────────────────────────────────────────

/**
 * 唤醒失败/被拒的**统一留痕出口**（ADR-0048 `D7`）：这些路径此前零日志，
 * 导致 UAT 排障只能靠"日志缺失"反推。凡失败与拒绝，先留痕再回报。
 */
function wakeFail(message: string, fields: Record<string, unknown>): WakeOutcome {
	log.warn('唤醒未成功', { ...fields, message });
	return { started: false, error: message };
}

/** 带跳过原因的拒绝（process-alive / self）：同样必须留痕 */
function wakeSkip(
	message: string,
	skipped: 'process-alive' | 'self',
	fields: Record<string, unknown>,
): WakeOutcome {
	log.warn('唤醒被拒绝', { ...fields, skipped, message });
	return { started: false, skipped, error: message };
}

export interface WakeOutcome {
	started: boolean;
	/**
	 * 幂等/防护跳过原因：
	 * online = socket 可连已在岗；process-alive = 进程在但未开 --session-control（不可重复拉起）；
	 * session-exists = tmux 会话已在（拉起中）；self = 目标就是本进程所在目录。
	 */
	skipped?: 'online' | 'process-alive' | 'session-exists' | 'self';
	sessionName?: string;
	/** 续接的上次会话 id（无记录则本次新建） */
	sessionId?: string;
	/**
	 * started=true 时：是否**已在岗**（socket 可连）。
	 * false 仅表示「进程活着但还没注册控制 socket」（慢启动）——不是失败，调用方据此措辞。
	 */
	online?: boolean;
	/**
	 * 07：本次唤醒为了能起来而**临时去掉**的启动参数（目标环境不识别它们时）。
	 * 只影响这一次拉起，不改成员记录——调用方应把降级告知人。
	 */
	degradedFrom?: string[];
	error?: string;
}

/**
 * 唤醒成员（ADR-0040 D1/D9/D11）：在其注册 cwd 以 tmux 会话拉起
 * `pi -a --session-control [--session-id <上次>]`。
 *
 * 三重幂等/防护（顺序即优先级）：
 * ① socket 可连 → 已在岗（这条同时覆盖"人类手工在终端启动的成员"）；
 * ② tmux 同名会话说在 → 正在拉起中，跳过（封死"已 spawn 但 socket 未注册"的窗口）；
 * ③ 目标目录 == 本进程目录 → 拒绝（否则一次自动唤醒就在人的看板目录里再起一个 pi）。
 */
export async function wakeMember(
	org: string,
	member: string,
	opts: { selfDir: string },
): Promise<WakeOutcome> {
	let targetDir = '';
	let memberLaunchArgs: string | undefined;
	try {
		const orgFile = await readOrg(org);
		const target = orgFile.members.find((m) => m.name === member);
		if (!target)
			return wakeFail(`成员 ${member} 不在组织 ${org} 中。`, {
				org,
				member,
				reason: 'not-a-member',
			});
		targetDir = target.dir;
		memberLaunchArgs = target.launchArgs;
	} catch (e) {
		return wakeFail(msg(e), { org, member, reason: 'read-org-failed' });
	}
	if (sameDir(targetDir, opts.selfDir)) {
		return wakeSkip(`不能唤醒自己所在的目录（一目录 = 一员工）。`, 'self', { org, member });
	}

	// ① 已在岗？
	const runtime = await readRuntime(org, member);
	if (runtime?.socketPath && (await isSocketAlive(runtime.socketPath).catch(() => false))) {
		log.debug('唤醒跳过：已在岗', { org, member });
		return { started: false, skipped: 'online' };
	}

	// ② 进程仍在但 socket 不可连 = 陈旧 runtime（崩溃 / SIGKILL 残留）→ 绝不重复拉起：
	//    要防的是 org 重复拉起同一个成员的在岗进程（同一 runtime 出现两个在岗 pi）。
	if (runtime && isPidAlive(runtime.pid)) {
		return wakeSkip(
			`成员 ${member} 的 runtime 记录仍在且进程存活（疑似陈旧记录，控制 socket 不可连）——为避免重复拉起已跳过；请确认其终端状态，必要时清理该 runtime 后重试。`,
			'process-alive',
			{ org, member },
		);
	}

	// ③ 正在拉起中？
	const sessionName = tmuxSessionName(org, member);
	if (await hasSession(sessionName)) {
		log.info('唤醒跳过：终端会话已在（拉起中）', { org, member, sessionName });
		return { started: false, skipped: 'session-exists', sessionName };
	}

	if (!(await tmuxAvailable())) {
		return wakeFail('未找到 tmux——唤醒需要 tmux 承载成员终端。', {
			org,
			member,
			reason: 'tmux-missing',
		});
	}
	if (!existsSync(targetDir)) {
		return wakeFail(`成员目录不存在：${targetDir}`, { org, member, reason: 'dir-missing' });
	}

	// ③ 续接上次会话（无记录则新建）
	const last = await readLastSession(org, member);
	const pi = await resolvePiCommand();
	if (!pi)
		return wakeFail('找不到 pi 可执行文件（PATH 与当前进程 argv 都不可用）。', {
			org,
			member,
			reason: 'pi-not-found',
		});
	const { command, prefixArgs } = pi;
	// 启动参数：固定核 + 该成员记录里的追加参数（ADR-0051 D3；字段缺失/空串 ⇒ 不追加）
	const wake = buildWakeArgs({
		prefixArgs,
		sessionId: last?.sessionId,
		launchArgs: memberLaunchArgs,
	});
	const { args } = wake;
	if (wake.droppedReason)
		log.warn('成员启动参数无效，已忽略追加项', {
			org,
			member,
			launchArgs: memberLaunchArgs,
			reason: wake.droppedReason,
		});
	// 拉起一次并校验（07 的降级重试要跑两遍，故收成闭包）
	const attempt = async (
		argv: string[],
	): Promise<
		| { ok: true; online: boolean }
		| { ok: false; spawnError?: string; detail?: string; output?: string }
	> => {
		try {
			await newDetachedSession({
				name: sessionName,
				cwd: targetDir,
				command,
				args: argv,
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					ORG_ROOT: process.env.ORG_ROOT,
				},
				// 06：退出后留住 pane——失败时要把「为什么没起来」的首屏输出带回来
				remainOnExit: true,
			});
		} catch (e) {
			return { ok: false, spawnError: msg(e) };
		}
		return verifyMemberStarted(org, member, sessionName);
	};

	// 06：拉起 ≠ 起来。终端建起来不代表成员进程活着——启动参数不被识别、扩展加载失败都会
	// 让它当场退出（实测 1.6–2.3s）。返回前校验，堵死「尸体也报成功」。
	let effectiveArgs = args;
	let degradedFrom: string[] = [];
	let result = await attempt(effectiveArgs);
	if (!result.ok && !result.spawnError) {
		// 07：失败原因是「追加的参数不被识别」时，去掉这些参数重试一次——能死在这里，
		// 说明目标环境并没有注册该 flag 的扩展（那道门禁本身也不在），去掉参数不削弱任何保护。
		// 只影响本次拉起，不写回成员记录；降级事实会随结果回报与留痕。
		const unknown = parseUnknownFlagNames(result.output ?? '');
		const baseArgs = buildWakeArgs({ prefixArgs, sessionId: last?.sessionId }).args;
		const appended = args.slice(baseArgs.length);
		const pruned = appended.filter((arg) => !unknown.includes(arg));
		if (unknown.length > 0 && pruned.length < appended.length) {
			const retryArgs = [...baseArgs, ...pruned];
			log.warn('成员启动参数不被目标环境识别，去掉后重试', {
				org,
				member,
				unknown,
				argv: [command, ...retryArgs],
			});
			result = await attempt(retryArgs);
			if (result.ok) {
				effectiveArgs = retryArgs;
				degradedFrom = unknown;
			}
		}
	}
	if (!result.ok) {
		if (result.spawnError) {
			return wakeFail(`tmux 启动失败：${result.spawnError}`, {
				org,
				member,
				reason: 'tmux-start-failed',
			});
		}
		const output = summarizePaneOutput(result.output);
		log.error('成员进程启动后未存活', {
			org,
			member,
			sessionName,
			argv: [command, ...args],
			output,
			degradedFrom,
		});
		return wakeFail(
			`成员进程启动后随即退出（${result.detail}）` +
				(output ? `。终端输出：${output}` : '。请确认启动参数与依赖在该成员环境可用。'),
			{ org, member, reason: 'died-after-start', output, degradedFrom },
		);
	}
	log.info('成员唤醒已发出', {
		org,
		member,
		sessionName,
		sessionId: last?.sessionId ?? null,
		argv: [command, ...effectiveArgs],
		online: result.online,
		degradedFrom,
	});
	return {
		started: true,
		sessionName,
		sessionId: last?.sessionId,
		online: result.online,
		degradedFrom: degradedFrom.length > 0 ? degradedFrom : undefined,
	};
}

/**
 * 从 pi 的失败输出里解析「不被识别的参数名」。
 * pi 的报错形如 `Error: Unknown option: --no-permission-gate`（多个用逗号分隔）。
 */
function parseUnknownFlagNames(output: string): string[] {
	const names = new Set<string>();
	for (const line of output.matchAll(/Unknown option[s]?:\s*([^\n]*)/gi)) {
		for (const token of line[1].match(/--[A-Za-z0-9_-]+/g) ?? []) names.add(token);
	}
	return [...names];
}

/** 把 pane 输出压成一行摘要（日志与提示都不宜塞多行）；优先挑错误行 */
function summarizePaneOutput(output: string | undefined, maxChars = 300): string {
	if (!output) return '';
	const lines = output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const picked =
		lines.find((line) => /error|unknown option|not found|failed|cannot find/i.test(line)) ??
		lines.at(-1) ??
		'';
	return picked.length > maxChars ? `${picked.slice(0, maxChars)}…` : picked;
}

/**
 * 「起来没有」校验（ADR-0051 审查 06）：窗口内三选一——
 * ① 在岗（socket 可连）→ 成功，并关掉 remain-on-exit 恢复常规行为；
 * ② pane 已退出 / 会话消失 → 失败，带回 pane 输出（Unknown option 这类原因即在此）；
 * ③ 窗口用尽但进程仍在 → 成功但 online=false（慢启动，不误报失败）。
 */
async function verifyMemberStarted(
	org: string,
	member: string,
	sessionName: string,
): Promise<{ ok: boolean; online: boolean; detail?: string; output?: string }> {
	const deadline = Date.now() + wakeVerifyWindowMs();
	for (;;) {
		const runtime = await readRuntime(org, member);
		if (
			runtime?.socketPath &&
			(await isSocketAlive(runtime.socketPath, 300).catch(() => false))
		) {
			await setRemainOnExit(sessionName, false).catch(() => {});
			return { ok: true, online: true };
		}
		const dead = await paneDead(sessionName);
		// dead === null ⇒ tmux 无法判定（会话不存在/输出不可解析），再用 has-session 兜底；
		// 两者都说"不在"才当死亡，避免把「探测不到」误判成「死了」。
		const gone = dead === null && !(await hasSession(sessionName));
		if (dead === true || gone) {
			const output = (await capturePane(sessionName)) ?? undefined;
			// 清理死会话：留着会让下次唤醒撞上 has-session 闸门而永久跳过
			await killSession(sessionName).catch(() => {});
			return {
				ok: false,
				online: false,
				detail: summarizePaneOutput(output) || '进程已退出且终端未留下输出',
				output,
			};
		}
		if (Date.now() >= deadline) {
			await setRemainOnExit(sessionName, false).catch(() => {});
			return { ok: true, online: false, detail: '仍在启动中' };
		}
		await sleep(WAKE_VERIFY_POLL_MS);
	}
}

/** 等成员在岗（socket 可连）。用于唤醒后的据实反馈与测试断言 */
export async function waitForOnline(
	org: string,
	member: string,
	timeoutMs = WAKE_VERIFY_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const runtime = await readRuntime(org, member);
		if (
			runtime?.socketPath &&
			(await isSocketAlive(runtime.socketPath, 500).catch(() => false))
		) {
			return true;
		}
		if (Date.now() >= deadline) return false;
		await sleep(300);
	}
}

// ── 诊断信息（成员详情屏用）──────────────────────────────────────────────────

/**
 * 批量探测"哪些成员由 tmux 托管"（会话名 = org-<公司>-<成员>）。
 * 只对**在岗**成员调用：睡眠成员无进程，无需探测。
 * 无 tmux server 时 `has-session` 返回失败且**不会启动 server**（实测），故巡检调用无副作用。
 */
export async function tmuxManagedMembers(org: string, members: string[]): Promise<Set<string>> {
	const managed = new Set<string>();
	// 顺序探测：成员数通常个位数，`tmux has-session` 约数毫秒；避免并发拉起的额外复杂度
	for (const name of members) {
		if (await hasSession(tmuxSessionName(org, name))) managed.add(name);
	}
	return managed;
}

/**
 * 派活前的自动唤醒（ADR-0040 D3/D8）：目标睡眠时先拉起再投递。
 * 幂等（已在岗/正在拉起都算成功）；失败或超时**不阻塞投递**——调用方继续走 inbox 兜底，任务不丢。
 */
export async function ensureAwakeForDispatch(
	org: string,
	member: string,
	opts: { selfDir: string; timeoutMs?: number },
): Promise<boolean> {
	// selfDir 显式收（与同模块 wakeMember / stopMember 一致）——
	// 否则本函数隐式绑定调用方的 cwd，测试与多目录场景下会静默出错。
	const res = await wakeMember(org, member, { selfDir: opts.selfDir });
	if (res.skipped === 'online') return true;
	// process-alive（陈旧 runtime，不可拉起）/ self / error → 交由 inbox 兜底
	if (!res.started && res.skipped !== 'session-exists') return false;
	return waitForOnline(org, member, opts.timeoutMs ?? 8000);
}
