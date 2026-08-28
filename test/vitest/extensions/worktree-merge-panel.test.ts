/**
 * pi-worktree — handleMerge / handleRebase 面板接线测试（ADR-0024 ticket 09/10/11）
 *
 * 覆盖此前缺失的「handler 拿到面板返回值后的分发」：
 *   - handleMerge 冲突面板 action 分发（agent / abort / stay）
 *   - handleMerge squash 冲突 → notify 引导（不弹面板）
 *   - handleMerge 成功面板 action 分发（switch / menu / dismiss）
 *   - handleRebase 冲突面板 action 分发（agent / abort）—— 死按钮修复回归
 *
 * 面板组件（ui.ts 的 showConflictPanel / showMergeSuccessPanel 等）被 mock，
 * 只验证 handler 的接线；面板自身的渲染/按键已由 worktree-conflict-panel.test.ts
 * 与 worktree-merge-success.tui.test.ts 覆盖。
 *
 * git 身份由 test/vitest/setup/git-ident.ts 通过环境变量注入（不写任何 git config）。
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';

// 只 mock 面板/交互函数，保留 buildConflictResolvePrompt 真实实现（验证 prompt 内容）
vi.mock('../../../extensions/meta/worktree/lib/ui.js', async () => {
	const actual = await vi.importActual('../../../extensions/meta/worktree/lib/ui.js');
	return {
		...actual,
		showConflictPanel: vi.fn(),
		showMergeSuccessPanel: vi.fn(),
		showWorktreeTui: vi.fn(),
		askSessionStrategy: vi.fn(),
		askMergeStrategy: vi.fn(),
		confirmRebaseFF: vi.fn(),
	};
});

import {
	showConflictPanel,
	showMergeSuccessPanel,
	showWorktreeTui,
	askSessionStrategy,
	askMergeStrategy,
} from '../../../extensions/meta/worktree/lib/ui.js';
import {
	handleMerge,
	handleRebase,
	setWorktreePi,
} from '../../../extensions/meta/worktree/lib/handlers.js';

const mockShowConflictPanel = vi.mocked(showConflictPanel);
const mockShowMergeSuccessPanel = vi.mocked(showMergeSuccessPanel);
const mockShowWorktreeTui = vi.mocked(showWorktreeTui);
const mockAskSessionStrategy = vi.mocked(askSessionStrategy);
const mockAskMergeStrategy = vi.mocked(askMergeStrategy);

const dirtyDirs: string[] = [];

function tmpBase(label: string): string {
	const base = resolve(tmpdir(), `pi-wt-panel-${label}-${Date.now()}`);
	mkdirSync(base, { recursive: true });
	dirtyDirs.push(base);
	return base;
}

function initRepo(baseDir: string): string {
	const repoDir = join(baseDir, 'repo');
	mkdirSync(repoDir, { recursive: true });
	execSync('git init --initial-branch main -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'README.md'), '# test\n');
	execSync('git add README.md && git commit -m init -q', { cwd: repoDir });
	return repoDir;
}

/** 构造 merge 冲突：wt/a 与 main 都改 conflict.txt 的同一行 */
function setupMergeConflict(baseDir: string): string {
	const repoDir = initRepo(baseDir);
	writeFileSync(join(repoDir, 'conflict.txt'), 'line1\nline2\n');
	execSync('git add conflict.txt && git commit -m base -q', { cwd: repoDir });
	execSync('git checkout -b wt/a -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'conflict.txt'), 'A\nline2\n');
	execSync('git add conflict.txt && git commit -m A -q', { cwd: repoDir });
	execSync('git checkout main -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'conflict.txt'), 'B\nline2\n');
	execSync('git add conflict.txt && git commit -m B -q', { cwd: repoDir });
	return repoDir;
}

/** 构造 merge 成功：wt/a 加独立文件，可 no-ff 合并 */
function setupMergeSuccess(baseDir: string): string {
	const repoDir = initRepo(baseDir);
	execSync('git checkout -b wt/a -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'feat.txt'), 'feature\n');
	execSync('git add feat.txt && git commit -m feat -q', { cwd: repoDir });
	execSync('git checkout main -q', { cwd: repoDir });
	return repoDir;
}

/** 构造 rebase 冲突：wt/rb 与 main 都改 rb.txt 的同一行，且 worktree 真实存在 */
function setupRebaseConflict(baseDir: string): { repoDir: string; wtDir: string } {
	const repoDir = initRepo(baseDir);
	writeFileSync(join(repoDir, 'rb.txt'), 'base\n');
	execSync('git add rb.txt && git commit -m base -q', { cwd: repoDir });
	execSync('git checkout -b wt/rb -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'rb.txt'), 'A\n');
	execSync('git add rb.txt && git commit -m A -q', { cwd: repoDir });
	execSync('git checkout main -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'rb.txt'), 'B\n');
	execSync('git add rb.txt && git commit -m B -q', { cwd: repoDir });
	// worktree 必须落在约定目录 <repo>-worktrees/<name>，resolveWorktreePath 才能按 name 解析
	const wtDir = join(dirname(repoDir), `${basename(repoDir)}-worktrees`, 'rb');
	execSync(`git worktree add ${wtDir} wt/rb -q`, { cwd: repoDir });
	return { repoDir, wtDir };
}

function makeCtx(repoDir: string): { ctx: any; notified: string[] } {
	const notified: string[] = [];
	const ctx: any = {
		hasUI: true,
		cwd: repoDir,
		ui: {
			notify: (m: string) => notified.push(m),
			confirm: vi.fn(async () => true),
			setStatus: vi.fn(),
		},
	};
	return { ctx, notified };
}

afterEach(() => {
	vi.clearAllMocks();
	setWorktreePi(null as any);
});
afterAll(() => {
	for (const d of dirtyDirs) rmSync(d, { recursive: true, force: true });
});

describe('handleMerge 冲突面板 action 分发（fromPanel）', () => {
	it('agent → 经 confirm 后 sendUserMessage 发出 merge 提示词', async () => {
		const repoDir = setupMergeConflict(tmpBase('agent'));
		const { ctx } = makeCtx(repoDir);
		const sendUserMessage = vi.fn(async (_prompt?: string, _opts?: unknown) => {});
		setWorktreePi({ sendUserMessage } as any);

		mockShowConflictPanel.mockResolvedValue({ action: 'agent' });
		mockAskMergeStrategy.mockResolvedValue('merge');

		await handleMerge(repoDir, { source: 'a', strategy: 'merge' }, ctx, true);

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const [prompt, opts] = sendUserMessage.mock.calls[0];
		expect(opts).toEqual({ deliverAs: 'followUp' });
		expect(prompt).toContain('conflict.txt');
		expect(prompt).toContain('git commit'); // merge 策略第 5 步
		expect(prompt).not.toContain('rebase --continue');
	});

	it('abort → handleAbort 清理 MERGE_HEAD（冲突状态被回滚）', async () => {
		const repoDir = setupMergeConflict(tmpBase('abort'));
		const { ctx } = makeCtx(repoDir);

		mockShowConflictPanel.mockResolvedValue({ action: 'abort' });
		mockAskMergeStrategy.mockResolvedValue('merge');

		await handleMerge(repoDir, { source: 'a', strategy: 'merge' }, ctx, true);

		// handleAbort → git merge --abort：MERGE_HEAD 应消失
		let merged = true;
		try {
			execSync('git rev-parse --verify MERGE_HEAD', { cwd: repoDir, stdio: 'pipe' });
		} catch {
			merged = false;
		}
		expect(merged).toBe(false);
	});

	it('stay → 不发送消息也不 abort（冲突状态保留）', async () => {
		const repoDir = setupMergeConflict(tmpBase('stay'));
		const { ctx } = makeCtx(repoDir);
		const sendUserMessage = vi.fn(async (_prompt?: string, _opts?: unknown) => {});
		setWorktreePi({ sendUserMessage } as any);

		mockShowConflictPanel.mockResolvedValue({ action: 'stay' });
		mockAskMergeStrategy.mockResolvedValue('merge');

		await handleMerge(repoDir, { source: 'a', strategy: 'merge' }, ctx, true);

		expect(sendUserMessage).not.toHaveBeenCalled();
		// 冲突状态仍在（MERGE_HEAD 未被清理）
		expect(
			execSync('git rev-parse --verify MERGE_HEAD', { cwd: repoDir, stdio: 'pipe' })
				.toString()
				.trim(),
		).toBeTruthy();
	});
});

describe('handleMerge squash 冲突与成功面板分发', () => {
	it('squash 冲突 → notify 引导，不弹冲突面板', async () => {
		const repoDir = setupMergeConflict(tmpBase('squash'));
		const { ctx, notified } = makeCtx(repoDir);
		// squash 冲突分支 fromPanel=true 时会回主菜单（handlePanel → showWorktreeTui）
		mockShowWorktreeTui.mockResolvedValue({ action: 'quit' });

		await handleMerge(repoDir, { source: 'a', strategy: 'squash' }, ctx, true);

		expect(mockShowConflictPanel).not.toHaveBeenCalled();
		expect(notified.some((m) => m.includes('回滚'))).toBe(true);
	});

	it('成功 switch → handleUse（经 askSessionStrategy 确认）', async () => {
		const repoDir = setupMergeSuccess(tmpBase('switch'));
		const { ctx } = makeCtx(repoDir);

		mockShowMergeSuccessPanel.mockResolvedValue({ action: 'switch' });
		mockAskMergeStrategy.mockResolvedValue('merge');
		mockAskSessionStrategy.mockResolvedValue('cancel');

		await handleMerge(repoDir, { source: 'a', strategy: 'merge' }, ctx, true);

		// switch → handleUse(repoRoot, {_positional:'main'}) → askSessionStrategy 被调用
		expect(mockAskSessionStrategy).toHaveBeenCalledWith(expect.anything(), 'main', false);
	});

	it('成功 menu → handlePanel（经 showWorktreeTui）', async () => {
		const repoDir = setupMergeSuccess(tmpBase('menu'));
		const { ctx } = makeCtx(repoDir);

		mockShowMergeSuccessPanel.mockResolvedValue({ action: 'menu' });
		mockAskMergeStrategy.mockResolvedValue('merge');
		mockShowWorktreeTui.mockResolvedValue({ action: 'quit' });

		await handleMerge(repoDir, { source: 'a', strategy: 'merge' }, ctx, true);

		expect(mockShowWorktreeTui).toHaveBeenCalled();
	});

	it('成功 dismiss → 不触发 switch/menu 分发', async () => {
		const repoDir = setupMergeSuccess(tmpBase('dismiss'));
		const { ctx } = makeCtx(repoDir);

		mockShowMergeSuccessPanel.mockResolvedValue({ action: 'dismiss' });
		mockAskMergeStrategy.mockResolvedValue('merge');

		await handleMerge(repoDir, { source: 'a', strategy: 'merge' }, ctx, true);

		expect(mockAskSessionStrategy).not.toHaveBeenCalled();
		expect(mockShowWorktreeTui).not.toHaveBeenCalled();
	});
});

describe('handleRebase 冲突面板 action 分发（死按钮修复回归）', () => {
	it('agent → sendUserMessage 发出 rebase 提示词（第 5 步 rebase --continue）', async () => {
		const { repoDir } = setupRebaseConflict(tmpBase('rb-agent'));
		const { ctx } = makeCtx(repoDir);
		const sendUserMessage = vi.fn(async (_prompt?: string, _opts?: unknown) => {});
		setWorktreePi({ sendUserMessage } as any);

		mockShowConflictPanel.mockResolvedValue({ action: 'agent' });

		await handleRebase(repoDir, { source: 'rb', target: 'main' }, ctx);

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const [prompt] = sendUserMessage.mock.calls[0];
		expect(prompt).toContain('rb.txt');
		expect(prompt).toContain('git rebase --continue'); // rebase 策略第 5 步
		expect(prompt).not.toContain('git commit');
	});

	it('abort → handleAbort 清理 rebase 状态', async () => {
		const { repoDir, wtDir } = setupRebaseConflict(tmpBase('rb-abort'));
		const { ctx } = makeCtx(repoDir);

		mockShowConflictPanel.mockResolvedValue({ action: 'abort' });

		await handleRebase(repoDir, { source: 'rb', target: 'main' }, ctx);

		// handleAbort → git rebase --abort：rebase 状态目录应消失
		let paused = true;
		try {
			const p = execSync('git rev-parse --git-path rebase-merge/stopped-sha', {
				cwd: wtDir,
				encoding: 'utf-8',
			}).trim();
			paused = existsSync(p);
		} catch {
			paused = false;
		}
		expect(paused).toBe(false);
	});
});
