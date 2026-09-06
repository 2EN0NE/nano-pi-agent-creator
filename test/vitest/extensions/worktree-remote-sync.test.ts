/**
 * pi-worktree — 只读同步差距诊断测试（getRemoteAheadBehind）
 *
 * 本地优先原则：merge 不自动同步远端，但提供只读诊断提示「本地落后远端 N 提交」。
 * getRemoteAheadBehind 只读（fetch/rev-list），无 remote、远端分支不存在、网络失败时
 * 返回 null（静默，绝不报错）。
 *
 * fetch 用异步 spawn（带超时 kill），不阻塞 TUI 事件循环——这是本地优先改造的关键约束。
 * 远端用 file:// bare repo 模拟（离线、无网络依赖）。
 * git 身份由 test/vitest/setup/git-ident.ts 通过环境变量注入。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 转发真实实现；仅超时用例用 mockImplementation 拦截 fetch（模拟挂起被 kill）
// realSpawnSync/realSpawn 通过 vi.hoisted 暴露给 mock 工厂（vitest 禁止工厂直接引用外部变量）
const { realSpawnSync, realSpawn } = vi.hoisted(() => ({
	realSpawnSync: {
		current: null as unknown as (typeof import('node:child_process'))['spawnSync'],
	},
	realSpawn: {
		current: null as unknown as (typeof import('node:child_process'))['spawn'],
	},
}));
vi.mock('node:child_process', async () => {
	const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
	realSpawnSync.current = actual.spawnSync;
	realSpawn.current = actual.spawn;
	return {
		...actual,
		spawnSync: vi.fn((cmd: string, args: string[], opts?: any) =>
			actual.spawnSync(cmd, args, opts),
		),
		spawn: vi.fn((cmd: string, args: string[], opts?: any) => actual.spawn(cmd, args, opts)),
	};
});

const mockSpawnSync = vi.mocked(spawnSync);
const mockSpawn = vi.mocked(spawn);

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_LIB = resolve(__dirname, '../../../extensions/meta/worktree/lib');

function createGitRepo(basedir: string, name: string): string {
	const repoDir = join(basedir, name);
	mkdirSync(repoDir, { recursive: true });
	execSync('git init --initial-branch main -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`);
	execSync('git add README.md && git commit -m init -q', { cwd: repoDir });
	return repoDir;
}

function createBareRemote(basedir: string, name: string): string {
	const remoteDir = join(basedir, name);
	mkdirSync(remoteDir, { recursive: true });
	execSync(`git init --bare -q`, { cwd: remoteDir });
	return remoteDir;
}

describe('getRemoteAheadBehind（只读同步差距诊断）', () => {
	afterEach(() => {
		mockSpawnSync.mockClear();
		mockSpawn.mockClear();
	});

	it('无 remote → null（静默，不报错）', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-rab1-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');

		const { getRemoteAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		expect(await getRemoteAheadBehind(repoDir, 'main')).toBeNull();

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('有 remote 但 branch 远端不存在（未 push）→ null', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-rab2-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		const remoteDir = createBareRemote(baseDir, 'origin');
		execSync(`git remote add origin file://${remoteDir}`, { cwd: repoDir });

		const { getRemoteAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		expect(await getRemoteAheadBehind(repoDir, 'main')).toBeNull();

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('本地领先远端（有未 push 提交）→ ahead=1', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-rab3-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		const remoteDir = createBareRemote(baseDir, 'origin');
		execSync(`git remote add origin file://${remoteDir}`, { cwd: repoDir });
		execSync(`git push -u origin main -q`, { cwd: repoDir });
		// 本地再提交 1 个（不 push）
		writeFileSync(join(repoDir, 'extra.txt'), 'extra\n');
		execSync('git add extra.txt && git commit -m extra -q', { cwd: repoDir });

		const { getRemoteAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		expect(await getRemoteAheadBehind(repoDir, 'main')).toEqual({ ahead: 1, behind: 0 });

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('远端领先本地（远端有新提交）→ behind=1', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-rab4-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		const remoteDir = createBareRemote(baseDir, 'origin');
		execSync(`git remote add origin file://${remoteDir}`, { cwd: repoDir });
		execSync(`git push -u origin main -q`, { cwd: repoDir });
		// 另一个 clone push 提交到 origin，使远端领先
		const otherDir = join(baseDir, 'other');
		execSync(`git clone file://${remoteDir} ${otherDir} -q`);
		writeFileSync(join(otherDir, 'remote.txt'), 'remote\n');
		execSync('git add remote.txt && git commit -m remote -q', { cwd: otherDir });
		execSync('git push origin main -q', { cwd: otherDir });

		const { getRemoteAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		expect(await getRemoteAheadBehind(repoDir, 'main')).toEqual({ ahead: 0, behind: 1 });

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('fetch 挂起（网络黑洞）→ 超时被 kill 后静默返回 null（异步，不阻塞）', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-rab5-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		const remoteDir = createBareRemote(baseDir, 'origin');
		execSync(`git remote add origin file://${remoteDir}`, { cwd: repoDir });
		execSync(`git push -u origin main -q`, { cwd: repoDir });

		const { getRemoteAheadBehind, REMOTE_FETCH_TIMEOUT_MS } = await import(
			resolve(EXT_LIB, 'git.ts')
		);

		// 默认超时用于网络 fetch 防挂起（本地优先：挂起时静默降级而非冻结 UI）
		expect(REMOTE_FETCH_TIMEOUT_MS).toBe(120_000);

		// 拦截 fetch：spawn 返回挂起的假 child（stdout/stderr 无数据、不触发 close），
		// kill() 时才异步触发 close(null)——模拟超时被 SIGKILL。
		// 通过 getRemoteAheadBehind 的 timeoutMs 参数传极小值（50ms）真实走超时路径，避免等 120s。
		mockSpawn.mockImplementation((cmd: string, args?: readonly string[], _opts?: any) => {
			if (cmd === 'git' && args?.[0] === 'fetch') {
				const child = new EventEmitter() as any;
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.kill = () => {
					setTimeout(() => child.emit('close', null), 0);
				};
				return child;
			}
			return realSpawn.current(cmd, args as string[], _opts);
		});

		expect(await getRemoteAheadBehind(repoDir, 'main', 50)).toBeNull();

		rmSync(baseDir, { recursive: true, force: true });
	});
});
