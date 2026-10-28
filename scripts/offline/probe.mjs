#!/usr/bin/env node
/**
 * 离线安装的加载探针（ADR-0069 D6）。
 *
 * 目的：在"安装成功"与"插件真的能用"之间补一道逐项可观测的验证。
 * - 扩展入口：用 pi 运行时自带的 jiti 逐个 import（每个独立子进程 + 超时），失败不牵连其他扩展
 * - 原生包：直接 require，暴露 glibc / 平台不匹配
 * - 工具二进制：spawn `rg --version` / `fd --version`
 *
 * 只用 node 内置模块 + 运行时目录里的 jiti，不依赖任何 npm 包（离线机没有 npm）。
 *
 * 用法：
 *   node probe.mjs --agent-dir ~/.pi/agent --runtime ~/.local/share/pi-offline/runtime \
 *                  --report ~/.pi/agent/load-report.json [--timeout 30000] [--skip-tools]
 *   node probe.mjs --preflight --runtime <runtime>       # 只校验运行时布局（pack 后自检）
 *   node probe.mjs --one <entry.ts> --runtime ...        # 子进程内部使用
 *   node probe.mjs --native <pkgName> --agent-dir ...    # 子进程内部使用
 *
 * 退出码：
 *   0 = 探针跑完（扩展级失败项见报告，由安装器隔离）
 *   1 = 参数/执行失败（--preflight 校验不通过也走这条）
 *   2 = pi 运行时自身不可用（仅完整探针）——安装器据此中止，不做扩展隔离
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

function parseArgs(argv) {
	const out = { timeout: 30000 };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === '--agent-dir') out.agentDir = next();
		else if (a === '--runtime') out.runtime = next();
		else if (a === '--report') out.report = next();
		else if (a === '--timeout') out.timeout = Number(next());
		else if (a === '--one') out.one = next();
		else if (a === '--native') out.native = next();
		else if (a === '--skip-tools') out.skipTools = true;
		else if (a === '--preflight') out.preflight = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));

/**
 * pi 加载器给扩展注入的 jiti 别名（见 pi `dist/core/extensions/loader.js` 的 getAliases）。
 * 不还原这份映射，扩展里的 `import '@earendil-works/pi-tui'` 就只能靠目录上溯解析——离线机上
 * 没有仓库 node_modules，会一律失败，进而把整批扩展误判为"不可加载"并隔离掉。
 * 目标不可达 = 运行时布局变了（bundle 与探针不匹配），属于必须大声失败的构建问题。
 */
function piAliases(runtime) {
	const nm = path.join(runtime, 'node_modules');
	const pi = (rel) => path.join(nm, rel);
	const targets = {
		'@earendil-works/pi-coding-agent': pi('@earendil-works/pi-coding-agent/dist/index.js'),
		'@earendil-works/pi-agent-core': pi('@earendil-works/pi-agent-core/dist/index.js'),
		'@earendil-works/pi-tui': pi('@earendil-works/pi-tui/dist/index.js'),
		'@earendil-works/pi-ai': pi('@earendil-works/pi-ai/dist/compat.js'),
		'@earendil-works/pi-ai/compat': pi('@earendil-works/pi-ai/dist/compat.js'),
		'@earendil-works/pi-ai/models': pi('@earendil-works/pi-ai/dist/models.js'),
		'@earendil-works/pi-ai/oauth': pi('@earendil-works/pi-ai/dist/oauth.js'),
		'@earendil-works/pi-ai/providers/all': pi('@earendil-works/pi-ai/dist/providers/all.js'),
	};
	const aliases = {};
	for (const [spec, target] of Object.entries(targets)) {
		if (!fs.existsSync(target))
			throw new Error(
				`运行时缺少 ${spec} 的实现文件：${target}（bundle 不完整或 pi 布局已变）`,
			);
		aliases[spec] = target;
		// @mariozechner/* 是 pi 的旧包名，加载器把它们映射到同一份实现
		aliases[spec.replace('@earendil-works/', '@mariozechner/')] = target;
	}
	const requirePi = createRequire(
		path.join(nm, '@earendil-works', 'pi-coding-agent', 'package.json'),
	);
	for (const spec of ['typebox', 'typebox/compile', 'typebox/value']) {
		let target;
		try {
			target = requirePi.resolve(spec);
		} catch (err) {
			throw new Error(`运行时里解析不到 ${spec}：${err.message}`, { cause: err });
		}
		aliases[spec] = target;
		aliases[`@sinclair/${spec}`] = target;
	}
	return aliases;
}

function jitiFor(runtime) {
	const candidates = [
		path.join(runtime, 'node_modules', 'jiti'),
		path.join(
			runtime,
			'node_modules',
			'@earendil-works',
			'pi-coding-agent',
			'node_modules',
			'jiti',
		),
	];
	for (const c of candidates) {
		if (fs.existsSync(path.join(c, 'package.json'))) {
			const require = createRequire(path.join(c, 'package.json'));
			return require(c).createJiti(SELF, {
				interopDefault: true,
				moduleCache: false,
				alias: piAliases(runtime),
			});
		}
	}
	throw new Error(`运行时里找不到 jiti：${candidates.join(' / ')}`);
}

/**
 * 运行时预检：pi 的 jiti 别名映射与 jiti 本身都必须可达。
 *
 * 布局漂移（pi 升级改了 dist 结构 / bundle 不完整）时，每个扩展都会加载失败。那不是
 * "某个扩展坏了"，隔离它们等于把整个安全栈静默下掉 —— 所以这里返回错误，由调用方
 * 决定大声失败（pack 时中止打包、安装时中止安装），而不是走逐项隔离。
 */
function preflightError(runtime) {
	try {
		jitiFor(runtime); // 内部构建 piAliases，目标缺失 / jiti 缺失都会 throw
		return null;
	} catch (err) {
		return err && err.message ? err.message : String(err);
	}
}

/** 子进程：尝试 import 单个扩展入口 */
async function runOne(entry, runtime) {
	const jiti = jitiFor(runtime);
	await jiti.import(entry);
}

/** 子进程：require 单个原生包 */
function runNative(spec, agentDir) {
	const roots = [
		path.join(agentDir, 'npm', 'node_modules'),
		path.join(agentDir, 'node_modules'),
		path.join(agentDir, 'git'),
	];
	const tried = [];
	for (const root of roots) {
		const marker = path.join(root, 'noop.js');
		const require = createRequire(marker);
		try {
			const resolved = require.resolve(spec, { paths: [root] });
			require(resolved);
			return;
		} catch (err) {
			if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(spec)) {
				tried.push(`${root}: 未安装`);
				continue;
			}
			throw err;
		}
	}
	throw new Error(`在 agent 目录里找不到 ${spec}（${tried.join('; ')}）`);
}

function fail(msg) {
	process.stderr.write(`${msg}\n`);
	process.exit(1);
}

/** 收集待测扩展：目录形态优先读 package.json 的 pi.extensions，缺失则回退 index.ts */
function collectExtensions(agentDir) {
	const extDir = path.join(agentDir, 'extensions');
	if (!fs.existsSync(extDir)) return [];
	const out = [];
	for (const name of fs.readdirSync(extDir).sort()) {
		const p = path.join(extDir, name);
		let st;
		try {
			st = fs.statSync(p);
		} catch {
			continue;
		}
		if (st.isFile()) {
			if (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.mjs')) {
				out.push({ name: name.replace(/\.(ts|js|mjs)$/, ''), entry: p });
			}
			continue;
		}
		const pkgPath = path.join(p, 'package.json');
		let declared = null;
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
				const list = pkg?.pi?.extensions;
				if (Array.isArray(list) && list.length > 0) declared = path.resolve(p, list[0]);
			} catch (err) {
				out.push({ name, entry: null, error: `package.json 解析失败：${err.message}` });
				continue;
			}
		}
		const fallback = [path.join(p, 'index.ts'), path.join(p, 'index.js')].find((f) =>
			fs.existsSync(f),
		);
		const entry = declared && fs.existsSync(declared) ? declared : fallback;
		// 与 pi 的加载器一致：既没有 pi.extensions 声明、也没有 index.* 的目录是"库目录"，
		// pi 会静默跳过，探针也不该把它算作失败（例如 extensions/pi-packages-manager）。
		if (entry) out.push({ name, entry });
		else if (!declared) out.push({ name, entry: null, skip: true });
		else
			out.push({
				name,
				entry: null,
				error: '找不到入口（pi.extensions / index.ts 都不存在）',
			});
	}
	return out;
}

function runChild(childArgs, timeout) {
	const res = spawnSync(process.execPath, [SELF, ...childArgs], {
		encoding: 'utf8',
		timeout,
		killSignal: 'SIGKILL',
	});
	const errText = (res.stderr || '').trim();
	const outText = (res.stdout || '').trim();
	let error = null;
	if (res.error && res.error.code === 'ETIMEDOUT')
		error = `超时（>${Math.round(timeout / 1000)}s）`;
	else if (res.status !== 0)
		error = errText.split('\n').slice(0, 6).join(' | ') || `退出码 ${res.status}`;
	return { ok: !error, error, output: outText };
}

function probeTools(agentDir, timeout) {
	const results = [];
	for (const tool of ['rg', 'fd']) {
		const bin = path.join(agentDir, 'bin', tool);
		if (!fs.existsSync(bin)) {
			results.push({
				name: tool,
				ok: false,
				error: `缺少 ${bin}（PI_OFFLINE=1 时 pi 不会下载）`,
			});
			continue;
		}
		const res = spawnSync(bin, ['--version'], {
			encoding: 'utf8',
			timeout: Math.min(timeout, 15000),
		});
		const line =
			(res.stdout || '').trim().split('\n')[0] || (res.stderr || '').trim().split('\n')[0];
		if (res.status === 0) results.push({ name: tool, ok: true, version: line });
		else results.push({ name: tool, ok: false, error: line || `退出码 ${res.status}` });
	}
	return results;
}

function nativeSpecs(agentDir) {
	const root = path.join(agentDir, 'npm', 'node_modules');
	const specs = [];
	for (const spec of [
		'sharp',
		'@ast-grep/napi',
		'@yuuang/ffi-rs',
		'@ff-labs/fff-node',
		'@typescript/typescript',
		'node-pty',
		'web-tree-sitter',
	]) {
		const p = path.join(root, spec);
		if (fs.existsSync(p)) specs.push(spec);
	}
	for (const spec of ['tree-sitter-bash']) {
		if (fs.existsSync(path.join(agentDir, 'node_modules', spec))) specs.push(spec);
	}
	return specs;
}

async function main() {
	if (args.one) return runOne(args.one, args.runtime);
	if (args.native) return runNative(args.native, args.agentDir);

	if (!args.runtime) fail('缺少 --runtime');
	if (args.preflight) {
		// 源机打包前的自检入口：只验证运行时布局，不碰扩展。
		const err = preflightError(path.resolve(args.runtime));
		if (err) fail(err);
		process.stdout.write('runtime preflight ok\n');
		return;
	}
	if (!args.agentDir) fail('缺少 --agent-dir');
	const agentDir = path.resolve(args.agentDir);
	const runtime = path.resolve(args.runtime);
	const timeout = Number.isFinite(args.timeout) ? args.timeout : 30000;

	// 运行时自身不可用（布局漂移 / bundle 不完整）：下面每个扩展都会失败，而隔离它们
	// 等于把整个安全栈静默下掉。退出码 2 = "运行时不可用"，与"某个扩展坏了（0）"区分，
	// 由安装器据此 die（ADR-0069 D6）。
	const runtimeError = preflightError(runtime);
	if (runtimeError) {
		const report = {
			generatedAt: new Date().toISOString(),
			agentDir,
			runtime,
			ok: false,
			runtimeError,
			extensionCount: 0,
			extensionFailures: [],
			nativeFailures: [],
			toolFailures: [],
			tools: [],
			nativeOk: [],
			extensionOk: [],
			extensionSkipped: [],
		};
		const json = `${JSON.stringify(report, null, 2)}\n`;
		if (args.report) fs.writeFileSync(args.report, json);
		process.stdout.write(json);
		process.stderr.write(`运行时预检失败：${runtimeError}\n`);
		process.exitCode = 2;
		return;
	}

	const extensions = collectExtensions(agentDir);
	const extensionFailures = [];
	const extensionOk = [];
	const extensionSkipped = [];
	for (const ext of extensions) {
		if (ext.skip) {
			extensionSkipped.push(ext.name);
			continue;
		}
		if (!ext.entry) {
			extensionFailures.push({ name: ext.name, entry: null, error: ext.error });
			continue;
		}
		const child = runChild(['--one', ext.entry, '--runtime', runtime], timeout);
		if (child.ok) extensionOk.push(ext.name);
		else extensionFailures.push({ name: ext.name, entry: ext.entry, error: child.error });
	}

	const nativeFailures = [];
	const nativeOk = [];
	for (const spec of nativeSpecs(agentDir)) {
		const child = runChild(['--native', spec, '--agent-dir', agentDir], timeout);
		if (child.ok) nativeOk.push(spec);
		else nativeFailures.push({ name: spec, error: child.error });
	}

	const tools = args.skipTools ? [] : probeTools(agentDir, timeout);
	const toolFailures = tools.filter((t) => !t.ok);

	const report = {
		generatedAt: new Date().toISOString(),
		agentDir,
		runtime,
		ok:
			extensionFailures.length === 0 &&
			nativeFailures.length === 0 &&
			toolFailures.length === 0,
		extensionCount: extensions.length,
		extensionFailures,
		nativeFailures,
		toolFailures,
		tools,
		nativeOk,
		extensionOk,
		extensionSkipped,
	};
	const json = `${JSON.stringify(report, null, 2)}\n`;
	if (args.report) fs.writeFileSync(args.report, json);
	process.stdout.write(json);
	// 探针失败不改变退出码：安装成功与否由安装器决定，失败项由安装器隔离（ADR-0069 D6）
}

main().catch((err) => {
	fail(err && err.stack ? err.stack : String(err));
});
