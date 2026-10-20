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
 *   3. repo-scoped-config-not-anchored（--anchor 模式单独跑，**阻塞**）——
 *      仓库级配置消费者（下列 REPO_SCOPED_CONFIG_CONSUMERS）解析配置时，必须显式锚到
 *      仓库根（`cwd: <repoRoot>`，repoRoot 由 `git rev-parse --git-common-dir` 推导），
 *      或者用 `// config-scope: session-cwd` 显式声明这是「目录作用域」配置。
 *      依据：AGENTS.md「项目级配置的解析锚点：仓库级 vs 目录级【强制判断】」——
 *      `.pi/` 通常被 gitignore 且每个 worktree 各有独立 `.pi/`，锚在会话 cwd 会让
 *      仓库级配置在成员 worktree 里静默不可见。
 *
 * 用法：
 *   npx tsx scripts/check-config-compliance.ts            # 规则 1/2 告警模式（exit 0）
 *   npx tsx scripts/check-config-compliance.ts --error    # 规则 1/2 阻塞模式
 *   npx tsx scripts/check-config-compliance.ts --anchor --error   # 只跑规则 3（阻塞）
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

// ── 规则 3：仓库级配置的解析锚点 ──

/**
 * 「仓库级配置消费者」：这些扩展的项目级配置描述的是**仓库事实**，必须锚在仓库根。
 * 新增此类扩展时把它加进来（并在该文件里用 `cwd: <repoRoot>` 解析配置）。
 */
const REPO_SCOPED_CONFIG_CONSUMERS = ['extensions/meta/worktree'];

/** 会话 cwd 值表达式（用作配置锚点 = 违反规则 3） */
const SESSION_CWD_VALUE = /^(?:process\.cwd\(\)|ctx\.cwd|cwd)(?![\w$.[])/;

/** 对象字面量里的 `cwd: <value>` 属性（值截到逗号/右括号/换行） */
const CWD_PROP = /[{,]\s*cwd\s*:\s*([^,}\n]+)/;

/** 简写属性 `{ cwd }`（等价于 `cwd: cwd`） */
const CWD_SHORTHAND = /[{,]\s*cwd\s*[,}]/;

/** 目录作用域声明（合法豁免：配置描述的确实是「当前目录」） */
const SESSION_SCOPE_MARK = /config-scope:\s*session-cwd/;

/** 解析配置的调用点 */
const CONFIG_CALL = /(?:createConfigStore|resolveConfigPaths|loadLayeredConfig)\s*[(<]/;

function isRepoScopedConsumer(rel: string): boolean {
	return REPO_SCOPED_CONFIG_CONSUMERS.some((prefix) => rel.startsWith(prefix));
}

/** 调用点前后的文本窗口（用于找 `// config-scope:` 声明，允许写在调用点上方） */
function statementWindow(lines: string[], i: number, span = 10): string {
	return lines.slice(Math.max(0, i - 3), i + span).join('\n');
}

/** **自调用行起**的文本窗口（用于找 `cwd:` 实参，避免把上方形参类型注解当成实参） */
function callWindow(lines: string[], i: number, span = 10): string {
	return lines.slice(i, i + span).join('\n');
}

/**
 * 判断调用点是否把配置锚在了仓库根。
 *
 * 两个必须避开的误判：
 *   - 函数形参/类型注解里的 `cwd:`（`probe(cwd: string)`、`ctx: { cwd: string }`）——
 *     故只在**自调用行起**的窗口里找，且要求 `cwd:` 前是 `{` 或 `,`（对象字面量）。
 *   - 简写属性 `{ cwd }`（= `cwd: cwd`）——单列处理。
 */
function anchorVerdict(window: string): 'anchored' | 'session' | 'none' {
	const m = CWD_PROP.exec(window);
	if (m) return SESSION_CWD_VALUE.test(m[1].trim()) ? 'session' : 'anchored';
	if (CWD_SHORTHAND.test(window)) return 'session'; // 简写 = cwd: cwd
	return 'none';
}

function scanFile(file: string, opts: { anchorOnly: boolean } = { anchorOnly: false }): Finding[] {
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
		if (!opts.anchorOnly && !usesPiConfig && line.includes('extensions-data')) {
			findings.push({
				file: rel,
				line: i + 1,
				rule: 'manual-extensions-data-path',
				text: 'extensions-data',
			});
		}

		// 规则 2：raw JSON 读写（readFile/writeFile + 同行 JSON.parse/stringify）
		if (
			!opts.anchorOnly &&
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

		// 规则 3：仓库级配置消费者的解析锚点
		if (opts.anchorOnly && isRepoScopedConsumer(rel) && CONFIG_CALL.test(line)) {
			const window = statementWindow(lines, i);
			const declared = SESSION_SCOPE_MARK.test(window);
			const anchored = anchorVerdict(callWindow(lines, i)) === 'anchored';
			if (!declared && !anchored) {
				findings.push({
					file: rel,
					line: i + 1,
					rule: 'repo-scoped-config-not-anchored',
					text: line.trim().slice(0, 80),
				});
			}
		}
	}
	return findings;
}

function main(): void {
	const errorMode = process.argv.includes('--error');
	// --anchor：只跑规则 3（仓库级配置锚点）。规则 1/2 尚有历史欠账，无法整体阻塞；
	// 规则 3 从第一天就是干净的，因此单独提供**阻塞**门禁。
	const anchorOnly = process.argv.includes('--anchor');
	const files: string[] = [];
	for (const dir of SCAN_DIRS) files.push(...collectTsFiles(join(process.cwd(), dir)));
	const all: Finding[] = [];
	for (const f of files) all.push(...scanFile(f, { anchorOnly }));

	if (all.length === 0) {
		console.log(
			anchorOnly
				? 'Config 锚点检查通过：仓库级配置消费者均显式声明了解析锚点。'
				: 'Config 合规检查通过：未发现违规。',
		);
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
		'  repo-scoped-config-not-anchored: 仓库级配置消费者必须显式锚仓库根 ' +
			'(`cwd: <repoRoot>`，repoRoot 由 git-common-dir 推导)，' +
			'或用 `// config-scope: session-cwd` 声明目录作用域（见 AGENTS.md 强制判断）',
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
