/**
 * merge 失败提示映射 + Agent 委托 prompt — 测试（ticket 11 / 本地优先改造）
 *
 * 覆盖 formatMergeFailure（非冲突失败的中文提示映射）与
 * buildMergeAdvicePrompt（失败面板「让 Agent 处理」的三段式 prompt）。
 */
import { describe, it, expect } from 'vitest';
import { formatMergeFailure } from '../../../extensions/meta/worktree/lib/handlers.ts';
import { buildMergeAdvicePrompt } from '../../../extensions/meta/worktree/lib/ui.ts';

describe('formatMergeFailure', () => {
	const base = { ok: false, conflicts: [] as Array<{ file: string; lines: string }> };

	it('rebase 成功后 ff-merge 失败 → 提示未回滚（源分支已 rebase）', () => {
		const msg = formatMergeFailure(
			{
				...base,
				message: 'Fast-forward merge failed after rebase (unexpected)',
				failedAfterRebase: true,
			},
			'main',
		);
		expect(msg).toContain('rebase');
		expect(msg).not.toContain('已回滚');
	});

	it('stash 失败 → 提示先提交或 stash', () => {
		const msg = formatMergeFailure({ ...base, message: 'Cannot stash changes' }, 'main');
		expect(msg).toContain('stash');
		expect(msg).toContain('提交');
	});

	it('checkout 失败 → 含目标分支与已回滚', () => {
		const msg = formatMergeFailure({ ...base, message: "Cannot checkout 'main'" }, 'main');
		expect(msg).toContain('main');
		expect(msg).toContain('回滚');
	});

	it('squash commit 失败 → 提交失败已回滚', () => {
		const msg = formatMergeFailure(
			{ ...base, message: 'Squash merge succeeded but commit failed' },
			'main',
		);
		expect(msg).toContain('提交失败');
		expect(msg).toContain('回滚');
	});

	it('其他失败 → 合并失败 + 原始 message', () => {
		const msg = formatMergeFailure({ ...base, message: 'some unknown error' }, 'main');
		expect(msg).toContain('合并失败');
		expect(msg).toContain('some unknown error');
	});
});

describe('buildMergeAdvicePrompt（三段式 Agent 委托 prompt）', () => {
	const opts = {
		sourceBranch: 'wt/review',
		targetBranch: 'dev',
		strategy: 'merge' as const,
		failureMessage: "Cannot checkout 'dev'",
		targetSync: { ahead: 0, behind: 3 },
		sourceAheadBehind: { ahead: 1, behind: 0 },
	};

	it('含三段式结构：原则 + 当前情况 + 任务', () => {
		const prompt = buildMergeAdvicePrompt(opts);
		expect(prompt).toContain('## 原则');
		expect(prompt).toContain('## 当前情况');
		expect(prompt).toContain('## 任务');
		expect(prompt).toContain('本地优先');
		expect(prompt).toContain('wt/review');
		expect(prompt).toContain('dev');
	});

	it('有远端时同步状态含 ahead/behind', () => {
		const prompt = buildMergeAdvicePrompt(opts);
		expect(prompt).toContain('ahead=0, behind=3');
	});

	it('无远端时同步状态标注无远端（静默降级，不报错）', () => {
		const prompt = buildMergeAdvicePrompt({ ...opts, targetSync: null });
		expect(prompt).toContain('无远端');
	});

	it('原则明确：不 push、只给命令不执行', () => {
		const prompt = buildMergeAdvicePrompt(opts);
		expect(prompt).toContain('不执行任何命令');
		expect(prompt).toContain('不得包含 push');
		expect(prompt).toContain('需用户手动执行');
	});
});
