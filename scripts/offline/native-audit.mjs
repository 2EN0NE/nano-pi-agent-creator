#!/usr/bin/env node
/**
 * 给原生包清单补 measured glibc 下限（pack 阶段在源机执行）。
 *
 * 为什么需要：目标机是"2019 年前后的 Linux"，glibc 可能低到 2.17（CentOS 7）。
 * 各预编译包要求不同（实测：ast-grep napi 2.14 / sharp 2.17 / libvips 2.25 /
 * fff 2.30 / ast-grep cli 2.34 / ffmpeg 2.35），必须逐包知道真实下限，
 * 才能在安装时给出"哪项会降级"的准确提示，而不是笼统报错。
 *
 * 用法： node native-audit.mjs <native.json> <native-dir> [<tools.json> <tools-dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

function cmpVersion(a, b) {
	const A = String(a).split('.').map(Number);
	const B = String(b).split('.').map(Number);
	for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
		if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
	}
	return 0;
}

const UNREADABLE = 'unreadable';

/**
 * 扫描单个二进制里出现的最高 GLIBC_x.y 需求。
 * 三态：版本字符串 = 有动态 glibc 需求；null = 读过且确认无符号需求（静态）；
 * UNREADABLE = 读不到，**不能**当成静态——否则安装期会给用户一个假的兼容承诺。
 */
function maxGlibcOfFile(file) {
	let buf;
	try {
		buf = fs.readFileSync(file);
	} catch {
		return UNREADABLE;
	}
	const text = buf.toString('latin1');
	const matches = text.match(/GLIBC_\d+\.\d+/g);
	if (!matches) return null;
	let max = null;
	for (const m of matches) {
		const v = m.slice('GLIBC_'.length);
		if (max === null || cmpVersion(v, max) > 0) max = v;
	}
	return max;
}

function walk(dir, out) {
	// 不做兜底：扫不到目录就等于审计结论不完整，而结论会变成"静态/无依赖"。大声失败。
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, out);
		else if (e.isFile() && !/\.(md|json|h|txt|js|d\.ts)$/.test(e.name)) out.push(full);
	}
	return out;
}

function auditTarball(tgz) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-audit-'));
	try {
		execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'ignore' });
		const files = walk(tmp, []);
		let max = null;
		let unreadable = 0;
		for (const f of files) {
			let head;
			try {
				const fd = fs.openSync(f, 'r');
				head = Buffer.alloc(4);
				fs.readSync(fd, head, 0, 4, 0);
				fs.closeSync(fd);
			} catch {
				unreadable += 1;
				continue;
			}
			// 只看 ELF
			if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46))
				continue;
			const g = maxGlibcOfFile(f);
			if (g === UNREADABLE) {
				unreadable += 1;
				continue;
			}
			if (g) {
				if (max === null || cmpVersion(g, max) > 0) max = g;
			}
		}
		// 只有"全部读通且确认无 GLIBC_ 符号需求"才算静态；读不到就是未知（maxGlibc 留 null）
		return { maxGlibc: max, staticOnly: max === null && unreadable === 0, unreadable };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

const [nativeJson, nativeDir, toolsJson] = process.argv.slice(2);
if (!nativeJson || !nativeDir) {
	process.stderr.write('用法: node native-audit.mjs <native.json> <native-dir> [tools.json]\n');
	process.exit(1);
}

function readJsonOrDie(p, label) {
	try {
		return JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch (err) {
		process.stderr.write(`[native-audit] 读不了 ${label}（${p}）：${err.message}\n`);
		process.exit(1);
	}
}

const entries = readJsonOrDie(nativeJson, 'native.json');
for (const e of entries) {
	if (e.status !== 'ok' || !e.tarball) continue;
	const tgz = path.join(nativeDir, e.tarball);
	if (!fs.existsSync(tgz)) continue;
	const audit = auditTarball(tgz);
	e.maxGlibc = audit.maxGlibc;
	e.staticOnly = audit.staticOnly;
}
fs.writeFileSync(nativeJson, `${JSON.stringify(entries, null, 2)}\n`);

if (toolsJson && fs.existsSync(toolsJson)) {
	const tools = readJsonOrDie(toolsJson, 'tools.json');
	for (const name of Object.keys(tools)) {
		const p = path.join(nativeDir, '..', name);
		if (!fs.existsSync(p)) continue;
		const g = maxGlibcOfFile(p);
		// 读不到 ≠ 静态：maxGlibc 留 null（安装期显示"未知"），不要给假的兼容承诺
		tools[name].maxGlibc = g === UNREADABLE ? null : g;
		tools[name].staticOnly = g === null;
	}
	fs.writeFileSync(toolsJson, `${JSON.stringify(tools, null, 2)}\n`);
}

const lines = entries
	.filter((e) => e.status === 'ok')
	.map(
		(e) =>
			`${e.linuxName}: ${e.staticOnly ? 'static' : e.maxGlibc ? `glibc >= ${e.maxGlibc}` : 'glibc 下限未知（读取失败）'}`,
	);
process.stdout.write(`${lines.join('\n')}\n`);
