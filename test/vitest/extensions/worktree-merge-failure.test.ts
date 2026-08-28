/**
 * merge 失败提示映射 + squash 冲突 — 测试（ticket 11）
 *
 * 覆盖 formatMergeFailure：非冲突失败的中文提示映射（含 timeout 单独提示）。
 */
import { describe, it, expect } from 'vitest';
import { formatMergeFailure } from '../../../extensions/meta/worktree/lib/handlers.ts';

describe('formatMergeFailure', () => {
	const base = { ok: false, conflicts: [] as Array<{ file: string; lines: string }> };

	it('timeout → 超时提示', () => {
		const msg = formatMergeFailure(
			{ ...base, message: 'Pull timed out', timedOut: true },
			'main',
		);
		expect(msg).toContain('超时');
		expect(msg).toContain('回滚');
	});

	it('rebase 成功后超时 → 提示未回滚（源分支已 rebase）', () => {
		const msg = formatMergeFailure(
			{ ...base, message: 'Pull timed out', timedOut: true, timedOutAfterRebase: true },
			'main',
		);
		expect(msg).toContain('超时');
		expect(msg).toContain('rebase');
		expect(msg).not.toContain('已回滚');
	});

	it('rebase 成功后 pull/ff 失败 → 提示未回滚（源分支已 rebase）', () => {
		const msg = formatMergeFailure(
			{
				...base,
				message: "Pull on 'main' failed after rebase, aborting.",
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

	it('pull 失败 → 拉取失败已回滚', () => {
		const msg = formatMergeFailure(
			{ ...base, message: "Pull on 'main' failed, aborting." },
			'main',
		);
		expect(msg).toContain('拉取');
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
