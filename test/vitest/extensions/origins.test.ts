/**
 * origins — 审计溯源工具单测（UX3）
 * 1. abbrevProjectPath 路径缩写
 * 2. findSessionFile / readSessionCurrentName 会话名读取（含 rename）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
	abbrevProjectPath,
	findSessionFile,
	readSessionCurrentName,
	resetSessionsRoot,
} from '../../../extensions/security/permission-gate/origins';

let sessionsHome: string;

beforeEach(() => {
	sessionsHome = mkdtempSync(join(tmpdir(), 'pg-origins-'));
	resetSessionsRoot(join(sessionsHome, '.pi', 'agent', 'sessions'));
	mkdirSync(join(sessionsHome, '.pi', 'agent', 'sessions'), { recursive: true });
});

afterEach(() => {
	rmSync(sessionsHome, { recursive: true, force: true });
});

describe('abbrevProjectPath', () => {
	const home = homedir();

	it('home 前缀 → ~ + 中间段首字母 + 叶子全名', () => {
		const p = join(home, 'Projects', 'Development', 'Agent', 'nano-pi-agent-creator');
		expect(abbrevProjectPath(p)).toBe('~/P/D/A/nano-pi-agent-creator');
	});

	it('home 本身 → ~', () => {
		expect(abbrevProjectPath(home)).toBe('~');
	});

	it('home 下仅一段 → ~/叶子（无中间段）', () => {
		expect(abbrevProjectPath(join(home, 'foo'))).toBe('~/foo');
	});

	it('home 下两段中间取首字母', () => {
		expect(abbrevProjectPath(join(home, 'work', 'repo'))).toBe('~/W/repo');
	});

	it('非 home 路径原样返回', () => {
		const p = '/var/log/system';
		expect(abbrevProjectPath(p)).toBe('/var/log/system');
	});

	it('空路径 → 空串', () => {
		expect(abbrevProjectPath('')).toBe('');
	});

	it('尾斜杠剥除', () => {
		const p = join(home, 'Projects', 'x') + '/';
		expect(abbrevProjectPath(p)).toBe('~/P/x');
	});
});

function writeSession(sessionId: string, lines: object[]): string {
	const dir = join(sessionsHome, '.pi', 'agent', 'sessions', '--cwd-slug--');
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-09-01T00-00-00-000Z_${sessionId}.jsonl`);
	writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
	return file;
}

describe('会话名读取（rename 后显示当前名）', () => {
	const sid = '019e1234-0000-7000-8000-000000000001';

	it('findSessionFile 按 sessionId 定位文件', () => {
		writeSession(sid, [{ type: 'session', id: sid }]);
		expect(findSessionFile(sid)).toMatch(new RegExp(`${sid}\\.jsonl$`));
	});

	it('读取最新 session_info name（多次 rename 取最后）', () => {
		writeSession(sid, [
			{ type: 'session', id: sid },
			{ type: 'session_info', name: '旧名字', timestamp: 't1' },
			{ type: 'message', message: {} },
			{ type: 'session_info', name: '改名后', timestamp: 't2' },
		]);
		expect(readSessionCurrentName(sid)).toBe('改名后');
	});

	it('无 session_info → undefined（回退快照）', () => {
		writeSession(sid, [{ type: 'session', id: sid }]);
		expect(readSessionCurrentName(sid)).toBeUndefined();
	});

	it('文件不存在 → undefined', () => {
		expect(readSessionCurrentName('019e0000-0000-7000-8000-000000000000')).toBeUndefined();
	});

	it('大文件尾部含 rename（倒序扫描生效）', () => {
		const lines: object[] = [{ type: 'session', id: sid }];
		for (let i = 0; i < 5000; i++) {
			lines.push({ type: 'message', message: { role: 'user', content: `m${i}` } });
		}
		lines.push({ type: 'session_info', name: '尾部改名', timestamp: 't3' });
		writeSession(sid, lines);
		expect(readSessionCurrentName(sid)).toBe('尾部改名');
	});
});
