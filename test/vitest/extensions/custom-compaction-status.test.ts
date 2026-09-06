/**
 * custom-compaction status — 状态栏渲染纯函数测试
 *
 * Covers:
 *   - fmtTokens：1.5M / 200K / 999 边界
 *   - updateStatus：四态优先级（compacting > triggered > approaching > normal）
 *   - reserve 型窗口估算（contextWindow 显式 + percent 反推）
 *   - hasUI=false / 无 usage 的降级路径
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
	fmtTokens,
	updateStatus,
	type StatusCtx,
} from '../../../extensions/context/custom-compaction/status.js';
import {
	createCompactionStore,
	__setStoreForTest,
} from '../../../extensions/context/custom-compaction/config.js';
import type { CompactionProfile } from '../../../extensions/context/custom-compaction/types.js';

let tmpRoot: string;
let userFile: string;

beforeEach(() => {
	tmpRoot = join(tmpdir(), `cc-status-test-${randomBytes(4).toString('hex')}`);
	const userDir = join(tmpRoot, 'home', '.pi', 'agent', 'extensions-data', 'custom-compaction');
	mkdirSync(userDir, { recursive: true });
	userFile = join(userDir, 'config.json');
	__setStoreForTest(
		createCompactionStore({ cwd: join(tmpRoot, 'cwd'), homeDir: join(tmpRoot, 'home') }),
	);
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfig(trigger: CompactionProfile['trigger']): void {
	const profile: CompactionProfile = {
		id: 'default',
		name: 'Default',
		model: 'current',
		trigger,
		mechanism: { type: 'summarize' },
		prompt: '',
		autoContinue: true,
		injectContinueText: false,
		autoContinueMessage: 'continue',
	};
	writeFileSync(
		userFile,
		JSON.stringify({ activeProfileId: 'default', profiles: { default: profile } }, null, 2) +
			'\n',
		'utf-8',
	);
}

/** 构造 StatusCtx：theme.fg 忽略颜色，setStatus 记录调用参数 */
function makeCtx(opts: {
	usage?: { tokens: number; percent: number | null } | null;
	contextWindow?: number;
	hasUI?: boolean;
}): { ctx: StatusCtx; setStatus: ReturnType<typeof vi.fn> } {
	const setStatus = vi.fn();
	const ctx: StatusCtx = {
		hasUI: opts.hasUI ?? true,
		ui: {
			setStatus,
			theme: { fg: (_key, s) => s as string },
		},
		getContextUsage: () => opts.usage ?? null,
		model: { provider: 'openai', id: 'gpt-4o', contextWindow: opts.contextWindow },
	};
	return { ctx, setStatus };
}

// ── fmtTokens ──────────────────────────────────────────────────

describe('fmtTokens', () => {
	it('formats plain numbers under 1000', () => {
		expect(fmtTokens(0)).toBe('0');
		expect(fmtTokens(999)).toBe('999');
	});

	it('formats thousands with K suffix', () => {
		expect(fmtTokens(1000)).toBe('1K');
		expect(fmtTokens(1500)).toBe('1.5K');
		expect(fmtTokens(200_000)).toBe('200K');
	});

	it('formats millions with M suffix', () => {
		expect(fmtTokens(1_000_000)).toBe('1M');
		expect(fmtTokens(1_500_000)).toBe('1.5M');
	});

	it('preserves sign for negative values', () => {
		expect(fmtTokens(-1500)).toBe('-1.5K');
	});
});

// ── updateStatus ───────────────────────────────────────────────

describe('updateStatus', () => {
	it('does nothing when hasUI is false', () => {
		const { ctx, setStatus } = makeCtx({ hasUI: false });
		updateStatus(ctx, false);
		expect(setStatus).not.toHaveBeenCalled();
	});

	it('renders threshold-only extra when no usage data is available', () => {
		writeConfig({ type: 'context_percent', threshold: 20 });
		const { ctx, setStatus } = makeCtx({ usage: null });
		updateStatus(ctx, false);
		expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-20%');
	});

	describe('context_percent', () => {
		it('renders triggered state when percent reaches threshold', () => {
			writeConfig({ type: 'context_percent', threshold: 50 });
			const { ctx, setStatus } = makeCtx({ usage: { tokens: 60000, percent: 60 } });
			updateStatus(ctx, false);
			expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-60%/50%');
		});

		it('renders approaching state at >=80% of threshold but below it', () => {
			writeConfig({ type: 'context_percent', threshold: 50 });
			const { ctx, setStatus } = makeCtx({ usage: { tokens: 40000, percent: 40 } });
			updateStatus(ctx, false);
			expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-40%/50%');
		});

		it('renders normal state when below 80% of threshold', () => {
			writeConfig({ type: 'context_percent', threshold: 50 });
			const { ctx, setStatus } = makeCtx({ usage: { tokens: 10000, percent: 10 } });
			updateStatus(ctx, false);
			expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-10%/50%');
		});
	});

	it('compacting state takes priority over triggered', () => {
		writeConfig({ type: 'context_percent', threshold: 50 });
		const { ctx, setStatus } = makeCtx({ usage: { tokens: 60000, percent: 60 } });
		updateStatus(ctx, true);
		expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-60%/50%');
	});

	describe('fixed', () => {
		it('formats absolute tokens as K', () => {
			writeConfig({ type: 'fixed', threshold: 50_000 });
			const { ctx, setStatus } = makeCtx({ usage: { tokens: 60_000, percent: null } });
			updateStatus(ctx, false);
			expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-60K/50K');
		});
	});

	describe('reserve', () => {
		it('computes remaining from explicit contextWindow', () => {
			writeConfig({ type: 'reserve', threshold: 10_000 });
			const { ctx, setStatus } = makeCtx({
				usage: { tokens: 90_000, percent: null },
				contextWindow: 100_000,
			});
			updateStatus(ctx, false);
			expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-10K/10K');
		});

		it('derives window from percent when contextWindow is undefined', () => {
			writeConfig({ type: 'reserve', threshold: 10_000 });
			const { ctx, setStatus } = makeCtx({
				usage: { tokens: 90_000, percent: 90 },
				contextWindow: undefined,
			});
			updateStatus(ctx, false);
			expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-10K/10K');
		});
	});
});

// ── widget 选择算法与真实压缩对齐（ADR-0036：路由规则/matchModel 参与择一）──

describe('widget 选择算法对齐', () => {
	const baseProfile: CompactionProfile = {
		id: 'default',
		name: 'Default',
		model: 'current',
		trigger: { type: 'context_percent', threshold: 50 },
		mechanism: { type: 'summarize' },
		prompt: '',
		autoContinue: true,
		injectContinueText: false,
		autoContinueMessage: 'continue',
	};

	function writeTwoProfiles(routingRules: unknown[], matchModel?: string): void {
		const alt: CompactionProfile = {
			...baseProfile,
			id: 'alt',
			name: 'Alt',
			trigger: { type: 'context_percent', threshold: 30 },
		};
		if (matchModel !== undefined) alt.matchModel = matchModel;
		writeFileSync(
			userFile,
			JSON.stringify(
				{
					profiles: { default: baseProfile, alt },
					enabledProfileIds: ['default', 'alt'],
					routingRules,
				},
				null,
				2,
			) + '\n',
			'utf-8',
		);
	}

	it('多个启用 profile 时显示数量，阈值反映路由目标（alt 30%）', () => {
		// tiebreak 会选 threshold 大的 default（50 > 30）；路由规则命中 → alt
		writeTwoProfiles([{ model: 'openai/', targetProfileId: 'alt' }]);
		const { ctx, setStatus } = makeCtx({ usage: { tokens: 60_000, percent: 60 } });
		updateStatus(ctx, false);
		expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:2 active-60%/30%');
	});

	it('多个启用 profile 时显示数量，阈值反映 tiebreak（default 50%）', () => {
		writeTwoProfiles([]);
		const { ctx, setStatus } = makeCtx({ usage: { tokens: 60_000, percent: 60 } });
		updateStatus(ctx, false);
		expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:2 active-60%/50%');
	});

	it('多个启用 profile 时显示数量，阈值反映 matchModel（alt 30%）', () => {
		// default 无 matchModel；alt matchModel 'openai/gpt-4o'（精确匹配）→ 应选 alt
		writeTwoProfiles([], 'openai/gpt-4o');
		const { ctx, setStatus } = makeCtx({ usage: { tokens: 60_000, percent: 60 } });
		updateStatus(ctx, false);
		expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:2 active-60%/30%');
	});
});
