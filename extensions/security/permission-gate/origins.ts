/**
 * origins — 审计溯源工具（UX3）
 *
 * 1. abbrevProjectPath()：项目路径缩写（列表列用）。home 前缀段替换为 `~`，
 *    中间目录取首字母大写，最后一段（项目名）保留全名。例：
 *    /Users/jojo/Projects/Development/Agent/nano-pi-agent-creator
 *      → ~/P/D/A/nano-pi-agent-creator
 * 2. readSessionCurrentName()：按 sessionId 读会话文件的最新 session_info（改名后的当前名）。
 *    会话文件：<~/.pi/agent/sessions>/<cwd-slug>/<start>_<sessionId>.jsonl，
 *    首行 {"type":"session",...}，session_info 行 {"type":"session_info","name":"..."}（最新者胜）。
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('permission-gate:origins');

/**
 * 路径缩写（列表列展示用）：
 * - home 前缀段 → `~`
 * - 中间目录取首字母（大写）
 * - 最后一段（项目/叶子名）保留全名
 * - 非 home 下路径原样返回（罕见场景，宽度截断由 UI 兜底）
 */
export function abbrevProjectPath(path: string): string {
	if (!path) return '';
	const home = homedir();
	const normalized = path.replace(/\/+$/, '');
	if (!normalized.startsWith(home + sep) && normalized !== home) {
		// 不在 home 下：原样返回
		return normalized;
	}

	// home 下：相对 home 的剩余段
	const rel = normalized.slice(home.length).replace(/^\/+/, '');
	if (!rel) return '~';
	const segs = rel.split('/').filter(Boolean);
	const leaf = segs[segs.length - 1];
	const middle = segs.slice(0, -1).map((s) => s.charAt(0).toUpperCase());
	return ['~', ...middle, leaf].join('/');
}

/**
 * 会话根目录（测试可注入）。默认 ~/.pi/agent/sessions
 */
let sessionsRoot: string = join(homedir(), '.pi', 'agent', 'sessions');

/** 测试专用：注入会话根目录 */
export function resetSessionsRoot(root: string): void {
	sessionsRoot = root;
}

/** 返回会话根目录（测试断言用） */
export function getSessionsRoot(): string {
	return sessionsRoot;
}

function walkJsonl(dir: string, depth: number, out: string[]): void {
	if (depth > 4 || !existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walkJsonl(p, depth + 1, out);
		} else if (name.endsWith('.jsonl')) {
			out.push(p);
		}
	}
}

/**
 * 按 sessionId 定位会话文件（文件名含 `<sessionId>.jsonl`）。
 */
export function findSessionFile(sessionId: string): string | null {
	if (!sessionId) return null;
	const files: string[] = [];
	walkJsonl(sessionsRoot, 0, files);
	// 文件名模板：<ISO-start>_<sessionId>.jsonl；sessionId 也可能不含连字符的缩略形式
	for (const f of files) {
		const base = parse(f).name;
		if (base === sessionId || base.endsWith(`_${sessionId}`)) return f;
	}
	return null;
}

/**
 * 读会话文件的最新 session_info name（会话若被 rename，返回改名后的当前名）。
 * 文件不存在或没有 session_info → undefined（调用方回退到审计快照名）。
 * 实现：从文件末尾倒序找最后一个 `"type":"session_info"` 行解析 name，
 * 避免整文件顺序读（长会话 10 万+ 行时保持低开销）。
 */
export function readSessionCurrentName(sessionId: string): string | undefined {
	const file = findSessionFile(sessionId);
	if (!file) return undefined;
	try {
		const name = scanLastSessionInfoName(file);
		return name?.trim() || undefined;
	} catch (err) {
		log.warn('readSessionCurrentName failed for %s: %s', sessionId, String(err));
		return undefined;
	}
}

/** 从文件尾部倒序块扫描，返回最后一个 session_info 的 name（无则 undefined）。 */
function scanLastSessionInfoName(file: string): string | undefined {
	const CHUNK = 64 * 1024;
	const st = statSync(file);
	const size = st.size;
	if (size === 0) return undefined;

	const fd = openFileSync(file);
	try {
		let tail = '';
		let offset = size;
		while (offset > 0) {
			const readStart = Math.max(0, offset - CHUNK);
			const buf = readFileRange(fd, readStart, offset - readStart);
			tail = buf.toString('utf8') + tail;
			offset = readStart;
			// 只保留尾部窗口，防止超大文件持续翻倍内存
			if (tail.length > 1_048_576) tail = tail.slice(-1_048_576);
			const found = lastSessionInfoNameIn(tail);
			if (found !== undefined || (tail.startsWith('{"type":"session"') && readStart === 0)) {
				return found;
			}
			// 本块末尾可能截断行首 —— 每轮保留下一次接续足够余量（一行长度上限内）
			if (readStart === 0) return lastSessionInfoNameIn(tail);
		}
		return undefined;
	} finally {
		closeFile(fd);
	}
}

// ── node:fs 同步范围读（避免整文件 readFileSync） ──

function openFileSync(file: string): number {
	return openSync(file, 'r');
}
function readFileRange(fd: number, position: number, length: number): Buffer {
	const buf = Buffer.alloc(length);
	readSync(fd, buf, 0, length, position);
	return buf;
}
function closeFile(fd: number): void {
	closeSync(fd);
}

/** 在文本中找最后一个 session_info 行，解析其 name（无 → undefined）。 */
export function lastSessionInfoNameIn(text: string): string | undefined {
	let idx = text.lastIndexOf('"type":"session_info"');
	while (idx >= 0) {
		const lineStart = text.lastIndexOf('\n', idx);
		const lineEnd = text.indexOf('\n', idx);
		const line = text.slice(lineStart + 1, lineEnd === -1 ? undefined : lineEnd).trim();
		try {
			const obj = JSON.parse(line) as { name?: unknown };
			if (typeof obj.name === 'string') return obj.name.trim() || undefined;
			return undefined; // 显式清除（name 为空）视为最新
		} catch {
			idx = text.lastIndexOf('"type":"session_info"', idx - 1);
		}
	}
	return undefined;
}

// 供 UI 全路径展示：原样返回（详情用）
export function fullProjectPath(path: string): string {
	return path;
}
