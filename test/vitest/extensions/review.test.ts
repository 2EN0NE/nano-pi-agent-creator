/**
 * review / test-analysis — 模式选择逻辑回归测试
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
 * 此问题同时存在于 review.ts 和 test-analysis.ts:
 *   extensions/verification/review.ts:2046
 *   extensions/verification/test-analysis.ts:2213
 *
 * ## 测试设计
 *
 * 由于比较逻辑嵌在 ctx.ui.select() + registerCommand handler 闭包内,
 * 无法直接导出单元测试。采用源码扫描方法直接验证:
 *
 *   - 读取源文件, 提取 select 选项数组和紧随的 choice === 'X' 比较值
 *   - 断言两者一致
 *
 * ## 红线体系
 *
 *   修复前 → 修复后:
 *   - verification/empty-branch-exists PASS → FAIL   (确认残留还在)
 *   - verification/empty-branch-absent FAIL → PASS     (确认已移除)
 *   - select-comparison-consistent     FAIL → PASS     (select 与比较值匹配)
 *
 * @see extensions/verification/review.ts:2035-2046
 * @see extensions/verification/test-analysis.ts:2202-2213
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ============================================================================
// 辅助: 从源文件中提取 select 选项与 choice === 'X' 的配对
// ============================================================================

const SOURCE_DIR = resolve(__dirname, '../../../extensions/verification');

function readSource(file: string): string {
	return readFileSync(resolve(SOURCE_DIR, file), 'utf-8');
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

	// 找到包含 select 标题的行
	const selectIdx = lines.findIndex((l) => l.includes(selectTitlePattern));
	if (selectIdx < 0) return null;

	// 从 select 行提取选项数组 [...]
	const selectLine = lines[selectIdx];
	const bracketMatch = selectLine.match(/\[([^\]]+)\]/);
	if (!bracketMatch) return null;

	const options = bracketMatch[1]
		.split(',')
		.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
		.filter(Boolean);

	// 在后 20 行内找 choice === 'X'
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
// 测试: review.ts
// ============================================================================

describe('review.ts 模式选择', () => {
	const source = readSource('review.ts');
	const pair = extractSelectPair(source, "'选择审查模式：'");

	it('找到了模式选择调用', () => {
		expect(pair).not.toBeNull();
	});

	it('select 选项为 ["新分支", "当前会话"]', () => {
		expect(pair?.options).toEqual(['新分支', '当前会话']);
	});

	it('comparisonValue 是 "新分支" (与 select 选项一致)', () => {
		expect(pair?.comparisonValue).toBe('新分支');
	});
});

// ============================================================================
// 测试: test-analysis.ts
// ============================================================================

describe('test-analysis.ts 模式选择', () => {
	const source = readSource('test-analysis.ts');
	const pair = extractSelectPair(source, "'选择分析模式：'");

	it('找到了模式选择调用', () => {
		expect(pair).not.toBeNull();
	});

	it('select 选项为 ["新分支", "当前会话"]', () => {
		expect(pair?.options).toEqual(['新分支', '当前会话']);
	});

	it('comparisonValue 是 "新分支" (与 select 选项一致)', () => {
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

	it('review.ts 的所有 ctx.ui.select 都有匹配的 choice 比较', () => {
		const source = readSource('review.ts');
		const lines = source.split('\n');

		// 找所有 select 调用
		for (let i = 0; i < lines.length; i++) {
			if (
				!lines[i].includes('ctx.ui.select(') &&
				!lines[i].includes('ctx.ui.picker(') &&
				!lines[i].includes('ctx.ui.menu(')
			)
				continue;

			const bracketMatch = lines[i].match(/\[([^\]]+)\]/);
			if (!bracketMatch) continue;

			const options = bracketMatch[1]
				.split(',')
				.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
				.filter(Boolean);

			// 跳过动作选择器（无 choice === 'X' 精确比较的行）
			if (!hasChoiceComparison(lines, i)) continue;

			// 找 choice === 'X' 比较
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

	it('test-analysis.ts 的所有 ctx.ui.select 都有匹配的 choice 比较', () => {
		const source = readSource('test-analysis.ts');
		const lines = source.split('\n');

		for (let i = 0; i < lines.length; i++) {
			if (
				!lines[i].includes('ctx.ui.select(') &&
				!lines[i].includes('ctx.ui.picker(') &&
				!lines[i].includes('ctx.ui.menu(')
			)
				continue;

			const bracketMatch = lines[i].match(/\[([^\]]+)\]/);
			if (!bracketMatch) continue;

			const options = bracketMatch[1]
				.split(',')
				.map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
				.filter(Boolean);

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
