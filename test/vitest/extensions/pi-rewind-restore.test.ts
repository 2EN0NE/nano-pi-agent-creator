/**
 * pi-rewind — P0：/rewind「回滚写文件」主链路集成测试
 *
 * 对应测试分析发现 [P0]：`runRestoreMode` / `safeRestoreTreeCodeState`
 * 编排层此前零覆盖，vitest 只覆盖到 `repo.safeCheckout` commit 级。
 *
 * 本文件验证 rewind 的破坏性主能力（真实 git，不 mock）：
 *   1. Restore code：工作区文件回到目标 checkpoint 状态，onCodeRestore 回调
 *      收到 commit；用户工作区如果是真实 git 仓库，其 HEAD/refs 不被改写
 *      （ADR-0038「不写用户真实 git refs」安全承诺）。
 *   2. dirty guard：工作区含未纳入快照的改动 → 拒绝回滚（notify warning），
 *      文件保持原状。
 *   3. storage-missing：repo 缺失 → Restore code 降级为提示，不 panic。
 *   4. Restore conversation：仅 navigateTree（不动文件）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { RepoManager } from '../../../extensions/auto/pi-rewind/engine';
import type {
	CheckpointEntry,
	NavigateTreeOptions,
	NavigateTreeResult,
} from '../../../extensions/auto/pi-rewind/engine';
import { runRestoreMode } from '../../../extensions/auto/pi-rewind/commands/restore-mode';

const execAsync = promisify(exec);

// ────────────────────────────────────────────────────────────────────────────
// 临时仓库 helper
// ────────────────────────────────────────────────────────────────────────────

interface TempFixture {
	/** 用户工作区目录（模拟真实项目，可能是真实 git 仓库）。 */
	workTree: string;
	/** checkpoint 存储（bare repo）所在目录。 */
	repoDir: string;
	repo: RepoManager;
	cleanup(): Promise<void>;
}

async function createFixture(options?: { initUserGit: boolean }): Promise<TempFixture> {
	const base = await mkdtemp(join(tmpdir(), 'pi-rewind-restore-'));
	const workTree = join(base, 'work');
	const repoDir = join(base, 'checkpoint-repo');
	await mkdir(workTree, { recursive: true });

	// 用户工作区先做一次真实 git 初始化（模拟真实项目仓库），
	// 用于断言回滚不触碰用户 git 的 HEAD/refs。
	if (options?.initUserGit) {
		await execAsync('git init', { cwd: workTree });
		await execAsync('git config user.email test@test.local', { cwd: workTree });
		await execAsync('git config user.name "Test"', { cwd: workTree });
	}

	const repo = new RepoManager(join(repoDir, '.git'), join(repoDir, 'index'), workTree);
	await repo.init();
	await repo.setExclude(['.git']);
	return {
		workTree,
		repoDir,
		repo,
		cleanup: async () => {
			await rm(base, { recursive: true, force: true });
		},
	};
}

async function write(path: string, content: string): Promise<void> {
	await writeFile(path, content, 'utf8');
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

/** 构造合法 CheckpointEntry fixture（命中 isCheckpointEntry 类型守卫）。 */
function makeCheckpoint(partial: {
	turnId: string;
	userEntryId: string;
	beforeCommit: string;
	afterCommit: string;
	prompt?: string;
	fileCount?: number;
	fileChanges?: CheckpointEntry['fileChanges'];
	createdAt?: string;
}): CheckpointEntry {
	return {
		v: 2,
		kind: 'checkpoint',
		turnId: partial.turnId,
		userEntryId: partial.userEntryId,
		beforeCommit: partial.beforeCommit,
		afterCommit: partial.afterCommit,
		prompt: partial.prompt ?? 'hello',
		fileCount: partial.fileCount ?? 0,
		fileChanges: partial.fileChanges ?? [],
		createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Mock ui / navigateTree（带签名 vi.fn，可同时满足接口与 .mock 断言）
// ────────────────────────────────────────────────────────────────────────────

type NotifyFn = (message: string, level: 'info' | 'warning' | 'error') => void;
type InputFn = (message: string, initialValue: string) => Promise<string | undefined>;
type SelectFn = (message: string, options: readonly string[]) => Promise<string | undefined>;
type SetEditorTextFn = (text: string) => void;
type NavigateTreeFn = (
	entryId: string,
	options?: NavigateTreeOptions,
) => Promise<NavigateTreeResult>;

interface MockUi {
	notify: ReturnType<typeof vi.fn<NotifyFn>>;
	input: ReturnType<typeof vi.fn<InputFn>>;
	select: ReturnType<typeof vi.fn<SelectFn>>;
	setEditorText: ReturnType<typeof vi.fn<SetEditorTextFn>>;
}

function makeMockUi(): MockUi {
	return {
		notify: vi.fn<NotifyFn>(),
		input: vi.fn<InputFn>(async () => undefined),
		select: vi.fn<SelectFn>(async () => undefined),
		setEditorText: vi.fn<SetEditorTextFn>(),
	};
}

function makeNavigateTree(editorText?: string): ReturnType<typeof vi.fn<NavigateTreeFn>> {
	return vi.fn<NavigateTreeFn>(async () => ({ cancelled: false, editorText }));
}

describe('runRestoreMode — /rewind 回滚主链路（真实 git）', () => {
	let fixture: TempFixture;

	beforeEach(async () => {
		fixture = await createFixture({ initUserGit: false });
	});

	afterEach(async () => {
		await fixture.cleanup();
	});

	it('Restore code：工作区文件回到目标 checkpoint 状态并回调 onCodeRestore', async () => {
		const { repo, workTree } = fixture;
		const filePath = join(workTree, 'a.txt');

		// h0 = u1.before（空状态）→ a.txt v1 产生 h1（u1.after）→ a.txt v2+b.txt 产生 h2（u2.after）
		const h0 = await repo.checkpoint('u0');
		await write(filePath, 'v1');
		const h1 = await repo.checkpoint('u1');
		await write(filePath, 'v2');
		await write(join(workTree, 'b.txt'), 'beta');
		const h2 = await repo.checkpoint('u2');

		expect(h0).toMatch(COMMIT_RE);
		expect(h1).not.toBe(h0);
		expect(h2).not.toBe(h1);

		const ui = makeMockUi();
		const onCodeRestore = vi.fn();
		const navigateTree = makeNavigateTree('conversation');

		// 用户选中 u1 → 回退到 u1 的 beforeCommit（h0 空状态）
		const targetCp = makeCheckpoint({
			turnId: 't1',
			userEntryId: 'u1',
			beforeCommit: h0,
			afterCommit: h1,
			fileCount: 1,
			fileChanges: [{ path: 'a.txt', added: 1, removed: 0 }],
		});
		const latestCp = makeCheckpoint({
			turnId: 't2',
			userEntryId: 'u2',
			beforeCommit: h1,
			afterCommit: h2,
			fileCount: 1,
		});

		await runRestoreMode({
			mode: 'Restore code',
			repo,
			ui,
			navigateTree,
			targetCp,
			latestCp,
			onCodeRestore,
		});

		// 工作区回到 h0：a.txt/b.txt 均应不存在
		await expect(access(filePath)).rejects.toThrow();
		await expect(access(join(workTree, 'b.txt'))).rejects.toThrow();

		// onCodeRestore 收到恢复的目标 commit（= beforeCommit）
		expect(onCodeRestore).toHaveBeenCalledWith(h0);
		expect(ui.notify).toHaveBeenCalledWith('回退完成', 'info');
		// 纯代码恢复不触碰会话树导航
		expect(navigateTree).not.toHaveBeenCalled();
	});

	it('Restore code：回退到含文件旧值的 commit 时文件内容回到旧值', async () => {
		const { repo, workTree } = fixture;
		const filePath = join(workTree, 'a.txt');

		// u1 之前已有一版内容（h0 含 a.txt=old）
		await write(filePath, 'old');
		const h0 = await repo.checkpoint('u0');
		await write(filePath, 'v1');
		const h1 = await repo.checkpoint('u1');
		await write(filePath, 'v2');
		const h2 = await repo.checkpoint('u2');

		const ui = makeMockUi();
		const onCodeRestore = vi.fn();

		await runRestoreMode({
			mode: 'Restore code',
			repo,
			ui,
			navigateTree: makeNavigateTree(),
			targetCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: h0,
				afterCommit: h1,
				fileCount: 1,
			}),
			latestCp: makeCheckpoint({
				turnId: 't2',
				userEntryId: 'u2',
				beforeCommit: h1,
				afterCommit: h2,
				fileCount: 1,
			}),
			onCodeRestore,
		});

		expect(await readFile(filePath, 'utf8')).toBe('old');
		expect(onCodeRestore).toHaveBeenCalledWith(h0);
	});

	it('dirty guard：工作区有未纳入快照的改动 → 拒绝回滚，文件保持原状', async () => {
		const { repo, workTree } = fixture;
		const filePath = join(workTree, 'a.txt');

		const h0 = await repo.checkpoint('u0');
		await write(filePath, 'v1');
		const h1 = await repo.checkpoint('u1');
		await write(filePath, 'v2');
		const h2 = await repo.checkpoint('u2');

		// 在 h2 之后手工引入一个未被快照捕获的改动（dirty）
		await write(join(workTree, 'dirty.txt'), 'unsnapshotted');

		const ui = makeMockUi();
		const onCodeRestore = vi.fn();

		await runRestoreMode({
			mode: 'Restore code',
			repo,
			ui,
			navigateTree: makeNavigateTree(),
			targetCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: h0,
				afterCommit: h1,
				fileCount: 1,
			}),
			latestCp: makeCheckpoint({
				turnId: 't2',
				userEntryId: 'u2',
				beforeCommit: h1,
				afterCommit: h2,
				fileCount: 1,
			}),
			onCodeRestore,
		});

		// dirty → warning 通知，未回滚
		const warningCall = ui.notify.mock.calls.find((call) => call[1] === 'warning');
		expect(warningCall).toBeDefined();
		expect(String(warningCall?.[0])).toMatch(/Workspace has changes/);
		expect(onCodeRestore).not.toHaveBeenCalled();
		// 文件未被改写
		expect(await readFile(filePath, 'utf8')).toBe('v2');
	});

	it('storage-missing（repo 缺失）：Restore code 降级提示，不 panic 不动文件', async () => {
		const { workTree } = fixture;
		await write(join(workTree, 'a.txt'), 'v1');

		const ui = makeMockUi();
		await runRestoreMode({
			mode: 'Restore code',
			repo: undefined,
			ui,
			navigateTree: makeNavigateTree(),
			targetCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: '0000'.padStart(40, '0'),
				afterCommit: '0000'.padStart(40, '0'),
			}),
			latestCp: makeCheckpoint({
				turnId: 't2',
				userEntryId: 'u2',
				beforeCommit: '0000'.padStart(40, '0'),
				afterCommit: '0000'.padStart(40, '0'),
			}),
		});

		const warningCall = ui.notify.mock.calls.find((call) => call[1] === 'warning');
		expect(warningCall).toBeDefined();
		expect(String(warningCall?.[0])).toMatch(/not restored because checkpoint storage/);
		expect(await readFile(join(workTree, 'a.txt'), 'utf8')).toBe('v1');
	});

	it('Restore conversation：仅导航会话树，不动文件', async () => {
		const { repo, workTree } = fixture;
		await write(join(workTree, 'a.txt'), 'v1');
		const h0 = await repo.checkpoint('u0');
		await write(join(workTree, 'a.txt'), 'v2');
		const h1 = await repo.checkpoint('u1');

		const ui = makeMockUi();
		const navigateTree = makeNavigateTree('loaded');

		await runRestoreMode({
			mode: 'Restore conversation',
			repo,
			ui,
			navigateTree,
			targetCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: h0,
				afterCommit: h1,
				fileCount: 1,
			}),
			latestCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: h0,
				afterCommit: h1,
				fileCount: 1,
			}),
		});

		expect(navigateTree).toHaveBeenCalledWith('u1', { summarize: false });
		expect(ui.setEditorText).toHaveBeenCalledWith('loaded');
		expect(ui.notify).toHaveBeenCalledWith('回退完成', 'info');
		expect(await readFile(join(workTree, 'a.txt'), 'utf8')).toBe('v2');
	});

	it('Restore code and conversation：先回滚文件再导航会话', async () => {
		const { repo, workTree } = fixture;
		const filePath = join(workTree, 'a.txt');

		await write(filePath, 'old');
		const h0 = await repo.checkpoint('u0');
		await write(filePath, 'v1');
		const h1 = await repo.checkpoint('u1');

		const ui = makeMockUi();
		const navigateTree = makeNavigateTree('loaded');
		const onCodeRestore = vi.fn();

		await runRestoreMode({
			mode: 'Restore code and conversation',
			repo,
			ui,
			navigateTree,
			targetCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: h0,
				afterCommit: h1,
				fileCount: 1,
			}),
			latestCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: h0,
				afterCommit: h1,
				fileCount: 1,
			}),
			onCodeRestore,
		});

		expect(await readFile(filePath, 'utf8')).toBe('old');
		expect(onCodeRestore).toHaveBeenCalledWith(h0);
		expect(navigateTree).toHaveBeenCalledWith('u1', { summarize: false });
		expect(ui.notify).toHaveBeenCalledWith('回退完成', 'info');
	});
});

describe('ADR-0038 安全承诺：rewind 不写用户真实 git refs（bare 快照仓库隔离）', () => {
	let fixture: TempFixture;

	beforeEach(async () => {
		fixture = await createFixture({ initUserGit: true });
	});

	afterEach(async () => {
		await fixture.cleanup();
	});

	async function captureUserGitState(): Promise<{ head: string; refs: string }> {
		const head = (
			await execAsync('git rev-parse HEAD', { cwd: fixture.workTree })
		).stdout.trim();
		const refs = (
			await execAsync("git for-each-ref --format='%(refname) %(objectname)'", {
				cwd: fixture.workTree,
			})
		).stdout.trim();
		return { head, refs };
	}

	it('checkpoint 快照不改变用户 git 对象；回滚只动文件不改用户 git refs', async () => {
		const { repo, workTree } = fixture;
		// 用户真实 git：初始提交 v0
		await write(join(workTree, 'user-tracked.txt'), 'u0');
		await execAsync('git add -A', { cwd: workTree });
		await execAsync('git commit -m "user v0"', { cwd: workTree });
		const userGitBefore = await captureUserGitState();

		// pi-rewind 在独立 bare 快照仓库里建快照（含用户 git 未跟踪的新文件）
		const h0 = await repo.checkpoint('u0');
		await write(join(workTree, 'pi-rewind-managed.txt'), 'v1');
		await write(join(workTree, 'user-tracked.txt'), 'u1'); // 用户 git 视作 dirty
		const h1 = await repo.checkpoint('u1');

		expect(h0).toMatch(COMMIT_RE);
		expect(h1).not.toBe(h0);

		// 快照后用户 git 仍未受影响（pi-rewind 不代为 commit 用户仓库）
		const userGitAfterCheckpoint = await captureUserGitState();
		expect(userGitAfterCheckpoint).toEqual(userGitBefore);

		// 回滚到 h0：pi-rewind-managed.txt 消失、user-tracked.txt 回到 u0 内容，
		// 但用户 git refs 依然不变。
		const ui = makeMockUi();
		await runRestoreMode({
			mode: 'Restore code',
			repo,
			ui,
			navigateTree: makeNavigateTree(),
			targetCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: h0,
				afterCommit: h1,
				fileCount: 1,
			}),
			latestCp: makeCheckpoint({
				turnId: 't1',
				userEntryId: 'u1',
				beforeCommit: h0,
				afterCommit: h1,
				fileCount: 1,
			}),
			onCodeRestore: vi.fn(),
		});

		await expect(access(join(workTree, 'pi-rewind-managed.txt'))).rejects.toThrow();
		expect(await readFile(join(workTree, 'user-tracked.txt'), 'utf8')).toBe('u0');

		const userGitAfterRestore = await captureUserGitState();
		expect(userGitAfterRestore).toEqual(userGitBefore);

		// checkpoint 存储（bare repo）仍然健康存在
		const repoDirEntries = await readdir(fixture.repoDir);
		expect(repoDirEntries).toContain('.git');
	});
});

describe('ADR-0038 体积保护：回滚不清理未纳入快照的文件（clean 保护）', () => {
	let fixture: TempFixture;

	beforeEach(async () => {
		fixture = await createFixture({ initUserGit: false });
	});

	afterEach(async () => {
		await fixture.cleanup();
	});

	it('回滚删除已纳入快照的文件，但被体积保护跳过的 untracked 文件原样保留', async () => {
		const { repo, workTree } = fixture;
		// 体积保护 knob（与 config.ts 默认值语义一致）
		repo.setMaxFileBytes(1024 * 1024);
		repo.setSkipBinary(true);
		repo.setIncludeUntracked(true);

		await write(join(workTree, 'hello.txt'), 'v1');
		const c1 = await repo.checkpoint('e1');
		expect(c1).toMatch(COMMIT_RE);

		// 第二个 checkpoint 前：改文件 + 新建文本（将纳入快照）+ 新建二进制（被 skip）
		await write(join(workTree, 'hello.txt'), 'v2');
		await write(join(workTree, 'captured.txt'), 'captured');
		await writeFile(join(workTree, 'big.bin'), Buffer.from([0x00, 0x01, 0xff, 0x00]));
		const c2 = await repo.checkpoint('e2');
		expect(c2).not.toBe(c1);

		// 工作区相对 c2 干净（big.bin 被体积保护排除在外）→ 允许回滚到 c1
		const result = await repo.safeCheckout(c1, c2);
		expect(result.ok).toBe(true);

		// captured.txt 已纳入快照 → 随回滚清理；hello.txt 回到 v1
		await expect(access(join(workTree, 'captured.txt'))).rejects.toThrow();
		expect(await readFile(join(workTree, 'hello.txt'), 'utf8')).toBe('v1');

		// big.bin 从未被快照记录 → 回滚必须保留（clean 不得删除未纳入快照的文件）
		const bin = await readFile(join(workTree, 'big.bin'));
		expect(bin).toEqual(Buffer.from([0x00, 0x01, 0xff, 0x00]));
	});

	it('includeUntracked=false 且全新目录（index 无已跟踪文件）时首次 checkpoint 不因 add -u 崩溃', async () => {
		const { repo } = fixture;
		repo.setIncludeUntracked(false);
		repo.setSkipBinary(false);
		repo.setMaxFileBytes(undefined);

		// 只有 untracked 文件：add -u -- . 的 pathspec 无匹配，checkpoint 应优雅跳过
		const c1 = await repo.checkpoint('e1');
		expect(c1).toMatch(COMMIT_RE);
	});

	it('includeUntracked=false 时 untracked 一律不入快照 → 回滚完全不动 untracked 文件', async () => {
		const { repo, workTree } = fixture;
		repo.setSkipBinary(false);
		repo.setMaxFileBytes(undefined);

		// 先以 includeUntracked=true 把 hello.txt 纳入快照（v1）
		repo.setIncludeUntracked(true);
		await write(join(workTree, 'hello.txt'), 'v1');
		const c1 = await repo.checkpoint('e1');

		// 之后关闭 untracked 纳入：已跟踪文件的修改仍进快照，新 untracked 不进
		repo.setIncludeUntracked(false);
		await write(join(workTree, 'hello.txt'), 'v2');
		await write(join(workTree, 'user-note.txt'), 'keep me');
		const c2 = await repo.checkpoint('e2');

		const result = await repo.safeCheckout(c1, c2);
		expect(result.ok).toBe(true);

		expect(await readFile(join(workTree, 'hello.txt'), 'utf8')).toBe('v1');
		// includeUntracked=false 下 untracked 从未进入快照 → 回滚不得清理
		expect(await readFile(join(workTree, 'user-note.txt'), 'utf8')).toBe('keep me');
	});

	it('回滚删除已纳入快照的文件后，其空目录也被清理（不残留空目录）', async () => {
		const { repo, workTree } = fixture;
		repo.setIncludeUntracked(true);
		repo.setSkipBinary(false);
		repo.setMaxFileBytes(undefined);

		await write(join(workTree, 'base.txt'), 'v1');
		const c1 = await repo.checkpoint('e1');

		// checkpoint 后新建嵌套目录与文件 → 纳入 c2 快照
		await mkdir(join(workTree, 'nested/deep'), { recursive: true });
		await write(join(workTree, 'nested/deep/made.txt'), 'x');
		const c2 = await repo.checkpoint('e2');
		expect(c2).not.toBe(c1);

		const result = await repo.safeCheckout(c1, c2);
		expect(result.ok).toBe(true);

		// 文件与仅因它而存在的空目录都应消失
		await expect(access(join(workTree, 'nested/deep/made.txt'))).rejects.toThrow();
		await expect(access(join(workTree, 'nested'))).rejects.toThrow();
	});
});

describe('ADR-0038 index 未初始化（fork/clone 存储）：checkpoint 不得写出空树', () => {
	it('clone 出的存储 index 为空时，checkpoint 快照必须包含工作区文件且回滚真的回滚', async () => {
		const base = await mkdtemp(join(tmpdir(), 'pi-rewind-clone-'));
		const workTree = join(base, 'work');
		await mkdir(workTree, { recursive: true });
		await write(join(workTree, 'a.txt'), 'v1');

		// 源会话存储（正常路径，index 由 stage 建立）
		const srcDir = join(base, 'src-repo');
		const src = new RepoManager(join(srcDir, '.git'), join(srcDir, 'index'), workTree);
		await src.init();
		await src.setExclude(['.git']);
		src.setIncludeUntracked(true);
		src.setSkipBinary(false);
		src.setMaxFileBytes(undefined);
		await src.checkpoint('e1');

		// 模拟 /fork 的 clone：bare repo 克隆到新存储，新存储没有 index 文件，
		// 而 HEAD 已有 tree（此状态曾被「index 为空即跳过 staging」误判为空快照）。
		const dstDir = join(base, 'dst-repo');
		await mkdir(dstDir, { recursive: true });
		await RepoManager.cloneFrom(join(srcDir, '.git'), join(dstDir, '.git'));
		const dst = new RepoManager(join(dstDir, '.git'), join(dstDir, 'index'), workTree);
		await dst.setExclude(['.git']);
		dst.setIncludeUntracked(false);
		dst.setSkipBinary(false);
		dst.setMaxFileBytes(undefined);

		const before = await dst.checkpoint('e2');
		const tree = (
			await execAsync(`git --git-dir=${join(dstDir, '.git')} ls-tree -r --name-only HEAD`)
		).stdout
			.trim()
			.split('\n')
			.filter((entry) => entry.length > 0);
		expect(tree).toEqual(['a.txt']);

		await write(join(workTree, 'a.txt'), 'v2');
		const after = await dst.checkpoint('e3');

		const result = await dst.safeCheckout(before, after);
		expect(result.ok).toBe(true);
		expect(await readFile(join(workTree, 'a.txt'), 'utf8')).toBe('v1');

		await rm(base, { recursive: true, force: true });
	});
});
