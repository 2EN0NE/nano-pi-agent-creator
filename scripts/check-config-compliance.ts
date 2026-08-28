/**
 * Config 合规门禁 — 检测扩展是否绕过 @zenone/pi-config 手写配置路径 / raw JSON 读写
 *
 * 用法：
 *   npx tsx scripts/check-config-compliance.ts            # 告警模式（exit 0）
 *   npx tsx scripts/check-config-compliance.ts --error    # 阻塞模式（发现违规 exit 1）
 *
 * 检测项（config 标准化：双层路径由 @zenone/pi-config 统一管理）：
 *   1. manual-extensions-data-path — 源码手写 "extensions-data" 路径字面量（未 import pi-config）
 *   2. raw-config-json-io — readFile/writeFile 直接读写 JSON（同行 JSON.parse/stringify，未 import pi-config）
 *
 * 豁免（AGENTS.md）：pi-config 自身、pi-logger（保留自身配置加载机制，避免循环依赖）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_DIRS = ['extensions'];
const EXEMPT_FILES = new Set([
	'extensions/meta/pi-config', // 自身
	'extensions/meta/pi-logger', // AGENTS.md 例外：保留自身配置加载机制
]);

interface Finding {
	file: string;
	line: number;
	rule: string;
	text: string;
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (entry === 'node_modules' || entry === '.pi') continue;
		const st = statSync(full);
		if (st.isDirectory()) collectTsFiles(full, out);
		// 测试文件不属于「扩展配置设计」范畴，跳过（测试写临时 fixture 非生产 config 违规）
		else if (
			(entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
			!entry.endsWith('.test.ts') &&
			!entry.endsWith('.spec.ts')
		)
			out.push(full);
	}
	return out;
}

function isExempt(rel: string): boolean {
	for (const prefix of EXEMPT_FILES) {
		if (rel.startsWith(prefix)) return true;
	}
	return false;
}

function scanFile(file: string): Finding[] {
	const findings: Finding[] = [];
	const rel = relative(process.cwd(), file);
	if (isExempt(rel)) return findings;

	const content = readFileSync(file, 'utf8');
	// 已 import pi-config = 已接入规范体系，豁免（规则只抓「完全绕过 pi-config」的文件）
	const usesPiConfig = content.includes('@zenone/pi-config');
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		// 跳过纯注释行，减少误报
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
			continue;
		// 行内豁免：// config-exempt
		if (line.includes('config-exempt')) continue;

		// 规则 1：手写 extensions-data 路径字面量
		if (!usesPiConfig && line.includes('extensions-data')) {
			findings.push({
				file: rel,
				line: i + 1,
				rule: 'manual-extensions-data-path',
				text: 'extensions-data',
			});
		}

		// 规则 2：raw JSON 读写（readFile/writeFile + 同行 JSON.parse/stringify）
		if (
			!usesPiConfig &&
			/(?:readFileSync|writeFileSync|readFile|writeFile)\s*\(/.test(line) &&
			/JSON\.(?:parse|stringify)/.test(line)
		) {
			const m = line.match(/(?:readFileSync|writeFileSync|readFile|writeFile)/);
			findings.push({
				file: rel,
				line: i + 1,
				rule: 'raw-config-json-io',
				text: m ? m[0] : 'raw-json-io',
			});
		}
	}
	return findings;
}

function main(): void {
	const errorMode = process.argv.includes('--error');
	const files: string[] = [];
	for (const dir of SCAN_DIRS) files.push(...collectTsFiles(join(process.cwd(), dir)));
	const all: Finding[] = [];
	for (const f of files) all.push(...scanFile(f));

	if (all.length === 0) {
		console.log('Config 合规检查通过：未发现违规。');
		return;
	}

	// 按规则分组统计
	const byRule = new Map<string, number>();
	for (const f of all) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);

	console.log(`Config 合规检查：发现 ${all.length} 处违规\n`);
	for (const [rule, count] of byRule) console.log(`  ${rule}: ${count}`);
	console.log('');

	for (const f of all) {
		console.log(`${f.file}:${f.line}  [${f.rule}]  ${f.text}`);
	}

	console.log('\n规则说明：');
	console.log(
		'  manual-extensions-data-path: 手写 extensions-data 路径字面量，改用 resolveConfigPaths()',
	);
	console.log(
		'  raw-config-json-io: readFile/writeFile 直接读写 JSON，改用 readJsonFile()/writeJsonAtomic()',
	);
	console.log(
		'\n豁免提示：pi-config/pi-logger 自身豁免；会话数据 store 也应按双层路径规范迁移。',
	);

	if (errorMode) {
		console.log('\n[ERROR] 违规未清，阻塞。');
		process.exit(1);
	}
	console.log('\n[WARN] 告警模式，不阻塞（违规清完后再切 --error 阻塞）。');
}

main();
