/**
 * pi-worktree — 路径推导与 Git 工作区定位（纯函数）
 *
 * 不依赖 pi API，不涉及副作用（除 execSync 调用 git）。
 * 所有函数可单元测试。
 */
import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, sep } from 'node:path';
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

// ── 工具 ──

/**
 * 归一化为真实路径（解析符号链接）。
 *
 * macOS /var → /private/var 等符号链接下，resolve() 与 git worktree list
 * 返回的逻辑路径可能不一致（git 返回未解析路径）。统一用 realpath 比较。
 */
export function realpathOf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

// ── cwd 身份判断 ──

/**
 * 当前 cwd 是否在某个 git worktree 目录内。
 *
 * 基于 git worktree list 判断（而非固定目录约定），因此仓库内（如 wt/ 下）
 * 或任意位置的外部 worktree 都能被识别。
 */
export function isWorktreeCwd(cwd: string, repoRoot: string): boolean {
	const resolved = realpathOf(cwd);
	return getManagedWorktrees(repoRoot).some(
		(wt) => resolved === realpathOf(wt.path) || resolved.startsWith(realpathOf(wt.path) + sep),
	);
}

/**
 * 从 cwd 提取 worktree 名称。
 * 前提：isWorktreeCwd(cwd, repoRoot) === true
 *
 * @returns worktree 名称（约定目录内为原名，外部为相对仓库根的路径），不在 worktree 内返回 null
 */
export function getNameFromCwd(cwd: string, repoRoot: string): string | null {
	const resolved = realpathOf(cwd);
	const wt = getManagedWorktrees(repoRoot).find((w) => {
		const real = realpathOf(w.path);
		return resolved === real || resolved.startsWith(real + sep);
	});
	return wt ? wt.name : null;
}

/**
 * 当前 cwd 是否在主仓库根中（不在任何 worktree 内）。
 *
 * 注意：cwd 在 repoRoot 之下但属于某个 worktree（如 <repo>/wt/<name>）时，
 * 返回 false —— 仓库内 worktree 不再被误判为 main。
 */
export function isMainCwd(cwd: string, repoRoot: string): boolean {
	const resolved = realpathOf(cwd);
	const root = realpathOf(repoRoot);
	if (!(resolved === root || resolved.startsWith(root + '/'))) return false;
	return !isWorktreeCwd(cwd, repoRoot);
}

// ── worktree 发现与过滤 ──

/**
 * 从 git worktree list --porcelain 收集所有受管 worktree（不包含 main checkout）。
 *
 * 与旧版不同：不再限定在 <repo>-worktrees/ 约定目录下——任意位置的
 * git worktree（如仓库内的 wt/、其他工具的 .pi/worktrees 等）都会被列出，
 * 名称推导见 parseWorktreeList。
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
		return parseWorktreeList(output, wtDir, repoRoot);
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
 *   worktree /path/to/repo/wt/Virgo-Spica   ← 仓库内外部 worktree
 *   HEAD ghi789...
 *   branch refs/heads/wt/tui-design
 *
 * 名称推导：
 *   - 约定目录（<repo>-worktrees/）内 → 相对该目录的路径（如 'Aries-Hamal'）
 *   - 其他位置 → 相对主仓库根的路径（如 'wt/Virgo-Spica'）；在仓库外则以完整路径为名
 */
export function parseWorktreeList(
	output: string,
	wtDir: string,
	repoRoot: string,
): ManagedWorktree[] {
	const results: ManagedWorktree[] = [];
	const blocks = output.trim().split('\n\n');
	const normalizedWtDir = realpathOf(wtDir);
	const normalizedRoot = realpathOf(repoRoot);

	for (const block of blocks) {
		const lines = block.split('\n');
		if (lines.length < 2) continue;

		// 第一行: worktree <path>
		const pathLine = lines[0];
		if (!pathLine.startsWith('worktree ')) continue;
		const wtPath = resolve(pathLine.slice('worktree '.length).trim());
		const wtReal = realpathOf(wtPath);

		// 排除主仓库根本身（main checkout）——realpath 比较，兼容 /var→/private/var 符号链接
		if (wtReal === normalizedRoot) continue;

		// 名称推导
		let name: string;
		const relWt = relative(normalizedWtDir, wtReal);
		if (relWt && !relWt.startsWith('..') && !relWt.startsWith('/')) {
			// 约定目录内：取第一段路径组件
			name = relWt.split(/[/\\]/)[0];
		} else {
			const relRoot = relative(normalizedRoot, wtReal);
			if (relRoot && !relRoot.startsWith('..')) {
				name = relRoot; // 仓库内外部 worktree：相对仓库根的完整路径
			} else {
				name = wtPath; // 仓库外：完整路径
			}
		}
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
 * 解析 worktree 目标到真实路径（支持任意位置的外部 worktree）。
 *
 * - target === 'main' → repoRoot
 * - 否则先在 git worktree list 中按名称匹配 → 该 worktree 的实际路径
 * - 匹配失败兜底约定目录 getWorktreePath（兼容旧命令与尚未检出的目录）
 */
export function resolveWorktreePath(repoRoot: string, target: string): string {
	if (target === 'main') return repoRoot;
	const hit = getManagedWorktrees(repoRoot).find((w) => w.name === target);
	return hit ? hit.path : getWorktreePath(repoRoot, target);
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
