/**
 * review（profile 驱动）— 模式选择逻辑回归测试
 *
 * ## Bug 记录
 *
 * 在 commit 0607ee0 中, select 菜单选项从英文翻译为中文:
 *   - 'Empty branch' → '新分支'
 *   - 'Current session' → '当前会话'
 *
 * 但 choice 的比较值未被同步更新, 导致:
 *   useFreshSession = choice === 'Empty branch';  // ← 永远为 false
 *                    // '新分支' !== 'Empty branch'
 *
 * 合并 review + test-analysis 为 profile 驱动插件后（ADR-0025），
 * 两个文件收敛为 extensions/verification/review/index.ts，
 * 模式选择逻辑只剩一份，但回归防护仍需保留。
 *
 * ## 测试设计
 *
 * 由于比较逻辑嵌在 registerCommand handler 闭包内,
 * 无法直接导出单元测试。采用源码扫描方法直接验证:
 *
 *   - 读取源文件, 提取 select 选项数组和紧随的 choice === 'X' 比较值
 *   - 断言两者一致
 *
 * @see extensions/verification/review/index.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLatestReviewSettings } from '../../../extensions/verification/review/index.js';
import type { CustomEntry } from '@earendil-works/pi-coding-agent';

// ============================================================================
// 辅助: 从源文件中提取 select 选项与 choice === 'X' 的配对
// ============================================================================

const SOURCE_DIR = resolve(__dirname, '../../../extensions/verification/review');
const SOURCE_FILE = resolve(SOURCE_DIR, 'index.ts');

function readSource(): string {
	return readFileSync(SOURCE_FILE, 'utf-8');
}

/**
 * 在 source 中查找包含 selectTitlePattern 的 select 调用, 返回:
 *   - options: 选项数组 (如 ['新分支', '当前会话'])
 *   - comparisonValue: 紧随的 choice === 'X' 中的 X
 *   未找到时返回 null
 */
function extractSelectPair(
	source: string,
	selectTitlePattern: string,
): { options: string[]; comparisonValue: string } | null {
	const lines = source.split('\n');

	const selectIdx = lines.findIndex((l) => l.includes(selectTitlePattern));
	if (selectIdx < 0) return null;

	const selectLine = lines[selectIdx];
	const bracketMatch = selectLine.match(/\[([^\]]+)\]/);
	if (!bracketMatch) return null;

	const options = bracketMatch[1]
		.split(',')
		.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
		.filter(Boolean);

	for (let i = selectIdx; i < Math.min(selectIdx + 50, lines.length); i++) {
		const line = lines[i];
		const match = line.match(/choice\s*===\s*'([^']+)'/);
		if (match) {
			return { options, comparisonValue: match[1] };
		}
	}

	return null;
}

// ============================================================================
// 测试: review/index.ts 模式选择
// ============================================================================

describe('review/index.ts 模式选择', () => {
	const source = readSource();

	it('找到了 Review Mode 选择调用', () => {
		const pair = extractSelectPair(source, "'Review Mode:'");
		expect(pair).not.toBeNull();
	});

	it('Review Mode select 选项为 ["新分支", "当前会话"]', () => {
		const pair = extractSelectPair(source, "'Review Mode:'");
		expect(pair?.options).toEqual(['新分支', '当前会话']);
	});

	it('Review Mode comparisonValue 是 "新分支" (与 select 选项一致)', () => {
		const pair = extractSelectPair(source, "'Review Mode:'");
		expect(pair?.comparisonValue).toBe('新分支');
	});
});

// ============================================================================
// 整体验证: 所有 choice === 'X' 比较值都应出现在 select 选项中
// ============================================================================

describe('整体验证', () => {
	/**
	 * 检查从第 i 行开始的 20 行窗口内是否存在 choice === 'X' 或 choice !== 'X' 精确比较。
	 * 用于跳过动作选择器等无精确比较的 select 调用。
	 */
	function hasChoiceComparison(lines: string[], i: number): boolean {
		for (let j = i; j < Math.min(i + 20, lines.length); j++) {
			if (/choice\s*(===|!==)\s*'/.test(lines[j])) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 提取从第 i 行开始的选项数组 `[...]`（支持跨行数组，如 selectPanel 的多行选项）。
	 * 返回去除引号后的选项列表；未找到闭合 `]` 时返回 null。
	 */
	function extractOptions(lines: string[], i: number): string[] | null {
		const openIdx = lines[i].indexOf('[');
		if (openIdx < 0) return null;

		let buf = lines[i].slice(openIdx);
		let j = i;
		while (!buf.includes(']') && j < lines.length - 1) {
			j++;
			buf += lines[j];
		}

		const bracketMatch = buf.match(/\[([^\]]+)\]/);
		if (!bracketMatch) return null;

		return bracketMatch[1]
			.split(',')
			.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
			.filter(Boolean);
	}

	it('index.ts 的所有 select 调用都有匹配的 choice 比较', () => {
		const source = readSource();
		const lines = source.split('\n');

		for (let i = 0; i < lines.length; i++) {
			if (
				!lines[i].includes('selectPanel(ctx, ') &&
				!lines[i].includes('ctx.ui.select(') &&
				!lines[i].includes('ctx.ui.picker(') &&
				!lines[i].includes('ctx.ui.menu(')
			)
				continue;

			const options = extractOptions(lines, i);
			if (!options) continue;

			// 跳过动作选择器（无 choice === 'X' 精确比较的行）
			if (!hasChoiceComparison(lines, i)) continue;

			let hasMatch = false;
			for (let j = i; j < Math.min(i + 20, lines.length); j++) {
				const m = lines[j].match(/choice\s*===\s*'([^']+)'/);
				if (m && options.includes(m[1])) {
					hasMatch = true;
					break;
				}
			}

			expect(hasMatch).toBe(true);
		}
	});
});

// ============================================================================
// lastProfileId 持久化回归测试（修复：跨会话记住最近使用的 profile）
// 行为级测试：getLatestReviewSettings 必须取「最新」一条 review-settings 条目
// ============================================================================

function makeCustomEntry(customType: string, data: unknown, id: string): CustomEntry<unknown> {
	return {
		type: 'custom',
		customType,
		data,
		id,
		parentId: null,
		timestamp: '2026-01-01T00:00:00.000Z',
	};
}

describe('getLatestReviewSettings（lastProfileId 持久化回归）', () => {
	it('多条 review-settings 条目时返回最新一条（反向遍历，而非最旧）', () => {
		const entries = [
			makeCustomEntry('review-settings', { lastProfileId: 'code-review' }, 'e1'),
			makeCustomEntry('review-settings', { lastProfileId: 'test-analysis' }, 'e2'),
		];
		expect(getLatestReviewSettings(entries)?.lastProfileId).toBe('test-analysis');
	});

	it('跳过不匹配 customType 的条目，仍取最新一条 review-settings', () => {
		const entries = [
			makeCustomEntry('review-settings', { lastProfileId: 'code-review' }, 'e1'),
			makeCustomEntry('other-type', { lastProfileId: 'should-be-ignored' }, 'x1'),
			makeCustomEntry('review-settings', { lastProfileId: 'test-analysis' }, 'e2'),
		];
		expect(getLatestReviewSettings(entries)?.lastProfileId).toBe('test-analysis');
	});

	it('无匹配条目时返回 undefined', () => {
		expect(getLatestReviewSettings([])).toBeUndefined();
	});
});
