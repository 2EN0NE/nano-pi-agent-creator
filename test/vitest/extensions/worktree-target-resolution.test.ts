/**
 * pi-worktree — 目标分支解析与本地优先（ADR-0061）
 *
 * 覆盖两点：
 *   1. 解析链（显式 → 组声明 baseRef → 仓库默认分支本地同名 → 当前 HEAD → 报错不猜）
 *   2. **本地优先**的硬约束：默认不 fetch。用「remote 指向不存在路径」证明——
 *      一旦实现偷偷 fetch，操作必然失败（与网络无关，纯本地可判定）。
 */
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

function createBareRemote(basedir: string, name: string): string {
	const remoteDir = join(basedir, name);
	mkdirSync(remoteDir, { recursive: true });
	execSync('git init --bare -q', { cwd: remoteDir });
	return remoteDir;
}

function revParse(dir: string, ref: string): string {
	return execSync(`git rev-parse ${ref}`, { cwd: dir, encoding: 'utf-8' }).trim();
}

function git(dir: string, args: string[]): string {
	const res = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
	return (res.stdout || '').trim();
}

function commitFile(dir: string, file: string, content: string, msg: string): void {
	writeFileSync(join(dir, file), content);
	execSync(`git add ${file} && git commit -m "${msg}" -q`, { cwd: dir });
}

describe('resolveTargetBranch（目标分支解析链，禁止写死分支名）', () => {
	it('显式指定优先于组声明 baseRef', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-tgt1-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		execSync('git branch dev -q', { cwd: repo });

		const { resolveTargetBranch } = await import(resolve(EXT_LIB, 'target.ts'));
		const r = resolveTargetBranch(repo, { explicit: 'main', baseRef: 'dev' });
		expect(r).toEqual({ branch: 'main', source: 'explicit', isLocal: true });

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('无显式时用组声明 baseRef', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-tgt2-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		execSync('git branch dev -q', { cwd: repo });

		const { resolveTargetBranch } = await import(resolve(EXT_LIB, 'target.ts'));
		const r = resolveTargetBranch(repo, { baseRef: 'dev' });
		expect(r).toEqual({ branch: 'dev', source: 'baseRef', isLocal: true });

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('都未给 → 仓库默认分支（origin/HEAD 的本地同名分支）', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-tgt3-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		const bare = createBareRemote(baseDir, 'origin');
		execSync(`git remote add origin file://${bare}`, { cwd: repo });
		execSync('git push -u origin main -q', { cwd: repo });
		// 模拟 clone 出来的 origin/HEAD
		execSync('git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main', {
			cwd: repo,
		});

		const { resolveTargetBranch } = await import(resolve(EXT_LIB, 'target.ts'));
		const r = resolveTargetBranch(repo);
		expect(r).toEqual({ branch: 'main', source: 'repo-default', isLocal: true });

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('无 origin/HEAD 也无 main/master → 回退当前 HEAD 分支', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-tgt4-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		execSync('git branch -m trunk -q', { cwd: repo }); // 既非 main 也非 master

		const { resolveTargetBranch } = await import(resolve(EXT_LIB, 'target.ts'));
		const r = resolveTargetBranch(repo);
		expect(r).toEqual({ branch: 'trunk', source: 'head', isLocal: true });

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('显式指定不存在的分支 → 报错（不猜）', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-tgt5-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');

		const { resolveTargetBranch, TargetResolutionError } = await import(
			resolve(EXT_LIB, 'target.ts')
		);
		expect(() => resolveTargetBranch(repo, { explicit: 'nope' })).toThrow(
			TargetResolutionError,
		);

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('解析不出任何分支（detached + 无 main/master）→ 报错要求显式指定', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-tgt6-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		const sha = revParse(repo, 'HEAD');
		execSync('git branch -m trunk -q', { cwd: repo });
		execSync(`git checkout --detach ${sha} -q`, { cwd: repo });
		execSync('git branch -D trunk -q', { cwd: repo });

		const { resolveTargetBranch, TargetResolutionError } = await import(
			resolve(EXT_LIB, 'target.ts')
		);
		expect(() => resolveTargetBranch(repo)).toThrow(TargetResolutionError);

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('无 origin/HEAD 时不按名称猜 main——当前在 dev 就落 dev', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-tgt-noguess-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		execSync('git branch dev -q', { cwd: repo });
		execSync('git checkout dev -q', { cwd: repo });
		// 本地确实存在 main，但没有 origin/HEAD（无远端）
		execSync('git show-ref --verify --quiet refs/heads/main', { cwd: repo });
		expect(() =>
			execSync('git symbolic-ref --quiet refs/remotes/origin/HEAD', {
				cwd: repo,
				stdio: 'pipe',
			}),
		).toThrow();

		const { resolveTargetBranch } = await import(resolve(EXT_LIB, 'target.ts'));
		const r = resolveTargetBranch(repo, {});
		expect(r).toEqual({ branch: 'dev', source: 'head', isLocal: true });

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('显式写 origin/<b> → isLocal=false（远端 ref 需显式）', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-tgt7-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		const bare = createBareRemote(baseDir, 'origin');
		execSync(`git remote add origin file://${bare}`, { cwd: repo });
		execSync('git push -u origin main -q', { cwd: repo });

		const { resolveTargetBranch } = await import(resolve(EXT_LIB, 'target.ts'));
		const r = resolveTargetBranch(repo, { explicit: 'origin/main' });
		expect(r.isLocal).toBe(false);
		expect(r.branch).toBe('origin/main');

		rmSync(baseDir, { recursive: true, force: true });
	});
});

describe('本地优先：基点取本地 ref，且不隐式 fetch（ADR-0061）', () => {
	it('createWorktree(baseRef) 从**本地** dev 派生（本地领先 origin/dev 时取本地）', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-local1-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		const bare = createBareRemote(baseDir, 'origin');
		execSync(`git remote add origin file://${bare}`, { cwd: repo });
		execSync('git push -u origin main -q', { cwd: repo });

		execSync('git checkout -b dev -q', { cwd: repo });
		commitFile(repo, 'dev1.txt', 'dev1\n', 'dev1');
		execSync('git push -u origin dev -q', { cwd: repo });
		commitFile(repo, 'dev2.txt', 'dev2\n', 'dev2'); // 仅本地领先 origin/dev

		const localDev = revParse(repo, 'dev');
		const originDev = revParse(repo, 'origin/dev');
		expect(localDev).not.toBe(originDev);

		const { createWorktree } = await import(resolve(EXT_LIB, 'worktree.ts'));
		const res = createWorktree(repo, 'Aries-Hamal', 'none', undefined, { baseRef: 'dev' });
		expect(res.ok).toBe(true);

		const wtHead = revParse(res.path!, 'HEAD');
		expect(wtHead).toBe(localDev);
		expect(wtHead).not.toBe(originDev);

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('createWorktree：remote 不可达也能成功（证明不隐式 fetch）', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-local2-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		execSync('git branch dev -q', { cwd: repo });
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repo });

		const { createWorktree } = await import(resolve(EXT_LIB, 'worktree.ts'));
		const res = createWorktree(repo, 'Taurus-Aldebaran', 'none', undefined, { baseRef: 'dev' });
		expect(res.ok).toBe(true);

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('execRebase 到本地 dev：remote 不可达也成功，且带上本地 dev 的提交', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-local3-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		execSync('git branch dev -q', { cwd: repo });

		const { createWorktree } = await import(resolve(EXT_LIB, 'worktree.ts'));
		const created = createWorktree(repo, 'Gemini-Castor', 'none', undefined, {
			baseRef: 'dev',
		});
		expect(created.ok).toBe(true);

		// dev 前进一个提交（模拟「本地集成分支领先远端」）
		execSync('git checkout dev -q', { cwd: repo });
		commitFile(repo, 'integration.txt', 'integration\n', 'integration');
		const devSha = revParse(repo, 'dev');

		// remote 指向不存在路径：若实现内部 fetch，必然失败
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repo });

		const { execRebase } = await import(resolve(EXT_LIB, 'git.ts'));
		const res = execRebase(repo, 'wt/Gemini-Castor', 'dev', created.path!);
		expect(res.ok).toBe(true);

		const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', devSha, 'HEAD'], {
			cwd: created.path!,
			encoding: 'utf-8',
		});
		expect(isAncestor.status).toBe(0);

		// 远端引用不应被创建/更新（没有 fetch 过 origin）
		expect(git(repo, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'])).toBe('');

		rmSync(baseDir, { recursive: true, force: true });
	});
});
