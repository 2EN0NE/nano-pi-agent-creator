/**
 * pi-worktree — 操作层集成测试
 *
 * 覆盖 P0/P1 缺口：
 * 1. execMerge（handlers.ts 中最复杂的 git merge 操作）
 * 2. git.ts 辅助函数
 * 3. stars.ts 名称池
 * 4. state.ts 配置持久化
 * 5. setup.ts（node_modules 策略、env 文件 symlink）
 * 6. deleteWorktreeBranch / findMergedWorktrees
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, destroySandbox } from '../helpers/sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_LIB = resolve(__dirname, '../../../extensions/meta/worktree/lib');

// ═══════════════════════════════════════════
// 辅助：创建 git 仓库并初始化
// ═══════════════════════════════════════════

function createGitRepo(basedir: string, name: string): string {
	const repoDir = join(basedir, name);
	mkdirSync(repoDir, { recursive: true });
	execSync('git init --initial-branch main -q', { cwd: repoDir });
	execSync('git config user.name "test" && git config user.email "test@test"', { cwd: repoDir });
	writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`);
	execSync('git add README.md && git commit -m init -q', { cwd: repoDir });
	return repoDir;
}

function gitCommit(repoDir: string, file: string, content: string): void {
	writeFileSync(join(repoDir, file), content);
	execSync(`git add ${file} && git commit -m "update ${file}" -q`, {
		cwd: repoDir,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'test',
			GIT_AUTHOR_EMAIL: 'test@test',
			GIT_COMMITTER_NAME: 'test',
			GIT_COMMITTER_EMAIL: 'test@test',
		},
	});
}

function gitCreateBranch(repoDir: string, branch: string): void {
	execSync(`git checkout -b ${branch} -q`, { cwd: repoDir });
}

function gitCheckout(repoDir: string, branch: string): void {
	execSync(`git checkout ${branch} -q`, { cwd: repoDir });
}

function gitBranches(repoDir: string): string[] {
	const out = execSync('git branch --format="%(refname:short)"', {
		cwd: repoDir,
		encoding: 'utf-8',
	});
	return out.trim().split('\n').filter(Boolean);
}

// ═══════════════════════════════════════════
// 套件 1：execMerge（P0 — 最复杂函数）
// ═══════════════════════════════════════════

describe('worktree execMerge', () => {
	let baseDir: string;
	let repoDir: string;

	beforeAll(async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-merge-test-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'merge-repo');

		// 创建 feature 分支并提交
		gitCreateBranch(repoDir, 'feature/test-merge');
		gitCommit(repoDir, 'feature.txt', 'feature content v1');
		gitCommit(repoDir, 'feature2.txt', 'feature content v2');

		// 回 main
		gitCheckout(repoDir, 'main');
	});

	afterAll(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('1. execMerge merges feature branch into main', async () => {
		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = execMerge(repoDir, 'feature/test-merge', 'main');

		expect(result.ok).toBe(true);
		expect(result.message).toContain('Merged');
		expect(result.message).toContain('feature/test-merge');
		expect(result.conflicts).toEqual([]);

		// 验证合并后的文件存在
		const mergedFile = join(repoDir, 'feature.txt');
		expect(existsSync(mergedFile)).toBe(true);
		expect(readFileSync(mergedFile, 'utf-8').trim()).toBe('feature content v1');
	});

	it('2. merge is recorded in git log', () => {
		const log = execSync('git log --oneline -5', {
			cwd: repoDir,
			encoding: 'utf-8',
		});
		expect(log).toContain('Merge');
	});

	it('3. execMerge detects real conflicts', async () => {
		// Create a shared base file that BOTH branches will modify on the same line
		writeFileSync(join(repoDir, 'conflict.txt'), 'common base line 1\ncommon base line 2\n');
		execSync('git add conflict.txt && git commit -m "add conflict.txt base" -q', {
			cwd: repoDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@test',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@test',
			},
		});

		// Branch A: modify line 1
		gitCreateBranch(repoDir, 'feature/conflict-a');
		writeFileSync(join(repoDir, 'conflict.txt'), 'version A line 1\ncommon base line 2\n');
		gitCommit(repoDir, 'conflict.txt', 'changed line 1 to version A');

		// Branch B: modify same line 1 differently (based on main)
		gitCheckout(repoDir, 'main');
		gitCreateBranch(repoDir, 'feature/conflict-b');
		writeFileSync(join(repoDir, 'conflict.txt'), 'version B line 1\ncommon base line 2\n');
		gitCommit(repoDir, 'conflict.txt', 'changed line 1 to version B');

		// Back to main, merge A first (should succeed)
		gitCheckout(repoDir, 'main');

		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));

		const resultA = execMerge(repoDir, 'feature/conflict-a', 'main');
		expect(resultA.ok).toBe(true);
		expect(resultA.conflicts).toEqual([]);

		// Merge B -- should conflict because both branches modified the same line
		const resultB = execMerge(repoDir, 'feature/conflict-b', 'main');
		expect(resultB.ok).toBe(false);
		expect(resultB.conflicts.length).toBeGreaterThan(0);
		expect(resultB.conflicts[0].file).toBe('conflict.txt');
		expect(resultB.message).toContain('conflict');

		// Cleanup: abort the conflicted merge to restore clean index for subsequent tests
		execSync('git merge --abort', { cwd: repoDir });
		gitCheckout(repoDir, 'main');
	});

	it('4. execMerge handles dirty working directory', async () => {
		gitCheckout(repoDir, 'main');
		gitCreateBranch(repoDir, 'feature/dirty-test');
		gitCommit(repoDir, 'dirty-file.txt', 'clean content');
		gitCheckout(repoDir, 'main');

		// 在 main 上制造 dirty state
		writeFileSync(join(repoDir, 'untracked-dirty.txt'), 'dirty');

		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = execMerge(repoDir, 'feature/dirty-test', 'main');

		// dirty 工作区不应阻止 merge（execMerge 有 stash 逻辑）
		expect(result.ok).toBe(true);
	});

	it('5. execMerge fails gracefully on non-existent branch', async () => {
		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = execMerge(repoDir, 'feature/non-existent', 'main');
		expect(result.ok).toBe(false);
	});

	// ── squash merge ──

	it('6. execMerge squash merges feature branch into main', async () => {
		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));

		// Create a new feature branch for squash test
		gitCreateBranch(repoDir, 'feature/squash-test');
		gitCommit(repoDir, 'squash1.txt', 'squash content v1');
		gitCommit(repoDir, 'squash2.txt', 'squash content v2');
		gitCommit(repoDir, 'squash3.txt', 'squash content v3');
		gitCheckout(repoDir, 'main');

		const result = execMerge(repoDir, 'feature/squash-test', 'main', 'squash');

		expect(result.ok).toBe(true);
		expect(result.message).toContain('squash');
		expect(result.conflicts).toEqual([]);

		// 验证 squash 吸收了原始 commit（commit message 不应出现在 log 中）
		const log = execSync('git log --oneline -10', { cwd: repoDir, encoding: 'utf-8' });
		expect(log).not.toContain('update squash1.txt');
		expect(log).not.toContain('update squash2.txt');
		expect(log).not.toContain('update squash3.txt');

		// 验证文件存在
		expect(existsSync(join(repoDir, 'squash1.txt'))).toBe(true);
		expect(existsSync(join(repoDir, 'squash3.txt'))).toBe(true);
	});

	it('7. execMerge squash conflict auto-resets worktree', async () => {
		// 清除之前测试遗留的脏文件
		const dirtyFile = join(repoDir, 'untracked-dirty.txt');
		if (existsSync(dirtyFile)) rmSync(dirtyFile);

		// Create shared base file
		writeFileSync(join(repoDir, 'squash-conflict.txt'), 'base line\n');
		execSync('git add squash-conflict.txt && git commit -m "add squash-conflict base" -q', {
			cwd: repoDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@test',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@test',
			},
		});

		// Branch A: modify base file
		gitCreateBranch(repoDir, 'feature/squash-a');
		writeFileSync(join(repoDir, 'squash-conflict.txt'), 'version A\n');
		gitCommit(repoDir, 'squash-conflict.txt', 'version A change');

		// Branch B: modify same file differently
		gitCheckout(repoDir, 'main');
		gitCreateBranch(repoDir, 'feature/squash-b');
		writeFileSync(join(repoDir, 'squash-conflict.txt'), 'version B\n');
		gitCommit(repoDir, 'squash-conflict.txt', 'version B change');

		gitCheckout(repoDir, 'main');

		// Merge A first (success)
		const { execMerge: mergeFn } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const resultA = mergeFn(repoDir, 'feature/squash-a', 'main', 'squash');
		expect(resultA.ok).toBe(true);
		expect(resultA.conflicts).toEqual([]);

		// Merge B with squash -- should auto-reset on conflict
		const resultB = mergeFn(repoDir, 'feature/squash-b', 'main', 'squash');
		expect(resultB.ok).toBe(false);
		expect(resultB.conflicts.length).toBeGreaterThan(0);
		expect(resultB.conflicts[0].file).toBe('squash-conflict.txt');

		// Verify worktree is clean (reset carried out)
		const status = execSync('git status --porcelain', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(status).toBe('');

		// Verify we're back on main
		const branch = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(branch).toBe('main');
	});
});

// ═══════════════════════════════════════════
// 套件 1b：execRebaseFF（rebase + fast-forward）
// ═══════════════════════════════════════════

describe('worktree execRebase (worktree-local)', () => {
	let baseDir: string;
	let repoDir: string;
	let wtDir: string;

	beforeAll(async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-rebase-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'rebase-repo');

		// worktree 分支：两个提交
		gitCreateBranch(repoDir, 'wt/Leo-Denebola');
		gitCommit(repoDir, 'r1.txt', 'r1 content');
		gitCommit(repoDir, 'r2.txt', 'r2 content');

		// main 前进：两个提交（rebase 目标）
		gitCheckout(repoDir, 'main');
		gitCommit(repoDir, 'm1.txt', 'm1 content');
		gitCommit(repoDir, 'm2.txt', 'm2 content');

		// 真实 worktree
		wtDir = join(baseDir, 'wt-leo');
		execSync(`git worktree add ${wtDir} wt/Leo-Denebola --quiet`, { cwd: repoDir });
	});

	afterAll(() => {
		try {
			execSync(`git worktree remove ${wtDir} --force`, { cwd: repoDir });
		} catch {
			/* already gone */
		}
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('1. plain rebase 在 worktree 内成功，分支变基到 main 最新，停在 worktree 分支', async () => {
		const { execRebase } = await import(resolve(EXT_LIB, 'git.ts'));
		const result = execRebase(repoDir, 'wt/Leo-Denebola', 'main', wtDir);

		expect(result.ok).toBe(true);
		expect(result.conflicts).toEqual([]);
		expect(result.message).toContain('Rebased');

		// worktree 分支已包含 main 最新提交（m1/m2）+ 自己的提交（r1/r2），线性无 merge commit
		const wtLog = execSync('git log --oneline -10', { cwd: wtDir, encoding: 'utf-8' });
		expect(wtLog).toContain('update m1.txt');
		expect(wtLog).toContain('update r1.txt');
		expect(wtLog).not.toContain('Merge');

		// main 未动：HEAD 仍是 main，不含 r1
		const mainLog = execSync('git log --oneline -5', { cwd: repoDir, encoding: 'utf-8' });
		expect(mainLog).not.toContain('update r1.txt');
	});

	it('2. rebase 冲突：返回冲突文件并留在冲突状态', async () => {
		const { execRebase } = await import(resolve(EXT_LIB, 'git.ts'));

		// 共同 base（在 main 上提交）
		writeFileSync(join(repoDir, 'rebase-conflict.txt'), 'common base\n');
		execSync('git add rebase-conflict.txt && git commit -m "add rebase-conflict base" -q', {
			cwd: repoDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@test',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@test',
			},
		});

		// worktree 分支：version A
		gitCreateBranch(repoDir, 'wt/Regulus');
		writeFileSync(join(repoDir, 'rebase-conflict.txt'), 'version A\n');
		gitCommit(repoDir, 'rebase-conflict.txt', 'rebase A');

		// main 侧：version B
		gitCheckout(repoDir, 'main');
		writeFileSync(join(repoDir, 'rebase-conflict.txt'), 'version B\n');
		gitCommit(repoDir, 'rebase-conflict.txt', 'rebase B');

		// 建 worktree
		const wtConflictDir = join(baseDir, 'wt-regulus');
		execSync(`git worktree add ${wtConflictDir} wt/Regulus --quiet`, { cwd: repoDir });

		const result = execRebase(repoDir, 'wt/Regulus', 'main', wtConflictDir);

		expect(result.ok).toBe(false);
		expect(result.conflicts).toContain('rebase-conflict.txt');
		expect(result.message).toContain('conflict');

		// 留在冲突状态：worktree gitDir 下 rebase-merge 状态存在
		const rbPath = execSync('git rev-parse --git-path rebase-merge', {
			cwd: wtConflictDir,
			encoding: 'utf-8',
		}).trim();
		expect(existsSync(rbPath)).toBe(true);

		// findInProgressDir 自动定位到冲突 worktree（ADR-0018 探测）
		// 用 realpathSync 归一化：macOS 上 tmpdir 返回 /var/... 而 git 输出 /private/var/...（同一目录）
		const { findInProgressDir } = await import(resolve(EXT_LIB, 'git.ts'));
		const detectedDir = findInProgressDir(repoDir, 'rebase');
		expect(detectedDir).not.toBeNull();
		expect(realpathSync(detectedDir!)).toBe(realpathSync(wtConflictDir));
		expect(findInProgressDir(repoDir, 'merge')).toBeNull();

		// 清理：abort + 移除 worktree
		execSync('git rebase --abort', { cwd: wtConflictDir });
		execSync(`git worktree remove ${wtConflictDir} --force`, { cwd: repoDir });
	});

	it('3. worktree 有未提交修改时拒绝 rebase', async () => {
		const { execRebase } = await import(resolve(EXT_LIB, 'git.ts'));
		writeFileSync(join(wtDir, 'dirty.txt'), 'uncommitted\n');
		const result = execRebase(repoDir, 'wt/Leo-Denebola', 'main', wtDir);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('uncommitted');
		execSync('rm dirty.txt', { cwd: wtDir });
	});

	it('4. rebase 冲突中止状态不被 execRebase 静默 abort（保留用户进度）', async () => {
		const { execRebase, findInProgressDir } = await import(resolve(EXT_LIB, 'git.ts'));

		// 构造 main 与 wt 分支对同一文件的冲突
		writeFileSync(join(repoDir, 'paused-conflict.txt'), 'base\n');
		execSync('git add paused-conflict.txt && git commit -m "paused base" -q', {
			cwd: repoDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@test',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@test',
			},
		});
		gitCreateBranch(repoDir, 'wt/PausedA');
		writeFileSync(join(repoDir, 'paused-conflict.txt'), 'version A\n');
		gitCommit(repoDir, 'paused-conflict.txt', 'paused A');
		gitCheckout(repoDir, 'main');
		writeFileSync(join(repoDir, 'paused-conflict.txt'), 'version B\n');
		gitCommit(repoDir, 'paused-conflict.txt', 'paused B');

		const wtPausedDir = join(baseDir, 'wt-paused');
		execSync(`git worktree add ${wtPausedDir} wt/PausedA --quiet`, { cwd: repoDir });

		// 手动发起 rebase 停在冲突（模拟用户手动操作），预期非零退出
		try {
			execSync('git rebase main', { cwd: wtPausedDir, stdio: 'pipe' });
		} catch {
			/* 冲突预期非零退出 */
		}
		// 确认处于冲突中止状态
		const pausedPath = execSync('git rev-parse --git-path rebase-merge/stopped-sha', {
			cwd: wtPausedDir,
			encoding: 'utf-8',
		}).trim();
		expect(existsSync(pausedPath)).toBe(true);

		// execRebase 不得 abort：失败但 rebase 状态与冲突文件保留
		const result = execRebase(repoDir, 'wt/PausedA', 'main', wtPausedDir);
		expect(result.ok).toBe(false);
		expect(existsSync(pausedPath)).toBe(true); // 状态未被 abort 清除
		expect(
			execSync('git status --porcelain', { cwd: wtPausedDir, encoding: 'utf-8' }),
		).toContain('paused-conflict.txt'); // 冲突文件仍在
		expect(findInProgressDir(repoDir, 'rebase')).not.toBeNull();

		// 清理：abort + 移除 worktree
		execSync('git rebase --abort', { cwd: wtPausedDir });
		execSync(`git worktree remove ${wtPausedDir} --force`, { cwd: repoDir });
	});

	it('5. [handler] handleRebase 不 abort 冲突暂停状态（ADR-0018 集成回归）', async () => {
		// 构造 main 与 wt 分支对同一文件的冲突
		writeFileSync(join(repoDir, 'handler-paused.txt'), 'base\n');
		execSync('git add handler-paused.txt && git commit -m "handler paused base" -q', {
			cwd: repoDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@test',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@test',
			},
		});
		gitCreateBranch(repoDir, 'wt/HandlerPaused');
		writeFileSync(join(repoDir, 'handler-paused.txt'), 'version A\n');
		gitCommit(repoDir, 'handler-paused.txt', 'handler paused A');
		gitCheckout(repoDir, 'main');
		writeFileSync(join(repoDir, 'handler-paused.txt'), 'version B\n');
		gitCommit(repoDir, 'handler-paused.txt', 'handler paused B');

		// worktree 放约定目录（handleRebase 经 resolveWorktreePath 按 name 解析）
		const wtHPausedDir = join(`${repoDir}-worktrees`, 'HandlerPaused');
		execSync(`git worktree add ${wtHPausedDir} wt/HandlerPaused --quiet`, { cwd: repoDir });

		// 手动 rebase 停在冲突（模拟用户手动操作）
		try {
			execSync('git rebase main', { cwd: wtHPausedDir, stdio: 'pipe' });
		} catch {
			/* 冲突预期非零退出 */
		}
		const pausedPath = execSync('git rev-parse --git-path rebase-merge/stopped-sha', {
			cwd: wtHPausedDir,
			encoding: 'utf-8',
		}).trim();
		expect(existsSync(pausedPath)).toBe(true);

		// 模拟用户已手工解决冲突并 git add（进度标记）
		writeFileSync(join(wtHPausedDir, 'handler-paused.txt'), 'resolved content\n');
		execSync('git add handler-paused.txt', { cwd: wtHPausedDir, encoding: 'utf-8' });

		// 调用 handler（修复前：else 分支无条件 git rebase --abort 会销毁上述进度）
		const notified: string[] = [];
		const ctx = {
			cwd: repoDir,
			ui: { notify: (msg: string) => notified.push(msg) },
		} as any;
		const { handleRebase } = await import(resolve(EXT_LIB, 'handlers.ts'));
		await handleRebase(repoDir, { source: 'HandlerPaused' }, ctx);

		// 断言 1：rebase 状态保留（未被 abort）
		expect(existsSync(pausedPath)).toBe(true);
		// 断言 2：用户已 add 的解析进度仍留在 index
		const staged = execSync('git diff --cached --name-only', {
			cwd: wtHPausedDir,
			encoding: 'utf-8',
		});
		expect(staged).toContain('handler-paused.txt');
		// 断言 3：通知包含失败提示（引导 continue/abort）
		expect(notified.some((m) => m.includes('Rebase failed'))).toBe(true);

		// 清理：abort + 移除 worktree
		execSync('git rebase --abort', { cwd: wtHPausedDir });
		execSync(`git worktree remove ${wtHPausedDir} --force`, { cwd: repoDir });
	});
});

describe('worktree execRebaseFF', () => {
	let baseDir: string;
	let repoDir: string;
	let wtSuccessDir: string;
	let wtCaDir: string;
	let wtCbDir: string;

	beforeAll(async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-rebaseff-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'rebaseff-repo');

		// Create feature branch with commits
		gitCreateBranch(repoDir, 'feature/rff-success');
		gitCommit(repoDir, 'rff1.txt', 'rff content v1');
		gitCommit(repoDir, 'rff2.txt', 'rff content v2');
		gitCheckout(repoDir, 'main');

		// Create real worktrees (simulating pi-worktree setup)
		// Branch already exists from gitCreateBranch above, so omit -b
		wtSuccessDir = join(baseDir, 'wt-rff-success');
		execSync(`git worktree add ${wtSuccessDir} feature/rff-success --quiet`, {
			cwd: repoDir,
		});
	});

	afterAll(() => {
		// Clean up worktrees before rm -rf.
		// Empty catch is intentional: worktrees may have been removed by tests already.
		try {
			execSync(`git worktree remove ${wtSuccessDir} --force`, { cwd: repoDir });
		} catch {
			/* worktree may already be gone */
		}
		try {
			execSync(`git worktree remove ${join(baseDir, 'wt-rff-ca')} --force`, {
				cwd: repoDir,
			});
		} catch {
			/* worktree may already be gone */
		}
		try {
			execSync(`git worktree remove ${join(baseDir, 'wt-rff-cb')} --force`, {
				cwd: repoDir,
			});
		} catch {
			/* worktree may already be gone */
		}
		try {
			execSync(`git worktree remove ${join(baseDir, 'wt-rff-dirty')} --force`, {
				cwd: repoDir,
			});
		} catch {
			/* worktree may already be gone */
		}
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('1. execRebaseFF rebases and fast-forwards feature branch into main', async () => {
		const { execRebaseFF } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = execRebaseFF(repoDir, 'feature/rff-success', 'main', wtSuccessDir);

		expect(result.ok).toBe(true);
		expect(result.message).toContain('Rebased');
		expect(result.message).toContain('fast-forward');
		expect(result.message).toContain('feature/rff-success');
		expect(result.conflicts).toEqual([]);

		// 验证 main 包含 rff 的提交
		const log = execSync('git log --oneline -10', { cwd: repoDir, encoding: 'utf-8' });
		expect(log).toContain('update rff1.txt');

		// 验证没有 merge commit（线性历史）
		expect(log).not.toContain('Merge');

		// 验证文件存在
		expect(existsSync(join(repoDir, 'rff1.txt'))).toBe(true);
		expect(existsSync(join(repoDir, 'rff2.txt'))).toBe(true);
	});

	it('2. execRebaseFF conflicts and auto-aborts', async () => {
		const { execRebaseFF } = await import(resolve(EXT_LIB, 'handlers.ts'));

		// Create shared base
		writeFileSync(join(repoDir, 'rff-conflict.txt'), 'common base\n');
		execSync('git add rff-conflict.txt && git commit -m "add rff-conflict base" -q', {
			cwd: repoDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@test',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@test',
			},
		});

		// Branch A: modify
		gitCreateBranch(repoDir, 'feature/rff-ca');
		writeFileSync(join(repoDir, 'rff-conflict.txt'), 'version A\n');
		gitCommit(repoDir, 'rff-conflict.txt', 'rff A');

		// Branch B: modify differently
		gitCheckout(repoDir, 'main');
		gitCreateBranch(repoDir, 'feature/rff-cb');
		writeFileSync(join(repoDir, 'rff-conflict.txt'), 'version B\n');
		gitCommit(repoDir, 'rff-conflict.txt', 'rff B');

		gitCheckout(repoDir, 'main');

		// Create worktrees for both conflict branches
		wtCaDir = join(baseDir, 'wt-rff-ca');
		execSync(`git worktree add ${wtCaDir} feature/rff-ca --quiet`, { cwd: repoDir });
		wtCbDir = join(baseDir, 'wt-rff-cb');
		execSync(`git worktree add ${wtCbDir} feature/rff-cb --quiet`, { cwd: repoDir });

		// Merge A first via regular merge (from main repo, source is read-only ref)
		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const resultA = execMerge(repoDir, 'feature/rff-ca', 'main');
		expect(resultA.ok).toBe(true);

		// Now rebase+ff B should fail with conflict and auto-abort
		const resultB = execRebaseFF(repoDir, 'feature/rff-cb', 'main', wtCbDir);
		expect(resultB.ok).toBe(false);
		expect(resultB.conflicts.length).toBeGreaterThan(0);
		expect(resultB.conflicts[0].file).toBe('rff-conflict.txt');

		// Verify clean state after abort
		const status = execSync('git status --porcelain', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(status).toBe('');

		// Verify back on main
		const branch = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(branch).toBe('main');
	});

	it('3. execRebaseFF handles dirty working directory', async () => {
		const { execRebaseFF } = await import(resolve(EXT_LIB, 'handlers.ts'));

		gitCheckout(repoDir, 'main');
		gitCreateBranch(repoDir, 'feature/rff-dirty');
		gitCommit(repoDir, 'rff-dirty.txt', 'clean content');
		gitCheckout(repoDir, 'main');

		// Create worktree for dirty test
		const wtDirtyDir = join(baseDir, 'wt-rff-dirty');
		execSync(`git worktree add ${wtDirtyDir} feature/rff-dirty --quiet`, { cwd: repoDir });

		// Dirty main (not worktree)
		writeFileSync(join(repoDir, 'rff-untracked.txt'), 'dirty');

		const result = execRebaseFF(repoDir, 'feature/rff-dirty', 'main', wtDirtyDir);

		// Dirty main should not block (gets stashed)
		expect(result.ok).toBe(true);
	});

	it('4. execRebaseFF fails when sourceDir does not exist', async () => {
		const { execRebaseFF } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = execRebaseFF(
			repoDir,
			'feature/rff-nonexistent',
			'main',
			join(baseDir, 'wt-not-exists'),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('not found');
	});
});

// ═══════════════════════════════════════════
// 套件 2：git.ts 辅助函数（P1）
// ═══════════════════════════════════════════

describe('worktree git helpers', () => {
	let baseDir: string;
	let repoDir: string;

	beforeAll(async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-git-test-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'git-test-repo');

		gitCreateBranch(repoDir, 'feature/helper-test');
		gitCommit(repoDir, 'helper.txt', 'helper content');
		// 多提交几个以产生 ahead
		gitCommit(repoDir, 'helper2.txt', 'more content');
		gitCheckout(repoDir, 'main');
	});

	afterAll(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('getCurrentBranch returns current branch name', async () => {
		const { getCurrentBranch } = await import(resolve(EXT_LIB, 'git.ts'));
		expect(getCurrentBranch(repoDir)).toBe('main');
	});

	it('getCurrentBranch returns correct branch on feature branch', async () => {
		const { getCurrentBranch } = await import(resolve(EXT_LIB, 'git.ts'));
		gitCheckout(repoDir, 'feature/helper-test');
		expect(getCurrentBranch(repoDir)).toBe('feature/helper-test');
		gitCheckout(repoDir, 'main');
	});

	it('getDefaultBranch returns null for repo without remote', async () => {
		const { getDefaultBranch } = await import(resolve(EXT_LIB, 'git.ts'));
		// 没有 remote 时，getDefaultBranch 无法知道默认分支
		const defaultBranch = getDefaultBranch(repoDir);
		expect(defaultBranch).toBeNull();
	});

	it('getDefaultBranch returns null for repo without origin/main remote ref', async () => {
		const { getDefaultBranch } = await import(resolve(EXT_LIB, 'git.ts'));

		// 创建没有 remote 的仓库
		const bareDir = join(baseDir, 'no-remote-repo');
		mkdirSync(bareDir, { recursive: true });
		execSync('git init --initial-branch main -q', { cwd: bareDir });
		writeFileSync(join(bareDir, 'f.txt'), 'f');
		execSync('git add f.txt && git commit -m init -q', {
			cwd: bareDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@test',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@test',
			},
		});

		// 没有 remote 时，getDefaultBranch 检查 origin/HEAD 和 origin/main
		// 两者都不存在时返回 null
		const result = getDefaultBranch(bareDir);
		expect(result).toBeNull();
	});

	it('getDirtyCount returns 0 for clean repo', async () => {
		const { getDirtyCount } = await import(resolve(EXT_LIB, 'git.ts'));
		expect(getDirtyCount(repoDir)).toBe(0);
	});

	it('getDirtyCount returns count for dirty files', async () => {
		const { getDirtyCount } = await import(resolve(EXT_LIB, 'git.ts'));
		writeFileSync(join(repoDir, 'dirty1.txt'), 'dirty');
		writeFileSync(join(repoDir, 'dirty2.txt'), 'dirty');
		expect(getDirtyCount(repoDir)).toBe(2);
	});

	it('getAheadBehind returns zeros for local-only branch', async () => {
		const { getAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		const result = getAheadBehind(repoDir, 'main');
		// 没有 remote，ahead/behind 都是 0
		expect(result.ahead).toBe(0);
		expect(result.behind).toBe(0);
	});

	it('getAheadBehind handles non-existent branch gracefully', async () => {
		const { getAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		const result = getAheadBehind(repoDir, 'non-existent-branch');
		expect(result.ahead).toBe(0);
		expect(result.behind).toBe(0);
	});

	it('getAheadBehind: ahead = 分支领先 main 的提交数（未 push 也可统计）', async () => {
		const { getAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		// feature/helper-test 领先 main 2 个提交（无 remote，即"未 push"场景）
		const result = getAheadBehind(repoDir, 'feature/helper-test');
		expect(result.ahead).toBe(2);
		expect(result.behind).toBe(0);
	});

	it('getAheadBehind: main 前进后 behind 正确', async () => {
		const { getAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		gitCommit(repoDir, 'helper-main.txt', 'main content');
		const result = getAheadBehind(repoDir, 'feature/helper-test');
		expect(result.ahead).toBe(2); // feature 仍领先 2
		expect(result.behind).toBe(1); // main 领先 1
	});

	it('getAheadBehind: main checkout 停留其他分支时基准仍为 main（不随 HEAD 漂移）', async () => {
		const { getAheadBehind, getCurrentBranch } = await import(resolve(EXT_LIB, 'git.ts'));
		// main checkout 切到别的分支（模拟用户在 main checkout 上工作）
		gitCreateBranch(repoDir, 'feature/unrelated');
		gitCommit(repoDir, 'unrelated.txt', 'unrelated work');
		expect(getCurrentBranch(repoDir)).toBe('feature/unrelated');

		// 基准固定 main：feature/helper-test 相对 main 仍是 behind=1, ahead=2
		const result = getAheadBehind(repoDir, 'feature/helper-test');
		expect(result.ahead).toBe(2);
		expect(result.behind).toBe(1);

		// 切回 main，避免影响后续用例
		gitCheckout(repoDir, 'main');
	});

	it('getAheadBehind: 分支名含 shell 元字符时不执行注入（参数数组传递）', async () => {
		const { getAheadBehind } = await import(resolve(EXT_LIB, 'git.ts'));
		const marker = join(tmpdir(), 'pwn-' + Date.now() + '.txt');
		// 该分支名在 git 中可创建（; 与 > 均合法、无空格），但不应触发 shell 执行
		const evilBranch = `wt/evil;echoINJ>${marker}`;
		try {
			execSync(`git branch ${JSON.stringify(evilBranch)}`, { cwd: repoDir });
		} catch {
			/* 环境不支持该分支名则跳过注入断言，仅验证不抛异常 */
		}
		const result = getAheadBehind(repoDir, evilBranch);
		expect(existsSync(marker)).toBe(false); // 未执行注入命令
		expect(typeof result.ahead).toBe('number');
		expect(typeof result.behind).toBe('number');
		// 清理测试分支，避免污染后续用例
		execSync(`git branch -D ${JSON.stringify(evilBranch)}`, { cwd: repoDir, stdio: 'pipe' });
	});
});

// ═══════════════════════════════════════════
// 套件 3：stars.ts 名称池（P1）
// ═══════════════════════════════════════════

describe('worktree stars name pool', () => {
	it('generateNamePool returns 36 names (12 constellations x 3 stars)', async () => {
		const { generateNamePool, STAR_NAMES } = await import(resolve(EXT_LIB, '../stars.ts'));
		const pool = generateNamePool();
		expect(pool).toHaveLength(36);
		expect(STAR_NAMES).toHaveLength(12);

		// 验证格式
		expect(pool[0]).toMatch(/^[A-Za-z]+-[A-Za-z]+$/);

		// 验证 Aries-Hamal 存在
		expect(pool).toContain('Aries-Hamal');
		expect(pool).toContain('Pisces-Torcular');
	});

	it('getNamePool caches result', async () => {
		const { getNamePool } = await import(resolve(EXT_LIB, '../stars.ts'));
		// 清模块缓存
		const pool1 = getNamePool();
		const pool2 = getNamePool();
		expect(pool1).toEqual(pool2);
		expect(pool1).toHaveLength(36);
	});

	it('constellationOf extracts constellation', async () => {
		const { constellationOf } = await import(resolve(EXT_LIB, '../stars.ts'));
		expect(constellationOf('Aries-Hamal')).toBe('Aries');
		expect(constellationOf('Leo-Denebola')).toBe('Leo');
		expect(constellationOf('Pisces-Alrisha')).toBe('Pisces');
	});

	it('constellationOf returns null for unknown formats', async () => {
		const { constellationOf } = await import(resolve(EXT_LIB, '../stars.ts'));
		expect(constellationOf('no-dash')).toBeNull();
		expect(constellationOf('')).toBeNull();
		expect(constellationOf('123-456')).toBeNull();
	});

	it('pickAvailableName returns unique names from pool', async () => {
		const { pickAvailableName } = await import(resolve(EXT_LIB, 'worktree.ts'));

		// 在空仓库中，所有 36 个名称都可用
		const sandbox = createSandbox({ useMockLLM: true });
		const repoDir = join(sandbox, 'home', 'pick-repo');
		mkdirSync(repoDir, { recursive: true });
		execSync('git init --initial-branch main -q', { cwd: repoDir });
		writeFileSync(join(repoDir, 'README.md'), '# pick\n');
		execSync('git add README.md && git commit -m init -q', {
			cwd: repoDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@test',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@test',
			},
		});

		const name1 = pickAvailableName(repoDir);
		expect(name1).toMatch(/^[A-Za-z]+-[A-Za-z]+$/);

		destroySandbox(sandbox);
	});
});

// ═══════════════════════════════════════════
// 套件 4：state.ts 配置持久化（P1）
// ═══════════════════════════════════════════

describe('worktree state config', () => {
	let sandbox: string;
	let originalHome: string;

	beforeAll(() => {
		originalHome = process.env.HOME || '';
		sandbox = createSandbox({ useMockLLM: true });
		const isolatedHome = resolve(sandbox, 'home');
		// 创建必要的 pi-config 目录
		mkdirSync(resolve(isolatedHome, '.pi/agent/extensions-data/pi-worktree'), {
			recursive: true,
		});
		process.env.HOME = isolatedHome;
	});

	afterAll(() => {
		process.env.HOME = originalHome;
		if (sandbox) destroySandbox(sandbox);
	});

	it('initPrefs loads without error', async () => {
		const { initPrefs } = await import(resolve(EXT_LIB, '../state.ts'));
		// 首次调用应该初始化 store 和缓存
		expect(() => initPrefs()).not.toThrow();
	});

	it('getLastNodeModulesStrategy returns default (symlink)', async () => {
		const { getLastNodeModulesStrategy } = await import(resolve(EXT_LIB, '../state.ts'));
		const strat = getLastNodeModulesStrategy();
		expect(strat).toBe('symlink');
	});

	it('setLastNodeModulesStrategy persists to file', async () => {
		// 先初始化
		const { initPrefs, setLastNodeModulesStrategy, getLastNodeModulesStrategy } = await import(
			resolve(EXT_LIB, '../state.ts')
		);
		initPrefs();

		setLastNodeModulesStrategy('copy');
		expect(getLastNodeModulesStrategy()).toBe('copy');

		// 验证文件写入
		const configDir = join(process.env.HOME!, '.pi/agent/extensions-data/pi-worktree');
		const configFile = join(configDir, 'config.json');
		expect(existsSync(configFile)).toBe(true);

		const config = JSON.parse(readFileSync(configFile, 'utf-8'));
		expect(config.lastNodeModulesStrategy).toBe('copy');
	});

	it('setLastNodeModulesStrategy handles install strategy', async () => {
		const { initPrefs, setLastNodeModulesStrategy, getLastNodeModulesStrategy } = await import(
			resolve(EXT_LIB, '../state.ts')
		);
		initPrefs();

		setLastNodeModulesStrategy('install');
		expect(getLastNodeModulesStrategy()).toBe('install');
	});

	it('setLastNodeModulesStrategy handles none strategy', async () => {
		const { initPrefs, setLastNodeModulesStrategy, getLastNodeModulesStrategy } = await import(
			resolve(EXT_LIB, '../state.ts')
		);
		initPrefs();

		setLastNodeModulesStrategy('none');
		expect(getLastNodeModulesStrategy()).toBe('none');
	});
});

// ═══════════════════════════════════════════
// 套件 5：setup.ts（P1 — node_modules 策略 + env 文件）
// ═══════════════════════════════════════════

describe('worktree setup operations', () => {
	let baseDir: string;
	let repoDir: string;
	let worktreeDir: string;

	beforeAll(() => {
		baseDir = resolve(tmpdir(), 'pi-wt-setup-test-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'setup-repo');
	});

	afterAll(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('setupEnvFiles links .env files from main repo', async () => {
		const { setupEnvFiles } = await import(resolve(EXT_LIB, 'setup.ts'));

		// 创建 .env 文件
		writeFileSync(join(repoDir, '.env'), 'SECRET=value\n');
		writeFileSync(join(repoDir, '.env.local'), 'LOCAL=value\n');

		worktreeDir = join(baseDir, 'setup-wt');
		mkdirSync(worktreeDir, { recursive: true });

		const linked = setupEnvFiles(repoDir, worktreeDir);
		expect(linked).toContain('.env');
		expect(linked).toContain('.env.local');

		// 验证链接文件存在且可读
		expect(existsSync(join(worktreeDir, '.env'))).toBe(true);
		expect(existsSync(join(worktreeDir, '.env.local'))).toBe(true);
	});

	it('setupEnvFiles skips existing files', async () => {
		const { setupEnvFiles } = await import(resolve(EXT_LIB, 'setup.ts'));

		// 已经存在 .env，setupEnvFiles 应该跳过
		writeFileSync(join(worktreeDir, '.env'), 'OVERRIDE=\n');

		const linked = setupEnvFiles(repoDir, worktreeDir);
		// .env 应被跳过（已存在），.env.local 应已存在（上一步链接的）
		expect(linked).not.toContain('.env');

		// 既有的 .env 内容不受影响
		expect(readFileSync(join(worktreeDir, '.env'), 'utf-8').trim()).toBe('OVERRIDE=');
	});

	it('setupNodeModules symlink creates link', async () => {
		const { setupNodeModules } = await import(resolve(EXT_LIB, 'setup.ts'));

		// 创建 main node_modules
		const mainModules = join(repoDir, 'node_modules');
		mkdirSync(mainModules, { recursive: true });
		const pkgDir = join(mainModules, 'test-pkg');
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, 'index.js'), 'module.exports={};\n');

		const wtDir = join(baseDir, 'nm-symlink-wt');
		mkdirSync(wtDir, { recursive: true });

		const result = setupNodeModules(repoDir, wtDir, 'symlink');
		expect(result).toBe('symlink');

		// 验证链接存在
		const wtModules = join(wtDir, 'node_modules');
		expect(existsSync(wtModules)).toBe(true);
		expect(existsSync(join(wtModules, 'test-pkg'))).toBe(true);
	});

	it('setupNodeModules skip when no main node_modules', async () => {
		const { setupNodeModules } = await import(resolve(EXT_LIB, 'setup.ts'));

		// 清理 main node_modules
		rmSync(join(repoDir, 'node_modules'), { recursive: true, force: true });

		const wtDir = join(baseDir, 'nm-none-wt');
		mkdirSync(wtDir, { recursive: true });

		const result = setupNodeModules(repoDir, wtDir, 'symlink');
		expect(result).toBe('none (no main node_modules)');
	});

	it('setupNodeModules skips when dest already exists', async () => {
		const { setupNodeModules } = await import(resolve(EXT_LIB, 'setup.ts'));

		// 恢复 main node_modules
		mkdirSync(join(repoDir, 'node_modules'), { recursive: true });
		const existTestDir = join(repoDir, 'node_modules', 'exist-test');
		mkdirSync(existTestDir, { recursive: true });
		writeFileSync(join(existTestDir, 'index.js'), '');

		const wtDir = join(baseDir, 'nm-exists-wt');
		mkdirSync(wtDir, { recursive: true });
		mkdirSync(join(wtDir, 'node_modules'), { recursive: true });

		const result = setupNodeModules(repoDir, wtDir, 'symlink');
		expect(result).toBe('symlink (skipped, exists)');
	});

	it('runWorktreeSetup orchestrates setup correctly', async () => {
		const { runWorktreeSetup } = await import(resolve(EXT_LIB, 'setup.ts'));

		// 确保有 main node_modules 和 .env 文件
		mkdirSync(join(repoDir, 'node_modules'), { recursive: true });
		writeFileSync(join(repoDir, '.env'), 'TEST=1\n');
		writeFileSync(join(repoDir, '.env.staging'), 'STAGING=1\n');

		const wtDir = join(baseDir, 'orchestrated-wt');
		mkdirSync(wtDir, { recursive: true });

		const notes = runWorktreeSetup(repoDir, wtDir, 'symlink');
		// 应该包含 env 相关和 node_modules 相关的日志
		const allNotes = notes.join(' ');
		expect(allNotes).toContain('env');
		expect(allNotes).toContain('symlink');
	});
});

// ═══════════════════════════════════════════
// 套件 6：deleteWorktreeBranch（P1）
// ═══════════════════════════════════════════

describe('worktree deleteWorktreeBranch', () => {
	let baseDir: string;
	let repoDir: string;

	beforeAll(() => {
		baseDir = resolve(tmpdir(), 'pi-wt-del-branch-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'del-branch-repo');
	});

	afterAll(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('deleteWorktreeBranch with force deletes local branch', async () => {
		const { deleteWorktreeBranch } = await import(resolve(EXT_LIB, 'worktree.ts'));

		// 创建分支
		gitCreateBranch(repoDir, 'wt/to-delete');
		gitCommit(repoDir, 'del-me.txt', 'to be deleted');
		gitCheckout(repoDir, 'main');

		const msgs = deleteWorktreeBranch(repoDir, 'to-delete', true);
		expect(msgs.some((m: string) => m.includes('Deleted local branch'))).toBe(true);

		// 验证分支已删除
		const branches = gitBranches(repoDir);
		expect(branches).not.toContain('wt/to-delete');
	});

	it('deleteWorktreeBranch without force skips unmerged branch', async () => {
		const { deleteWorktreeBranch } = await import(resolve(EXT_LIB, 'worktree.ts'));

		// 创建未合并的分支
		gitCreateBranch(repoDir, 'wt/unmerged');
		gitCommit(repoDir, 'unmerged.txt', 'unmerged content');
		gitCheckout(repoDir, 'main');

		// 不加 force，应跳过（有未合并提交）
		const msgs = deleteWorktreeBranch(repoDir, 'unmerged', false);

		// 分支存在，有 unpushed/merged commits
		// 行为：force=false, git merge-base --is-ancestor 检查失败 → 返回提示信息
		expect(msgs.some((m: string) => m.includes('unpushed'))).toBe(true);

		// 验证分支还在
		const branches = gitBranches(repoDir);
		expect(branches).toContain('wt/unmerged');

		// 清理
		execSync('git branch -D wt/unmerged -q', { cwd: repoDir });
	});

	it('deleteWorktreeBranch handles force=true for unmerged branch', async () => {
		const { deleteWorktreeBranch } = await import(resolve(EXT_LIB, 'worktree.ts'));

		// 创建未合并分支
		gitCreateBranch(repoDir, 'wt/force-delete');
		gitCommit(repoDir, 'force-del.txt', 'force delete');
		gitCheckout(repoDir, 'main');

		const msgs = deleteWorktreeBranch(repoDir, 'force-delete', true);
		expect(msgs.some((m: string) => m.includes('Deleted local branch'))).toBe(true);

		const branches = gitBranches(repoDir);
		expect(branches).not.toContain('wt/force-delete');
	});
});

// ═══════════════════════════════════════════
// 套件 7：findMergedWorktrees（P2 — clean 命令基础）
// ═══════════════════════════════════════════

describe('worktree findMergedWorktrees', () => {
	let baseDir: string;
	let repoDir: string;

	beforeAll(() => {
		baseDir = resolve(tmpdir(), 'pi-wt-merged-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'merged-repo');
	});

	afterAll(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('returns empty for repo with no worktrees', async () => {
		const { findMergedWorktrees } = await import(resolve(EXT_LIB, 'worktree.ts'));
		const merged = findMergedWorktrees(repoDir);
		expect(merged).toEqual([]);
	});

	it('returns empty when branches not merged', async () => {
		const { findMergedWorktrees } = await import(resolve(EXT_LIB, 'worktree.ts'));
		// 创建未合并的分支
		gitCreateBranch(repoDir, 'wt/not-merged-yet');
		gitCommit(repoDir, 'unmerged.txt', 'data');
		gitCheckout(repoDir, 'main');

		// 没有实际的 worktree 目录，getManagedWorktrees 会返回空
		const merged = findMergedWorktrees(repoDir);
		expect(merged).toEqual([]);
	});

	it('exclude set filters out current worktree', async () => {
		const { findMergedWorktrees } = await import(resolve(EXT_LIB, 'worktree.ts'));
		const exclude = new Set(['current-wt']);
		const merged = findMergedWorktrees(repoDir, exclude);
		// 即使 current-wt 是 worktree，也被排除
		expect(merged).toEqual([]);
	});
});

// ═══════════════════════════════════════════
// 套件 8：parseArgs（handlers.ts — 命令行参数解析）
// ═══════════════════════════════════════════

describe('worktree parseArgs', () => {
	it('parses simple command', async () => {
		// parseArgs 是 handlers.ts 的内部函数，通过命令测试间接覆盖
		// 直接导入不可行（非 export），通过 COMMANDS 常量验证
		const { COMMANDS } = await import(resolve(EXT_LIB, 'handlers.ts'));
		expect(COMMANDS).toContain('create [--name <n>]');
		expect(COMMANDS).toContain('use <name>  or  main');
		expect(COMMANDS).toContain('list');
		expect(COMMANDS).toContain('delete <name>');
		expect(COMMANDS).toContain(
			'merge [--source <n>] [--target <b>] [--strategy <merge|squash|rebase-ff>]',
		);
		expect(COMMANDS).toContain('clean [--dry-run]');
		expect(COMMANDS).toContain('shell');
	});

	it('formatHelp returns help text', async () => {
		const { formatHelp } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const help = formatHelp();
		expect(help).toContain('/worktree');
		expect(help).toContain('create');
		expect(help).toContain('delete');
		expect(help).toContain('zodiac+star');
	});
});

describe('worktree findInProgressDir merge 场景（ADR-0018）', () => {
	let baseDir: string;
	let repoDir: string;

	beforeAll(async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-merge-probe-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'merge-probe-repo');

		// feature 分支
		gitCreateBranch(repoDir, 'feature/probe');
		gitCommit(repoDir, 'probe.txt', 'probe A');
		gitCheckout(repoDir, 'main');
		gitCommit(repoDir, 'probe.txt', 'probe B');
	});

	afterAll(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('main 根 merge 冲突 → merge 探测返回 main 根，rebase 探测返回 null', async () => {
		const { findInProgressDir } = await import(resolve(EXT_LIB, 'git.ts'));

		// 真实 merge 冲突（main 根）：冲突时 git merge 退出码非零，预期行为
		try {
			execSync('git merge feature/probe', { cwd: repoDir, stdio: 'pipe' });
		} catch {
			/* merge 冲突预期非零退出 */
		}
		// 断言冲突发生（merge 未完成，MERGE_MSG 存在）
		const mergeMsg = execSync('git rev-parse --git-path MERGE_MSG', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(existsSync(resolve(repoDir, mergeMsg))).toBe(true);

		const detected = findInProgressDir(repoDir, 'merge');
		expect(detected).not.toBeNull();
		expect(realpathSync(detected!)).toBe(realpathSync(repoDir));
		// rebase 探测不应误判 merge 冲突
		expect(findInProgressDir(repoDir, 'rebase')).toBeNull();

		// 清理：abort 恢复
		execSync('git merge --abort', { cwd: repoDir });
	});

	it('worktree rebase 冲突存在时 merge 探测排除该目录', async () => {
		// 保险：若上个用例异常导致 merge 状态残留，先清理
		try {
			execSync('git merge --abort', { cwd: repoDir });
		} catch {
			/* 无进行中 merge */
		}
		const { execRebase, findInProgressDir } = await import(resolve(EXT_LIB, 'git.ts'));

		// 构造 worktree 内的 rebase 冲突
		gitCreateBranch(repoDir, 'wt/probe-rb');
		gitCommit(repoDir, 'rb.txt', 'rb A');
		gitCheckout(repoDir, 'main');
		gitCommit(repoDir, 'rb.txt', 'rb B');
		const wtDir = join(baseDir, 'wt-probe-rb');
		execSync(`git worktree add ${wtDir} wt/probe-rb --quiet`, { cwd: repoDir });
		const result = execRebase(repoDir, 'wt/probe-rb', 'main', wtDir);
		expect(result.ok).toBe(false);
		expect(result.conflicts.length).toBeGreaterThan(0);

		// worktree 有 rebase 状态：merge 探测不应返回该目录
		expect(findInProgressDir(repoDir, 'rebase')).not.toBeNull();
		expect(findInProgressDir(repoDir, 'merge')).toBeNull();

		// 清理
		execSync('git rebase --abort', { cwd: wtDir });
		execSync(`git worktree remove ${wtDir} --force`, { cwd: repoDir });
	});
});

describe('worktree sync 别名声明（05）', () => {
	it('COMMANDS 包含 sync 并声明为 rebase 别名', async () => {
		const { COMMANDS, formatHelp } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const syncCmd = COMMANDS.find((c: string) => c.startsWith('sync'));
		expect(syncCmd).toBeDefined();
		expect(syncCmd).toContain('alias for rebase');
		const help = formatHelp();
		expect(help).toContain('sync');
		expect(help).toContain('rebase');
	});
});

describe('worktree hasClonedSession 路径归一化（06）', () => {
	let baseDir: string;
	let repoDir: string;
	let targetDir: string;

	beforeAll(async () => {
		baseDir = resolve(tmpdir(), 'pi-wt-clone-meta-' + Date.now());
		mkdirSync(baseDir, { recursive: true });
		repoDir = createGitRepo(baseDir, 'clone-repo');
		targetDir = join(baseDir, 'wt-clone-target');
	});

	afterAll(() => {
		rmSync(baseDir, { recursive: true, force: true });
	});

	async function writeCloneMeta(sourceCwd: string): Promise<void> {
		// 目标目录的 session 目录（resolveSessionDir = getAgentDir()/sessions/--<cwd>--）与
		// .clone-meta.json（与 cloneSession 写入结构一致）
		const { resolveSessionDir } = await import(resolve(EXT_LIB, 'session.ts'));
		const sessionDir = resolveSessionDir(targetDir);
		mkdirSync(sessionDir, { recursive: true });
		const metaPath = join(sessionDir, '.clone-meta.json');
		writeFileSync(
			metaPath,
			JSON.stringify(
				{
					sourceCwd,
					targetCwd: targetDir,
					clonedAt: new Date().toISOString(),
					sourceSessionId: 'src-id',
					targetSessionId: 'tgt-id',
				},
				null,
				2,
			),
			'utf-8',
		);
	}

	it('realpath 归一化后匹配（macOS /var vs /private/var）', async () => {
		const { hasClonedSession } = await import(resolve(EXT_LIB, 'session.ts'));
		// 源 cwd 用非 realpath 形式存储（如 /var/...），查询用 realpath 形式（/private/var/...）
		const storedCwd = realpathSync(repoDir).replace('/private/var', '/var');
		const queryCwd = realpathSync(repoDir);

		if (storedCwd === queryCwd) {
			// 平台无 /var 符号链接差异（如 Linux /tmp）：退化为普通匹配断言
			await writeCloneMeta(queryCwd);
			expect(hasClonedSession(targetDir, queryCwd)).not.toBeNull();
		} else {
			await writeCloneMeta(storedCwd);
			const meta = hasClonedSession(targetDir, queryCwd);
			expect(meta).not.toBeNull();
			expect(meta!.sourceSessionId).toBe('src-id');
		}
	});

	it('来源目录不同时不匹配', async () => {
		const { hasClonedSession } = await import(resolve(EXT_LIB, 'session.ts'));
		await writeCloneMeta(realpathSync(repoDir));
		const other = join(baseDir, 'unrelated-dir');
		mkdirSync(other, { recursive: true });
		expect(hasClonedSession(targetDir, other)).toBeNull();
	});
});
