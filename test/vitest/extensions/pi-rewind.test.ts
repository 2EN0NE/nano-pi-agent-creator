/**
 * pi-rewind — Vitest 单元测试
 *
 * 分层：纯函数（零 git 依赖）+ engine 集成（真实 git 操作，临时目录）。
 * engine 是零 Pi 依赖的纯 git 库，直接用 RepoManager 构造（不经过 Pi 生命周期），
 * 属于组件测试（AGENTS.md 分层：test/vitest/ 覆盖逻辑正确性，不测 Pi runtime）。
 *
 * 覆盖：
 *   1. 纯函数：parseDiffStats / resolveExcludePatterns / isWindowsReservedDevicePath /
 *      validateRewindConfig / toCheckpointConfig
 *   2. engine 集成：RepoManager.checkpoint / checkpointIfChanged / safeCheckout
 *   3. checkpoint 语义：AutoCheckpointProducer（message 模式 before/after 跨度）、
 *      EventCheckpointCapturer（event 模式快照 before=after）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	RepoManager,
	parseDiffStats,
	resolveExcludePatterns,
} from '../../../extensions/auto/pi-rewind/engine';
import { isWindowsReservedDevicePath } from '../../../extensions/auto/pi-rewind/engine/repo-manager';
import {
	AutoCheckpointProducer,
	EventCheckpointCapturer,
} from '../../../extensions/auto/pi-rewind/auto-checkpoint';

// config.ts 的纯函数不调用 loadLayeredConfig，mock 掉 pi-config 隔离其运行时依赖
vi.mock('@zenone/pi-config', () => ({
	loadLayeredConfig: () => ({ config: {} }),
	resolveConfigPaths: () => ({ user: '', project: '' }),
	createConfigStore: () => ({ get: () => ({}), save: () => {}, reload: () => {} }),
	deepMerge: (base: unknown, overlay: unknown) => ({
		...(base as object),
		...(overlay as object),
	}),
	readJsonFile: () => null,
	writeJsonAtomic: () => {},
}));

import {
	validateRewindConfig,
	toCheckpointConfig,
	DEFAULT_REWIND_CONFIG,
} from '../../../extensions/auto/pi-rewind/config';

// ────────────────────────────────────────────────────────────────────────────
// 临时仓库 helper（真实 git，非 mock）
// ────────────────────────────────────────────────────────────────────────────

interface TempRepo {
	workTree: string;
	repo: RepoManager;
	cleanup(): Promise<void>;
}
async function createTempRepo(): Promise<TempRepo> {
	const base = await mkdtemp(join(tmpdir(), 'pi-rewind-'));
	const workTree = join(base, 'work');
	const repoDir = join(base, 'repo');
	await mkdir(workTree, { recursive: true });
	const repo = new RepoManager(join(repoDir, '.git'), join(repoDir, 'index'), workTree);
	await repo.init();
	return {
		workTree,
		repo,
		cleanup: async () => {
			await rm(base, { recursive: true, force: true });
		},
	};
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

// ────────────────────────────────────────────────────────────────────────────
// 纯函数
// ────────────────────────────────────────────────────────────────────────────

describe('parseDiffStats', () => {
	it('解析标准 numstat 输出（added/removed/path）', () => {
		const out = parseDiffStats('1\t2\ta.txt\n3\t0\tb dir/c.txt\n');
		expect(out).toEqual([
			{ path: 'a.txt', added: 1, removed: 2 },
			{ path: 'b dir/c.txt', added: 3, removed: 0 },
		]);
	});

	it('二进制文件（-\\t-）映射为 0/0', () => {
		const out = parseDiffStats('-\t-\tbin.dat\n');
		expect(out).toEqual([{ path: 'bin.dat', added: 0, removed: 0 }]);
	});

	it('空输出 / 纯空白返回空数组', () => {
		expect(parseDiffStats('')).toEqual([]);
		expect(parseDiffStats('\n  \n')).toEqual([]);
	});
});

describe('resolveExcludePatterns', () => {
	it('合并内置排除 + 用户 exclude + include 以 ! 重包含', () => {
		const out = resolveExcludePatterns(['custom-build/'], ['node_modules/']);
		expect(out).toContain('.git');
		expect(out).toContain('node_modules/');
		expect(out).toContain('custom-build/');
		expect(out).toContain('!node_modules/');
	});

	it('include 已带 ! 时不重复加', () => {
		const out = resolveExcludePatterns([], ['!dist/']);
		expect(out).toContain('!dist/');
	});
});

describe('isWindowsReservedDevicePath', () => {
	it('识别保留设备名（含扩展名 / 尾点空格 / 大小写）', () => {
		expect(isWindowsReservedDevicePath('CON')).toBe(true);
		expect(isWindowsReservedDevicePath('con.txt')).toBe(true);
		expect(isWindowsReservedDevicePath('foo/NUL.txt')).toBe(true);
		expect(isWindowsReservedDevicePath('COM1')).toBe(true);
		expect(isWindowsReservedDevicePath('LPT1 ')).toBe(true);
	});

	it('普通路径不受影响', () => {
		expect(isWindowsReservedDevicePath('a/b/c.txt')).toBe(false);
		expect(isWindowsReservedDevicePath('console.log')).toBe(false);
		expect(isWindowsReservedDevicePath('constant.ts')).toBe(false);
	});
});

describe('validateRewindConfig', () => {
	it('合法字段全部保留', () => {
		const out = validateRewindConfig({
			enabled: false,
			checkpointTrigger: 'event',
			restoreOnTree: 'always',
			restoreOnFork: 'never',
			retentionDays: 7,
			maxFileMB: 0,
			skipBinary: false,
			includeUntracked: false,
			exclude: ['a/'],
			include: ['b/'],
		});
		expect(out).toEqual({
			enabled: false,
			checkpointTrigger: 'event',
			restoreOnTree: 'always',
			restoreOnFork: 'never',
			retentionDays: 7,
			maxFileMB: undefined,
			skipBinary: false,
			includeUntracked: false,
			exclude: ['a/'],
			include: ['b/'],
		});
	});

	it('非法字段丢弃（batch/未知 mode/负 retention）', () => {
		const out = validateRewindConfig({
			checkpointTrigger: 'batch',
			restoreOnTree: 'sometimes',
			retentionDays: -5,
			maxFileMB: -1,
		});
		expect(out).toEqual({});
	});

	it('非对象输入返回 null', () => {
		expect(validateRewindConfig('x')).toBeNull();
		expect(validateRewindConfig(null)).toBeNull();
		expect(validateRewindConfig([1, 2])).toBeNull();
	});
});

describe('toCheckpointConfig', () => {
	it('映射用户配置到引擎子集并合并 exclude', () => {
		const cfg = toCheckpointConfig({
			...DEFAULT_REWIND_CONFIG,
			maxFileMB: 10,
			skipBinary: false,
			includeUntracked: false,
			exclude: ['x/'],
			include: ['y/'],
		});
		expect(cfg.maxFileMB).toBe(10);
		expect(cfg.skipBinary).toBe(false);
		expect(cfg.includeUntracked).toBe(false);
		expect(cfg.exclude).toContain('x/');
		expect(cfg.exclude).toContain('!y/');
		expect(cfg.include).toEqual(['y/']);
	});

	it('默认配置：maxFileMB 25 / skipBinary true / includeUntracked true', () => {
		const cfg = toCheckpointConfig(DEFAULT_REWIND_CONFIG);
		expect(cfg.maxFileMB).toBe(25);
		expect(cfg.skipBinary).toBe(true);
		expect(cfg.includeUntracked).toBe(true);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// engine 集成（真实 git）
// ────────────────────────────────────────────────────────────────────────────

describe('RepoManager 集成（真实 git）', () => {
	let temp: TempRepo;

	beforeEach(async () => {
		temp = await createTempRepo();
		await temp.repo.setExclude(['.git']);
	});

	afterEach(async () => {
		await temp.cleanup();
	});

	it('checkpoint 创建空 commit，diffAgainst 检测后续变更', async () => {
		const c1 = await temp.repo.checkpoint('u1');
		expect(c1).toMatch(COMMIT_RE);

		// 无变更时 diff 为空
		await temp.repo.stageAll();
		const emptyDiff = await temp.repo.diffAgainst(c1);
		expect(emptyDiff.trim()).toBe('');

		// 新增文件后 diff 检测到 1 个文件
		await writeFile(join(temp.workTree, 'a.txt'), 'hello');
		await temp.repo.stageAll();
		const diff = parseDiffStats(await temp.repo.diffAgainst(c1));
		expect(diff).toEqual([{ path: 'a.txt', added: 1, removed: 0 }]);
	});

	it('checkpointIfChanged：无变更复用 baseCommit，有变更才新建', async () => {
		const c1 = await temp.repo.checkpoint('u1');
		const unchanged = await temp.repo.checkpointIfChanged('u2', c1);
		expect(unchanged).toBe(c1);

		await writeFile(join(temp.workTree, 'b.txt'), 'v1');
		const changed = await temp.repo.checkpointIfChanged('u3', c1);
		expect(changed).toMatch(COMMIT_RE);
		expect(changed).not.toBe(c1);

		// changed commit 中包含 b.txt
		const stats = parseDiffStats(await temp.repo.diffStats(changed));
		expect(stats.some((f) => f.path === 'b.txt')).toBe(true);
	});

	it('safeCheckout 恢复文件到目标 commit 状态', async () => {
		const c1 = await temp.repo.checkpoint('u1'); // 空状态
		await writeFile(join(temp.workTree, 'a.txt'), 'v1');
		const c2 = await temp.repo.checkpoint('u2'); // 含 a.txt=v1
		await writeFile(join(temp.workTree, 'a.txt'), 'v2'); // 修改工作区

		const result = await temp.repo.safeCheckout(c2);
		expect(result.ok).toBe(true);
		expect(await readFile(join(temp.workTree, 'a.txt'), 'utf8')).toBe('v1');

		// 恢复到空状态（c1）→ a.txt 应被删除
		const result2 = await temp.repo.safeCheckout(c1);
		expect(result2.ok).toBe(true);
		await expect(access(join(temp.workTree, 'a.txt'))).rejects.toThrow();
	});
});

describe('AutoCheckpointProducer（message 模式 before/after 跨度）', () => {
	let temp: TempRepo;
	let producer: AutoCheckpointProducer;

	beforeEach(async () => {
		temp = await createTempRepo();
		producer = new AutoCheckpointProducer({
			repo: temp.repo,
			exclude: ['.git'],
			createTurnId: () => 'turn-1',
			now: () => new Date('2026-01-01T00:00:00Z'),
		});
	});

	afterEach(async () => {
		await temp.cleanup();
	});

	it('turnStart 无 pending 时只打 before 点；finalizeRun 产出 before≠after 的 checkpoint', async () => {
		const start = await producer.turnStart({ userEntryId: 'u1', prompt: 'hello' });
		expect(start.ok).toBe(true);
		if (!start.ok) return;
		expect(start.entries).toHaveLength(0); // 首次无 pending finalize

		// turn 内修改文件 → finalize 产出变更 checkpoint
		await writeFile(join(temp.workTree, 'a.txt'), 'v1');
		const fin = await producer.finalizeRun();
		expect(fin.ok).toBe(true);
		if (!fin.ok) return;
		expect(fin.entry.userEntryId).toBe('u1');
		expect(fin.entry.prompt).toBe('hello');
		expect(fin.entry.beforeCommit).toMatch(COMMIT_RE);
		expect(fin.entry.afterCommit).toMatch(COMMIT_RE);
		expect(fin.entry.afterCommit).not.toBe(fin.entry.beforeCommit); // 有变更 → 新 commit
		expect(fin.entry.fileCount).toBe(1);
		expect(fin.entry.fileChanges).toEqual([{ path: 'a.txt', added: 1, removed: 0 }]);
		expect(fin.entry.createdAt).toBe('2026-01-01T00:00:00.000Z');
	});

	it('turn 内无变更时 finalize 复用 beforeCommit（after=before）', async () => {
		await producer.turnStart({ userEntryId: 'u1', prompt: 'no-op' });
		const fin = await producer.finalizeRun();
		expect(fin.ok).toBe(true);
		if (!fin.ok) return;
		expect(fin.entry.afterCommit).toBe(fin.entry.beforeCommit);
		expect(fin.entry.fileCount).toBe(0);
	});
});

describe('EventCheckpointCapturer（event 模式快照 before=after）', () => {
	let temp: TempRepo;

	beforeEach(async () => {
		temp = await createTempRepo();
	});

	afterEach(async () => {
		await temp.cleanup();
	});

	it('capture 生成 before=after 的快照 checkpoint（fileCount=0）', async () => {
		await temp.repo.setExclude(['.git']);
		await writeFile(join(temp.workTree, 'a.txt'), 'v1');
		const capturer = new EventCheckpointCapturer({
			repo: temp.repo,
			exclude: ['.git'],
			createTurnId: () => 'evt-1',
			now: () => new Date('2026-01-02T03:04:05Z'),
		});

		const result = await capturer.capture('u9', 'fork');
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const entry = result.entry;
		expect(entry.kind).toBe('checkpoint');
		expect(entry.v).toBe(2);
		expect(entry.userEntryId).toBe('u9');
		expect(entry.prompt).toBe('fork');
		expect(entry.turnId).toBe('evt-1');
		expect(entry.beforeCommit).toMatch(COMMIT_RE);
		expect(entry.afterCommit).toBe(entry.beforeCommit); // 快照点即恢复点
		expect(entry.fileCount).toBe(0);
		expect(entry.fileChanges).toEqual([]);
		expect(entry.createdAt).toBe('2026-01-02T03:04:05.000Z');

		// 快照 commit 应包含 a.txt（stageAll 已纳入 untracked）
		const stats = parseDiffStats(await temp.repo.diffStats(entry.afterCommit));
		expect(stats.some((f) => f.path === 'a.txt')).toBe(true);
	});

	it('连续两次 capture 产生不同 commit', async () => {
		await temp.repo.setExclude(['.git']);
		const capturer = new EventCheckpointCapturer({
			repo: temp.repo,
			exclude: ['.git'],
			createTurnId: () => 'evt-x',
			now: () => new Date(),
		});
		const r1 = await capturer.capture('u1', 'tree');
		const r2 = await capturer.capture('u2', 'fork');
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		if (!r1.ok || !r2.ok) return;
		expect(r1.entry.afterCommit).not.toBe(r2.entry.afterCommit);
	});
});
