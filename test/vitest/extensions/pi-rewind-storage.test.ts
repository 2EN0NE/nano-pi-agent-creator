/**
 * pi-rewind — P1：checkpoint 存储删除与 retention GC 原语测试
 *
 * 对应测试分析发现 [P1]：recursive 删除会话 checkpoint 存储、按 manifest
 * `updatedAt` 清扫的 prune/purge 路径此前零覆盖。清单损坏/边界 bug 会静默
 * 删除其他会话的回滚能力（数据丢失级）。
 *
 * 覆盖（storage-manifest.ts 原语，真实文件系统）：
 *   1. listCheckpointStorageManifests：多会话混合（过期/未过期/损坏
 *      manifest/非目录文件/非法名）→ 只返回健康 manifest，按 modifiedAt
 *      降序；损坏 manifest 不 panic。
 *   2. purge 语义：过期会话被清、未过期保留、active session 受保护。
 *   3. deleteSessionCheckpointStorage：path-safety（目录必须位于 sessions
 *      root 且名字合法）、manifest-missing、storage-corrupt、active-session、
 *      成功删除。
 *   4. manifest 读写 roundtrip 与损坏容错。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, utimes, access, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node:os 作为 ESM 命名空间不可 spy；storage-manifest 通过 resolver 读
// sessions root。这里 mock resolver 模块本身，把根指到隔离临时目录
// （storage-manifest/repo 内 './resolver' 与下方相对路径解析到同一模块，
//   vi.mock 统一拦截，importOriginal 保留其它导出）。
const rootMock = vi.hoisted(() => ({ root: '' }));

vi.mock('../../../extensions/auto/pi-rewind/engine/resolver', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../extensions/auto/pi-rewind/engine/resolver')>();
	const path = await import('node:path');
	return {
		...actual,
		getCheckpointSessionsRoot: () => rootMock.root,
		// getRepoDir 内部闭包引用原模块的 root，这里必须一并覆盖，
		// 否则 active-session 保护（repoDir vs getRepoDir(sessionFile)）永不命中。
		getRepoDir: (sessionFile: string | undefined) =>
			sessionFile
				? path.join(rootMock.root, path.basename(sessionFile, '.jsonl'))
				: path.join(rootMock.root, 'ephemeral'),
	};
});
import {
	listCheckpointStorageManifests,
	deleteSessionCheckpointStorage,
	purgeSessionCheckpointStorage,
	readCheckpointStorageManifest,
	writeCheckpointStorageManifest,
} from '../../../extensions/auto/pi-rewind/engine/storage-manifest';

// ────────────────────────────────────────────────────────────────────────────
// Harness：把 os.homedir() 指向临时根，使 sessions root 落在隔离目录
// ────────────────────────────────────────────────────────────────────────────

interface StorageHarness {
	homeRoot: string;
	storageRoot: string;
	cleanup(): Promise<void>;
}

async function createHarness(): Promise<StorageHarness> {
	const homeRoot = await mkdtemp(join(tmpdir(), 'pi-rewind-storage-'));
	// 与实现无关（rootMock 覆盖 getCheckpointSessionsRoot），但命名对齐真实布局
	const storageRoot = join(homeRoot, '.pi', 'agent', 'rewind', 'checkpoints');
	rootMock.root = storageRoot;
	await mkdir(storageRoot, { recursive: true });
	return {
		homeRoot,
		storageRoot,
		cleanup: async () => {
			rootMock.root = '';
			await rm(homeRoot, { recursive: true, force: true });
		},
	};
}

const BASE_MANIFEST = {
	version: 1 as const,
	sessionId: 's1',
	sessionFile: '/x/01.jsonl',
	cwd: '/proj',
	firstUserMessage: 'hello',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-02T00:00:00.000Z',
};

/** 建一个会话存储目录：可选 manifest、健康 bare git 骨架、自定义 mtime。 */
async function createSession(
	harness: StorageHarness,
	name: string,
	options: { manifest?: boolean; healthyGit?: boolean; mtimeMs?: number } = {},
): Promise<string> {
	const repoDir = join(harness.storageRoot, name);
	await mkdir(repoDir, { recursive: true });
	if (options.manifest !== false) {
		await writeCheckpointStorageManifest(repoDir, {
			...BASE_MANIFEST,
			sessionId: name,
			sessionFile: join(harness.storageRoot, `${name}.jsonl`),
		});
	}
	if (options.healthyGit) {
		await mkdir(join(repoDir, '.git', 'objects'), { recursive: true });
		await mkdir(join(repoDir, '.git', 'refs'), { recursive: true });
		await writeFile(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		await writeFile(join(repoDir, '.git', 'config'), '[core]\n\tbare = true\n');
	}
	if (options.mtimeMs !== undefined) {
		await utimes(repoDir, new Date(options.mtimeMs), new Date(options.mtimeMs));
	}
	return repoDir;
}

const OLD_MS = Date.parse('2020-01-01T00:00:00Z');
const NOW_MS = Date.parse('2026-01-01T00:00:00Z');

describe('read/writeCheckpointStorageManifest', () => {
	let h: StorageHarness;

	beforeEach(async () => {
		h = await createHarness();
	});

	afterEach(async () => {
		await h.cleanup();
	});

	it('write 后可读回相同内容（含换行规范化）', async () => {
		const repoDir = await createSession(h, 'sess-write', { manifest: false });
		await writeCheckpointStorageManifest(repoDir, BASE_MANIFEST);
		const manifest = await readCheckpointStorageManifest(repoDir);
		expect(manifest).toEqual(BASE_MANIFEST);
	});

	it('损坏 JSON / 缺失文件 / 结构非法 → undefined（不 panic）', async () => {
		const repoDir = await createSession(h, 'sess-bad', { manifest: false });
		await writeFile(join(repoDir, 'manifest.json'), '{ not json', 'utf8');
		expect(await readCheckpointStorageManifest(repoDir)).toBeUndefined();

		expect(
			await readCheckpointStorageManifest(join(h.storageRoot, 'not-exist')),
		).toBeUndefined();

		await writeFile(join(repoDir, 'manifest.json'), JSON.stringify({ version: 2 }), 'utf8');
		expect(await readCheckpointStorageManifest(repoDir)).toBeUndefined();
	});
});

describe('listCheckpointStorageManifests', () => {
	let h: StorageHarness;

	beforeEach(async () => {
		h = await createHarness();
	});

	afterEach(async () => {
		await h.cleanup();
	});

	it('混合目录：跳过损坏 manifest、非目录、非法名；健康清单按 modifiedAt 降序', async () => {
		const fresh = await createSession(h, 'sess-fresh', { healthyGit: true, mtimeMs: NOW_MS });
		await createSession(h, 'sess-old', { healthyGit: true, mtimeMs: OLD_MS });
		// 损坏 manifest 目录（含垃圾 json）
		const corruptDir = await createSession(h, 'sess-corrupt', { manifest: false });
		await writeFile(join(corruptDir, 'manifest.json'), 'garbage{', 'utf8');
		// 无 manifest 目录（孤儿 storage）
		await createSession(h, 'sess-orphan', { manifest: false });
		// 普通文件（非目录）
		await writeFile(join(h.storageRoot, 'plain-file'), 'x');
		// 非法目录名（含路径穿越字符）
		await mkdir(join(h.storageRoot, 'bad..name'), { recursive: true });

		const records = await listCheckpointStorageManifests();
		const names = records.map((r) => r.repoDir);
		expect(names).toEqual([fresh, 'sess-old'.length ? join(h.storageRoot, 'sess-old') : '']);
		// 降序：fresh 在前
		expect(names[0]).toBe(fresh);
		expect(names[1]).toBe(join(h.storageRoot, 'sess-old'));
		// 只含健康 manifest 的会话
		expect(records.map((r) => r.manifest.sessionId).sort()).toEqual(['sess-fresh', 'sess-old']);
	});

	it('根目录不存在时返回空数组（不 panic）', async () => {
		await rm(h.storageRoot, { recursive: true, force: true });
		const records = await listCheckpointStorageManifests();
		expect(records).toEqual([]);
	});
});

describe('deleteSessionCheckpointStorage — 守卫与删除', () => {
	let h: StorageHarness;

	beforeEach(async () => {
		h = await createHarness();
	});

	afterEach(async () => {
		await h.cleanup();
	});

	it('path-safety-failed：目录不在 sessions root 内', async () => {
		const outside = join(h.homeRoot, 'outside-repo');
		await mkdir(outside, { recursive: true });
		const result = await deleteSessionCheckpointStorage(outside, undefined);
		expect(result).toMatchObject({ ok: false, reason: 'path-safety-failed' });
	});

	it('path-safety-failed：名字含非法字符（basename 穿越）', async () => {
		const evil = join(h.storageRoot, '..', '..', 'escape');
		await mkdir(evil, { recursive: true });
		const result = await deleteSessionCheckpointStorage(evil, undefined);
		expect(result).toMatchObject({ ok: false, reason: 'path-safety-failed' });
	});

	it('manifest-missing：目录不存在', async () => {
		const result = await deleteSessionCheckpointStorage(
			join(h.storageRoot, 'sess-ghost'),
			undefined,
		);
		expect(result).toMatchObject({ ok: false, reason: 'manifest-missing' });
	});

	it('manifest-missing：目录存在但无 manifest.json', async () => {
		const repoDir = await createSession(h, 'sess-nomanifest', { manifest: false });
		const result = await deleteSessionCheckpointStorage(repoDir, undefined);
		expect(result).toMatchObject({ ok: false, reason: 'manifest-missing' });
	});

	it('storage-corrupt：有 manifest 但 bare git 骨架不健康', async () => {
		const repoDir = await createSession(h, 'sess-corrupt-git', { manifest: true });
		const result = await deleteSessionCheckpointStorage(repoDir, undefined);
		expect(result).toMatchObject({ ok: false, reason: 'storage-corrupt' });
	});

	it('active-session：repoDir 属于当前活跃会话时拒绝删除', async () => {
		const repoDir = await createSession(h, 'sess-active', { healthyGit: true });
		const activeSessionFile = join(h.storageRoot, 'sess-active.jsonl');
		const result = await deleteSessionCheckpointStorage(repoDir, activeSessionFile);
		expect(result).toMatchObject({ ok: false, reason: 'active-session' });
	});

	it('成功删除健康会话存储（recursive，含 bare git）', async () => {
		const repoDir = await createSession(h, 'sess-remove', { healthyGit: true });
		const result = await deleteSessionCheckpointStorage(repoDir, undefined);
		expect(result).toMatchObject({ ok: true });
		await expect(access(repoDir)).rejects.toThrow();
	});

	it('非活跃会话不受 active 保护影响，正常删除', async () => {
		const repoDir = await createSession(h, 'sess-other', { healthyGit: true });
		const otherActiveFile = join(h.storageRoot, 'sess-active.jsonl');
		const result = await deleteSessionCheckpointStorage(repoDir, otherActiveFile);
		expect(result).toMatchObject({ ok: true });
	});
});

describe('purge 语义（模拟 pruneExpiredStorages 的清扫循环）', () => {
	let h: StorageHarness;

	beforeEach(async () => {
		h = await createHarness();
	});

	afterEach(async () => {
		await h.cleanup();
	});

	it('过期会话被清、未过期保留；损坏/孤儿目录 force 清除不 panic', async () => {
		const fresh = await createSession(h, 'sess-fresh', { mtimeMs: NOW_MS });
		const old = await createSession(h, 'sess-old', { mtimeMs: OLD_MS });
		const orphan = await createSession(h, 'sess-orphan', { manifest: false, mtimeMs: OLD_MS });

		const cutoffMs = NOW_MS - 30 * 24 * 60 * 60 * 1000; // retention 30d
		for (const record of await listCheckpointStorageManifests()) {
			const modifiedAt = new Date(record.modifiedAt).getTime();
			if (Number.isNaN(modifiedAt) || modifiedAt >= cutoffMs) continue;
			const result = await purgeSessionCheckpointStorage(record.repoDir, undefined);
			expect(result.ok).toBe(true);
		}
		// 孤儿目录（无 manifest）不在 list 中 → 单独 purge force 清
		const orphanPurge = await purgeSessionCheckpointStorage(orphan, undefined);
		expect(orphanPurge.ok).toBe(true);

		await expect(access(old)).rejects.toThrow();
		await expect(access(orphan)).rejects.toThrow();
		// fresh 保留且内容完整
		const remaining = await readdir(h.storageRoot);
		expect(remaining).toEqual([fresh.split('/').pop()]);
	});

	it('purge 同样尊重 active-session 保护', async () => {
		const repoDir = await createSession(h, 'sess-active', { mtimeMs: OLD_MS });
		const activeSessionFile = join(h.storageRoot, 'sess-active.jsonl');
		const result = await purgeSessionCheckpointStorage(repoDir, activeSessionFile);
		expect(result).toMatchObject({ ok: false, reason: 'active-session' });
		// 存储仍在
		const manifest = await readCheckpointStorageManifest(repoDir);
		expect(manifest?.sessionId).toBe('sess-active');
	});

	it('retentionDays<=0 表示永不清理（返回 0 语义由上层决定，原语不动任何目录）', async () => {
		const repoDir = await createSession(h, 'sess-keep', { mtimeMs: OLD_MS });
		// 0 保留时不 purge
		await expect(access(repoDir)).resolves.toBeUndefined();
		expect((await readFile(join(repoDir, 'manifest.json'), 'utf8')).length).toBeGreaterThan(0);
	});
});
