/**
 * ADR-0048 `D7` 留痕要求 — 唤醒/派发失败路径**必须有 warn/error 日志**（可观测是排障前提）。
 *
 * 缺口背景（审查 P2）：`wakeFail` / `wakeSkip` / tmux 建会话失败 / 派活未唤醒 四处新增日志
 * 此前无任何断言——本次 UAT 的教训正是"这些路径零日志，排障只能靠日志缺失反推"。
 * 这里以注入方式（mock `@zenone/pi-logger`）断言日志的**消息与结构化字段**，
 * 使日志文案或分支被改动时测试即红（防止可观测性静默回退）。
 */
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { logger } = vi.hoisted(() => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@zenone/pi-logger', () => ({ createLogger: () => logger }));

import {
	joinOrg,
	createOrg,
	setAutoWake,
	setMemberLaunchArgs,
} from '../../../extensions/auto/org/orgstore.js';
import { wakeMember } from '../../../extensions/auto/org/lifecycle.js';
import { newDetachedSession } from '../../../extensions/auto/org/tmux.js';
import { dispatchTask } from '../../../extensions/auto/org/dispatch.js';
import { writeRuntimeFile } from './org-lifecycle-helpers.js';

const ORG = 'trace-team';
let root = '';
let chiefDir = '';
let memberDir = '';
let selfDir = '';
let savedPath: string | undefined;

/** 命中某条日志（message, fields） */
function logged(level: 'info' | 'warn' | 'error', message: string): Record<string, unknown> {
	const hit = logger[level].mock.calls.find((c) => c[0] === message);
	expect(
		hit,
		`未找到 ${level} 日志「${message}」；实际：${JSON.stringify(logger[level].mock.calls)}`,
	).toBeDefined();
	return hit?.[1] as Record<string, unknown>;
}

beforeAll(async () => {
	mkdirSync(join(tmpdir(), 'org-wake-trace-probe'), { recursive: true });
});

beforeEach(async () => {
	for (const l of ['info', 'warn', 'error', 'debug'] as const) logger[l].mockReset();
	root = mkdtempSync(join(tmpdir(), 'org-wake-trace-'));
	process.env.ORG_ROOT = join(root, 'orgdata');
	// 06：校验窗口归零——假 tmux 演的是「进程一直活着」，真等满 6s 只会拖死用例（真路径由 e2e 覆盖）
	process.env.ORG_WAKE_VERIFY_MS = '0';
	chiefDir = join(root, 'chief');
	memberDir = join(root, 'worker-a');
	selfDir = join(root, 'self');
	for (const d of [chiefDir, memberDir, selfDir]) mkdirSync(d, { recursive: true });
	await createOrg(ORG, { name: 'chief', dir: chiefDir });
	await joinOrg(ORG, { manifest: { name: 'worker-a', role: 'member' }, dir: memberDir });
});

afterEach(() => {
	if (savedPath !== undefined) {
		process.env.PATH = savedPath;
		savedPath = undefined;
	}
	// 兜底：本文件绝不应真的拉起成员进程（用例均让唤醒快速失败）
	try {
		execFileSync('tmux', ['kill-session', '-t', `org-${ORG}-worker-a`], { stdio: 'ignore' });
	} catch {
		/* 无会话或本机无 tmux：无需清理 */
	}
	delete process.env.ORG_ROOT;
	delete process.env.ORG_WAKE_VERIFY_MS;
	rmSync(root, { recursive: true, force: true });
});

describe('wakeMember 失败/拒绝留痕（D7）', () => {
	it('目标不是成员 → warn「唤醒未成功」+ reason=not-a-member', async () => {
		const res = await wakeMember(ORG, 'nobody', { selfDir });
		expect(res.started).toBe(false);
		const fields = logged('warn', '唤醒未成功');
		expect(fields).toMatchObject({ org: ORG, member: 'nobody', reason: 'not-a-member' });
	});

	it('组织读不到 → warn「唤醒未成功」+ reason=read-org-failed', async () => {
		const res = await wakeMember('no-such-org', 'worker-a', { selfDir });
		expect(res.started).toBe(false);
		expect(logged('warn', '唤醒未成功')).toMatchObject({
			org: 'no-such-org',
			reason: 'read-org-failed',
		});
	});

	it('自我豁免 → warn「唤醒被拒绝」+ skipped=self', async () => {
		await joinOrg(ORG, { manifest: { name: 'me', role: 'member' }, dir: selfDir });
		const res = await wakeMember(ORG, 'me', { selfDir });
		expect(res.skipped).toBe('self');
		expect(logged('warn', '唤醒被拒绝')).toMatchObject({
			org: ORG,
			member: 'me',
			skipped: 'self',
		});
	});

	it('陈旧 runtime（进程活、socket 不可连）→ warn「唤醒被拒绝」+ skipped=process-alive', async () => {
		await writeRuntimeFile(ORG, 'worker-a', {
			socketPath: join(root, 'gone.sock'), // 无监听者 → socket 不可连
			pid: process.pid, // 本进程 PID：真实存活
		});
		const res = await wakeMember(ORG, 'worker-a', { selfDir });
		expect(res.skipped).toBe('process-alive');
		expect(logged('warn', '唤醒被拒绝')).toMatchObject({
			org: ORG,
			member: 'worker-a',
			skipped: 'process-alive',
		});
	});

	it('tmux 不可用 → warn「唤醒未成功」+ reason=tmux-missing', async () => {
		savedPath = process.env.PATH;
		process.env.PATH = ''; // which tmux → 找不到
		const res = await wakeMember(ORG, 'worker-a', { selfDir });
		expect(res.started).toBe(false);
		expect(logged('warn', '唤醒未成功')).toMatchObject({ reason: 'tmux-missing' });
	});
});

describe('tmux 建会话失败留痕（D7）', () => {
	it('起会话失败 → error「tmux 建会话失败」并向上抛（不吞错）', async () => {
		savedPath = process.env.PATH;
		process.env.PATH = ''; // 无 tmux 可执行 → execFile ENOENT
		await expect(
			newDetachedSession({ name: 'org-trace-x', cwd: root, command: 'sleep', args: ['1'] }),
		).rejects.toThrow();
		const fields = logged('error', 'tmux 建会话失败');
		expect(fields).toMatchObject({ session: 'org-trace-x', command: 'sleep' });
		expect(String(fields.err ?? '')).not.toBe('');
	});
});

describe('派发不唤醒的决策留痕（D7）', () => {
	it('门禁关（缺省）：负责人派活 → info 记录「未自动唤醒 + 落 inbox 兜底」并写明门禁原因', async () => {
		await dispatchTask({
			org: ORG,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'T',
			background: 'bg',
			items: ['i1'],
			targets: [{ agent: 'worker-a', description: 'd' }],
		});
		const fields = logged('info', '派活未自动唤醒（目标落 inbox 兜底）');
		expect(fields).toMatchObject({ org: ORG, agent: 'worker-a' });
		expect(String(fields.reason)).toContain('autoWake');
	});

	it('门禁开：负责人派活 → 不再写「未唤醒」决策行（走自动唤醒分支）', async () => {
		await setAutoWake(ORG, true);
		// PATH 清空 → 唤醒在 tmux 缺失处**快速失败**（不 spawn，不阻塞 8s 轮询）
		savedPath = process.env.PATH;
		process.env.PATH = '';
		await dispatchTask({
			org: ORG,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'T2',
			background: 'bg',
			items: ['i1'],
			targets: [{ agent: 'worker-a', description: 'd' }],
		});
		const unwoken = logger.info.mock.calls.filter(
			(c) => c[0] === '派活未自动唤醒（目标落 inbox 兜底）',
		);
		expect(unwoken).toHaveLength(0);
	});
});

describe('唤醒命令行携带成员启动参数（ADR-0051 D3/D7）', () => {
	/**
	 * 伪造 tmux（06/07 起要模拟的语义变多了）。
	 *
	 * 用 **node 脚本**而不是 sh：测试把 PATH 设成只有 fakebin，shell 版的 `cat`/`rm`
	 * 这类外部命令会找不到（builtin 如 echo/printf 才可用），导致计数永远从 0 起。
	 * node 版用绝对路径 shebang（不查 PATH），文件读写走 fs，语义可长可短。
	 *
	 * 场景开关（环境变量，子进程继承）：
	 * - FAKE_TMUX_PANE_DEAD：display-message 报 1（pane 已退）= 模拟"启动即死"；
	 * - FAKE_TMUX_ALIVE_AFTER=N：第 N 次 new-session 之后才报活（模拟"降级重试成功"）；
	 * - FAKE_TMUX_CAPTURE：capture-pane 回放的输出（失败原因就在这里）。
	 */
	function installFakeTmux(): string {
		const binDir = join(root, 'fakebin');
		const logFile = join(root, 'tmux-args.log');
		const marker = join(root, 'tmux-session-alive');
		const stateFile = join(root, 'tmux-state.json');
		mkdirSync(binDir, { recursive: true });
		writeFileSync(
			join(binDir, 'tmux'),
			`#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const NL = String.fromCharCode(10);
fs.appendFileSync(${JSON.stringify(logFile)}, argv.join(' ') + NL);
const readState = () => {
	try {
		return JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
	} catch {
		return { count: 0 };
	}
};
const cmd = argv[0];
if (cmd === 'has-session') process.exit(fs.existsSync(${JSON.stringify(marker)}) ? 0 : 1);
if (cmd === 'new-session') {
	fs.writeFileSync(${JSON.stringify(marker)}, '1');
	const s = readState();
	fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ count: (s.count || 0) + 1 }));
	process.exit(0);
}
if (cmd === 'display-message') {
	const aliveAfter = Number(process.env.FAKE_TMUX_ALIVE_AFTER || 0);
	const dead = aliveAfter > 0
		? (readState().count || 0) >= aliveAfter ? 0 : 1
		: Number(process.env.FAKE_TMUX_PANE_DEAD || 0);
	console.log(String(dead));
	process.exit(0);
}
if (cmd === 'capture-pane') {
	console.log(process.env.FAKE_TMUX_CAPTURE || '');
	process.exit(0);
}
if (cmd === 'kill-session') {
	try {
		fs.unlinkSync(${JSON.stringify(marker)});
	} catch {}
	process.exit(0);
}
process.exit(0);
`,
			{ mode: 0o755 },
		);
		savedPath = process.env.PATH;
		process.env.PATH = binDir;
		return logFile;
	}

	it('拉起后进程随即退出 → 唤醒失败并把终端输出带回来（不再"尸体报成功"）', async () => {
		const logFile = installFakeTmux();
		process.env.FAKE_TMUX_PANE_DEAD = '1';
		process.env.FAKE_TMUX_CAPTURE = 'Error: Unknown option: --no-permission-gate';
		try {
			await setMemberLaunchArgs(ORG, 'worker-a', '--no-permission-gate');
			const res = await wakeMember(ORG, 'worker-a', { selfDir });

			// 核心断言：进程死了就不能报成功，且原因要能被看到
			expect(res.started).toBe(false);
			expect(res.error).toContain('Unknown option');
			expect(logged('warn', '唤醒未成功')).toMatchObject({
				org: ORG,
				member: 'worker-a',
				reason: 'died-after-start',
			});
			expect(logged('error', '成员进程启动后未存活')).toBeTruthy();
			// remain-on-exit 必须在建会话时打开（否则退出瞬间的输出读不到）
			expect(readFileSync(logFile, 'utf8')).toContain('remain-on-exit');
		} finally {
			delete process.env.FAKE_TMUX_PANE_DEAD;
			delete process.env.FAKE_TMUX_CAPTURE;
		}
	});

	it('追加参数不被目标环境识别 → 去掉后重试一次并如实告知降级（成员能起来）', async () => {
		const logFile = installFakeTmux();
		process.env.FAKE_TMUX_PANE_DEAD = '1';
		process.env.FAKE_TMUX_CAPTURE = 'Error: Unknown option: --no-permission-gate';
		process.env.FAKE_TMUX_ALIVE_AFTER = '2'; // 第 2 次拉起就活着（模拟降级重试成功）
		try {
			await setMemberLaunchArgs(ORG, 'worker-a', '--no-permission-gate --model x');
			const res = await wakeMember(ORG, 'worker-a', { selfDir });

			expect(res.started).toBe(true);
			expect(res.degradedFrom).toEqual(['--no-permission-gate']);
			expect(logged('warn', '成员启动参数不被目标环境识别，去掉后重试')).toMatchObject({
				org: ORG,
				member: 'worker-a',
			});

			// 降级只影响本次拉起：第二次 new-session 的 argv 里没有该参数，但**别的参数要留着**
			// 假 tmux 每次调用记一行（node 版把 argv 用空格连成一行）
			const newSessions = readFileSync(logFile, 'utf8')
				.split('\n')
				.filter((line) => line.startsWith('new-session'));
			expect(newSessions.length).toBe(2);
			const lastNew = newSessions.at(-1) ?? '';
			expect(lastNew).not.toContain('--no-permission-gate');
			expect(lastNew).toContain('--model');

			// 成员记录不被改写（降级是 per-launch 的事）
			const { readOrg } = await import('../../../extensions/auto/org/orgstore.js');
			const orgFile = await readOrg(ORG);
			expect(orgFile.members.find((m) => m.name === 'worker-a')?.launchArgs).toBe(
				'--no-permission-gate --model x',
			);
		} finally {
			delete process.env.FAKE_TMUX_PANE_DEAD;
			delete process.env.FAKE_TMUX_CAPTURE;
			delete process.env.FAKE_TMUX_ALIVE_AFTER;
		}
	});

	it('实际拉起的命令行带上成员的启动参数，并把生效 argv 记进日志', async () => {
		const logFile = installFakeTmux();
		await setMemberLaunchArgs(ORG, 'worker-a', '--no-permission-gate --model x');

		const res = await wakeMember(ORG, 'worker-a', { selfDir });
		expect(res.started).toBe(true);

		const recorded = readFileSync(logFile, 'utf8');
		expect(recorded).toContain('new-session');
		expect(recorded).toContain('--no-permission-gate');
		expect(recorded).toContain('--model');
		// D7 可观测：生效 argv 进日志（排障不必 attach tmux 反推）
		const fields = logged('info', '成员唤醒已发出');
		expect(fields.argv as string[]).toContain('--no-permission-gate');
	});

	it('成员记录无该字段 ⇒ 命令行不带任何追加参数（没有的就没有）', async () => {
		const logFile = installFakeTmux();
		const res = await wakeMember(ORG, 'worker-a', { selfDir });
		expect(res.started).toBe(true);
		expect(readFileSync(logFile, 'utf8')).not.toContain('--no-permission-gate');
	});
});
