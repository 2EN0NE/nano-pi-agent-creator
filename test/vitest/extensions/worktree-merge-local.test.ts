/**
 * pi-worktree — merge 完全本地化测试（Local Merge / 本地优先原则）
 *
 * 本地优先：merge 是纯本地操作，不自动 pull 远端。
 * 覆盖：有 remote 但 target 远端不可达/不存在时，直接本地 merge 成功，
 * 而非 pull 失败回滚。网络无关（file:// 指向不存在路径）。
 *
 * git 身份由 test/vitest/setup/git-ident.ts 通过环境变量注入（不写 git config）。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('worktree merge 本地化（Local Merge）', () => {
	it('execMerge：有 remote 但 target 远端不可达 → 直接本地 merge 成功，不 pull', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-local-merge-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		// feature/x 有独立提交
		execSync('git checkout -b feature/x -q', { cwd: repoDir });
		writeFileSync(join(repoDir, 'feat.txt'), 'feature\n');
		execSync('git add feat.txt && git commit -m feat -q', { cwd: repoDir });
		execSync('git checkout main -q', { cwd: repoDir });
		// 有 remote，但指向不存在路径（pull 必然失败，与网络无关）
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repoDir });

		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = await execMerge(repoDir, 'feature/x', 'main');

		expect(result.ok).toBe(true);
		// main 已包含 feature 提交
		const log = execSync('git log main --oneline', { cwd: repoDir, encoding: 'utf-8' });
		expect(log).toContain('feat');
		// 合并后切回原分支 main
		const branch = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(branch).toBe('main');

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('execMerge：有 remote 不可达 + target 有 dirty → 本地 merge 成功并恢复 stash', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-local-dirty-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		// tracked 文件（可被 stash 的 dirty）+ feature 分支提交
		writeFileSync(join(repoDir, 'tracked.txt'), 'clean\n');
		execSync('git add tracked.txt && git commit -m "add tracked" -q', { cwd: repoDir });
		execSync('git checkout -b feature/x -q', { cwd: repoDir });
		writeFileSync(join(repoDir, 'feat.txt'), 'feature\n');
		execSync('git add feat.txt && git commit -m feat -q', { cwd: repoDir });
		execSync('git checkout main -q', { cwd: repoDir });
		// 有 remote 但不可达
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repoDir });
		// main 上制造 dirty（tracked 修改，execMerge 会 stash 再 pop）
		writeFileSync(join(repoDir, 'tracked.txt'), 'dirty modification\n');

		const { execMerge } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = await execMerge(repoDir, 'feature/x', 'main');

		expect(result.ok).toBe(true);
		// dirty 改动被 stash pop 恢复（未丢失）
		expect(readFileSync(join(repoDir, 'tracked.txt'), 'utf-8')).toBe('dirty modification\n');
		// 合并后仍在原分支 main
		const branch = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoDir,
			encoding: 'utf-8',
		}).trim();
		expect(branch).toBe('main');

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('execRebaseFF：有 remote 但远端不可达 → 本地 rebase-ff 成功，不 pull', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-local-rebase-' + Date.now());
		const repoDir = createGitRepo(baseDir, 'repo');
		execSync('git checkout -b wt/x -q', { cwd: repoDir });
		writeFileSync(join(repoDir, 'feat.txt'), 'feature\n');
		execSync('git add feat.txt && git commit -m feat -q', { cwd: repoDir });
		execSync('git checkout main -q', { cwd: repoDir });
		const wtDir = join(baseDir, 'wt-x');
		execSync(`git worktree add ${wtDir} wt/x -q`, { cwd: repoDir });
		// 有 remote 但不可达（rebase-ff 原本会 fetch + pull，均应跳过）
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repoDir });

		const { execRebaseFF } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const result = await execRebaseFF(repoDir, 'wt/x', 'main', wtDir);

		expect(result.ok).toBe(true);
		// main 已 fast-forward 到 wt/x 的提交
		const log = execSync('git log main --oneline', { cwd: repoDir, encoding: 'utf-8' });
		expect(log).toContain('feat');

		rmSync(baseDir, { recursive: true, force: true });
	});
});
