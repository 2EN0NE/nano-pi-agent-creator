/**
 * Extension Dev Final Sync
 *
 * 自动同步扩展：在每轮 agent 对话结束后（agent_end），检测 extensions/ 目录下的文件变更。
 * 如果变更涉及扩展插件的修改，且通过 TypeScript 编译检查，则自动同步到 ./.pi/extensions/。
 *
 * 原理：
 * 1. agent_end 事件 → 对话结束
 * 2. git diff HEAD -- extensions/ → 检测变更
 * 3. npx tsc --noEmit → 全量编译检查（过滤只关心变更文件的错误）
 * 4. 直接拷贝扩展文件到 ./.pi/extensions/（不依赖 sync-to-local-pi.ts）
 *     - 单文件扩展（.ts）：直接拷贝
 *     - 目录扩展（index.ts）：递归拷贝（跳过 node_modules）
 *     - npm 包扩展（package.json）：拷贝后运行 npm install，注册 @zenone/* 依赖
 *
 * 保护措施：
 * - syncingInProgress flag 防止重入
 * - 只同步通过编译检查的扩展
 * - 只检查变更文件是否有错误（跳过项目中其他预存错误的干扰）
 */

import { createLogger } from '@zenone/pi-logger';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
	existsSync,
	mkdirSync,
	cpSync,
	rmSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
const log = createLogger('extension-dev-final-sync');

/** 同步进行中的保护锁，防止 agent_end → 同步 → 触发其他事件 → 再进 agent_end 的重入 */
let syncingInProgress = false;

/** 累计是否有 @zenone/* 包注册到 .pi/package.json，需要在同步完成后运行一次根 npm install */
let pendingPiRootInstall = false;

/**
 * 查找扩展文件在项目中的路径
 * extensions/ 下有 7 个分类子目录，在子目录中查找匹配的扩展文件
 * 支持 .ts 和 .tsx 两种文件后缀
 */
function findExtensionPath(ctx: ExtensionContext, extName: string): string | null {
	const extRoot = join(ctx.cwd, 'extensions');
	const categories = ['tui', 'context', 'security', 'auto', 'accuracy', 'verification', 'meta'];

	for (const cat of categories) {
		const dirPath = join(extRoot, cat, extName);
		const tsPath = join(extRoot, cat, `${extName}.ts`);
		const tsxPath = join(extRoot, cat, `${extName}.tsx`);

		if (existsSync(join(dirPath, 'index.ts'))) {
			return join(dirPath, 'index.ts');
		}
		if (existsSync(join(dirPath, 'index.tsx'))) {
			return join(dirPath, 'index.tsx');
		}
		if (existsSync(tsPath)) return tsPath;
		if (existsSync(tsxPath)) return tsxPath;
	}

	return null;
}

/**
 * 通过 git diff + git status 检测 extensions/ 下变更的扩展名列表
 *
 * 需要同时覆盖四种场景：
 * - 已跟踪文件的修改（工作区） → git diff HEAD
 * - 已跟踪文件的修改（暂存区） → git diff HEAD（同时覆盖）
 * - 已暂存的新文件              → git status --porcelain 的 `A ` 行
 * - 未跟踪的新文件              → git status --porcelain 的 `??` 行
 */
async function getChangedExtensions(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string[]> {
	const extNames = new Set<string>();

	// 1. 已跟踪文件的变更（工作区 + 暂存区，git diff HEAD 覆盖两者）
	const { stdout: diffOut, code: diffCode } = await execCmd(
		'git',
		['diff', '--name-only', 'HEAD', '--', 'extensions/'],
		pi,
		ctx,
	);
	if (diffCode === 0 && diffOut.trim()) {
		extractExtNames(diffOut, extNames);
	}

	// 2. 未跟踪 + 已暂存的新文件
	const { stdout: statusOut, code: statusCode } = await execCmd(
		'git',
		['status', '--porcelain', '--', 'extensions/'],
		pi,
		ctx,
	);
	if (statusCode === 0 && statusOut.trim()) {
		const newFiles = statusOut
			.split('\n')
			// ?? 开头 = 未跟踪的新文件
			.filter((l) => l.startsWith('?? '))
			.map((l) => l.slice(3).trim())
			// 首列 A = 已暂存的新文件（如 `A ` 或 `AM`）
			.concat(
				statusOut
					.split('\n')
					.filter((l) => /^A./.test(l))
					.map((l) => l.slice(2).trim()),
			)
			.filter(Boolean);
		extractExtNames(newFiles.join('\n'), extNames);
	}

	return [...extNames].sort();
}

/**
 * 从文件路径列表中提取扩展名
 * 支持：
 * - 单文件：extensions/{category}/{name}.ts(x)
 * - 目录扩展根入口：extensions/{category}/{name}/index.ts(x)
 * - 目录扩展深层文件：extensions/{category}/{name}/any/file.ts(x)
 * - 裸目录路径（git status 输出）：extensions/{category}/{name}/
 */
export function extractExtNames(output: string, set: Set<string>): void {
	for (const file of output.split('\n')) {
		const f = file.trim();
		if (!f.startsWith('extensions/')) continue;

		// 单文件：extensions/category/name.ts(x)
		const fileMatch = f.match(/^extensions\/[^/]+\/([^/]+)\.tsx?$/);
		// 目录扩展根入口：extensions/category/name/index.ts(x)
		const dirMatch = f.match(/^extensions\/[^/]+\/([^/]+)\/index\.tsx?$/);
		// 裸目录（git status --porcelain 对未跟踪目录的输出）
		const bareDirMatch = f.match(/^extensions\/[^/]+\/([^/.]+)\/?$/);
		// 目录扩展深层文件：extensions/category/name/any/file.ts(x)
		const subMatch = f.match(/^extensions\/[^/]+\/([^/]+)\/.*\.tsx?$/);

		const match = fileMatch || dirMatch || bareDirMatch;

		if (match) {
			set.add(match[1]);
		} else if (subMatch) {
			set.add(subMatch[1]);
		}
	}
}

/**
 * 运行一次全项目 tsc --noEmit，收集所有编译错误输出
 *
 * 返回值语义：
 * - string[] — tsc 成功执行后的错误行列表（空数组 = 完全通过）
 * - null     — tsc 无法执行（代码不可运行、npx 未找到、超时等）
 *
 * 调用方必须检查 null，区分"无错误"和"无法检查"两种场景。
 */
async function runTscCheck(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string[] | null> {
	const { stdout, stderr, code } = await execCmd(
		'npx',
		['tsc', '--noEmit', '--pretty', 'false'],
		pi,
		ctx,
		{ timeout: 60_000 },
	);

	if (code === -1) {
		// execCmd 内部捕获到异常 — tsc 不可执行
		log.error('tsc check failed to execute — skipping validation', {
			stderr: stderr.slice(0, 500),
		});
		return null;
	}

	if (code === 0) return []; // 全项目通过，无错误

	return (stderr + '\n' + stdout).trim().split('\n');
}

/**
 * 用缓存的 tsc 输出检查单个扩展文件是否包含编译错误
 *
 * 匹配策略：仅使用完整的相对路径（relPath）匹配 tsc 错误行。
 * tsc 输出格式：`path/to/file.ts(line,col): error TS...: message`
 * 不匹配 extName 或短路径，避免误将其他文件中提到的同名文本算作自己错误。
 *
 * @param tscLines - runTscCheck 返回的错误行列表。空数组 = 全项目通过。
 *                   调用方保证不为 null（tsc 不可用场景在调用方处理）。
 */
function checkExtensionForErrors(
	extName: string,
	tscLines: string[],
	ctx: ExtensionContext,
): boolean {
	const extPath = findExtensionPath(ctx, extName);
	if (!extPath) {
		log.warn(`Extension "${extName}" not found in project`);
		return false;
	}

	const relPath = extPath.replace(ctx.cwd + '/', '');

	// tsc 完全通过（空数组），所有扩展从验证角度视为合法
	if (tscLines.length === 0) {
		log.debug(`Validation passed for "${extName}" — tsc completed with no errors`);
		return true;
	}

	// 匹配：错误行必须以完整文件路径开头，且紧跟 ( 行号标记
	// tsc 输出格式示例：
	//   extensions/auto/foo.ts(42,5): error TS2322: Type 'X' is not assignable to type 'Y'
	// 用 startsWith(relPath + '(') 避免误匹配同名的 .tsx 文件
	const hasOwnError = tscLines.some((line) => line.startsWith(relPath + '('));

	if (hasOwnError) {
		const ownErrors = tscLines
			.filter((line) => line.startsWith(relPath + '('))
			.slice(0, 10)
			.join('\n');
		log.warn(`Validation failed for "${extName}":`, { errors: ownErrors });
		return false;
	}

	log.debug(`Validation passed for "${extName}" (errors in other files only)`);
	return true;
}

/** 拷贝时要跳过的目录（node_modules 等生成目录） */
const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

/**
 * 解析扩展源信息：确定扩展类型（单文件/目录/npm包）和源/目标路径
 *
 * 返回联合类型区分两种场景：
 * - type === 'file'      → targetFile 是 .ts 文件路径
 * - type === 'directory' → targetDir  是目标目录路径
 */
function resolveExtensionSource(
	extName: string,
	ctx: ExtensionContext,
):
	| { type: 'file'; sourcePath: string; targetFile: string }
	| { type: 'directory'; sourcePath: string; targetDir: string }
	| null {
	const extPath = findExtensionPath(ctx, extName);
	if (!extPath) return null;

	const targetRoot = join(ctx.cwd, '.pi', 'extensions');

	// 判断是否为目录扩展：extPath 指向分类子目录下的 {extName}/index.ts(x)
	// 例如 extensions/meta/worktree/index.ts → 源目录为 extensions/meta/worktree/
	const expectedDir = dirname(extPath); // extensions/{cat}/{extName}
	const dirName = expectedDir.split('/').pop() || '';

	// 检查：extPath 是 {extName}/index.ts(x) 格式 → 目录扩展
	if (
		dirName === extName &&
		(existsSync(join(expectedDir, 'index.ts')) || existsSync(join(expectedDir, 'index.tsx')))
	) {
		return {
			type: 'directory',
			sourcePath: expectedDir,
			targetDir: join(targetRoot, extName),
		};
	}

	// 单文件扩展
	return {
		type: 'file',
		sourcePath: extPath,
		targetFile: join(targetRoot, `${extName}.ts`),
	};
}

/**
 * 递归拷贝目录（跳过 node_modules 等忽略目录）
 */
function copyDirRecursive(sourceDir: string, targetDir: string): void {
	mkdirSync(targetDir, { recursive: true });

	const entries = readdirSync(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;

		const srcPath = join(sourceDir, entry.name);
		const tgtPath = join(targetDir, entry.name);

		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, tgtPath);
		} else {
			mkdirSync(dirname(tgtPath), { recursive: true });
			cpSync(srcPath, tgtPath, { force: true });
		}
	}
}

/**
 * 检查目录是否有 package.json 依赖
 */
function hasDependencies(dir: string): boolean {
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
 * 在 .pi/extensions/{name}/ 中运行 npm install
 * 使用 npm --prefix 指定目标目录（pi.exec 不支持 cwd 参数）
 */
async function runNpmInstall(
	dir: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	log.info(`Running npm install in ${dir}`);
	const { code, stderr } = await execCmd('npm', ['--prefix', dir, 'install'], pi, ctx, {
		timeout: 120_000,
	});
	if (code !== 0) {
		log.error(`npm install failed in ${dir}`, { stderr: stderr.slice(0, 500) });
		return false;
	}
	return true;
}

/**
 * 将 @zenone/* 本地包注册到 .pi/package.json 的 dependencies 中
 */
function registerLocalPackage(extName: string, pkgName: string, ctx: ExtensionContext): void {
	const rootPkgPath = join(ctx.cwd, '.pi', 'package.json');
	if (!existsSync(rootPkgPath)) {
		log.debug('No .pi/package.json found, skipping local package registration');
		return;
	}

	try {
		const raw = readFileSync(rootPkgPath, 'utf8');
		const pkg = JSON.parse(raw);
		if (!pkg.dependencies) pkg.dependencies = {};

		if (!pkg.dependencies[pkgName]) {
			pkg.dependencies[pkgName] = `./extensions/${extName}`;
			writeFileSync(rootPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
			log.info(`Registered ${pkgName} → ./extensions/${extName} in .pi/package.json`);
		}
	} catch (err) {
		log.error('Failed to update .pi/package.json', { error: String(err) });
	}
}

/**
 * 同步扩展到目标目录（.pi/extensions/）
 *
 * 自包含实现，不依赖 sync-to-local-pi.ts 脚本：
 * 1. 解析扩展类型（单文件/目录）和源路径
 * 2. 拷贝源文件到 .pi/extensions/{name}
 * 3. 对于目录扩展：读取 package.json，注册 @zenone/* 本地依赖，运行 npm install
 * 4. 注册 @zenone/* 时标记 pendingPiRootInstall，待同步完成后再在 .pi/ 根目录运行 npm install
 *
 * ⚠ 不会删除 .pi/extensions/ 中其他已有扩展（无 stale deletion）
 */
async function syncExtension(
	extName: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	// 1. 解析扩展源信息
	const info = resolveExtensionSource(extName, ctx);
	if (!info) {
		log.error(`Cannot find extension source for "${extName}"`);
		return false;
	}

	try {
		// 2. 拷贝文件
		if (info.type === 'file') {
			mkdirSync(dirname(info.targetFile), { recursive: true });
			cpSync(info.sourcePath, info.targetFile, { force: true });
			log.info(`Synced file extension "${extName}" → ${info.targetFile}`);
			return true;
		}

		// 以下为 directory 类型
		const targetDir = info.targetDir;
		log.info(`Syncing directory extension "${extName}" → ${targetDir}`);

		// 先清空目标再拷贝（避免残留旧文件）
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		copyDirRecursive(info.sourcePath, targetDir);

		// 3. 读取 package.json（如果有），处理 @zenone/* 本地包注册
		const pkgPath = join(targetDir, 'package.json');
		if (existsSync(pkgPath)) {
			let pkg: Record<string, unknown> = {};
			try {
				pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
			} catch {
				log.warn(`Invalid package.json in "${extName}"`);
			}

			const pkgName = pkg.name as string | undefined;

			// 任何 name 以 @zenone/ 开头的目录扩展，都注册到 .pi/package.json
			// （不依赖 pi 字段，pi-logger 等基础设施包也需要注册）
			if (pkgName && typeof pkgName === 'string' && pkgName.startsWith('@zenone/')) {
				registerLocalPackage(extName, pkgName, ctx);
				pendingPiRootInstall = true;
			}

			// 4. 有依赖就运行 npm install（安装扩展自身的 npm 依赖）
			if (hasDependencies(targetDir)) {
				const ok = await runNpmInstall(targetDir, pi, ctx);
				if (!ok) {
					log.error(
						`npm install failed for "${extName}" — sync aborted, deps not available`,
					);
					return false;
				}
			}
		}

		log.info(`Sync completed for "${extName}"`);
		return true;
	} catch (err) {
		log.error(`Sync failed for "${extName}"`, { error: String(err) });
		return false;
	}
}

/**
 * 封装 pi.exec，统一错误处理
 *
 * ⚠ 需要显式传入 pi 引用（而非依赖模块级变量），
 * 避免 /reload 场景下 jiti 重新执行 default export 导致的时序问题。
 */
async function execCmd(
	command: string,
	args: string[],
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
	const cwd = ctx.cwd;
	try {
		const result = await pi.exec(command, args, {
			cwd,
			timeout: opts?.timeout ?? 30_000,
		});
		return result;
	} catch (e) {
		log.error(`exec failed: ${command} ${args.join(' ')}`, { error: String(e) });
		return { stdout: '', stderr: String(e), code: -1 };
	}
}

/**
/** 模块级持久的 pi API 引用，default export 时赋值 */
let pi: ExtensionAPI;

export default function (api: ExtensionAPI): void {
	pi = api;

	log.debug('Extension loaded');

	// ── agent_end 事件：每轮对话结束后触发 ────────────────────
	pi.on('agent_end', async (_event, ctx) => {
		log.debug('event: agent_end');

		// 保护锁：防止重入（同步过程中另一个 agent_end 事件到达）
		if (syncingInProgress) {
			log.debug('Sync already in progress, skipping');
			return;
		}

		syncingInProgress = true;
		let notifyTitle = '';
		let notifyLevel: 'info' | 'warning' = 'info';

		try {
			// 1. 检测 extensions/ 目录下的变更
			const changed = await getChangedExtensions(pi, ctx);
			if (changed.length === 0) {
				log.debug('No extensions changed, skipping');
				notifyTitle = '✅ 无扩展变更，无需同步';
			} else {
				log.info('Changed extensions:', changed.join(', '));

				// 2. 运行一次全项目 tsc 检查，收集错误输出
				const tscResult = await runTscCheck(pi, ctx);

				// tsc 不可执行时跳过同步，避免静默降级
				if (tscResult === null) {
					log.info('Skipping sync — tsc is not available');
					notifyTitle = '⚠️ tsc 不可用，跳过同步';
					notifyLevel = 'warning';
				} else {
					// 3. 用缓存的 tsc 输出逐扩展过滤编译错误
					const validExts: string[] = [];
					for (const extName of changed) {
						if (checkExtensionForErrors(extName, tscResult, ctx)) {
							validExts.push(extName);
						} else {
							log.info(`Skipping "${extName}" — TS validation failed`);
						}
					}

					if (validExts.length === 0) {
						log.debug('No valid extensions to sync');
						notifyTitle = `⚠️ ${changed.join(', ')} 有编译错误，未同步`;
						notifyLevel = 'warning';
					} else {
						// 4. 同步通过验证的扩展
						const synced: string[] = [];
						const failed: string[] = [];
						for (const extName of validExts) {
							if (await syncExtension(extName, pi, ctx)) {
								synced.push(extName);
							} else {
								failed.push(extName);
							}
						}

						// 5. 如果注册了 @zenone/* 本地包，在 .pi/ 根目录运行 npm install 创建 symlink
						if (pendingPiRootInstall && synced.length > 0) {
							const piDir = join(ctx.cwd, '.pi');
							log.info('Running npm install in .pi/ root for @zenone/* symlinks');
							const ok = await runNpmInstall(piDir, pi, ctx);
							if (!ok) {
								log.error('Root npm install failed — @zenone/* deps not linked');
							}
							pendingPiRootInstall = false;
						}

						// 6. 日志记录
						if (synced.length > 0) {
							log.info(`已同步: ${synced.join(', ')}`);
						}
						if (failed.length > 0) {
							log.warn(`同步失败: ${failed.join(', ')}`);
						}

						// 7. 构建通知消息
						const parts: string[] = [];
						if (synced.length > 0) {
							parts.push(`已同步 ${synced.join(', ')} 到 ./.pi/extensions/`);
						}
						if (failed.length > 0) {
							parts.push(`${failed.join(', ')} 同步失败（见日志）`);
						}
						if (parts.length > 0) {
							notifyTitle = parts.join('；') + '，可以 /reload 进行用户测试';
							notifyLevel = failed.length > 0 ? 'warning' : 'info';
						}
					}
				}
			}
		} finally {
			syncingInProgress = false;
		}

		// 始终推送通知
		if (ctx.hasUI && notifyTitle) {
			ctx.ui.notify(notifyTitle, notifyLevel);
		}
	});
}
