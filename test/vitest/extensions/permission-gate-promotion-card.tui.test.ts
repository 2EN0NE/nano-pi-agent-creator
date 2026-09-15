/**
 * permission-gate 提升确认卡片 — headless snapshot 测试（Ticket 07）
 *
 * AGENTS.md 对 TUI 是强制要求：多宽度不超宽、无 emoji/方角边框、按键后状态切换正确。
 */
import { describe, it, expect } from 'vitest';
import { assertWithinWidth, stripAnsi } from '../../../src/tui-testing/index.js';
import { makeThemeColors } from '../../../src/tui/helpers.js';
import {
	PromotionCard,
	type PromotionCardResult,
} from '../../../extensions/security/permission-gate/promotion-card';
import type { PromotionCandidate } from '../../../extensions/security/permission-gate/promotion';
import type { PromotionLevel } from '../../../extensions/security/permission-gate/promotion-adopt';

/** 与 answer.tui.test.ts 同款最小 theme（makeThemeColors 只需 fg/bold） */
function mockTheme(): {
	fg: (c: string, t: string) => string;
	bold: (t: string) => string;
} {
	return { fg: (_c: string, t: string) => t, bold: (t: string) => t };
}

const candidate: PromotionCandidate = {
	dimension: 'sameTool',
	key: 'tool:rm',
	tool: 'rm',
	command: 'rm -rf /tmp/probe/nested',
	dir: '/tmp/probe/nested',
	tier: 'warning',
	evidence: {
		sessionManual: 4,
		sessionAuto: 0,
		historyDirectories: 5,
		historySessions: 9,
		userDenials: 0,
	},
};

const threeLevels: Array<{ level: PromotionLevel; path: string }> = [
	{ level: 'leaf', path: '/tmp/probe/nested' },
	{ level: 'parent', path: '/tmp/probe' },
	{ level: 'root', path: '/tmp' },
];

function makeCard(
	levels = threeLevels,
	onDone: (r: PromotionCardResult) => void = () => {},
): PromotionCard {
	return new PromotionCard(candidate, levels, makeThemeColors(mockTheme() as never), onDone);
}

describe('PromotionCard 渲染', () => {
	it('在 80 / 120 宽度下不超宽、不崩溃', () => {
		for (const w of [80, 120]) {
			assertWithinWidth(makeCard().render(w), w);
		}
	});

	it('纯横线范式：无竖线、无方角、无 emoji', () => {
		const out = makeCard().render(80).map(stripAnsi).join('\n');
		for (const bad of ['│', '┌', '┐', '└', '┘', '✓', '✗', '📋', '✅']) {
			expect(out).not.toContain(bad);
		}
		expect(out).toContain('── 提升建议');
	});

	it('说明为什么没能自动放行，并展示目标', () => {
		const out = makeCard().render(80).map(stripAnsi).join('\n');
		expect(out).toContain('已被你人工放行 4 次');
		expect(out).toContain('从未自动放行');
		expect(out).toContain('/tmp/probe/nested');
	});

	it('台阶三级，默认停在第 ① 级（具体路径）', () => {
		const out = makeCard().render(80).map(stripAnsi).join('\n');
		expect(out).toContain('> （默认）具体路径：/tmp/probe/nested');
		expect(out).toContain('父目录：/tmp/probe');
		expect(out).toContain('目标根：/tmp');
	});

	it('条件默认勾选', () => {
		const card = makeCard();
		expect(card.hasProvenanceCondition).toBe(true);
		expect(card.render(80).map(stripAnsi).join('\n')).toContain('[x] 仅限本会话创建的路径');
	});

	it('认不出目标根时只展示两级（不猜）', () => {
		const out = makeCard(threeLevels.slice(0, 2)).render(80).map(stripAnsi).join('\n');
		expect(out).toContain('父目录');
		expect(out).not.toContain('目标根');
	});
});

describe('PromotionCard 键盘交互', () => {
	it('↓ 切换台阶、Space 取消勾选、e 展开证据', () => {
		const card = makeCard();
		card.handleInput('\x1b[B');
		expect(card.render(80).map(stripAnsi).join('\n')).toContain('> 父目录');
		expect(card.render(80).map(stripAnsi).join('\n')).not.toContain('> （默认）');

		card.handleInput(' ');
		const afterSpace = card.render(80).map(stripAnsi).join('\n');
		expect(card.hasProvenanceCondition).toBe(false);
		expect(afterSpace).toContain('[ ] 仅限本会话创建的路径');
		expect(afterSpace).toContain('放宽');

		expect(card.render(80).map(stripAnsi).join('\n')).not.toContain('历史：');
		card.handleInput('e');
		const afterEvidence = card.render(80).map(stripAnsi).join('\n');
		expect(afterEvidence).toContain('历史：5 目录 / 9 会话 / 0 次用户拒绝');
		expect(afterEvidence).toContain('tool:rm');
	});

	it('↑↓ 不越界', () => {
		const card = makeCard();
		card.handleInput('\x1b[A');
		card.handleInput('\x1b[A');
		expect(card.render(80).map(stripAnsi).join('\n')).toContain('> （默认）具体路径');
		for (let i = 0; i < 6; i++) card.handleInput('j');
		expect(card.render(80).map(stripAnsi).join('\n')).toContain('> 目标根');
	});

	it('Enter 采纳当前台阶 + 当前条件状态', () => {
		let got: PromotionCardResult | null = null;
		const card = makeCard(threeLevels, (r) => {
			got = r;
		});
		card.handleInput('j');
		card.handleInput('\r');
		expect(got).toEqual({ action: 'adopt', level: 'parent', requireProvenance: true });
	});

	it('Enter 在取消勾选后回传 requireProvenance=false', () => {
		let got: PromotionCardResult | null = null;
		const card = makeCard(threeLevels, (r) => {
			got = r;
		});
		card.handleInput(' ');
		card.handleInput('\n');
		expect(got).toEqual({ action: 'adopt', level: 'leaf', requireProvenance: false });
	});

	it('d 忽略、Esc 取消（不落盘）', () => {
		let got: PromotionCardResult | null = null;
		const a = makeCard(threeLevels, (r) => {
			got = r;
		});
		a.handleInput('d');
		expect(got).toEqual({ action: 'ignore' });

		const b = makeCard(threeLevels, (r) => {
			got = r;
		});
		b.handleInput('\x1b');
		expect(got).toEqual({ action: 'cancel' });
	});
});
