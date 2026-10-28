#!/usr/bin/env node
/**
 * 为离线包生成清单（manifest 的骨架部分）。
 *
 * 在源机（有仓库 node_modules）执行，因此可以放心用 js-yaml 解析 sync-profiles.yaml；
 * 产物只作为 pack 的输入，离线机不会运行本文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
	const out = { arch: 'x64', agentDir: path.join(process.env.HOME || '', '.pi', 'agent') };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === '--arch') out.arch = argv[++i];
		else if (a === '--agent-dir') out.agentDir = argv[++i];
		else if (a === '--out') out.out = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const arch = args.arch;
const agentDir = path.resolve(args.agentDir);

function readJson(p, fallback = null) {
	let text;
	try {
		text = fs.readFileSync(p, 'utf8');
	} catch (err) {
		// 只有"文件不存在"是正常情况；权限 / IO 错误不能当成"没声明"，否则清单会静默改变结论
		if (err.code === 'ENOENT') return fallback;
		fail(`读不到 ${p}：${err.message}`);
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		// 构建期清单：坏 JSON 会让入口/桥接/本地包闭包静默走另一条路，必须大声失败
		fail(`${p} 不是合法 JSON：${err.message}`);
	}
}

function fail(msg) {
	process.stderr.write(`[collect] ${msg}\n`);
	process.exit(1);
}

// ── 1. pi 版本（钉仓库 devDependency） ───────────────────────────────
const repoPkg = readJson(path.join(REPO_ROOT, 'package.json'));
if (!repoPkg) fail(`读不到 ${path.join(REPO_ROOT, 'package.json')}`);
const rawPi =
	repoPkg.devDependencies?.['@earendil-works/pi-coding-agent'] ||
	repoPkg.dependencies?.['@earendil-works/pi-coding-agent'];
if (!rawPi) fail('package.json 里没有 @earendil-works/pi-coding-agent 依赖，无法确定 pi 版本');
const piVersion = String(rawPi).replace(/^[\^~=v\s]+/, '');
if (!/^\d+\.\d+\.\d+/.test(piVersion)) fail(`无法从 "${rawPi}" 解析出版本号`);

// ── 2. repo 身份 ─────────────────────────────────────────────────────
function git(...a) {
	try {
		return execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
	} catch {
		// git 不可用 / 不在 git 树：返回 null 表示"未知"，不要伪装成空字符串（那是"干净工作区"）
		return null;
	}
}
const repoCommit = git('rev-parse', 'HEAD') ?? '';
const repoShort = repoCommit.slice(0, 8) || 'unknown';
const repoStatus = git('status', '--porcelain');
const repoDirty = repoStatus === null ? null : repoStatus.length > 0;

// ── 3. 用户安装清单（profile 是唯一事实来源，不硬编码） ─────────────
const require_ = createRequire(path.join(REPO_ROOT, 'package.json'));
let yaml;
try {
	yaml = require_('js-yaml');
} catch {
	fail('仓库里没有 js-yaml，无法解析 scripts/sync-profiles.yaml（先 npm install）');
}
const profilesPath = path.join(REPO_ROOT, 'scripts', 'sync-profiles.yaml');
if (!fs.existsSync(profilesPath)) fail(`找不到 ${profilesPath}`);
const profiles = yaml.load(fs.readFileSync(profilesPath, 'utf8'))?.profiles;
const userInstall = profiles?.['user-install'];
if (!userInstall) fail('sync-profiles.yaml 里没有 user-install profile');
const wantExtensions = Array.isArray(userInstall.extensions) ? userInstall.extensions : [];
if (wantExtensions.length === 0) fail('user-install.extensions 为空，拒绝生成空包');
const wantSkills = Array.isArray(userInstall.skills) ? userInstall.skills : [];
const wantThemes =
	userInstall.themes === '*' ? '*' : Array.isArray(userInstall.themes) ? userInstall.themes : [];

// ── 4. 扩展名 → 源码路径 ────────────────────────────────────────────
const index = new Map(); // 名字 → [绝对路径]
const extensionsRoot = path.join(REPO_ROOT, 'extensions');
for (const category of fs.readdirSync(extensionsRoot)) {
	const categoryDir = path.join(extensionsRoot, category);
	if (!fs.statSync(categoryDir).isDirectory()) continue;
	for (const entry of fs.readdirSync(categoryDir)) {
		const full = path.join(categoryDir, entry);
		const st = fs.statSync(full);
		if (st.isDirectory()) {
			if (!index.has(entry)) index.set(entry, []);
			index.get(entry).push(full);
		} else if (/\.(ts|js|mjs)$/.test(entry)) {
			const name = entry.replace(/\.(ts|js|mjs)$/, '');
			if (!index.has(name)) index.set(name, []);
			index.get(name).push(full);
		}
	}
}

/** 把一个扩展源码（目录 / 单文件）描述成 manifest 条目。library=true 表示"纯库包"（不加载，只被 import）。 */
function describeExtension(name, src, { library = false } = {}) {
	const isDir = fs.statSync(src).isDirectory();
	const pkg = isDir ? readJson(path.join(src, 'package.json')) : null;
	let entry = null;
	let needsBridge = false;
	if (isDir) {
		const declared = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions[0] : null;
		const candidates = [declared, 'index.ts', 'index.js']
			.filter(Boolean)
			.map((f) => path.join(src, f));
		entry = candidates.find((f) => fs.existsSync(f)) || null;
		if (!entry) {
			// npm 包形态扩展：pi.extensions 指向 dist（未构建），但 src/index.ts 在。
			// pi 的加载器会回退到同目录 index.ts，因此生成桥接即可，无需在离线机构建 dist。
			if (declared && fs.existsSync(path.join(src, 'src', 'index.ts'))) {
				needsBridge = true;
				entry = path.join(src, 'index.ts');
			} else if (!library) {
				problems.push(
					`扩展 "${name}" 是目录但找不到入口（pi.extensions / index.ts / src/index.ts）`,
				);
			}
		}
	}
	return {
		name,
		source: path.relative(REPO_ROOT, src),
		kind: isDir ? 'dir' : 'file',
		entry: entry ? path.relative(src, entry) : null,
		needsBridge,
		packageName: pkg?.name || null,
		...(library ? { library: true } : {}),
	};
}

const extensions = [];
const problems = [];
for (const name of wantExtensions) {
	const hits = index.get(name) || [];
	if (hits.length === 0) problems.push(`扩展 "${name}" 在 extensions/ 下找不到`);
	else if (hits.length > 1)
		problems.push(
			`扩展 "${name}" 匹配到多个源码：${hits.map((h) => path.relative(REPO_ROOT, h)).join(', ')}`,
		);
	else extensions.push(describeExtension(name, hits[0]));
}

// ── 4b. @zenone/* 本地包闭包 ─────────────────────────────────────────
// 安装后 `agent/node_modules/@zenone/x` 是 `agent/extensions/<dir>` 的链接，所以源码必须随包落到
// extensions/ 下。只按 profile 推导会漏掉"纯库"包：@zenone/pi-state 不在 user-install.extensions
// 里，却被 pi-config / permission-gate / preset 直接 import —— 目标机缺它 → pi-config 加载失败 →
// 十几个依赖 pi-config 的扩展级联失败 → 探针把安全栈整体隔离。这里按源码 import 闭包补齐。
const packageIndex = new Map(); // 本地包名 → { abs, extName }
for (const [extName, paths] of index) {
	for (const abs of paths) {
		if (!fs.statSync(abs).isDirectory()) continue;
		const pkgName = readJson(path.join(abs, 'package.json'))?.name;
		if (typeof pkgName !== 'string' || !pkgName.startsWith('@zenone/')) continue;
		const prev = packageIndex.get(pkgName);
		if (prev && prev.abs !== abs)
			problems.push(
				`本地包 "${pkgName}" 对应多个源码：${[prev.abs, abs].map((p) => path.relative(REPO_ROOT, p)).join(', ')}`,
			);
		else packageIndex.set(pkgName, { abs, extName });
	}
}

const ZENONE_SPECIFIER = /['"](@zenone\/[a-z0-9][a-z0-9._-]*)['"]/g;
function* walkSources(target) {
	const st = fs.statSync(target);
	if (st.isFile()) {
		if (/\.(ts|mts|js|mjs|cjs)$/.test(target)) yield target;
		return;
	}
	for (const e of fs.readdirSync(target, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
		yield* walkSources(path.join(target, e.name));
	}
}

const queue = extensions.map((e) => path.join(REPO_ROOT, e.source));
const scanned = new Set();
const requiredPackages = new Set();
while (queue.length > 0) {
	const target = path.resolve(queue.pop());
	if (scanned.has(target)) continue;
	scanned.add(target);
	for (const file of walkSources(target)) {
		for (const m of fs.readFileSync(file, 'utf8').matchAll(ZENONE_SPECIFIER)) {
			const pkgName = m[1];
			if (requiredPackages.has(pkgName)) continue;
			const hit = packageIndex.get(pkgName);
			if (!hit) {
				problems.push(
					`源码 ${path.relative(REPO_ROOT, file)} 引用了本地包 "${pkgName}"，但 extensions/ 下没有同名 package.json`,
				);
				continue;
			}
			requiredPackages.add(pkgName);
			queue.push(hit.abs); // 传递闭包：例如 pi-config 又 import pi-state
		}
	}
}
for (const pkgName of requiredPackages) {
	const hit = packageIndex.get(pkgName);
	if (extensions.some((e) => e.packageName === pkgName)) continue;
	extensions.push(describeExtension(hit.extName, hit.abs, { library: true }));
}

// ── 5. 技能 / 主题 ──────────────────────────────────────────────────
const skillsRoot = path.join(REPO_ROOT, 'skills');
const skillIndex = new Map();
if (fs.existsSync(skillsRoot)) {
	for (const category of fs.readdirSync(skillsRoot)) {
		const catDir = path.join(skillsRoot, category);
		if (!fs.statSync(catDir).isDirectory()) continue;
		for (const entry of fs.readdirSync(catDir)) {
			const full = path.join(catDir, entry);
			if (!fs.statSync(full).isDirectory()) continue;
			if (!fs.existsSync(path.join(full, 'SKILL.md'))) continue;
			if (!skillIndex.has(entry)) skillIndex.set(entry, []);
			skillIndex.get(entry).push(full);
		}
	}
}
const skills = [];
for (const name of wantSkills) {
	const hits = skillIndex.get(name) || [];
	if (hits.length !== 1) problems.push(`技能 "${name}" 解析失败（命中 ${hits.length} 个）`);
	else skills.push({ name, source: path.relative(REPO_ROOT, hits[0]) });
}

const themesRoot = path.join(REPO_ROOT, 'themes');
const themes = [];
if (fs.existsSync(themesRoot)) {
	for (const entry of fs.readdirSync(themesRoot)) {
		if (!entry.endsWith('.json')) continue;
		const name = entry.replace(/\.json$/, '');
		if (wantThemes === '*' || wantThemes.includes(name)) {
			themes.push({ name, source: path.relative(REPO_ROOT, path.join(themesRoot, entry)) });
		}
	}
}

if (problems.length > 0) {
	for (const p of problems) process.stderr.write(`[collect] ${p}\n`);
	fail(`清单构建失败：${problems.length} 个问题`);
}

// ── 6. 原生包：darwin → linux 映射（版本必须与已装 darwin 版一致） ──
const linuxArch = arch; // npm 的 linux 包用 x64 / arm64
const NATIVE_RULES = [
	{
		test: /^@ast-grep\/(napi|cli)-darwin-(?:arm64|x64)$/,
		linux: (m) => `@ast-grep/${m[1]}-linux-${linuxArch}-gnu`,
	},
	{
		test: /^@yuuang\/ffi-rs-darwin-(?:arm64|x64)$/,
		linux: () => `@yuuang/ffi-rs-linux-${linuxArch}-gnu`,
	},
	{
		test: /^@ff-labs\/fff-bin-darwin-(?:arm64|x64)$/,
		linux: () => `@ff-labs/fff-bin-linux-${linuxArch}-gnu`,
	},
	{ test: /^@img\/sharp-darwin-(?:arm64|x64)$/, linux: () => `@img/sharp-linux-${linuxArch}` },
	{
		test: /^@img\/sharp-libvips-darwin-(?:arm64|x64)$/,
		linux: () => `@img/sharp-libvips-linux-${linuxArch}`,
	},
	{
		test: /^@typescript\/typescript-darwin-(?:arm64|x64)$/,
		linux: () => `@typescript/typescript-linux-${linuxArch}`,
	},
	{
		test: /^@amaster\.ai\/pi-video-gen-ffmpeg-darwin-(?:arm64|x64)$/,
		linux: () => `@amaster.ai/pi-video-gen-ffmpeg-linux-${linuxArch}`,
	},
	{
		test: /^@mariozechner\/clipboard-darwin-(?:arm64|x64|universal)$/,
		linux: () => `@mariozechner/clipboard-linux-${linuxArch}-gnu`,
	},
];

function scanNativePackages(root) {
	const found = [];
	if (!fs.existsSync(root)) return found;
	const stack = [{ dir: root, depth: 0 }];
	while (stack.length > 0) {
		const { dir, depth } = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const full = path.join(dir, e.name);
			if (e.name.startsWith('@')) {
				stack.push({ dir: full, depth });
				continue;
			}
			// 只认"真正的包目录"：必须有 package.json，且不能是 prebuilds/<platform> 这类子目录
			if (
				/darwin/.test(e.name) &&
				fs.existsSync(path.join(full, 'package.json')) &&
				path.basename(dir) !== 'prebuilds'
			) {
				const pkg = readJson(path.join(full, 'package.json'));
				const parentDir = path.dirname(full);
				const scopeName = path.basename(parentDir);
				const isScoped = scopeName.startsWith('@');
				const name = isScoped ? `${scopeName}/${e.name}` : e.name;
				// root 必须是 node_modules 根（不是 scope 目录），否则安装路径会变成 @scope/@scope/pkg
				const nodeModulesRoot = isScoped ? path.dirname(parentDir) : parentDir;
				const rule = NATIVE_RULES.find((r) => r.test.test(name));
				found.push({
					name,
					version: pkg?.version || null,
					linuxName: rule ? rule.linux(name.match(rule.test)) : null,
					root: path.relative(agentDir, nodeModulesRoot),
					absPath: full,
				});
				continue;
			}
			if (depth < 12) stack.push({ dir: full, depth: depth + 1 });
		}
	}
	return found;
}

const nativePackages = scanNativePackages(agentDir).filter((n) => {
	// 只关心会被复制进 bundle 的 node_modules 层（npm / 共享 node_modules / git 插件树）
	return /(^|\/)node_modules$/.test(n.root);
});

const bundlesWithNative = [];
const seenNativeTargets = new Set();
for (const n of nativePackages) {
	if (!n.linuxName) {
		bundlesWithNative.push({
			...n,
			strategy: 'expected-degraded',
			reason: '没有对应的 linux 包映射规则',
		});
		continue;
	}
	// 同一个目标 linux 包只需下载一次；但每个 darwin 副本都要在目标机删掉
	const key = `${n.root}/${n.linuxName}`;
	if (seenNativeTargets.has(key)) {
		bundlesWithNative.push({
			...n,
			strategy: 'remove-only',
			reason: '同一 linux 包的重复 darwin 副本',
		});
		continue;
	}
	seenNativeTargets.add(key);
	bundlesWithNative.push({ ...n, strategy: 'npm-pack' });
}

// node-pty 没有 linux 预编译，需要在 Linux 容器里编译；拿不到就标记为预期降级
const nodePtyPath = path.join(agentDir, 'npm', 'node_modules', 'node-pty');
const compiled = [];
if (fs.existsSync(nodePtyPath)) {
	compiled.push({
		name: 'node-pty',
		root: 'npm/node_modules',
		strategy: 'docker-node-gyp',
		optional: true,
	});
}

// 共享模块：扩展用相对路径 import '<root>/src/tui/*.js'，安装后必须落在
// dirname(agentDir)/src/tui（sync 工具同一约定，见 scripts/sync-to-local-pi.ts）。
const shared = [];
if (fs.existsSync(path.join(REPO_ROOT, 'src', 'tui'))) {
	shared.push({ name: 'src/tui', source: 'src/tui', installTo: 'sibling-of-agent' });
}

const manifest = {
	schemaVersion: 1,
	piVersion,
	repoCommit,
	repoShort,
	repoDirty,
	arch,
	localDev: arch === 'local',
	extensions,
	skills,
	themes,
	prompts: [],
	shared,
	zenoneLinks: extensions
		.filter((e) => e.packageName && e.packageName.startsWith('@zenone/'))
		.map((e) => ({ name: e.packageName, dir: e.name })),
	nativePackages: bundlesWithNative,
	compiledPackages: compiled,
};

const json = `${JSON.stringify(manifest, null, 2)}\n`;
if (args.out) {
	fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
	fs.writeFileSync(path.resolve(args.out), json);
}
process.stdout.write(json);
