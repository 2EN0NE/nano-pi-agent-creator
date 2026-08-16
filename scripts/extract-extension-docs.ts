#!/usr/bin/env node

/**
 * extract-extension-docs.ts — 静态扫描 extensions/ 下的注册代码，生成 docs/extensions-reference.md
 *
 * 扫描目标（每个扩展 .ts 文件的注册调用）：
 *   - pi.registerShortcut('键', { description })        → 直接快捷键
 *   - <hub>.register({ name, keys, description })      → leader-key 子键快捷键
 *   - pi.registerCommand('name', { description })      → 命令
 *   - pi.registerTool({ name, description })           → 工具
 *   - pi.registerFlag('name', { description })         → flag
 *
 * 实现：esbuild 把 TS → JS（剥离类型），acorn 解析 JS AST，遍历 CallExpression 提取元数据。
 * 不依赖 TypeScript compiler API（TS 7 为原生实现，不导出 JS API）。
 *
 * 用法：
 *   npx tsx scripts/extract-extension-docs.ts
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { transform } from 'esbuild';
import { parse } from 'acorn';

// ═══════════════════════════════════════════════════
//  类型
// ═══════════════════════════════════════════════════

interface ShortcutDoc {
	keys: string[];
	description: string;
	kind: 'hub' | 'direct';
}

interface NamedDoc {
	name: string;
	description: string;
}

interface ExtensionDoc {
	file: string;
	category: string;
	name: string;
	shortcuts: ShortcutDoc[];
	commands: NamedDoc[];
	tools: NamedDoc[];
	flags: NamedDoc[];
}

// ═══════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════

const EXT_DIR = join(process.cwd(), 'extensions');
const OUT_FILE = join(process.cwd(), 'docs', 'extensions-reference.md');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.pi']);

const CATEGORY_LABELS: Record<string, string> = {
	tui: '交互界面',
	context: '上下文组装',
	security: '审计与安全',
	auto: '自动化',
	accuracy: '更精准强大信息获取与操作工具',
	verification: '验证与评估',
	meta: '元插件',
};

// ═══════════════════════════════════════════════════
//  文件收集
// ═══════════════════════════════════════════════════

function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collectTsFiles(full, out);
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			out.push(full);
		}
	}
	return out;
}

// ═══════════════════════════════════════════════════
//  AST 工具（acorn ESTree）
// ═══════════════════════════════════════════════════

function walk(node: unknown, fn: (n: any) => void): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) walk(item, fn);
		return;
	}
	const n = node as Record<string, unknown>;
	if (typeof n.type === 'string') fn(n as any);
	for (const [key, value] of Object.entries(n)) {
		if (key === 'loc' || key === 'start' || key === 'end' || key === 'parent') continue;
		walk(value, fn);
	}
}

/** 提取字符串字面量（Literal / TemplateLiteral，动态部分用 … 占位） */
function stringOf(node: any): string | null {
	if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node?.type === 'TemplateLiteral') {
		const parts = node.quasis.map((q: any) => q.value.cooked ?? '');
		return parts.join('…').replace(/…+/g, '…');
	}
	return null;
}

/** Key 修饰符映射（pi-tui Key.xxx('y') → 'ctrl+shift+y' 等） */
const KEY_MODIFIERS: Record<string, string> = {
	ctrl: 'ctrl+',
	shift: 'shift+',
	alt: 'alt+',
	meta: 'meta+',
	ctrlShift: 'ctrl+shift+',
	ctrlAlt: 'ctrl+alt+',
	shiftAlt: 'shift+alt+',
	ctrlShiftAlt: 'ctrl+shift+alt+',
};

/**
 * 提取快捷键键值：
 * - 字符串字面量 → 原值
 * - Key.xxx('y') 调用 → '修饰符+y'
 * - 变量 / 其他表达式 → null（动态键豁免，决策 #6）
 */
function keyOf(node: any): string | null {
	const literal = stringOf(node);
	if (literal !== null) return literal;
	if (node?.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
		const obj = node.callee.object;
		const prop = node.callee.property;
		if (obj?.type === 'Identifier' && obj.name === 'Key' && prop?.type === 'Identifier') {
			const mod = KEY_MODIFIERS[prop.name];
			const arg = node.arguments[0];
			const ch = arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value : null;
			if (mod && ch) return mod + ch;
		}
	}
	return null;
}

/** 从 ObjectExpression 提取 description */
function descriptionOf(obj: any): string | null {
	if (obj?.type !== 'ObjectExpression') return null;
	for (const prop of obj.properties) {
		if (prop.type !== 'Property') continue;
		const key = prop.key?.name ?? prop.key?.value;
		if (key === 'description') return stringOf(prop.value);
	}
	return null;
}

/** 从 ObjectExpression 提取 name + keys + description */
function extractObject(obj: any): {
	name: string | null;
	keys: string[] | null;
	description: string | null;
} {
	const result = {
		name: null as string | null,
		keys: null as string[] | null,
		description: null as string | null,
	};
	if (obj?.type !== 'ObjectExpression') return result;
	for (const prop of obj.properties) {
		if (prop.type !== 'Property') continue;
		const key = prop.key?.name ?? prop.key?.value;
		if (key === 'name') result.name = stringOf(prop.value);
		else if (key === 'description') result.description = stringOf(prop.value);
		else if (key === 'keys' && prop.value?.type === 'ArrayExpression') {
			result.keys = prop.value.elements
				.filter((e: any) => e?.type === 'Literal' && typeof e.value === 'string')
				.map((e: any) => e.value as string);
		}
	}
	return result;
}

// ═══════════════════════════════════════════════════
//  扩展名 / 分类提取
// ═══════════════════════════════════════════════════

function extName(rel: string, filePath: string): string {
	const base = basename(filePath, '.ts');
	if (base !== 'index') return base;
	const parts = rel.split('/');
	// index.ts → 取所在目录名（跳过通用 src/）
	for (let i = parts.length - 2; i >= 0; i--) {
		if (parts[i] !== 'src') return parts[i];
	}
	return base;
}

// ═══════════════════════════════════════════════════
//  单文件扫描
// ═══════════════════════════════════════════════════

async function scanFile(filePath: string): Promise<ExtensionDoc | null> {
	const code = readFileSync(filePath, 'utf8');
	let js: string;
	try {
		js = (await transform(code, { loader: 'ts', format: 'esm', target: 'es2022' })).code;
	} catch {
		return null;
	}
	let ast: any;
	try {
		ast = parse(js, { ecmaVersion: 'latest', sourceType: 'module' });
	} catch {
		return null;
	}

	const rel = relative(EXT_DIR, filePath);
	const doc: ExtensionDoc = {
		file: relative(process.cwd(), filePath),
		category: rel.split('/')[0],
		name: extName(rel, filePath),
		shortcuts: [],
		commands: [],
		tools: [],
		flags: [],
	};

	walk(ast, (node) => {
		if (node.type !== 'CallExpression') return;
		const callee = node.callee;
		if (callee?.type !== 'MemberExpression') return;
		const obj = callee.object;
		const prop = callee.property;
		if (obj?.type !== 'Identifier' || prop?.type !== 'Identifier') return;
		const method = prop.name;

		if (method === 'registerShortcut') {
			const key = keyOf(node.arguments[0]);
			const desc = descriptionOf(node.arguments[1]);
			if (key) doc.shortcuts.push({ keys: [key], description: desc ?? '', kind: 'direct' });
		} else if (method === 'registerCommand') {
			const name = stringOf(node.arguments[0]);
			const desc = descriptionOf(node.arguments[1]);
			if (name) doc.commands.push({ name, description: desc ?? '' });
		} else if (method === 'registerFlag') {
			const name = stringOf(node.arguments[0]);
			const desc = descriptionOf(node.arguments[1]);
			if (name) doc.flags.push({ name, description: desc ?? '' });
		} else if (method === 'registerTool') {
			const extracted = extractObject(node.arguments[0]);
			if (extracted.name)
				doc.tools.push({ name: extracted.name, description: extracted.description ?? '' });
		} else if (method === 'register' && /hub|shortcut/i.test(obj.name)) {
			const extracted = extractObject(node.arguments[0]);
			if (extracted.name && extracted.keys && extracted.keys.length > 0) {
				doc.shortcuts.push({
					keys: extracted.keys,
					description: extracted.description ?? '',
					kind: 'hub',
				});
			}
		}
	});

	const hasAny =
		doc.shortcuts.length > 0 ||
		doc.commands.length > 0 ||
		doc.tools.length > 0 ||
		doc.flags.length > 0;
	return hasAny ? doc : null;
}

// ═══════════════════════════════════════════════════
//  Markdown 生成
// ═══════════════════════════════════════════════════

function fmtKeys(keys: string[]): string {
	return keys.map((k) => `\`${k}\``).join(' ');
}

function render(docs: ExtensionDoc[]): string {
	const lines: string[] = [];
	lines.push(
		'<!-- 自动生成，请勿手改：运行 `npx tsx scripts/extract-extension-docs.ts` 重新生成 -->',
	);
	lines.push('# Extensions Reference');
	lines.push('');
	lines.push('> 本文件由 `scripts/extract-extension-docs.ts` 静态扫描扩展注册代码自动生成。');
	lines.push(
		'> 快捷键体系（leader-key 子键分发）见 [docs/adr/0015-shortcut-hub-architecture.md](adr/0015-shortcut-hub-architecture.md)。',
	);
	lines.push('');

	// 按分类分组
	const byCategory = new Map<string, ExtensionDoc[]>();
	for (const doc of docs) {
		const list = byCategory.get(doc.category) ?? [];
		list.push(doc);
		byCategory.set(doc.category, list);
	}

	for (const [category, list] of [...byCategory.entries()].sort()) {
		const label = CATEGORY_LABELS[category] ?? category;
		lines.push(`## ${category}/ — ${label}`);
		lines.push('');

		for (const doc of list.sort((a, b) => a.name.localeCompare(b.name))) {
			lines.push(`### ${doc.name}`);
			lines.push('');
			lines.push(`路径: \`${doc.file}\``);
			lines.push('');

			if (doc.shortcuts.length > 0) {
				lines.push('**快捷键**');
				lines.push('');
				for (const s of doc.shortcuts) {
					const kind = s.kind === 'hub' ? '（子键）' : '（降级键）';
					const desc = s.description || '—';
					lines.push(`- ${fmtKeys(s.keys)} ${kind} — ${desc}`);
				}
				lines.push('');
			}

			if (doc.commands.length > 0) {
				lines.push('**命令**');
				lines.push('');
				for (const c of doc.commands) {
					lines.push(`- \`/${c.name}\` — ${c.description || '—'}`);
				}
				lines.push('');
			}

			if (doc.tools.length > 0) {
				lines.push('**工具**');
				lines.push('');
				for (const t of doc.tools) {
					lines.push(`- \`${t.name}\` — ${t.description || '—'}`);
				}
				lines.push('');
			}

			if (doc.flags.length > 0) {
				lines.push('**Flags**');
				lines.push('');
				for (const f of doc.flags) {
					lines.push(`- \`${f.name}\` — ${f.description || '—'}`);
				}
				lines.push('');
			}
		}
	}

	return lines.join('\n');
}

// ═══════════════════════════════════════════════════
//  main
// ═══════════════════════════════════════════════════

async function main(): Promise<void> {
	const files = collectTsFiles(EXT_DIR);
	const docs: ExtensionDoc[] = [];
	for (const f of files) {
		const doc = await scanFile(f);
		if (doc) docs.push(doc);
	}
	docs.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

	const md = render(docs);
	mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
	writeFileSync(OUT_FILE, md);
	console.log(`Generated ${OUT_FILE}: ${docs.length} extensions, ${files.length} files scanned`);
}

void main();
