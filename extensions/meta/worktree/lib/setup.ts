/**
 * pi-worktree — 环境创建时设置（symlink、node_modules、setup 脚本）
 */
import { existsSync, readdirSync, symlinkSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync, spawn, execSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';
import type { NodeModulesStrategy, SymlinkSelections } from '../types.js';

const log = createLogger('pi-worktree');

// ── node_modules 策略 ──

/**
 * 根据所选策略设置 worktree 的 node_modules。
 * 仅在 main checkout 有 node_modules 时执行。
 *
 * @returns 标记执行了什么策略的字符串
 */
export function setupNodeModules(
	repoRoot: string,
	worktreePath: string,
	strategy: NodeModulesStrategy,
): string {
	if (strategy === 'none') return 'none';
	const mainModules = join(repoRoot, 'node_modules');
	if (!existsSync(mainModules)) {
		log.info('no main node_modules to setup', { strategy });
		return 'none (no main node_modules)';
	}

	switch (strategy) {
		case 'symlink':
			return doSymlink(mainModules, join(worktreePath, 'node_modules'));
		case 'copy':
			return doHardlinkCopy(repoRoot, worktreePath);
		case 'install':
			return doInstall(worktreePath);
		default:
			return 'unknown strategy';
	}
}

function doSymlink(src: string, dest: string): string {
	if (existsSync(dest)) {
		log.info('node_modules already exists in worktree, skipping symlink');
		return 'symlink (skipped, exists)';
	}
	try {
		const linkType = process.platform === 'win32' ? 'junction' : undefined;
		symlinkSync(src, dest, linkType as any);
		return 'symlink';
	} catch (err) {
		log.error('symlink node_modules failed', { error: String(err), src, dest });
		return `symlink (failed: ${(err as Error).message})`;
	}
}

function doHardlinkCopy(repoRoot: string, worktreePath: string): string {
	const dest = join(worktreePath, 'node_modules');
	if (existsSync(dest)) return 'copy (skipped, exists)';
	try {
		const result = spawnSync('cp', ['-al', join(repoRoot, 'node_modules'), dest], {
			cwd: repoRoot,
			encoding: 'utf-8',
		});
		if (result.status === 0) return 'copy (cp -al)';
		// fallback: 如果 -a 不支持（macOS 特定场景），用 -R
		const fallback = spawnSync('cp', ['-R', join(repoRoot, 'node_modules'), dest], {
			cwd: repoRoot,
			encoding: 'utf-8',
		});
		if (fallback.status === 0) return 'copy (cp -R fallback)';
		return `copy (failed: ${fallback.stderr?.trim() || 'unknown'})`;
	} catch (err) {
		return `copy (failed: ${(err as Error).message})`;
	}
}

function doInstall(worktreePath: string): string {
	const dest = join(worktreePath, 'node_modules');
	if (existsSync(dest)) return 'install (skipped, exists)';

	const pm = existsSync(join(worktreePath, 'pnpm-lock.yaml'))
		? 'pnpm'
		: existsSync(join(worktreePath, 'yarn.lock'))
			? 'yarn'
			: 'npm';
	const child = spawn(pm, ['install'], { cwd: worktreePath, stdio: 'ignore', detached: true });
	child.unref();
	return `${pm} install (background)`;
}

// ── 环境文件 symlink ──

/**
 * 将 main checkout 下的 .env* 文件 symlink 到 worktree。
 * 默认在创建时执行。
 */
export function setupEnvFiles(repoRoot: string, worktreePath: string): string[] {
	const linked: string[] = [];
	try {
		for (const entry of readdirSync(repoRoot)) {
			if (!entry.startsWith('.env')) continue;
			const src = join(repoRoot, entry);
			const dest = join(worktreePath, entry);
			if (existsSync(dest)) continue;
			try {
				symlinkSync(src, dest);
				linked.push(entry);
			} catch {
				/* skip */
			}
		}
	} catch {
		/* skip */
	}
	return linked;
}

// ── 用户 setup 脚本 ──

const SETUP_DIR = '.pi/worktree-setup';

function runSetupScript(repoRoot: string, worktreePath: string): { ok: boolean; output: string } {
	const scriptPath = join(repoRoot, SETUP_DIR, `${basename(repoRoot)}.sh`);
	if (!existsSync(scriptPath)) return { ok: true, output: '' };
	const result = spawnSync('bash', [scriptPath], {
		cwd: worktreePath,
		encoding: 'utf-8',
		env: {
			...process.env,
			WT_REPO: worktreePath,
			WT_MAIN: repoRoot,
			WT_NAME: basename(worktreePath),
		},
	});
	if (result.error) return { ok: false, output: result.error.message };
	return {
		ok: result.status === 0,
		output: [result.stdout, result.stderr].filter(Boolean).join('').trim(),
	};
}

// ── 通用 symlink ──

/**
 * 将 main checkout 下的指定相对路径 symlink 到 worktree。
 * 跳过源不存在的、目标已存在的。
 *
 * @returns 对每个路径的操作说明
 */
export function setupSymlinkPaths(
	repoRoot: string,
	worktreePath: string,
	relativePaths: string[],
): string[] {
	const results: string[] = [];
	for (const relPath of relativePaths) {
		const src = join(repoRoot, relPath);
		const dest = join(worktreePath, relPath);
		if (!existsSync(src)) {
			results.push(`${relPath}: source not found, skip`);
			continue;
		}
		if (existsSync(dest)) {
			results.push(`${relPath}: already exists, skip`);
			continue;
		}
		try {
			const parentDir = dirname(dest);
			if (!existsSync(parentDir)) {
				mkdirSync(parentDir, { recursive: true });
			}
			symlinkSync(src, dest);
			results.push(`${relPath}: symlinked`);
		} catch (err) {
			results.push(`${relPath}: failed (${(err as Error).message})`);
		}
	}
	return results;
}

// ── Husky hooks 自动配置 ──

/**
 * 如果 repo 有 .husky/ 目录且 core.hooksPath 未设置，
 * 自动设为 .husky/ 使所有 worktree 的 hooks 生效。
 *
 * @returns 说明字符串，或空字符串（无需操作时）
 */
function setupHuskyHooks(repoRoot: string): string {
	const huskyDir = join(repoRoot, '.husky');
	if (!existsSync(huskyDir)) return '';

	try {
		// 检查是否已设置
		const current = execSync('git config core.hooksPath', {
			cwd: repoRoot,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
		if (current) {
			log.info('core.hooksPath already set', { current });
			return ''; // 已设置，跳过
		}
	} catch {
		// 未设置，继续
	}

	try {
		execSync('git config core.hooksPath .husky/', {
			cwd: repoRoot,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		log.info('hooks configured', { repoRoot });
		return 'hooks: core.hooksPath -> .husky/';
	} catch (err) {
		log.warn('failed to set core.hooksPath', { error: String(err) });
		return `hooks: failed (${(err as Error).message})`;
	}
}

// ── 完整创建后设置 ──

/**
 * 创建 worktree 后执行全套设置。
 */
export function runWorktreeSetup(
	repoRoot: string,
	worktreePath: string,
	nodeModulesStrategy: NodeModulesStrategy,
	selections?: SymlinkSelections,
): string[] {
	const notes: string[] = [];

	// 1. 环境文件
	const envLinked = setupEnvFiles(repoRoot, worktreePath);
	if (envLinked.length > 0) notes.push(`env: ${envLinked.join(', ')} linked`);

	// 2. 选中的 symlink 目标（除 node_modules 外由通用路径处理器处理）
	if (selections) {
		// 预设目标（不含 node_modules—由下一步单独处理）
		const presetPaths = selections.targets
			.filter((t) => t.id !== 'node_modules')
			.map((t) => t.relativePath);
		const presetNotes = setupSymlinkPaths(repoRoot, worktreePath, presetPaths);
		for (const n of presetNotes) notes.push(n);

		// 自定义路径
		const customNotes = setupSymlinkPaths(repoRoot, worktreePath, selections.customPaths);
		for (const n of customNotes) notes.push(n);

		// 3. Husky hooks 自动配置（如果选了 .husky/ 且 symlink 成功）
		const hasHusky = selections.targets.some((t) => t.id === 'husky');
		if (hasHusky) {
			const hooksNote = setupHuskyHooks(repoRoot);
			if (hooksNote) notes.push(hooksNote);
		}

		// 4. node_modules（使用独立策略）
		const nm = setupNodeModules(repoRoot, worktreePath, selections.nodeModulesStrategy);
		if (nm !== 'none') notes.push(`node_modules: ${nm}`);
	} else {
		// 向后兼容：无 selections 时使用独立的 nodeModulesStrategy
		const nm = setupNodeModules(repoRoot, worktreePath, nodeModulesStrategy);
		if (nm !== 'none') notes.push(`node_modules: ${nm}`);
	}

	// 4. 用户 setup 脚本
	const { ok, output } = runSetupScript(repoRoot, worktreePath);
	if (output) {
		notes.push(`setup script: ${ok ? 'ok' : 'failed'}`);
		if (!ok) notes.push(`  ${output.split('\n').slice(-3).join('\n')}`);
	}

	return notes;
}
