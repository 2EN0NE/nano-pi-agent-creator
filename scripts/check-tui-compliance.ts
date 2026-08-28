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
 * session-breakdown / resources-tree（连续色阶热力图，theme 无对应 API）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_DIRS = ['extensions', 'src/tui'];
const EXEMPT_FILES = new Set([
	'extensions/tui/catch-the-fox', // 像素网格渲染，直接输出 ANSI 转义
	'extensions/auto/pi-tmux-status', // tmux 状态栏 emoji，非 Pi TUI 渲染路径
	'extensions/meta/pi-logger', // 日志基础设施，给终端日志着色（ADR-0023：日志文本不受限）
	'extensions/tui/session-breakdown', // 日历热力图：模型颜色加权 RGB + 亮度，连续色阶
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
		'\n豁免提示：ctx.ui.notify() 通知文案、日志文本按 ADR-0023 不受限，命中需人工判断。',
	);

	if (errorMode) {
		console.log('\n[ERROR] 违规未清，阻塞。');
		process.exit(1);
	}
	console.log('\n[WARN] 告警模式，不阻塞（违规清完后再切 --error 阻塞）。');
}

main();
