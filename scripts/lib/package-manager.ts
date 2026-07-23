/**
 * scripts/lib/package-manager.ts — npm 包依赖管理模块
 *
 * 职责：
 *   1. 扫描目标目录和源码目录的 @zenone/* 本地包
 *   2. 管理 root package.json 的 @zenone/* 依赖（增/删）
 *   3. 执行 npm install（root 级和 per-extension 级）
 *
 * 不输出日志——所有结果通过返回值传递，调用者决定如何呈现。
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
	type Dirent,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';

import { isNpmPackageDir } from './utils.js';

// ============================================================================
// Types
// ============================================================================

export interface NpmInstallResult {
	path: string;
	success: boolean;
	output: string;
}

export interface RootDependencyChange {
	added: number;
	removed: number;
	/** 当前 package.json 中的 @zenone/* 依赖总数 */
	total: number;
}

export interface ExtensionInstallSummary {
	count: number;
	skipped: number;
	failed: number;
	results: NpmInstallResult[];
}

export interface PackageManagerOptions {
	/** 目标根目录（如 ~/.pi/agent/ 或 ./.pi/） */
	targetDir: string;
	/** 源码项目根目录（用于扫描未同步的 @zenone/* 包） */
	projectRoot: string;
	/** 模拟模式 —— 不实际写入或安装 */
	dryRun?: boolean;
}

// ============================================================================
// ResolvedResource 类型（与 sync-to-local-pi.ts 保持一致）
// ============================================================================

export interface ResolvedResource {
	type: string;
	name: string;
	sourcePath: string;
	targetPath: string;
	isDirectory: boolean;
}

// ============================================================================
// PackageManager
// ============================================================================

export class PackageManager {
	private readonly targetDir: string;
	private readonly projectRoot: string;
	private readonly dryRun: boolean;

	constructor(opts: PackageManagerOptions) {
		this.targetDir = opts.targetDir;
		this.projectRoot = opts.projectRoot;
		this.dryRun = opts.dryRun ?? false;
	}

	// ── 包扫描 ──────────────────────────────────────────────────

	/**
	 * 扫描目标目录（已同步的扩展）和源码目录（项目中的扩展），
	 * 收集所有 @zenone/* 本地包。
	 *
	 * 目标目录中的包使用相对路径（./extensions/<name>），
	 * 源码目录中找不到的包使用绝对路径（确保 npm 解析可用）。
	 *
	 * 目标目录的包优先（保留相对路径）。
	 */
	scanLocalPackages(): Map<string, string> {
		const packages = new Map<string, string>();

		// 1. 扫目标目录的 extensions/ 下已同步的包
		const extDir = join(this.targetDir, 'extensions');
		if (existsSync(extDir)) {
			let entries: Dirent[];
			try {
				entries = readdirSync(extDir, { withFileTypes: true });
			} catch {
				entries = [];
			}

			for (const entry of entries) {
				if (entry.name.startsWith('.')) continue;
				if (entry.name === 'node_modules') continue;
				if (!entry.isDirectory()) continue;

				const pkgPath = join(extDir, entry.name, 'package.json');
				if (!existsSync(pkgPath)) continue;

				try {
					const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
					if (
						pkg.name &&
						typeof pkg.name === 'string' &&
						pkg.name.startsWith('@zenone/')
					) {
						packages.set(pkg.name, `./extensions/${entry.name}`);
					}
				} catch {
					// 跳过无效 package.json
				}
			}
		}

		// 2. 扫源码目录中未被目标覆盖的包
		const sourceExtDir = join(this.projectRoot, 'extensions');
		if (existsSync(sourceExtDir)) {
			const sourcePackages = this._findZenonePackages(sourceExtDir);
			for (const [name, absPath] of sourcePackages) {
				if (!packages.has(name)) {
					packages.set(name, absPath);
				}
			}
		}

		return packages;
	}

	/**
	 * 根据扫描结果写入/更新 root package.json 中的 @zenone/* 依赖。
	 *
	 * - 移除目标中不再存在的 @zenone/* 条目
	 * - 添加新的 @zenone/* 条目
	 * - 保留非 @zenone/* 的依赖（如用户手动添加的）
	 *
	 * @returns 变更统计
	 */
	writeRootPackageJson(localPackages: Map<string, string>): RootDependencyChange {
		const rootPkgPath = join(this.targetDir, 'package.json');
		let rootPkg: Record<string, unknown> = {};
		if (existsSync(rootPkgPath)) {
			try {
				rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
			} catch {
				rootPkg = {};
			}
		}

		rootPkg.private = true;
		rootPkg.type = 'module';
		if (!rootPkg.dependencies) {
			rootPkg.dependencies = {} as Record<string, string>;
		}
		const deps = rootPkg.dependencies as Record<string, string>;

		let packagesAdded = 0;
		let packagesRemoved = 0;

		// Phase 1: 移除已不存在的 @zenone/* 条目
		for (const depName of Object.keys(deps)) {
			if (depName.startsWith('@zenone/') && !localPackages.has(depName)) {
				delete deps[depName];
				packagesRemoved++;
			}
		}

		// Phase 2: 添加新增的 @zenone/* 条目
		for (const [name, relPath] of localPackages) {
			if (deps[name] !== relPath) {
				deps[name] = relPath;
				packagesAdded++;
			}
		}

		if ((packagesAdded > 0 || packagesRemoved > 0) && !this.dryRun) {
			mkdirSync(this.targetDir, { recursive: true });
			writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf8');
		}

		return {
			added: packagesAdded,
			removed: packagesRemoved,
			total: localPackages.size,
		};
	}

	// ── npm install ──────────────────────────────────────────────

	/**
	 * 在目标根目录执行 npm install。
	 * 如果 node_modules 已是最新（不早于 package.json/package-lock.json）则跳过。
	 *
	 * @param force 强制安装（跳过缓存的 node_modules 检查）
	 */
	installRoot(force?: boolean): Promise<NpmInstallResult> {
		if (!force && this.dryRun) {
			return Promise.resolve({
				path: this.targetDir,
				success: true,
				output: '[dry-run] npm install would run here',
			});
		}

		if (!force && this._shouldSkipNpmInstall(this.targetDir)) {
			return Promise.resolve({
				path: this.targetDir,
				success: true,
				output: 'node_modules up-to-date, skipped',
			});
		}

		return this._runNpmInstall(this.targetDir);
	}

	/**
	 * 为指定扩展列表执行 per-extension npm install。
	 *
	 * 自动跳过：
	 *   - npm 风格扩展（其依赖由 root node_modules 解析）
	 *   - 没有依赖的目录
	 *   - node_modules 已是最新的目录
	 */
	async installExtensions(resources: ResolvedResource[]): Promise<ExtensionInstallSummary> {
		const tasks: Array<{ path: string; name: string }> = [];

		for (const resource of resources) {
			const checkPath = resource.isDirectory
				? resource.targetPath
				: dirname(resource.targetPath);

			// npm 风格扩展的依赖由 root node_modules 解析，跳过本地 install
			if (resource.isDirectory && isNpmPackageDir(checkPath)) {
				continue;
			}

			if (this._hasDependencies(checkPath)) {
				if (this._shouldSkipNpmInstall(checkPath)) {
					continue;
				}
				tasks.push({ path: checkPath, name: resource.name });
			}
		}

		if (this.dryRun) {
			return {
				count: 0,
				skipped: tasks.length,
				failed: 0,
				results: tasks.map((t) => ({
					path: t.path,
					success: true,
					output: '[dry-run] npm install would run here',
				})),
			};
		}

		const results: NpmInstallResult[] = [];
		for (const task of tasks) {
			const result = await this._runNpmInstallAsync(task.path);
			results.push(result);
		}

		return {
			count: results.filter((r) => r.success).length,
			skipped: 0,
			failed: results.filter((r) => !r.success).length,
			results,
		};
	}

	/**
	 * 判断 root package.json 是否有变更（相比当前的 @zenone/* 依赖）。
	 * 用于 installRoot() 调用前判断是否需要安装。
	 */
	hasRootDependencyChanged(localPackages: Map<string, string>): boolean {
		const rootPkgPath = join(this.targetDir, 'package.json');
		if (!existsSync(rootPkgPath)) return true;

		try {
			const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
			const deps: Record<string, string> = rootPkg.dependencies ?? {};

			// 检查是否有 @zenone/* 条目不匹配
			for (const [name, relPath] of localPackages) {
				if (deps[name] !== relPath) return true;
			}

			// 检查是否有多余的 @zenone/* 条目
			for (const depName of Object.keys(deps)) {
				if (depName.startsWith('@zenone/') && !localPackages.has(depName)) {
					return true;
				}
			}

			return false;
		} catch {
			return true;
		}
	}

	// ── 内部方法 ────────────────────────────────────────────────

	/**
	 * 递归扫描目录查找 @zenone/* 包。
	 */
	private _findZenonePackages(dir: string): Map<string, string> {
		const packages = new Map<string, string>();

		const scan = (currentDir: string, depth: number) => {
			if (depth > 6) return;
			let entries: Dirent[];
			try {
				entries = readdirSync(currentDir, { withFileTypes: true });
			} catch {
				return;
			}

			for (const entry of entries) {
				if (entry.name.startsWith('.')) continue;
				if (entry.name === 'node_modules') continue;
				if (!entry.isDirectory()) continue;

				const fullPath = join(currentDir, entry.name);
				const pkgPath = join(fullPath, 'package.json');
				if (!existsSync(pkgPath)) {
					scan(fullPath, depth + 1);
					continue;
				}

				try {
					const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
					if (
						pkg.name &&
						typeof pkg.name === 'string' &&
						pkg.name.startsWith('@zenone/')
					) {
						if (!packages.has(pkg.name)) {
							packages.set(pkg.name, fullPath);
						}
					}
				} catch {
					// 跳过无效 package.json
				}
			}
		};

		scan(dir, 0);
		return packages;
	}

	/**
	 * 检查目录是否有 npm 依赖需要安装。
	 */
	private _hasDependencies(dir: string): boolean {
		const pkgPath = join(dir, 'package.json');
		if (!existsSync(pkgPath)) return false;

		try {
			const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
			if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) return true;
			if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) return true;
			if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) return true;
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * 检查 node_modules 是否已是最新（跳过 npm install）。
	 * 如果 node_modules/ 存在且比 package.json（和 package-lock.json）更新，返回 true。
	 */
	private _shouldSkipNpmInstall(dir: string): boolean {
		const pkgPath = join(dir, 'package.json');
		const nodeModulesPath = join(dir, 'node_modules');
		if (!existsSync(nodeModulesPath)) return false;
		if (!existsSync(pkgPath)) return true;
		try {
			const pkgStat = statSync(pkgPath);
			const nmStat = statSync(nodeModulesPath);
			const lockPath = join(dir, 'package-lock.json');
			if (existsSync(lockPath)) {
				const lockStat = statSync(lockPath);
				return nmStat.mtimeMs >= Math.max(pkgStat.mtimeMs, lockStat.mtimeMs);
			}
			return nmStat.mtimeMs >= pkgStat.mtimeMs;
		} catch {
			return false;
		}
	}

	/**
	 * 同步执行 npm install。
	 */
	private _runNpmInstall(dir: string): Promise<NpmInstallResult> {
		if (this.dryRun) {
			return Promise.resolve({
				path: dir,
				success: true,
				output: '[dry-run] npm install would run here',
			});
		}

		try {
			const output = execSync('npm install', {
				cwd: dir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 120_000,
			});
			return Promise.resolve({ path: dir, success: true, output: output.trim() });
		} catch (err: unknown) {
			const error = err as { stdout?: string; stderr?: string; message?: string };
			const msg = error.stderr || error.stdout || error.message || 'unknown error';
			return Promise.resolve({ path: dir, success: false, output: msg });
		}
	}

	private _execPromise = promisify(exec);

	/**
	 * 异步执行 npm install（用于 per-extension 并行执行）。
	 */
	private async _runNpmInstallAsync(dir: string): Promise<NpmInstallResult> {
		if (this.dryRun) {
			return { path: dir, success: true, output: '[dry-run] npm install would run here' };
		}

		try {
			const { stdout, stderr } = await this._execPromise('npm install', {
				cwd: dir,
				encoding: 'utf8',
				timeout: 120_000,
			});
			return { path: dir, success: true, output: (stdout + stderr).trim() };
		} catch (err: unknown) {
			const error = err as {
				stdout?: string;
				stderr?: string;
				code?: number;
				message?: string;
			};
			const msg = (
				error.stderr ||
				error.stdout ||
				error.message ||
				'unknown error'
			).toString();
			return { path: dir, success: false, output: msg };
		}
	}
}
