/**
 * org 成员进程生命周期（睡眠 / 唤醒）— ADR-0040 D1/D9/D10/D11
 *
 * 覆盖：
 * - 睡眠：真实进程被停止（PID 路径）、杀前落 last-session、停后清 runtime、自我豁免
 * - 唤醒：三重幂等/防护（已在岗 / tmux 同名 / 自我豁免）、tmux 缺失报错
 * - tmux 原语：newDetachedSession / hasSession / killSession 真实往返（无 tmux 时跳过）
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	autoWakeEnabled,
	createOrg,
	joinOrg,
	readOrg,
	runtimeFile,
	setAutoWake,
} from '../../../extensions/auto/org/orgstore.js';
import {
	ensureAwakeForDispatch,
	lastSessionFile,
	readLastSession,
	sameDir,
	stopMember,
	wakeMember,
} from '../../../extensions/auto/org/lifecycle.js';
import {
	hasSession,
	killSession,
	newDetachedSession,
	tmuxAvailable,
	tmuxSessionName,
} from '../../../extensions/auto/org/tmux.js';
import { killIfAlive, spawnFakeMember, writeRuntimeFile } from './org-lifecycle-helpers.js';

const ORG = 'dev-team';
let root = '';
let chiefDir = '';
let memberDir = '';
let selfDir = '';
const pids: number[] = [];
const sessions: string[] = [];
let tmuxOk = false;

beforeAll(async () => {
	tmuxOk = await tmuxAvailable();
});

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'org-life-'));
	process.env.ORG_ROOT = join(root, 'orgdata');
	chiefDir = join(root, 'chief-dir');
	memberDir = join(root, 'worker-a-dir');
	selfDir = join(root, 'me-dir');
	for (const d of [chiefDir, memberDir, selfDir]) mkdirSync(d, { recursive: true });
	await createOrg(ORG, { name: 'chief', dir: chiefDir });
	await joinOrg(ORG, { manifest: { name: 'worker-a', role: 'member' }, dir: memberDir });
});

afterEach(async () => {
	for (const s of sessions.splice(0)) await killSession(s).catch(() => {});
	for (const p of pids.splice(0)) killIfAlive(p);
	rmSync(root, { recursive: true, force: true });
	parkOrgRoot();
});

/** 起一个真实在岗的"假成员"（真进程 + 真 socket）并写 runtime */
async function bringOnline(name = 'worker-a', busy = false): Promise<number> {
	const sock = join(root, `${name}.sock`);
	const pid = await spawnFakeMember({
		scriptPath: join(root, `fake-${name}.mjs`),
		socketPath: sock,
	});
	pids.push(pid);
	await writeRuntimeFile(ORG, name, {
		socketPath: sock,
		pid,
		dir: name === 'worker-a' ? memberDir : chiefDir,
		sessionId: `sess-${name}`,
		busy,
	});
	return pid;
}

describe('stopMember（睡眠）', () => {
	it('停在岗成员：真实进程被停止 + 杀前落 last-session + 停后清 runtime', async () => {
		const pid = await bringOnline();
		const res = await stopMember(ORG, 'worker-a', { selfDir });
		expect(res.stopped).toBe(true);
		expect(res.via).toBe('pid'); // 无 tmux 会话 → PID 路径（覆盖人类手工启动的成员）
		expect(res.sessionId).toBe('sess-worker-a');
		// 进程真的没了
		expect(() => process.kill(pid, 0)).toThrow();
		// last-session 落盘（供下次唤醒续接）
		const last = await readLastSession(ORG, 'worker-a');
		expect(last?.sessionId).toBe('sess-worker-a');
		expect(last?.stoppedAt).toBeTruthy();
		expect(existsSync(lastSessionFile(ORG, 'worker-a'))).toBe(true);
		// runtime 已清（圆点立刻反映，不必等巡检）
		expect(existsSync(runtimeFile(ORG, 'worker-a'))).toBe(false);
	});

	it('不在岗 → 不报成功（据实提示）', async () => {
		const res = await stopMember(ORG, 'worker-a', { selfDir });
		expect(res.stopped).toBe(false);
		expect(res.via).toBe('none');
		expect(res.error).toContain('不在岗');
	});

	it('自我豁免：目标目录 == 本进程目录时拒绝', async () => {
		await joinOrg(ORG, { manifest: { name: 'me', role: 'member' }, dir: selfDir });
		const res = await stopMember(ORG, 'me', { selfDir });
		expect(res.stopped).toBe(false);
		expect(res.error).toContain('自己');
	});

	it('陈旧 runtime：runtime.dir 与名册不符 → 拒绝停止（不误杀可能被复用的 pid）', async () => {
		const pid = await bringOnline();
		// 篡改 runtime.dir：模拟陈旧记录（成员目录改名/被删后遗留的 runtime）
		await writeRuntimeFile(ORG, 'worker-a', {
			socketPath: join(root, 'worker-a.sock'),
			pid,
			dir: '/tmp/not-the-member-dir',
			sessionId: 'sess-worker-a',
		});
		const res = await stopMember(ORG, 'worker-a', { selfDir });
		expect(res.stopped).toBe(false);
		expect(res.error).toContain('与名册');
		expect(() => process.kill(pid, 0)).not.toThrow(); // 未误杀
	});

	it('非成员 → 报错', async () => {
		const res = await stopMember(ORG, 'nobody', { selfDir });
		expect(res.stopped).toBe(false);
		expect(res.error).toContain('不在组织');
	});
});

describe('wakeMember（唤醒）', () => {
	it('已在岗 → 跳过（覆盖人类手工启动的成员）', async () => {
		await bringOnline();
		const res = await wakeMember(ORG, 'worker-a', { selfDir });
		expect(res.started).toBe(false);
		expect(res.skipped).toBe('online');
	});

	it('自我豁免：目标目录 == 本进程目录时拒绝', async () => {
		await joinOrg(ORG, { manifest: { name: 'me', role: 'member' }, dir: selfDir });
		const res = await wakeMember(ORG, 'me', { selfDir });
		expect(res.started).toBe(false);
		expect(res.skipped).toBe('self');
	});

	it('非成员 → 报错', async () => {
		const res = await wakeMember(ORG, 'nobody', { selfDir });
		expect(res.started).toBe(false);
		expect(res.error).toContain('不在组织');
	});

	it('tmux 同名会话已存在 → 跳过（封死 spawn 后未注册的竞态窗口）', async () => {
		if (!tmuxOk) return; // 无 tmux 环境不适用
		const name = tmuxSessionName(ORG, 'worker-a');
		sessions.push(name);
		await newDetachedSession({ name, cwd: memberDir, command: 'sleep', args: ['30'] });
		const res = await wakeMember(ORG, 'worker-a', { selfDir });
		expect(res.started).toBe(false);
		expect(res.skipped).toBe('session-exists');
		expect(res.sessionName).toBe(name);
	});

	it('tmux 不可用 → 可见报错（不静默失败）', async () => {
		const savedPath = process.env.PATH;
		try {
			process.env.PATH = '';
			const res = await wakeMember(ORG, 'worker-a', { selfDir });
			expect(res.started).toBe(false);
			expect(res.error).toContain('tmux');
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it('成员目录不存在 → 可见报错', async () => {
		if (!tmuxOk) return;
		const goneDir = join(root, 'gone-dir');
		await joinOrg(ORG, { manifest: { name: 'ghost', role: 'member' }, dir: goneDir });
		const res = await wakeMember(ORG, 'ghost', { selfDir });
		expect(res.started).toBe(false);
		expect(res.error).toContain('目录不存在');
	});
});

describe('tmux 原语（真实 tmux）', () => {
	it('newDetachedSession → hasSession → killSession 往返', async () => {
		if (!tmuxOk) return;
		const name = `org-test-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
		expect(await hasSession(name)).toBe(false);
		await newDetachedSession({ name, cwd: root, command: 'sleep', args: ['30'] });
		sessions.push(name);
		expect(await hasSession(name)).toBe(true);
		await killSession(name);
		sessions.length = 0;
		expect(await hasSession(name)).toBe(false);
	});

	it('killSession：杀掉最后一个会话（server 随之退出）不抛错', async () => {
		if (!tmuxOk) return;
		const name = `org-test-last-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
		await newDetachedSession({ name, cwd: root, command: 'sleep', args: ['30'] });
		// 不加入 sessions 清理列表：本用例就是要把它杀掉
		await expect(killSession(name)).resolves.toBeUndefined();
		expect(await hasSession(name)).toBe(false);
	});

	it('会话名约定：org-<公司>-<成员>；`.`/`:` 归一为 `_`（否则 tmux target 解析失效）', () => {
		expect(tmuxSessionName('dev-team', 'worker-a')).toBe('org-dev-team-worker-a');
		expect(tmuxSessionName('v1.0', 'team:a')).toBe('org-v1_0-team_a');
	});

	it('命令经 shell 安全转义（目录含空格/引号不注入）', async () => {
		if (!tmuxOk) return;
		const weird = join(root, "weird dir's");
		mkdirSync(weird, { recursive: true });
		const name = `org-test-quote-${process.pid}`;
		// 写出 cwd 到文件，验证命令真的在含引号的目录里执行
		const out = join(root, 'cwd.txt');
		await newDetachedSession({
			name,
			cwd: weird,
			command: 'sh',
			args: ['-c', `pwd > ${out}`],
		});
		sessions.push(name);
		for (let i = 0; i < 40; i++) {
			if (existsSync(out)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(readFileSync(out, 'utf8').trim()).toBe(weird);
	});
});

describe('sameDir', () => {
	it('归一化尾斜杠与相对路径', () => {
		expect(sameDir(root, `${root}/`)).toBe(true);
		expect(sameDir(root, join(root, '..', root.split('/').pop() ?? ''))).toBe(true);
		expect(sameDir(root, selfDir)).toBe(false);
	});
});

describe('autoWake（org 级开关，ADR-0040 D8）', () => {
	it('缺省关；setAutoWake 落本组织 org.json；作用域不跨组织', async () => {
		expect(autoWakeEnabled(await readOrg(ORG))).toBe(false);
		await setAutoWake(ORG, true);
		expect(autoWakeEnabled(await readOrg(ORG))).toBe(true);
		// 另一个组织不受影响（作用域 = 该组织）
		await createOrg('other-co', { name: 'boss', dir: chiefDir });
		expect(autoWakeEnabled(await readOrg('other-co'))).toBe(false);
		// 再关回去也持久化
		await setAutoWake(ORG, false);
		expect(autoWakeEnabled(await readOrg(ORG))).toBe(false);
	});

	it('ensureAwakeForDispatch：目标已在岗 → true（无需拉起）', async () => {
		await bringOnline();
		expect(
			await ensureAwakeForDispatch(ORG, 'worker-a', {
				selfDir: process.cwd(),
				timeoutMs: 1000,
			}),
		).toBe(true);
	});

	it('ensureAwakeForDispatch：失败不抛错 → false（调用方继续 inbox 兜底）', async () => {
		const saved = process.env.PATH;
		try {
			process.env.PATH = ''; // tmux 不可用
			await expect(
				ensureAwakeForDispatch(ORG, 'worker-a', { selfDir: process.cwd(), timeoutMs: 500 }),
			).resolves.toBe(false);
		} finally {
			process.env.PATH = saved;
		}
	});
});
