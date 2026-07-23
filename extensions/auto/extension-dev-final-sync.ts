/**
 * Extension Dev Final Sync v2
 *
 * 自动同步扩展：在每轮 agent 对话结束后（agent_end），检测 extensions/ 目录下的文件变更。
 * 如果变更涉及扩展插件的修改，且通过 TypeScript 编译检查，则自动同步到目标目录。
 *
 * 改进点（v2）：
 * 1. [重入安全] SyncGate -> 同步进行中新请求标记 pending，下次同步自动重检测所有变更
 * 2. [tsc 优化] 优先用 node_modules/.bin/tsc 而非 npx，减少 2-3s 启动开销
 * 3. [Profile 对齐] 读取 sync-profiles.yaml/.pi-sync-config.json 决定同步目标
 * 4. [非 .ts 检测] extractExtNames 支持 package.json 等非 TS 文件变更
 * 5. [错误可见] 同步失败时通过 notify + log 告知用户
 *
 * 降级策略：
 * - 找不到 profile 配置时，回退到原有的 extensionExistsInDir 逻辑
 * - node_modules/.bin/tsc 不存在时回退到 npx tsc
 * - 解析器失败时回退到内置解析
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

// ══════════════════════════════════════════════════════════════════════════════
// SyncGate — 重入保护 + pending 跟踪
// ══════════════════════════════════════════════════════════════════════════════

class SyncGate {
	private _inProgress = false;
	private _pending = false;

	get inProgress(): boolean {
		return this._inProgress;
	}

	get pending(): boolean {
		return this._pending;
	}

	/**
	 * 尝试执行同步。如果同步进行中，标记 pending 并返回 'queued'。
	 * @returns 'synced' — 同步已执行；'queued' — 进行了中，已排队
	 */
	async run(fn: () => Promise<void>): Promise<'synced' | 'queued'> {
		if (this._inProgress) {
			this._pending = true;
			return 'queued';
		}
		this._inProgress = true;
		this._pending = false;
		try {
			await fn();
			return 'synced';
		} finally {
			this._inProgress = false;
		}
	}

	/** 消费 pending 标记（同步后需要重新检测变更时调用） */
	consumePending(): boolean {
		if (this._pending) {
			this._pending = false;
			return true;
		}
		return false;
	}
}

const syncGate = new SyncGate();

// ══════════════════════════════════════════════════════════════════════════════
// Profile 配置解析（无 js-yaml 依赖的简易 YAML 解析器 + JSON 备用）
// ══════════════════════════════════════════════════════════════════════════════

interface YamlProfilesConfig {
	profiles: Record<
		string,
		{
			description?: string;
			target: string;
			extensions: string[] | '*';
			exclude?: Record<string, string[]>;
		}
	>;
}

/** 已知的关键字（不是 profile 名） */
const KNOWN_FIELD_KEYS = new Set([
	'description',
	'target',
	'extensions',
	'skills',
	'themes',
	'prompts',
	'exclude',
	'npmBuild',
]);

/** 简易 YAML 解析（仅支持本工具需要的二级键值列表格式） */
function parseSimpleYaml(raw: string, configPath?: string): YamlProfilesConfig | null {
	// 先尝试 JSON 解析（兼容 .json 格式 + YAML 的 JSON 子集）
	try {
		return JSON.parse(raw);
	} catch {
		// 不是 JSON，走 YAML 解析路径
	}

	if (!raw.includes('profiles:')) {
		log.warn(`Config ${configPath ?? '(unknown)'} has no "profiles:" — not a valid config`);
		return null;
	}

	const result = { profiles: {} } as YamlProfilesConfig;
	const profiles = result.profiles;
	const lines = raw.split('\n');

	let currentProfile: string | null = null;
	let currentSection: string | null = null;
	let inExclude = false;
	let excludeType: string | null = null;

	/** 去除行中的 # 注释 */
	function stripComment(line: string): string {
		const idx = line.indexOf(' #');
		return idx >= 0 ? line.slice(0, idx) : line;
	}

	/** 去除引号包裹 */
	function stripQuotes(s: string): string {
		return s.replace(/^['"]|['"]$/g, '').trim();
	}

	for (const rawLine of lines) {
		const line = stripComment(rawLine.trim());
		if (!line || line.startsWith('#')) continue;

		// 根级 profiles:
		if (line === 'profiles:') continue;

		// profile 名检测
		const profileMatch = line.match(/^(\S+):$/);
		if (profileMatch && !line.startsWith('-')) {
			const name = profileMatch[1];
			if (name === 'profiles' || KNOWN_FIELD_KEYS.has(name)) continue;
			currentProfile = name;
			currentSection = null;
			inExclude = false;
			excludeType = null;
			profiles[currentProfile] = { target: '', extensions: [] };
			continue;
		}

		// exclude 内的子 section（先于 fieldMatch 匹配，避免被吃掉）
		const subFieldMatch = line.match(/^(\S+):\s*$/);
		if (
			subFieldMatch &&
			currentProfile &&
			currentSection === 'exclude' &&
			KNOWN_FIELD_KEYS.has(subFieldMatch[1])
		) {
			excludeType = subFieldMatch[1];
			inExclude = true;
			continue;
		}

		// 字段 key: value
		const fieldMatch = line.match(/^(\S+):\s*(.*)$/);
		if (fieldMatch && currentProfile) {
			const key = fieldMatch[1];
			const val = fieldMatch[2].trim();
			if (!KNOWN_FIELD_KEYS.has(key)) continue;
			const profile = profiles[currentProfile];

			if (key === 'target' && val) {
				profile.target = stripQuotes(val);
				continue;
			}
			if (
				(key === 'extensions' ||
					key === 'skills' ||
					key === 'themes' ||
					key === 'prompts') &&
				!val
			) {
				currentSection = key;
				inExclude = false;
				continue;
			}
			if (key === 'exclude' && !val) {
				currentSection = 'exclude';
				inExclude = false;
				continue;
			}
			if (
				(key === 'extensions' ||
					key === 'skills' ||
					key === 'themes' ||
					key === 'prompts') &&
				val
			) {
				if (val === "'*'" || val === '"*"' || val === '*') {
					profile.extensions = '*';
				} else if (val.startsWith('[')) {
					const inner = val.slice(1, -1);
					const list = inner
						.split(',')
						.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
						.filter(Boolean);
					if (list.length > 0) profile.extensions = list;
				}
			}
			continue;
		}

		// 列表项
		const listItemMatch = line.match(/^-\s*(.+)$/);
		if (listItemMatch && currentProfile) {
			const name = stripQuotes(listItemMatch[1]);
			if (
				currentSection === 'extensions' ||
				currentSection === 'skills' ||
				currentSection === 'themes' ||
				currentSection === 'prompts'
			) {
				if (Array.isArray(profiles[currentProfile].extensions)) {
					(profiles[currentProfile].extensions as string[]).push(name);
				}
			} else if (inExclude && excludeType) {
				if (!profiles[currentProfile].exclude) profiles[currentProfile].exclude = {};
				if (!profiles[currentProfile].exclude![excludeType])
					profiles[currentProfile].exclude![excludeType] = [];
				profiles[currentProfile].exclude![excludeType].push(name);
			}
		}
	}

	// 清理无 target 的 profile
	for (const key of Object.keys(profiles)) {
		if (!profiles[key].target) delete profiles[key];
	}

	return Object.keys(profiles).length > 0 ? result : null;
}

/** 根据 extName 在 profile 配置中解析目标目录列表 */
function resolveFromProfiles(
	extName: string,
	profiles: Record<
		string,
		{ target: string; extensions: string[] | '*'; exclude?: Record<string, string[]> }
	>,
): { roots: string[]; label: string } | null {
	const matchedTargets = new Set<string>();

	for (const [, entry] of Object.entries(profiles)) {
		const excludeList: string[] = [];
		if (entry.exclude?.extensions) excludeList.push(...entry.exclude.extensions);
		if (excludeList.includes(extName)) continue;

		if (entry.extensions === '*') {
			matchedTargets.add(entry.target);
		} else if (Array.isArray(entry.extensions) && entry.extensions.includes(extName)) {
			matchedTargets.add(entry.target);
		}
	}

	if (matchedTargets.size > 0) {
		const roots = [...matchedTargets].sort();
		const label = roots
			.map((r) => {
				if (r.includes('.pi/agent')) return '用户级 (~/.pi/agent/extensions/)';
				if (r.includes('.pi') || r.includes('./.pi')) return '项目级 (.pi/extensions/)';
				return r;
			})
			.join('、');
		return { roots, label };
	}
	return null;
}

/** 尝试从多个路径读取 profile 配置，返回 profiles 映射或 null */
function loadProfileConfig(
	projectRoot: string,
): Record<
	string,
	{ target: string; extensions: string[] | '*'; exclude?: Record<string, string[]> }
> | null {
	const candidates = [
		join(projectRoot, '.pi-sync-config.json'),
		join(projectRoot, 'scripts', 'sync-profiles.yaml'),
		join(projectRoot, 'sync-profiles.yaml'),
		join(homedir(), '.pi', 'agent', 'sync-profiles.yaml'),
	];

	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		try {
			const raw = readFileSync(filePath, 'utf8');
			const config = parseSimpleYaml(raw, filePath);
			if (config?.profiles && Object.keys(config.profiles).length > 0) {
				log.info(`Loaded profile config from ${filePath}`);
				return config.profiles;
			}
		} catch (err) {
			log.warn(`Failed to parse config ${filePath}: ${String(err)}`);
		}
	}

	return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 扩展名提取增强版（支持 package.json 等非 .ts 文件）
// ══════════════════════════════════════════════════════════════════════════════

/** 从文件路径列表中提取扩展名 */
export function extractExtNames(output: string, set: Set<string>): void {
	for (const file of output.split('\n')) {
		const f = file.trim();
		if (!f.startsWith('extensions/')) continue;

		// 单文件：extensions/category/name.ts(x)
		const fileMatch = f.match(/^extensions\/[^/]+\/([^/]+)\.tsx?$/);
		// 目录扩展根入口：extensions/category/name/index.ts(x)
		const dirMatch = f.match(/^extensions\/[^/]+\/([^/]+)\/index\.tsx?$/);
		// 裸目录（git status 对未跟踪目录的输出）
		const bareDirMatch = f.match(/^extensions\/[^/]+\/([^/.]+)\/?$/);
		// 目录扩展深层 .ts 文件
		const subMatch = f.match(/^extensions\/[^/]+\/([^/]+)\/.*\.tsx?$/);
		// 目录扩展深层非 .ts 文件（4+ 层深度，排除 category 级文件）
		const nonTSDeepMatch = f.match(/^extensions\/[^/]+\/([^/]+)\/.+$/);

		const match = fileMatch || dirMatch || bareDirMatch;
		if (match) {
			set.add(match[1]);
		} else if (subMatch) {
			set.add(subMatch[1]);
		} else if (nonTSDeepMatch) {
			set.add(nonTSDeepMatch[1]);
		}
	}
}

// ══════════════════════════════════════════════════════════════════════════════
// 扩展目录查找+目标决议
// ══════════════════════════════════════════════════════════════════════════════

/** 7 个分类子目录 */
const EXT_CATEGORIES = ['tui', 'context', 'security', 'auto', 'accuracy', 'verification', 'meta'];

function findExtensionPath(ctx: ExtensionContext, extName: string): string | null {
	const extRoot = join(ctx.cwd, 'extensions');
	for (const cat of EXT_CATEGORIES) {
		const dirPath = join(extRoot, cat, extName);
		const tsPath = join(extRoot, cat, `${extName}.ts`);
		const tsxPath = join(extRoot, cat, `${extName}.tsx`);
		if (existsSync(join(dirPath, 'index.ts'))) return join(dirPath, 'index.ts');
		if (existsSync(join(dirPath, 'index.tsx'))) return join(dirPath, 'index.tsx');
		if (existsSync(tsPath)) return tsPath;
		if (existsSync(tsxPath)) return tsxPath;
	}
	return null;
}

function extensionExistsInDir(extDir: string, extName: string): boolean {
	return (
		existsSync(join(extDir, `${extName}.ts`)) ||
		existsSync(join(extDir, `${extName}.tsx`)) ||
		existsSync(join(extDir, extName, 'index.ts')) ||
		existsSync(join(extDir, extName, 'index.tsx'))
	);
}

/** 从 profile 或 dir-exists 逻辑确定同步目标 */

/** profile 配置惰性缓存，避免同一轮同步中重复读取解析 */
let _profileCache: Record<
	string,
	{ target: string; extensions: string[] | '*'; exclude?: Record<string, string[]> }
> | null = null;
let _profileCacheCwd = '';

function resolveSyncTargets(
	extName: string,
	ctx: ExtensionContext,
): { roots: string[]; label: string } {
	// 优先尝试 profile 配置（惰性缓存，避免重复读取解析）
	try {
		if (_profileCache === null || _profileCacheCwd !== ctx.cwd) {
			_profileCache = loadProfileConfig(ctx.cwd);
			_profileCacheCwd = ctx.cwd;
		}
		if (_profileCache) {
			const result = resolveFromProfiles(extName, _profileCache);
			if (result) return result;
		}
	} catch (err) {
		log.warn('Profile-based resolution failed, falling back to dir check', {
			error: String(err),
		});
	}

	// 降级：检查目标目录是否存在该扩展
	const userExtDir = join(homedir(), '.pi', 'agent', 'extensions');
	const projectExtDir = join(ctx.cwd, '.pi', 'extensions');
	const hasUser = extensionExistsInDir(userExtDir, extName);
	const hasProject = extensionExistsInDir(projectExtDir, extName);

	if (hasUser && hasProject)
		return { roots: [userExtDir, projectExtDir], label: '用户级 + 项目级' };
	if (hasUser) return { roots: [userExtDir], label: '用户级 (~/.pi/agent/extensions/)' };
	if (hasProject) return { roots: [projectExtDir], label: '项目级 (.pi/extensions/)' };
	return { roots: [projectExtDir], label: '项目级 (.pi/extensions/)' };
}

// ══════════════════════════════════════════════════════════════════════════════
// Git 变更检测
// ══════════════════════════════════════════════════════════════════════════════

async function getChangedExtensions(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string[]> {
	const extNames = new Set<string>();
	const { stdout: diffOut, code: diffCode } = await execCmd(
		'git',
		['diff', '--name-only', 'HEAD', '--', 'extensions/'],
		pi,
		ctx,
	);
	if (diffCode === 0 && diffOut.trim()) extractExtNames(diffOut, extNames);

	const { stdout: statusOut, code: statusCode } = await execCmd(
		'git',
		['status', '--porcelain', '--', 'extensions/'],
		pi,
		ctx,
	);
	if (statusCode === 0 && statusOut.trim()) {
		const newFiles = statusOut
			.split('\n')
			.filter((l) => l.startsWith('?? '))
			.map((l) => l.slice(3).trim())
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

// ══════════════════════════════════════════════════════════════════════════════
// tsc 编译检查（优先 node_modules/.bin/tsc）
// ══════════════════════════════════════════════════════════════════════════════

async function runTscCheck(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string[] | null> {
	// 优先直接用本地 tsc（省去 npx 启动开销 2-3s）
	const localTsc = join(ctx.cwd, 'node_modules', '.bin', 'tsc');
	const tscCmd = existsSync(localTsc) ? localTsc : 'npx';
	const tscArgs = existsSync(localTsc)
		? ['--noEmit', '--pretty', 'false']
		: ['tsc', '--noEmit', '--pretty', 'false'];

	const { stdout, stderr, code } = await execCmd(tscCmd, tscArgs, pi, ctx, { timeout: 60_000 });

	if (code === -1) {
		log.error('tsc check failed to execute', { stderr: stderr.slice(0, 500) });
		return null;
	}
	if (code === 0) return [];
	return (stderr + '\n' + stdout).trim().split('\n');
}

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
	if (tscLines.length === 0) return true;
	const hasOwnError = tscLines.some((line) => line.startsWith(relPath + '('));
	if (hasOwnError) {
		const ownErrors = tscLines
			.filter((line) => line.startsWith(relPath + '('))
			.slice(0, 10)
			.join('\n');
		log.warn(`Validation failed for "${extName}":`, { errors: ownErrors });
		return false;
	}
	return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// 文件同步
// ══════════════════════════════════════════════════════════════════════════════

const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

function resolveExtensionSource(
	extName: string,
	ctx: ExtensionContext,
): { type: 'file'; sourcePath: string } | { type: 'directory'; sourcePath: string } | null {
	const extPath = findExtensionPath(ctx, extName);
	if (!extPath) return null;
	const expectedDir = dirname(extPath);
	const dirName = expectedDir.split('/').pop() || '';
	if (
		dirName === extName &&
		(existsSync(join(expectedDir, 'index.ts')) || existsSync(join(expectedDir, 'index.tsx')))
	) {
		return { type: 'directory', sourcePath: expectedDir };
	}
	return { type: 'file', sourcePath: extPath };
}

function copyDirRecursive(sourceDir: string, targetDir: string): void {
	mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
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

function hasDependencies(dir: string): boolean {
	const pkgPath = join(dir, 'package.json');
	if (!existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		return (
			!!(pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
			!!(pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) ||
			!!(pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0)
		);
	} catch {
		return false;
	}
}

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

function registerLocalPackageAtRoot(extName: string, pkgName: string, piDir: string): void {
	const pkgFilePath = join(piDir, 'package.json');
	if (!existsSync(pkgFilePath)) return;
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
		const targetDir = join(targetRoot, extName);
		log.info(`Syncing directory extension "${extName}" → ${targetDir}`);
		if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
		copyDirRecursive(sourceInfo.sourcePath, targetDir);

		const pkgPath = join(targetDir, 'package.json');
		if (existsSync(pkgPath)) {
			let pkg: Record<string, unknown> = {};
			try {
				pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
			} catch {
				log.warn(`Invalid package.json in "${extName}"`);
			}
			const pkgName = pkg.name as string | undefined;
			if (pkgName && typeof pkgName === 'string' && pkgName.startsWith('@zenone/')) {
				const piDir = dirname(targetRoot);
				registerLocalPackageAtRoot(extName, pkgName, piDir);
				pendingPiRootDirs.add(piDir);
			}
			if (hasDependencies(targetDir)) {
				const ok = await runNpmInstall(targetDir, pi, ctx);
				if (!ok) {
					log.error(`npm install failed for "${extName}" — cleaning up`);
					if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
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

async function syncExtension(
	extName: string,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	const sourceInfo = resolveExtensionSource(extName, ctx);
	if (!sourceInfo) {
		log.error(`Cannot find extension source for "${extName}"`);
		return false;
	}
	const { roots: targetRoots } = resolveSyncTargets(extName, ctx);
	let allOk = true;
	for (const targetRoot of targetRoots) {
		if (!(await syncToTargetRoot(sourceInfo, targetRoot, extName, pi, ctx))) allOk = false;
	}
	return allOk;
}

// ══════════════════════════════════════════════════════════════════════════════
// execCmd 封装
// ══════════════════════════════════════════════════════════════════════════════

async function execCmd(
	command: string,
	args: string[],
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		return await pi.exec(command, args, { cwd: ctx.cwd, timeout: opts?.timeout ?? 30_000 });
	} catch (e) {
		log.error(`exec failed: ${command} ${args.join(' ')}`, { error: String(e) });
		return { stdout: '', stderr: String(e), code: -1 };
	}
}

// ══════════════════════════════════════════════════════════════════════════════
// 模块级持久引用
// ══════════════════════════════════════════════════════════════════════════════

/** 模块级持久的 pi API 引用 */
let pi: ExtensionAPI;

/** @zenone/* 包注册后需要运行根 npm install 的目录 */
const pendingPiRootDirs = new Set<string>();

export default function (api: ExtensionAPI): void {
	pi = api;
	log.info('Extension v2 loaded');

	pi.on('agent_end', async (_event, ctx) => {
		const syncResult = await syncGate.run(async () => {
			await performSync(ctx);
		});

		if (syncResult === 'queued') {
			log.info('Sync already in progress — changes queued for next round');
			if (ctx.hasUI) {
				ctx.ui.notify('上一轮同步进行中，变更将在本轮结束时同步', 'info');
			}
		} else if (syncResult === 'synced' && syncGate.consumePending()) {
			// 同步期间有排队变更，立即再跑一轮
			await syncGate.run(async () => {
				log.info('Re-running sync for queued changes');
				await performSync(ctx);
			});
		}
	});
}

async function performSync(ctx: ExtensionContext): Promise<void> {
	log.info('event: agent_end → performing sync');

	let notifyTitle = '';
	let notifyLevel: 'info' | 'warning' = 'info';

	try {
		const changed = await getChangedExtensions(pi, ctx);
		if (changed.length === 0) {
			log.info('No extensions changed, skipping');
			notifyTitle = '无扩展变更，无需同步';
		} else {
			log.info('Changed extensions:', changed.join(', '));
			const tscResult = await runTscCheck(pi, ctx);

			if (tscResult === null) {
				log.info('Skipping sync — tsc is not available');
				notifyTitle = '⚠️ tsc 不可用，跳过同步（可运行 npm install 后重试）';
				notifyLevel = 'warning';
			} else {
				const validExts: string[] = [];
				for (const extName of changed) {
					if (checkExtensionForErrors(extName, tscResult, ctx)) validExts.push(extName);
					else log.info(`Skipping "${extName}" — TS validation failed`);
				}

				if (validExts.length === 0) {
					notifyTitle = `⚠️ ${changed.join(', ')} 有编译错误，未同步`;
					notifyLevel = 'warning';
				} else {
					const synced: string[] = [];
					const failed: string[] = [];
					for (const extName of validExts) {
						if (await syncExtension(extName, pi, ctx)) synced.push(extName);
						else failed.push(extName);
					}

					if (pendingPiRootDirs.size > 0 && synced.length > 0) {
						for (const piDir of pendingPiRootDirs) {
							log.info(`Running npm install in ${piDir} for @zenone/* symlinks`);
							const ok = await runNpmInstall(piDir, pi, ctx);
							if (!ok)
								log.error(
									`Root npm install failed at ${piDir} — @zenone/* deps not linked`,
								);
						}
						pendingPiRootDirs.clear();
					}

					const parts: string[] = [];
					if (synced.length > 0) {
						const targetLabels = synced
							.map((n) => {
								const { label } = resolveSyncTargets(n, ctx);
								return `${n} → ${label}`;
							})
							.join('，');
						parts.push(`已同步 ${targetLabels}`);
					}
					if (failed.length > 0) parts.push(`${failed.join(', ')} 同步失败（见日志）`);
					if (synced.length > 0) {
						log.info(`已同步: ${synced.join(', ')}`);
					}
					if (failed.length > 0) {
						log.warn(`同步失败: ${failed.join(', ')}`);
					}
					if (parts.length > 0) {
						notifyTitle = parts.join('；') + '，可以 /reload 进行用户测试';
						notifyLevel = failed.length > 0 ? 'warning' : 'info';
					}
				}
			}
		}
	} catch (err) {
		log.error('Sync error', { error: String(err) });
		notifyTitle = '❌ 同步过程出错（见日志）';
		notifyLevel = 'warning';
	}

	if (ctx.hasUI && notifyTitle) {
		ctx.ui.notify(notifyTitle, notifyLevel);
	}
}
