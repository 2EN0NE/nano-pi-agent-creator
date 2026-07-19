/**
 * pi-worktree — Git 辅助函数
 */
import { execSync, spawnSync } from 'node:child_process';
import {
	existsSync,
	readFileSync,
	appendFileSync,
	writeFileSync,
	readdirSync,
	statSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { getCachedHubRoot, setCachedHubRoot, getCachedRepos, setCachedRepos } from '../state.js';

// ── 基础 git ──

export function getCurrentBranch(repoPath: string): string {
	try {
		return execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
	} catch {
		return 'main';
	}
}

export function getDefaultBranch(repoPath: string): string | null {
	try {
		const ref = execSync('git symbolic-ref --quiet refs/remotes/origin/HEAD', {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
		return ref.replace(/^refs\/remotes\/origin\//, '') || null;
	} catch {
		for (const candidate of ['main', 'master']) {
			const check = spawnSync(
				'git',
				['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`],
				{ cwd: repoPath, encoding: 'utf-8' },
			);
			if (check.status === 0) return candidate;
		}
		return null;
	}
}

export function fetchBase(repoPath: string, base: string): boolean {
	return (
		spawnSync('git', ['fetch', 'origin', base, '--quiet'], { cwd: repoPath, encoding: 'utf-8' })
			.status === 0
	);
}

export function ensureGitignore(repoPath: string, worktreesDir: string): void {
	const gitignorePath = join(repoPath, '.gitignore');
	const content = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
	if (!content.includes(worktreesDir)) {
		appendFileSync(gitignorePath, `\n${worktreesDir}/\n`);
	}
}

export function isGitRepo(dir: string): boolean {
	return existsSync(join(dir, '.git'));
}

// ── Hub 根目录发现（带缓存）──

export function findHubRoot(cwd: string): string | null {
	const cached = getCachedHubRoot();
	if (cached && cwd.startsWith(cached)) return cached;

	let dir = cwd;
	let prev = '';
	while (dir !== prev) {
		if (existsSync(join(dir, 'AGENTS.md')) || existsSync(join(dir, 'hub.config.ts'))) {
			setCachedHubRoot(dir);
			return dir;
		}
		prev = dir;
		dir = resolve(dir, '..');
	}
	return null;
}

// ── 仓库发现（带缓存）──

export function discoverRepos(cwd: string): string[] {
	const cached = getCachedRepos();
	if (cached) return cached;

	const hubRoot = findHubRoot(cwd);
	if (!hubRoot) {
		const result = isGitRepo(cwd) ? [cwd] : [];
		setCachedRepos(result);
		return result;
	}

	const repos: string[] = [];

	// 加入 hubRoot 自身（如果它是 git 仓库）
	if (isGitRepo(hubRoot)) repos.push(hubRoot);

	// 扫描 hubRoot 下的子仓库
	for (const entry of readdirSync(hubRoot)) {
		const full = join(hubRoot, entry);
		if (full === join(hubRoot, '.git')) continue; // 跳过 .git 自身
		if (statSync(full).isDirectory() && isGitRepo(full) && !repos.includes(full)) {
			repos.push(full);
		}
	}
	repos.sort((a, b) => basename(a).localeCompare(basename(b)));
	setCachedRepos(repos);
	return repos;
}

/**
 * 诊断：检查 cwd 的 git 状态，返回友好提示
 */
export function diagnoseWorktreeEnv(cwd: string): string {
	const isRepo = isGitRepo(cwd);
	const hasGitDir = existsSync(join(cwd, '.git'));
	const hasDotGit = existsSync(cwd) && statSync(cwd).isDirectory() && basename(cwd) === '.git';

	if (hasDotGit) return '当前在 .git 目录中，请到仓库根目录运行 pi。';
	if (!hasGitDir && !isRepo) {
		// 检查是否在 git worktree 的 .git 文件中
		const gitPath = join(cwd, '.git');
		if (existsSync(gitPath)) {
			try {
				const content = readFileSync(gitPath, 'utf-8').trim();
				if (content.startsWith('gitdir:'))
					return '当前在 git worktree 内，可以在主仓库运行 pi 然后使用 /worktree use 激活。';
			} catch {
				/* ignore */
			}
		}
		return `当前目录不是 git 仓库。\n  请 cd 到 git 仓库目录（如 nano-pi-stuff/）后重试。\n  提示：运行 git init 初始化当前目录，或 cd 到已有仓库。`;
	}

	const hubRoot = findHubRoot(cwd);
	if (!hubRoot) return ''; // 正常单仓库

	if (hubRoot && isRepo) {
		return `已找到仓库：${basename(cwd)}（项目根：${basename(hubRoot)}）`;
	}
	return '';
}

// ── 分支合并检查 ──

export function isBranchMergedIntoBase(repoPath: string, branch: string): boolean {
	const base = getDefaultBranch(repoPath);
	if (!base) return false;
	fetchBase(repoPath, base);

	const merged = spawnSync(
		'git',
		['branch', '--merged', `origin/${base}`, '--format=%(refname:short)'],
		{ cwd: repoPath, encoding: 'utf-8' },
	);
	if (merged.status === 0) {
		if (
			(merged.stdout || '')
				.split('\n')
				.map((s) => s.trim())
				.filter(Boolean)
				.includes(branch)
		)
			return true;
	}
	return (
		spawnSync('git', ['merge-base', '--is-ancestor', branch, `origin/${base}`], {
			cwd: repoPath,
			encoding: 'utf-8',
		}).status === 0
	);
}

// ── 版本辅助 ──

export function bumpPackageVersion(
	pkgPath: string,
	kind: 'patch' | 'minor' | 'major',
): { from: string; to: string } | null {
	if (!existsSync(pkgPath)) return null;
	let pkg: any;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
	} catch {
		return null;
	}
	const [maj, min, pat] = String(pkg.version || '0.0.0')
		.split('.')
		.map((n) => parseInt(n, 10) || 0);
	const next =
		kind === 'major'
			? `${maj + 1}.0.0`
			: kind === 'minor'
				? `${maj}.${min + 1}.0`
				: `${maj}.${min}.${pat + 1}`;
	const prev = String(pkg.version);
	pkg.version = next;
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
	return { from: prev, to: next };
}
