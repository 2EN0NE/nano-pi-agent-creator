/**
 * pi-worktree — merge 超时/拉取失败回滚测试
 *
 * 覆盖 execMerge/execRebaseFF 的 pull 失败与超时回滚编排（ADR-0024 核心安全网）：
 *   1. execMerge pull status!==0 → 回到原分支 + 恢复 stash（真实 git + 不可达 remote）
 *   2. execMerge pull timedOut → 返回 timedOut=true + 回滚 checkout 被调用（mock spawn）
 *   3. execRebaseFF 第一处 pull timedOut → 返回 timedOut=true（mock spawn）
 *
 * execRebaseFF 第二处 timedOut（rebase 成功后再次 pull）与第一处回滚代码逐字同构，
 * 且 rebase 冲突回滚已由 worktree.operations.test.ts 覆盖，此处不再重复构造。
 *
 * git 身份由 test/vitest/setup/git-ident.ts 通过环境变量注入（不写任何 git config）。
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认 spawn 转发真实实现；超时测试用 mockImplementation 只拦截 pull
vi.mock('node:child_process', async () => {
	const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
	return {
		...actual,
		spawn: vi.fn((cmd: string, args: string[], opts?: any) => actual.spawn(cmd, args, opts)),
	};
});

const mockSpawn = vi.mocked(spawn);

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_LIB = resolve(__dirname, '../../../extensions/meta/worktree/lib');

/** 立即以 status 0 关闭的 fake child（非 pull 的 runGit 命令） */
function makeImmediateChild(): any {
	const child: any = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	queueMicrotask(() => child.emit('close', 0));
	return child;
}

/** 挂起直到被 kill 才 close(null) 的 fake child（模拟 pull 超时） */
function makeHangingChild(): any {
	const child: any = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn(() => child.emit('close', null));
	return child;
}

function createGitRepo(basedir: string, name: string): string {
	const repoDir = join(basedir, name);
	mkdirSync(repoDir, { recursive: true });
	execSync('git init --initial-branch main -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`);
	execSync('git add README.md && git commit -m init -q', { cwd: repoDir });
	return repoDir;
}

afterEach(() => {
	mockSpawn.mockReset();
});

describe('worktree merge 超时与拉取失败回滚', () => {
	let baseDir: string;

	afterAll(() => {
		if (baseDir) rmSync(baseDir, { recursive: true, force: true });
	});

	it('execMerge pull 失败（status!==0）回滚：回到原分支 + 恢复 stash', async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-timeout-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');

		// tracked 文件（可被 stash 的 dirty）+ feature 分支
		writeFileSync(join(repoDir, 'tracked.txt'), 'clean\n');
		execSync('git add tracked.txt && git commit -m "add tracked" -q', { cwd: repoDir });
		execSync('git checkout -b feature/x -q', { cwd: repoDir });
		writeFileSync(join(repoDir, 'feat.txt'), 'feature\n');
		execSync('git add feat.txt && git commit -m feat -q', { cwd: repoDir });
		execSync('git checkout main -q', { cwd: repoDir });

		// 不可达 remote：file:// 指向不存在路径，pull 立即失败（不依赖网络）
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repoDir });
		// main 上制造 dirty（tracked 修改，execMerge 会 stash 再 pop）
		writeFileSync(join(repoDir, 'tracked.txt'), 'dirty modification\n');

		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = await execMerge(repoDir, 'feature/x', 'main');

		expect(result.ok).toBe(false);
		expect(result.message).toContain('Pull on');
		// 回滚到原分支 main
		const branch = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(branch).toBe('main');
		// dirty 改动被 stash pop 恢复（未丢失）
		expect(readFileSync(join(repoDir, 'tracked.txt'), 'utf-8')).toBe('dirty modification\n');
	});

	it('execMerge pull 超时：返回 timedOut=true 且回滚 checkout 被调用', async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-timeout2-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		execSync('git checkout -b feature/x -q', { cwd: repoDir });
		writeFileSync(join(repoDir, 'feat.txt'), 'feature\n');
		execSync('git add feat.txt && git commit -m feat -q', { cwd: repoDir });
		// 停在 feature 分支（origBranch=feature/x），加 remote
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repoDir });

		// 只拦截 pull 挂起，其余 runGit 命令立即 close(0)
		mockSpawn.mockImplementation(((cmd: string, args: string[]) => {
			if (cmd === 'git' && Array.isArray(args) && args.includes('pull')) {
				return makeHangingChild();
			}
			return makeImmediateChild();
		}) as any);

		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = await execMerge(repoDir, 'feature/x', 'main', 'merge', 100);

		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.message).toContain('timed out');

		// 回滚编排：checkout target(main) + checkout 回 origBranch(feature/x)
		const checkoutCalls = mockSpawn.mock.calls
			.filter(([cmd, args]) => cmd === 'git' && Array.isArray(args) && args[0] === 'checkout')
			.map(([, args]) => args as string[]);
		expect(checkoutCalls).toContainEqual(['checkout', 'main']);
		expect(checkoutCalls).toContainEqual(['checkout', 'feature/x']);
	});

	it('execRebaseFF 第一处 pull 超时：返回 timedOut=true', async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-timeout3-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		execSync('git checkout -b wt/x -q', { cwd: repoDir });
		writeFileSync(join(repoDir, 'feat.txt'), 'feature\n');
		execSync('git add feat.txt && git commit -m feat -q', { cwd: repoDir });
		execSync('git checkout main -q', { cwd: repoDir });

		const wtDir = join(baseDir, 'wt-x');
		execSync(`git worktree add ${wtDir} wt/x -q`, { cwd: repoDir });
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repoDir });

		mockSpawn.mockImplementation(((cmd: string, args: string[]) => {
			if (cmd === 'git' && Array.isArray(args) && args.includes('pull')) {
				return makeHangingChild();
			}
			return makeImmediateChild();
		}) as any);

		const { execRebaseFF } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = await execRebaseFF(repoDir, 'wt/x', 'main', wtDir, 100);

		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.message).toContain('timed out');
	});
});
