/**
 * TUI 合规门禁 — 检测三类视觉违规（ADR-0023）
 *
 * 用法：
 *   npx tsx scripts/check-tui-compliance.ts            # 告警模式（exit 0）
 *   npx tsx scripts/check-tui-compliance.ts --error    # 阻塞模式（发现违规 exit 1）
 *
 * 检测项：
 *   1. 硬编码 ANSI 颜色（SGR 序列以 m 结尾；排除按键序列 \x1b[A-D）
 *   2. 双宽 emoji / 图标（Unicode Extended_Pictographic；单宽箭头 ↑↓←→ 不在其内，天然放行）
 *   3. padEnd/repeat 配 .length 的对齐写法（提示性，需人工确认）
 *
 * 豁免（ADR-0023）：catch-the-fox（像素网格）、pi-tmux-status（tmux 状态栏）、
 * session-analytics / resources-tree（连续色阶热力图，theme 无对应 API）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_DIRS = ['extensions', 'src/tui'];
const EXEMPT_FILES = new Set([
	'extensions/tui/DEMO:catch-the-fox', // 像素网格渲染，直接输出 ANSI 转义
	'extensions/auto/pi-tmux-status', // tmux 状态栏 emoji，非 Pi TUI 渲染路径
	'extensions/meta/pi-logger', // 日志基础设施，给终端日志着色（ADR-0023：日志文本不受限）
	'extensions/observability/session-analytics', // 日历热力图：模型颜色加权 RGB + 亮度，连续色阶
	'extensions/context/resources-tree/utils', // 用量比例 256 色渐变，连续色阶
]);

interface Finding {
	file: string;
	line: number;
	rule: string;
	text: string;
}

// 检测 1：硬编码 ANSI **颜色** SGR 序列（\x1b[...m / \033[...m / \u001b[...m）
// 匹配颜色码：30-38（前景+256/24位）、40-48（背景）、90-97（亮前景）、100-107（亮背景），
// 含变量插值形态（38;5;${code} / 38;2;${r};${g};${b}）。
// 豁免：reset(0)/bold(1)/dim(2)/italic(3)/underline(4)/normal(22) 等样式序列；
//       连续色阶（数据可视化热力图）由 EXEMPT_FILES 显式豁免，不依赖 regex 巧合漏检。
const ANSI_COLOR_RE =
	/\\(?:x1b|033|u001b)\[(?:3[0-8]|4[0-8]|9[0-7]|10[0-7])(?:[;0-9]|\$\{[^}]*\})*m/g;

// 检测 2：双宽 emoji / 图标。\p{Extended_Pictographic} 覆盖双宽 emoji（📋⚠⏳▶🔴 等）；
// 显式补充 ✓(U+2713)/✗(U+2717)——它们不是 Extended_Pictographic（实测 false），
// 但宽度不确定、ADR-0023 明确禁止。
// 单宽箭头（U+2190-U+21FF，含 ↔↕↖ 等被 Extended_Pictographic 误收录的）在 scanFile 里排除。
const EMOJI_RE = /[\p{Extended_Pictographic}\u2713\u2717]/gu;

// 检测 3：.padEnd / .repeat 调用参数中直接使用 .length（启发式，提示性）
const LENGTH_ALIGN_RE = /\.(?:padEnd|repeat)\s*\([^)]*\.length\b/g;

// 检测 4（expect 脚本）：等待循环里只 send/sleep 而不读取 PTY。
// 根因（实测）：expect 停止读 PTY → pi 的 TUI 写满 PTY 缓冲后**同步阻塞在 write** →
// 事件循环冻结 → 工具调用不执行、exec 的 close 不再触发、覆盖层不渲染，最终用例超时
// 且留下未释放的锁（pi-rewind `/rewind` 用例曾因此稳定失败 120s）。
// 判定：循环体内含 send 与 sleep，但不含 expect / read / drain（后者是各文件的排空助手）。
// 排空写法：expect { -timeout 0 -re {.+} { exp_continue } timeout { } }（零延迟，不改节奏）。
const E2E_EXPECT_DIR = 'test/e2e/extensions';

function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (entry === 'node_modules' || entry === '.pi') continue;
		const st = statSync(full);
		if (st.isDirectory()) collectTsFiles(full, out);
		else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
	}
	return out;
}

/** 收集 expect 脚本（tui-*.test.sh / *.exp） */
function collectExpectFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (entry === 'node_modules') continue;
		const st = statSync(full);
		if (st.isDirectory()) collectExpectFiles(full, out);
		else if (entry.endsWith('.test.sh') || entry.endsWith('.exp')) out.push(full);
	}
	return out;
}

/**
 * 找出「等待循环只 send/sleep、不排空 PTY」的循环体行号。
 *
 * 用大括号配对（而非正则）提取 `while {…} { … }` / `for {…} { … }` 的**体**，
 * 再判断体内是否含 send+sleep、且无 expect/read/drain。嵌套循环由扫描自然覆盖。
 */
function findUndrainedLoops(src: string): number[] {
	const hits: number[] = [];
	const re = /(?:^|[\s;])(while|for)\s*\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		// Tcl：while {cond} {body} / for {init} {cond} {incr} {body}
		// → 收集紧跟其后的所有大括号组，**最后一组**才是循环体（曾只跳 1 组，
		//   把 for 的「条件组」当成体 → 规则永不命中）。
		const groups: Array<{ start: number; end: number }> = [];
		let pos = src.indexOf('{', m.index);
		while (pos !== -1 && groups.length <= 4) {
			let depth = 0;
			let k = pos;
			for (; k < src.length; k++) {
				if (src[k] === '{') depth++;
				else if (src[k] === '}') {
					depth--;
					if (depth === 0) break;
				}
			}
			if (depth !== 0) break;
			groups.push({ start: pos, end: k });
			let nxt = k + 1;
			while (nxt < src.length && /\s/.test(src[nxt])) nxt++;
			if (src[nxt] !== '{') break;
			pos = nxt;
		}
		const last = groups[groups.length - 1];
		if (!last) continue;
		const body = src.slice(last.start, last.end + 1);
		const hasSleep = /\bsleep\b/.test(body);
		// 判据是「等待（sleep）期间不读 PTY」，**与是否 send 无关**：pi-rewind 的
		// 死锁循环体里只有 `file exists` 轮询（无 send），而 pi 正在流式输出 →
		// 同样写满 PTY 缓冲。只看 send 会漏掉真正的元凶（曾因此规则形同虚设）。
		// \bdrain 前缀匹配：harness 助手名为 drain_pty（\bdrain\b 会被下划线挡住 → 曾漏判）
		const drains = /\bexpect\b|\bread\b|\bdrain/.test(body);
		if (hasSleep && !drains) {
			hits.push(src.slice(0, m.index).split('\n').length);
		}
	}
	return hits;
}

function findUnboundedDrains(src: string): number[] {
	const hits: number[] = [];
	const re = /\bexpect\b[^\n]*\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		const open = src.indexOf('{', m.index);
		const startLine = src.slice(0, open).split('\n').length;
		const startLineText = src.split('\n')[startLine - 1] ?? '';
		// 注释里的示例不算（缺陷只在真代码里）
		if (startLineText.trim().startsWith('#')) {
			re.lastIndex = open + 1;
			continue;
		}
		let depth = 0;
		let k = open;
		for (; k < src.length; k++) {
			if (src[k] === '{') depth++;
			else if (src[k] === '}') {
				depth--;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) continue;
		const block = src.slice(open, k + 1);
		// 无界特征：`exp_continue` 反复续读 + `-timeout 0`（**无时间上限**）+ 无 `break`（无块数上限）
		// → pi 只要在流式输出就永远 exp_continue（实测 case 003 因此挂满 300s 被预算杀掉）。
		// 有界写法：`-timeout 2`（时间限）或带计数 `break`（块数限，见 harness 的 drain_pty）。
		if (
			/\bexp_continue\b/.test(block) &&
			/-timeout\s+0\b/.test(block) &&
			!/\bbreak\b/.test(block)
		) {
			hits.push(startLine);
		}
		re.lastIndex = k + 1;
	}
	return hits;
}

function scanExpectFile(file: string): Finding[] {
	const src = readFileSync(file, 'utf-8');
	const findings: Finding[] = findUndrainedLoops(src).map((line) => ({
		file,
		line,
		rule: 'expect-poll-without-drain',
		text: '等待循环内只 sleep 未读 PTY：pi 会写满 PTY 缓冲后同步阻塞（循环内加 drain_pty 20 或 expect { -timeout 2 ... }）',
	}));
	for (const line of findUnboundedDrains(src)) {
		findings.push({
			file,
			line,
			rule: 'unbounded-pty-drain',
			text: '排空无界：-timeout 0 + exp_continue 且无 break → pi 持续流式输出时永不返回（用 drain_pty 20，或给 -timeout 非 0）',
		});
	}
	return findings;
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
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		// 跳过纯注释行，减少误报（含 /** 块注释开头行）
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
			continue;
		// 行内豁免：// tui-exempt（ADR-0023：通知文案/日志文本不受限）
		if (line.includes('tui-exempt')) continue;

		for (const m of line.matchAll(ANSI_COLOR_RE)) {
			findings.push({
				file: rel,
				line: i + 1,
				rule: 'hardcoded-ansi-color',
				text: m[0],
			});
		}
		for (const m of line.matchAll(EMOJI_RE)) {
			// 排除单宽箭头（U+2190-U+21FF，如 ↔↕↖），宽度恒为 1 无崩溃风险（ADR 允许 ↑↓←→ 及同类）
			const cp = m[0].codePointAt(0);
			if (cp !== undefined && cp >= 0x2190 && cp <= 0x21ff) continue;
			findings.push({
				file: rel,
				line: i + 1,
				rule: 'wide-emoji',
				text: m[0],
			});
		}
		for (const m of line.matchAll(LENGTH_ALIGN_RE)) {
			findings.push({
				file: rel,
				line: i + 1,
				rule: 'length-alignment',
				text: m[0],
			});
		}
		// 方角/圆角边框：仅报成对的框（┌┐ 同行顶框、└┘ 同行底框）。
		// 单独的 └/├（树形 connector，如 '└─ '、'│' 延续）是树结构本体，ADR-0023 豁免。
		const hasTopCorners = line.includes('\u250c') && line.includes('\u2510');
		const hasBottomCorners = line.includes('\u2514') && line.includes('\u2518');
		if (hasTopCorners || hasBottomCorners) {
			findings.push({
				file: rel,
				line: i + 1,
				rule: 'box-corner',
				text: hasTopCorners ? '方角顶框' : '方角底框',
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
	for (const f of collectExpectFiles(join(process.cwd(), E2E_EXPECT_DIR))) {
		all.push(...scanExpectFile(f));
	}

	if (all.length === 0) {
		console.log('TUI 合规检查通过：未发现违规。');
		return;
	}

	// 按规则分组统计
	const byRule = new Map<string, number>();
	for (const f of all) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);

	console.log(`TUI 合规检查：发现 ${all.length} 处违规\n`);
	for (const [rule, count] of byRule) console.log(`  ${rule}: ${count}`);
	console.log('');

	for (const f of all) {
		console.log(`${f.file}:${f.line}  [${f.rule}]  ${f.text}`);
	}

	console.log('\n规则说明：');
	console.log('  hardcoded-ansi-color: 硬编码 ANSI 颜色，改用 theme.fg/accent/... 主题色');
	console.log('  wide-emoji: 双宽 emoji/图标，改用纯文本（OK/BLOCK/[x]/[ ]/等）');
	console.log('  length-alignment: 对齐用 .length 而非 visibleWidth，宽字符会错位');
	console.log(
		'  box-corner: 方角/圆角边框（┌┐└┘╭╮╰╯），纯横线范式禁用（改用 topBorder/bottomBorder）',
	);
	console.log(
		'  expect-poll-without-drain: 等待循环只 sleep 不读 PTY → pi 会同步阻塞在 write（循环内调用 drain_pty 20）',
		'  unbounded-pty-drain: -timeout 0 + exp_continue 且无 break 的排空在持续流式输出下永不返回（用 drain_pty 20）',
	);
	console.log(
		'\n豁免提示：ctx.ui.notify() 通知文案、日志文本按 ADR-0023 不受限，命中需人工判断。',
	);

	if (errorMode) {
		console.log('\n[ERROR] 违规未清，阻塞。');
		process.exit(1);
	}
	console.log('\n[WARN] 告警模式，不阻塞（违规清完后再切 --error 阻塞）。');
}

main();
