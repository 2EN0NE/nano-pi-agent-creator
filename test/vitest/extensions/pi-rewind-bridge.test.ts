/**
 * pi-rewind — P1：review×pi-rewind 弱依赖桥契约测试
 *
 * 对应测试分析发现 [P1]：双端 `globalThis.__piRewind` 方法名/语义只靠人工
 * 保持一致——任一侧改方法名即静默 no-op（review 开审查分支/end-review 返回
 * 时 restoreOnTree=ask/always 可能弹出多余「同步文件?」甚至改写用户工作区）。
 *
 * 采用 review.test.ts 同款 source-scan 方法：桥接消费方（review）从源码中
 * 调用的方法集合必须等于桥提供方（pi-rewind）声明的方法集合。两侧都以
 * source 文本为准，改任何一侧方法名都会被抓住。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REWIND_INDEX = resolve(__dirname, '../../../extensions/auto/pi-rewind/index.ts');
const REVIEW_INDEX = resolve(__dirname, '../../../extensions/verification/review/index.ts');

/** 提取 pi-rewind 声明给桥的对象字面量方法名（globalThis.__piRewind = { ... }）。 */
function extractRewindBridgeMethods(source: string): string[] {
	const assignment = source.match(/globalThis\.__piRewind\s*=\s*\{([\s\S]*?)\};/);
	if (!assignment) return [];
	return [...assignment[1]!.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\(/g)].map((m) => m[1]!);
}

/** 提取 review 通过 bridge.xxx(...) 调用桥的方法名。 */
function extractReviewBridgeCalls(source: string): string[] {
	const methods = new Set<string>();
	for (const match of source.matchAll(/bridge\.([A-Za-z_$][\w$]*)\s*\(/g)) {
		methods.add(match[1]!);
	}
	return [...methods];
}

describe('review×pi-rewind 弱依赖桥契约（source-scan）', () => {
	it('review 调用的桥方法集合 ⊆ pi-rewind 提供的方法集合', () => {
		const rewindSource = readFileSync(REWIND_INDEX, 'utf8');
		const reviewSource = readFileSync(REVIEW_INDEX, 'utf8');

		const provided = extractRewindBridgeMethods(rewindSource);
		const consumed = extractReviewBridgeCalls(reviewSource);

		expect(provided.length).toBeGreaterThan(0);
		expect(consumed.length).toBeGreaterThan(0);

		const missing = consumed.filter((method) => !provided.includes(method));
		expect(missing).toEqual([]);
	});

	it('pi-rewind 桥至少提供 suppressTreeRestore 与 clearSuppressTreeRestore', () => {
		const rewindSource = readFileSync(REWIND_INDEX, 'utf8');
		const methods = extractRewindBridgeMethods(rewindSource);
		expect(methods).toEqual(
			expect.arrayContaining(['suppressTreeRestore', 'clearSuppressTreeRestore']),
		);
	});

	it('review 的抑制是「立即 suppress + finally clear」语义（防泄漏）', () => {
		const reviewSource = readFileSync(REVIEW_INDEX, 'utf8');
		// 找到调用 suppressTreeRestore 的函数，确认其返回的清理函数调用 clear
		const suppressCall = reviewSource.match(
			/bridge\.suppressTreeRestore\([\s\S]*?return\s*\(\)\s*=>\s*bridge\.clearSuppressTreeRestore\(/,
		);
		expect(suppressCall).not.toBeNull();
	});
});
