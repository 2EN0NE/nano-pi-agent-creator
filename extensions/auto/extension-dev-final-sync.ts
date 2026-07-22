/**
 * Extension Dev Final Sync
 *
 * 自动同步扩展：在每轮 agent 对话结束后（agent_end），检测 extensions/ 目录下的文件变更。
 * 如果变更涉及扩展插件的修改，且通过 TypeScript 编译检查，则自动同步到目标目录。
 * 目标决策：检查用户级 ~/.pi/agent/extensions/ 和项目级 ./.pi/extensions/ 中扩展的存在情况。
 * - 两者都有 → 都更新
 * - 只有一个有 → 更新对应的
 * - 都没有 → 放到项目级
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
import { homedir } from 'node:os';
const log = createLogger('extension-dev-final-sync');

/** 同步进行中的保护锁，防止 agent_end → 同步 → 触发其他事件 → 再进 agent_end 的重入 */
let syncingInProgress = false;

/** 累计哪些 pi 根目录注册了 @zenone/* 本地包，需要在同步完成后对每个目录运行根 npm install */
const pendingPiRootDirs = new Set<string>();

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
 * 检查扩展是否存在于指定的扩展根目录中
 * 支持单文件 (.ts/.tsx) 和目录 (index.ts/.tsx) 两种形式
 */
function extensionExistsInDir(extDir: string, extName: string): boolean {
	return (
		existsSync(join(extDir, `${extName}.ts`)) ||
		existsSync(join(extDir, `${extName}.tsx`)) ||
		existsSync(join(extDir, extName, 'index.ts')) ||
		existsSync(join(extDir, extName, 'index.tsx'))
	);
}

/**
 * 解析同步目标根目录路径列表及其人类可读标签
 *
 * 返回结构：
 * - roots：同步目标根目录列表（用户级和/或项目级）
 * - label：人类可读的标签（用于通知消息，如 "用户级 + 项目级"）
 *
 * 策略：
 * 1. 检查用户级 ~/.pi/agent/extensions/ 和项目级 ./.pi/extensions/ 中扩展的存在情况
 * 2. 如果两者都有该扩展 → 返回两者（都更新）
 * 3. 如果只有其中一个有 → 只更新对应的目录
 * 4. 如果都没有 → 返回项目级目录（默认放置位置）
 */
function resolveSyncTargets(
	extName: string,
	ctx: ExtensionContext,
): { roots: string[]; label: string } {
	const userExtDir = join(homedir(), '.pi', 'agent', 'extensions');
	const projectExtDir = join(ctx.cwd, '.pi', 'extensions');

	const hasUser = extensionExistsInDir(userExtDir, extName);
	const hasProject = extensionExistsInDir(projectExtDir, extName);

	if (hasUser && hasProject) {
		log.debug(
			`Extension "${extName}" found in both user (~/.pi/agent/extensions/) and project (.pi/extensions/) — updating both`,
		);
		return { roots: [userExtDir, projectExtDir], label: '用户级 + 项目级' };
	}
	if (hasUser) {
		log.debug(
			`Extension "${extName}" found in user (~/.pi/agent/extensions/) only — updating user`,
		);
		return { roots: [userExtDir], label: '用户级 (~/.pi/agent/extensions/)' };
	}
	if (hasProject) {
		log.debug(
			`Extension "${extName}" found in project (.pi/extensions/) only — updating project`,
		);
		return { roots: [projectExtDir], label: '项目级 (.pi/extensions/)' };
	}

	log.debug(`Extension "${extName}" not found in either — placing in project (.pi/extensions/)`);
	return { roots: [projectExtDir], label: '项目级 (.pi/extensions/)' };
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
 * 解析扩展源信息：确定扩展类型（单文件/目录/npm包）和源路径
 *
 * 目标路径不再在此计算，由 syncExtension 根据 resolveSyncTargets 返回的根目录列表动态构造。
 *
 * 返回类型：
 * - type === 'file'      → sourcePath 指向 .ts(x) 文件
 * - type === 'directory' → sourcePath 指向扩展目录（含 index.ts 的目录）
 */
function resolveExtensionSource(
	extName: string,
	ctx: ExtensionContext,
): { type: 'file'; sourcePath: string } | { type: 'directory'; sourcePath: string } | null {
	const extPath = findExtensionPath(ctx, extName);
	if (!extPath) return null;

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
		};
	}

	// 单文件扩展
	return {
		type: 'file',
		sourcePath: extPath,
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
 * 将 @zenone/* 本地包注册到指定 pi 根目录的 package.json 中
 *
 * @param extName - 扩展名（用作相对路径目录名）
 * @param pkgName - @zenone/* 包名
 * @param piDir   - pi 根目录（~/.pi/agent/ 或 ./.pi/）
 */
function registerLocalPackageAtRoot(extName: string, pkgName: string, piDir: string): void {
	const pkgFilePath = join(piDir, 'package.json');
	if (!existsSync(pkgFilePath)) {
		log.debug(`No package.json found at ${piDir}, skipping local package registration`);
		return;
	}

	try {
		const raw = readFileSync(pkgFilePath, 'utf8');
		const pkg = JSON.parse(raw);
		if (!pkg.dependencies) pkg.dependencies = {};

		if (!pkg.dependencies[pkgName]) {
			pkg.dependencies[pkgName] = `./extensions/${extName}`;
			writeFileSync(pkgFilePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
			log.info(`Registered ${pkgName} → ./extensions/${extName} in ${pkgFilePath}`);
		}
	} catch (err) {
		log.error('Failed to update package.json at ' + pkgFilePath, { error: String(err) });
	}
}

/**
 * 将扩展同步到单个目标根目录
 *
 * @param sourceInfo - 扩展源信息（类型 + 源路径）
 * @param targetRoot - 目标根目录（~/.pi/agent/extensions/ 或 ./.pi/extensions/）
 * @param extName    - 扩展名
 * @param pi         - ExtensionAPI 引用
 * @param ctx        - ExtensionContext 引用
 * @returns 同步是否成功
 */
async function syncToTargetRoot(
	sourceInfo: { type: 'file'; sourcePath: string } | { type: 'directory'; sourcePath: string },
	targetRoot: string,
	extName: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	try {
		if (sourceInfo.type === 'file') {
			const targetFile = join(targetRoot, `${extName}.ts`);
			mkdirSync(dirname(targetFile), { recursive: true });
			cpSync(sourceInfo.sourcePath, targetFile, { force: true });
			log.info(`Synced file extension "${extName}" → ${targetFile}`);
			return true;
		}

		// 以下为 directory 类型
		const targetDir = join(targetRoot, extName);
		log.info(`Syncing directory extension "${extName}" → ${targetDir}`);

		// 先清空目标再拷贝（避免残留旧文件）
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		copyDirRecursive(sourceInfo.sourcePath, targetDir);

		// 读取 package.json（如果有），处理 @zenone/* 本地包注册
		const pkgPath = join(targetDir, 'package.json');
		if (existsSync(pkgPath)) {
			let pkg: Record<string, unknown> = {};
			try {
				pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
			} catch {
				log.warn(`Invalid package.json in "${extName}"`);
			}

			const pkgName = pkg.name as string | undefined;

			// 任何 name 以 @zenone/ 开头的目录扩展，都在对应 pi 根目录的 package.json 中注册
			// 用户级 → ~/.pi/agent/package.json，项目级 → ./.pi/package.json
			if (pkgName && typeof pkgName === 'string' && pkgName.startsWith('@zenone/')) {
				const piDir = dirname(targetRoot);
				registerLocalPackageAtRoot(extName, pkgName, piDir);
				pendingPiRootDirs.add(piDir);
			}

			// 有依赖就运行 npm install（安装扩展自身的 npm 依赖）
			if (hasDependencies(targetDir)) {
				const ok = await runNpmInstall(targetDir, pi, ctx);
				if (!ok) {
					log.error(`npm install failed for "${extName}" — cleaning up and aborting`);
					// 清除已落地的拷贝文件，避免留下破损扩展
					if (existsSync(targetDir)) {
						rmSync(targetDir, { recursive: true, force: true });
					}
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
 * 同步扩展到目标目录
 *
 * 自包含实现，不依赖 sync-to-local-pi.ts 脚本：
 * 1. 解析扩展类型（单文件/目录）和源路径
 * 2. 调用 resolveSyncTargets 确定目标根目录列表
 * 3. 遍历每个目标根目录，执行拷贝、npm install、依赖注册
 *
 * 目标决策：
 * - 用户级 (~/.pi/agent/extensions/) 和项目级 (.pi/extensions/) 都有的 → 两者都更新
 * - 只有其中一个有 → 只更新存在的
 * - 都没有 → 放到项目级
 *
 * ⚠ 不会删除目标中其他已有扩展（无 stale deletion）
 *
 * @returns 是否所有目标都同步成功
 */
async function syncExtension(
	extName: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	// 1. 解析扩展源信息
	const sourceInfo = resolveExtensionSource(extName, ctx);
	if (!sourceInfo) {
		log.error(`Cannot find extension source for "${extName}"`);
		return false;
	}

	// 2. 解析目标根目录列表
	const { roots: targetRoots } = resolveSyncTargets(extName, ctx);

	// 3. 遍历同步每个目标
	let allOk = true;
	for (const targetRoot of targetRoots) {
		const ok = await syncToTargetRoot(sourceInfo, targetRoot, extName, pi, ctx);
		if (!ok) allOk = false;
	}

	return allOk;
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

	log.info('Extension loaded');

	// ── agent_end 事件：每轮对话结束后触发 ────────────────────
	pi.on('agent_end', async (_event, ctx) => {
		log.info('event: agent_end');

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
				log.info('No extensions changed, skipping');
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
						log.info('No valid extensions to sync');
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

						// 5. 如果注册了 @zenone/* 本地包，在每个涉及到的 pi 根目录运行 npm install 创建 symlink
						if (pendingPiRootDirs.size > 0 && synced.length > 0) {
							for (const piDir of pendingPiRootDirs) {
								log.info(`Running npm install in ${piDir} for @zenone/* symlinks`);
								const ok = await runNpmInstall(piDir, pi, ctx);
								if (!ok) {
									log.error(
										`Root npm install failed at ${piDir} — @zenone/* deps not linked`,
									);
								}
							}
							pendingPiRootDirs.clear();
						}

						// 6. 日志记录
						if (synced.length > 0) {
							log.info(`已同步: ${synced.join(', ')}`);
						}
						if (failed.length > 0) {
							log.warn(`同步失败: ${failed.join(', ')}`);
						}

						// 7. 构建通知消息（含目标位置描述）
						const parts: string[] = [];
						if (synced.length > 0) {
							const targetLabels = synced
								.map((name) => {
									const { label } = resolveSyncTargets(name, ctx);
									return `${name} → ${label}`;
								})
								.join('，');
							parts.push(`已同步 ${targetLabels}`);
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
