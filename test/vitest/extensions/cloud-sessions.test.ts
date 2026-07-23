/**
 * cloud-sessions — Sync 模块：仅同步当前 cwd 的会话
 *
 * Bug: Sync.run() 的 listLocalSessions() 遍历 ~/.pi/agent/sessions/ 下
 * 所有 cwd 目录的 .jsonl 文件，导致推送时上传其他项目的会话。
 *
 * 修复：过滤 local 会话，只保留当前 cwd 目录下的文件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

// ── Mock @earendil-works/pi-coding-agent 的 getAgentDir ──
const TEST_TMP = join(
	'/tmp',
	`cloud-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
);

vi.mock('@earendil-works/pi-coding-agent', () => ({
	getAgentDir: () => TEST_TMP,
}));

// ── Mock @zenone/pi-logger ──
vi.mock('@zenone/pi-logger', () => ({
	createLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import {
	listLocalSessions,
	listLocalSessionsForCwd,
	sessionsRoot,
} from '../../../extensions/auto/cloud-sessions/src/sessions';

// ── 辅助函数 ──

/** 创建编码后的 cwd 目录并写入会话文件 */
async function createSessionFile(
	encodedCwd: string,
	fileName: string,
	content?: string,
): Promise<string> {
	const dir = join(sessionsRoot(), encodedCwd);
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, fileName);
	await writeFile(filePath, content ?? `{"type":"session","version":3,"id":"${fileName}"}\n`);
	return filePath;
}

describe('listLocalSessions — cwd 过滤', () => {
	const CWD_A = '--home-user-projects-project-alpha--';
	const CWD_B = '--home-user-projects-project-beta--';
	const CWD_C = '--Users-other-machine-project-alpha--';

	beforeEach(async () => {
		// 清理并重建测试目录结构
		await rm(sessionsRoot(), { recursive: true, force: true }).catch(() => {});
		await mkdir(sessionsRoot(), { recursive: true });

		// project-alpha 有 2 个会话
		await createSessionFile(CWD_A, 'session-001.jsonl', '{"type":"session","id":"s1"}');
		await createSessionFile(CWD_A, 'session-002.jsonl', '{"type":"session","id":"s2"}');

		// project-beta 有 2 个会话
		await createSessionFile(CWD_B, 'session-003.jsonl', '{"type":"session","id":"s3"}');
		await createSessionFile(CWD_B, 'session-004.jsonl', '{"type":"session","id":"s4"}');

		// 同项目不同机器 有 1 个会话
		await createSessionFile(CWD_C, 'session-005.jsonl', '{"type":"session","id":"s5"}');
	});

	afterEach(async () => {
		await rm(sessionsRoot(), { recursive: true, force: true }).catch(() => {});
	});

	it('列出所有 cwd 的会话（当前行为）', async () => {
		const all = await listLocalSessions();
		expect(all.length).toBe(5);
	});

	it('过滤后只返回当前 cwd 的会话', async () => {
		// 模拟只取 CWD_A 的会话
		const all = await listLocalSessions();
		const filtered = all.filter((f) => f.relativePath.startsWith(CWD_A + '/'));
		expect(filtered.length).toBe(2);
		for (const f of filtered) {
			expect(f.relativePath.startsWith(CWD_A + '/')).toBe(true);
		}
	});

	it('过滤后只返回 CWD_B 的会话', async () => {
		const all = await listLocalSessions();
		const filtered = all.filter((f) => f.relativePath.startsWith(CWD_B + '/'));
		expect(filtered.length).toBe(2);
		for (const f of filtered) {
			expect(f.relativePath.startsWith(CWD_B + '/')).toBe(true);
		}
	});

	it('跨机器同项目会话不被包含在当前 cwd 过滤结果中', async () => {
		const all = await listLocalSessions();
		const filtered = all.filter((f) => f.relativePath.startsWith(CWD_A + '/'));
		// CWD_C 的会话不应被包含
		const cwdCFiles = filtered.filter((f) => f.relativePath.startsWith(CWD_C + '/'));
		expect(cwdCFiles.length).toBe(0);
	});

	// ── 期望行为（待实现） ─────────────────────────────────────────────

	it('listLocalSessionsForCwd 只返回指定 cwd 的会话', async () => {
		const resultA = await listLocalSessionsForCwd(CWD_A);
		expect(resultA.length).toBe(2);
		for (const f of resultA) {
			expect(f.relativePath.startsWith(CWD_A + '/')).toBe(true);
		}
	});

	it('listLocalSessionsForCwd 返回空数组当目录不存在时', async () => {
		const result = await listLocalSessionsForCwd('--nonexistent--');
		expect(result).toEqual([]);
	});
});
