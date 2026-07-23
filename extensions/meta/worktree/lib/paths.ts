/**
 * pi-worktree — 路径推导与 Git 工作区定位（纯函数）
 *
 * 不依赖 pi API，不涉及副作用（除 execSync 调用 git）。
 * 所有函数可单元测试。
 */
import { execSync } from 'node:child_process';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-worktree');
import { getAgentDir } from '@earendil-works/pi-coding-agent';

// ── 类型 ──

export interface ManagedWorktree {
	name: string;
	branch: string;
	path: string;
}

// ── 主仓库定位 ──

/**
 * 从任意 cwd 推导主仓库根目录。
 *
 * 原理：git rev-parse --path-format=absolute --git-common-dir 返回共享 .git 目录，
 * 其父目录即主仓库根。无论 cwd 在 worktree 内还是 main checkout 内都有效。
 *
 * @param cwd 当前工作目录（任意 git 仓库内路径）
 * @returns 主仓库绝对路径，非 git 仓库时返回 null
 */
export function getRepoRoot(cwd: string): string | null {
	try {
		const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
			cwd,
			encoding: 'utf-8',
			timeout: 5000,
		}).trim();
		if (!commonDir) return null;
		return dirname(resolve(cwd, commonDir));
	} catch {
		return null;
	}
}

/**
 * 从主仓库根推导 worktree 存放根目录。
 *
 * 约定：${dirname(repoRoot)}/${basename(repoRoot)}-worktrees/
 *
 * 示例：
 *   repoRoot = /path/to/my-project
 *   return   = /path/to/my-project-worktrees
 */
export function getWorktreesDir(repoRoot: string): string {
	return join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
}

/**
 * 获取指定 worktree 的路径。
 */
export function getWorktreePath(repoRoot: string, name: string): string {
	return join(getWorktreesDir(repoRoot), name);
}

// ── cwd 身份判断 ──

/**
 * 当前 cwd 是否在管理的 worktree 目录内。
 */
export function isWorktreeCwd(cwd: string, repoRoot: string): boolean {
	const wtDir = getWorktreesDir(repoRoot);
	const rel = relative(wtDir, resolve(cwd));
	// rel 非空且不以 '..' 开头 = cwd 在 wtDir 子路径内
	return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
}

/**
 * 从 cwd 提取 worktree 名称。
 * 前提：isWorktreeCwd(cwd, repoRoot) === true
 *
 * @returns worktree 名称，若 cwd 不在 worktree 内则返回 null
 */
export function getNameFromCwd(cwd: string, repoRoot: string): string | null {
	if (!isWorktreeCwd(cwd, repoRoot)) return null;
	const wtDir = getWorktreesDir(repoRoot);
	const rel = relative(wtDir, resolve(cwd));
	// 取第一段路径组件
	const first = rel.split(/[/\\]/)[0];
	return first || null;
}

/**
 * 当前 cwd 是否不在任何 worktree 内（在主仓库根中）。
 */
export function isMainCwd(cwd: string, repoRoot: string): boolean {
	const resolved = resolve(cwd);
	const root = resolve(repoRoot);
	return resolved === root || resolved.startsWith(root + '/');
}

// ── worktree 发现与过滤 ──

/**
 * 从 git worktree list --porcelain 收集 managed worktrees。
 *
 * 只返回路径在 getWorktreesDir(repoRoot) 下的 worktree（不包含 main checkout）。
 * main checkout 的 branch 不会出现在返回值中。
 *
 * @param repoRoot 主仓库根
 * @returns ManagedWorktree 列表
 */
export function getManagedWorktrees(repoRoot: string): ManagedWorktree[] {
	const wtDir = getWorktreesDir(repoRoot);
	try {
		const output = execSync('git worktree list --porcelain', {
			cwd: repoRoot,
			encoding: 'utf-8',
			timeout: 5000,
		});
		return parseWorktreeList(output, wtDir);
	} catch {
		return [];
	}
}

/**
 * 解析 git worktree list --porcelain 输出。
 *
 * Porcelain 格式示例：
 *   worktree /path/to/main
 *   HEAD abc123...
 *   branch refs/heads/main
 *
 *   worktree /path/to/repo-worktrees/Aries-Hamal
 *   HEAD def456...
 *   branch refs/heads/wt/Aries-Hamal
 *
 *   worktree /path/to/repo-worktrees/Leo-Denebola
 *   HEAD ghi789...
 *   detached
 */
export function parseWorktreeList(output: string, wtDir: string): ManagedWorktree[] {
	const results: ManagedWorktree[] = [];
	const blocks = output.trim().split('\n\n');
	const normalizedWtDir = resolve(wtDir);

	for (const block of blocks) {
		const lines = block.split('\n');
		if (lines.length < 2) continue;

		// 第一行: worktree <path>
		const pathLine = lines[0];
		if (!pathLine.startsWith('worktree ')) continue;
		const wtPath = resolve(pathLine.slice('worktree '.length).trim());

		// 过滤：只接受在 wtDir 下，且不是主仓库根
		if (!wtPath.startsWith(normalizedWtDir + '/')) continue;

		// 提取名称
		const rel = relative(normalizedWtDir, wtPath);
		if (!rel || rel.startsWith('..')) continue;
		const name = rel.split(/[/\\]/)[0];
		if (!name) continue;

		// 提取 branch
		const branchLine = lines.find((l) => l.startsWith('branch ') || l === 'detached');
		const branch = branchLine?.startsWith('branch ')
			? branchLine.slice('branch '.length).replace('refs/heads/', '')
			: 'detached';

		results.push({ name, branch, path: wtPath });
	}

	return results;
}

/**
 * 获取当前活跃 worktree 的名称（从 cwd 推导）。
 * 仅用于 UI/日志显示，不参与业务逻辑。
 */
export function getActiveWorktreeName(repoRoot: string, cwd: string): string | null {
	if (isMainCwd(cwd, repoRoot)) return null; // null = main
	return getNameFromCwd(cwd, repoRoot);
}

// ── 安全守卫 ──

/**
 * 断言目标路径在 worktrees 根目录下。
 * 用于删除操作的前置安全检查，防止误删 main checkout 或其他目录。
 *
 * @throws Error 当 path 不在 worktreesDir 内
 */
export function assertPathInWorktrees(worktreesDir: string, path: string): void {
	const resolvedPath = resolve(path);
	const resolvedWtDir = resolve(worktreesDir);

	if (!resolvedPath.startsWith(resolvedWtDir + '/') && resolvedPath !== resolvedWtDir) {
		throw new Error(
			`SAFETY 拒绝操作：路径 "${resolvedPath}" 不在 worktree 目录 "${resolvedWtDir}" 内。` +
				'这可能是误删 main checkout 或非管理目录。',
		);
	}
	if (resolvedPath === resolvedWtDir) {
		throw new Error(
			`SAFETY 拒绝操作：目标路径 "${resolvedPath}" 是 worktree 根目录本身，` +
				'不是一个具体 worktree。',
		);
	}
}

// ── Session 目录 ──

/**
 * 纯函数：计算 Pi 为给定 cwd 使用的默认 session 目录。
 *
 * 编码方式与 SessionManager 内部完全一致：
 *   <agentDir>/sessions/--<encoded-cwd>--
 * 其中 encoded-cwd = cwd 的绝对路径，去除前导 /，替换 /\\: 为 -
 *
 * 无副作用（不创建目录）。
 */
export function getDefaultSessionDirPath(cwd: string): string {
	const agentDir = getAgentDir();
	const resolvedCwd = resolve(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
	return join(agentDir, 'sessions', safePath);
}
