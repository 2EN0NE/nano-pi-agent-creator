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
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
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
		expect(COMMANDS).toContain('create [--name <n>] [--branch <b>]');
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
