/**
 * pi-worktree — pullTargetLatest（用户主动「拉取最新」）测试
 *
 * 本地优先原则下唯一的远端同步入口（成功面板/失败面板「拉取最新」）。
 * 覆盖四条路径：
 *   1. 成功：checkout target → pull --ff-only → 回切原分支，本地分支前移到远端
 *   2. checkout target 失败（分支不存在）→ ok=false + error，仍在原分支
 *   3. pull 失败（origin 无该分支）→ ok=false + error，回切原分支（工作区无残留）
 *   4. 回切原分支失败 → ok=false + error 明确提示「当前停留在 target」
 *      （修复前回切失败被静默吞掉，用户仓库被留在错误分支且无提示）
 *
 * 远端用 file:// bare repo 模拟（离线、无网络依赖）。
 * git 身份由 test/vitest/setup/git-ident.ts 通过环境变量注入。
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 转发真实实现；仅「回切失败」用例用 mockImplementation 拦截 checkout 原分支
const { realSpawnSync } = vi.hoisted(() => ({
	realSpawnSync: {
		current: null as unknown as (typeof import('node:child_process'))['spawnSync'],
	},
}));
vi.mock('node:child_process', async () => {
	const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
	realSpawnSync.current = actual.spawnSync;
	return {
		...actual,
		spawnSync: vi.fn((cmd: string, args: string[], opts?: any) =>
			actual.spawnSync(cmd, args, opts),
		),
	};
});

const mockSpawnSync = vi.mocked(spawnSync);

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_LIB = resolve(__dirname, '../../../extensions/meta/worktree/lib');

const dirtyDirs: string[] = [];

function tmpBase(label: string): string {
	const base = resolve(tmpdir(), `pi-wt-pull-${label}-${Date.now()}`);
	mkdirSync(base, { recursive: true });
	dirtyDirs.push(base);
	return base;
}

function initRepo(baseDir: string, name = 'repo'): string {
	const repoDir = join(baseDir, name);
	mkdirSync(repoDir, { recursive: true });
	execSync('git init --initial-branch main -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`);
	execSync('git add README.md && git commit -m init -q', { cwd: repoDir });
	return repoDir;
}

/** 构造 main 落后 origin/main 的场景（origin 有本地没有的新提交） */
function setupRemoteAhead(baseDir: string): { repoDir: string; remoteDir: string } {
	const repoDir = initRepo(baseDir);
	const remoteDir = join(baseDir, 'origin.git');
	mkdirSync(remoteDir, { recursive: true });
	execSync(`git init --bare -q`, { cwd: remoteDir });
	execSync(`git remote add origin file://${remoteDir}`, { cwd: repoDir });
	execSync(`git push -u origin main -q`, { cwd: repoDir });
	// 另一个 clone push 新提交 → origin/main 前进，本地 main 落后
	const otherDir = join(baseDir, 'other');
	execSync(`git clone file://${remoteDir} ${otherDir} -q`);
	writeFileSync(join(otherDir, 'remote.txt'), 'remote\n');
	execSync('git add remote.txt && git commit -m remote -q', { cwd: otherDir });
	execSync('git push origin main -q', { cwd: otherDir });
	// 本地 fetch（只更新 remote-tracking ref，本地 main 仍落后）
	execSync('git fetch origin -q', { cwd: repoDir });
	return { repoDir, remoteDir };
}

afterEach(() => {
	mockSpawnSync.mockClear();
});
afterAll(() => {
	for (const d of dirtyDirs) rmSync(d, { recursive: true, force: true });
});

describe('pullTargetLatest（手动拉取 target 最新）', () => {
	it('成功：pull --ff-only 后本地分支前移到远端，并回切原分支', async () => {
		const baseDir = tmpBase('ok');
		const { repoDir } = setupRemoteAhead(baseDir);

		const { pullTargetLatest } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const res = await pullTargetLatest(repoDir, 'main');

		expect(res.ok).toBe(true);
		expect(res.error).toBe('');
		// 本地 main 已快进到 origin/main
		const local = execSync('git rev-parse main', { cwd: repoDir, encoding: 'utf-8' }).trim();
		const remote = execSync('git rev-parse origin/main', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(local).toBe(remote);
		// 回切原分支（main）
		const head = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(head).toBe('main');

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('checkout target 失败（分支不存在）→ ok=false + error，仍在原分支', async () => {
		const baseDir = tmpBase('no-checkout');
		const repoDir = initRepo(baseDir);

		const { pullTargetLatest } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const res = await pullTargetLatest(repoDir, 'nonexistent');

		expect(res.ok).toBe(false);
		expect(res.error).toContain('checkout nonexistent');
		const head = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(head).toBe('main');

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('pull 失败（origin 无该分支）→ ok=false + error，回切原分支且工作区无残留', async () => {
		const baseDir = tmpBase('pull-fail');
		const repoDir = initRepo(baseDir);
		const remoteDir = join(baseDir, 'origin.git');
		mkdirSync(remoteDir, { recursive: true });
		execSync(`git init --bare -q`, { cwd: remoteDir });
		execSync(`git remote add origin file://${remoteDir}`, { cwd: repoDir });
		execSync(`git push -u origin main -q`, { cwd: repoDir });
		// 本地分支 dev 从未 push（origin/dev 不存在 → pull 失败）
		execSync('git checkout -b dev -q', { cwd: repoDir });
		execSync('git checkout main -q', { cwd: repoDir });

		const { pullTargetLatest } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const res = await pullTargetLatest(repoDir, 'dev');

		expect(res.ok).toBe(false);
		expect(res.error.length).toBeGreaterThan(0);
		// 回切原分支 + 工作区干净（pull 失败后 checkout 回 main，无冲突残留）
		const head = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(head).toBe('main');
		const status = execSync('git status --porcelain', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(status).toBe('');

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('回切原分支失败 → ok=false + error 明确提示当前停留分支（不静默）', async () => {
		const baseDir = tmpBase('back-fail');
		const repoDir = initRepo(baseDir);

		// 拦截：checkout target（dev）成功、pull 成功、checkout 回 main 失败
		mockSpawnSync.mockImplementation((cmd: string, args?: readonly string[], opts?: any) => {
			if (cmd === 'git' && args?.[0] === 'checkout' && args[1] === 'main') {
				return {
					pid: 0,
					output: [],
					stdout: '',
					stderr: '',
					status: 1,
					signal: null,
				};
			}
			if (cmd === 'git' && (args?.[0] === 'checkout' || args?.[0] === 'pull')) {
				return {
					pid: 0,
					output: [],
					stdout: '',
					stderr: '',
					status: 0,
					signal: null,
				};
			}
			return realSpawnSync.current(cmd, args, opts);
		});

		const { pullTargetLatest } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const res = await pullTargetLatest(repoDir, 'dev');

		// 回切失败不再被静默：ok=false 且 error 说明停留分支
		expect(res.ok).toBe(false);
		expect(res.error).toContain('切换回 main 失败');
		expect(res.error).toContain('当前停留在 dev');

		rmSync(baseDir, { recursive: true, force: true });
	});
});
