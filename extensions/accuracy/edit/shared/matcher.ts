/**
 * 编辑匹配引擎 — 包含 exact/fuzzy matching、行序列搜索、替换逻辑
 *
 * 从 multi-edit.ts 提取，供 classic 和 row-script 实现共享。
 */

import { normalizeToLF, normalizeForFuzzyMatch } from './workspace.js';

// ============================================================================
// 行序列搜索
// ============================================================================

export function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;

	const searchStart =
		eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const searchEnd = lines.length - pattern.length;

	const exactEqual = (a: string, b: string) => a === b;
	const rstripEqual = (a: string, b: string) => a.trimEnd() === b.trimEnd();
	const trimEqual = (a: string, b: string) => a.trim() === b.trim();
	const fuzzyEqual = (a: string, b: string) =>
		normalizeForFuzzyMatch(a) === normalizeForFuzzyMatch(b);

	const passes = [exactEqual, rstripEqual, trimEqual, fuzzyEqual];

	for (const eq of passes) {
		for (let i = searchStart; i <= searchEnd; i++) {
			let ok = true;
			for (let p = 0; p < pattern.length; p++) {
				if (!eq(lines[i + p], pattern[p])) {
					ok = false;
					break;
				}
			}
			if (ok) return i;
		}
	}

	return undefined;
}

export function applyReplacements(
	lines: string[],
	replacements: Array<[number, number, string[]]>,
): string[] {
	const next = [...lines];

	for (const [start, oldLen, newSegment] of [...replacements].sort((a, b) => b[0] - a[0])) {
		next.splice(start, oldLen, ...newSegment);
	}

	return next;
}

export function deriveUpdatedContent(
	filePath: string,
	currentContent: string,
	chunks: UpdateChunk[],
): string {
	const originalLines = currentContent.split('\n');
	if (originalLines[originalLines.length - 1] === '') {
		originalLines.pop();
	}

	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (ctxIndex === undefined) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
			}
			lineIndex = ctxIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			replacements.push([originalLines.length, 0, [...chunk.newLines]]);
			continue;
		}

		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;

		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (found === undefined && pattern[pattern.length - 1] === '') {
			pattern = pattern.slice(0, -1);
			if (newSlice[newSlice.length - 1] === '') {
				newSlice = newSlice.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}

		if (found === undefined) {
			throw new Error(
				`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`,
			);
		}

		replacements.push([found, pattern.length, [...newSlice]]);
		lineIndex = found + pattern.length;
	}

	const newLines = applyReplacements(originalLines, replacements);
	if (newLines[newLines.length - 1] !== '') {
		newLines.push('');
	}
	return newLines.join('\n');
}

export interface UpdateChunk {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

// ============================================================================
// Fuzzy Text Matching
// ============================================================================

function isWholeLineBoundary(
	content: string,
	start: number,
	length: number,
	oldText: string,
): boolean {
	const end = start + length;
	const startsOnBoundary = start === 0 || content[start - 1] === '\n';
	const consumesTrailingNewline = oldText.endsWith('\n');
	const endsOnBoundary =
		consumesTrailingNewline || end >= content.length || content[end] === '\n';
	return startsOnBoundary && endsOnBoundary;
}

function findMatchIndex(content: string, needle: string, wholeLines: boolean): number {
	if (needle.length === 0) return -1;
	let index = content.indexOf(needle);
	while (index !== -1) {
		if (!wholeLines || isWholeLineBoundary(content, index, needle.length, needle)) return index;
		index = content.indexOf(needle, index + 1);
	}
	return -1;
}

interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

function fuzzyFindText(content: string, oldText: string, wholeLines: boolean): FuzzyMatchResult {
	const exactIndex = findMatchIndex(content, oldText, wholeLines);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = findMatchIndex(fuzzyContent, fuzzyOldText, wholeLines);
	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function countOccurrences(content: string, oldText: string, wholeLines: boolean): number {
	if (oldText.length === 0) return 0;
	let count = 0;
	const needle = oldText;
	let index = content.indexOf(needle);
	while (index !== -1) {
		if (!wholeLines || isWholeLineBoundary(content, index, needle.length, needle)) count++;
		index = content.indexOf(needle, index + 1);
	}
	if (count > 0) return count;

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyNeedle = normalizeForFuzzyMatch(oldText);
	if (fuzzyNeedle.length === 0) return count;
	let fIndex = fuzzyContent.indexOf(fuzzyNeedle);
	while (fIndex !== -1) {
		if (!wholeLines || isWholeLineBoundary(fuzzyContent, fIndex, fuzzyNeedle.length, needle))
			count++;
		fIndex = fuzzyContent.indexOf(fuzzyNeedle, fIndex + 1);
	}
	return count;
}

function applyTextReplacements(
	content: string,
	replacements: Array<{ matchIndex: number; matchLength: number; newText: string }>,
): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		result =
			result.substring(0, r.matchIndex) +
			r.newText +
			result.substring(r.matchIndex + r.matchLength);
	}
	return result;
}

// ============================================================================
// 模糊位置到原始位置的映射
// ============================================================================

/**
 * 将 fuzzy-normalized 内容中的位置映射回原始 normalized 内容的位置。
 * fuzzy 内容每行的尾部空白被 trimEnd 删除，导致字符位置偏移。
 * 这个函数通过逐行对齐来补偿偏移。
 */
function fuzzyToOriginalPos(normalized: string, fuzzy: string, fuzzyPos: number): number {
	const nl = '\n';
	let origIdx = 0;
	let fuzzyIdx = 0;

	while (fuzzyIdx < fuzzy.length && fuzzyIdx < fuzzyPos) {
		// 找到 fuzzy 中当前行的结束
		const fuzzyNl = fuzzy.indexOf(nl, fuzzyIdx);
		const fuzzyLineLen = fuzzyNl === -1 ? fuzzy.length - fuzzyIdx : fuzzyNl - fuzzyIdx;

		// 找到 original 中对应行的结束
		const origNl = normalized.indexOf(nl, origIdx);
		const origLineLen = origNl === -1 ? normalized.length - origIdx : origNl - origIdx;

		if (fuzzyIdx + fuzzyLineLen >= fuzzyPos) {
			// 位置在当前行内部——偏移量相同
			return origIdx + (fuzzyPos - fuzzyIdx);
		}

		// 跳过这一行（包括换行符）
		fuzzyIdx += fuzzyLineLen + 1;
		origIdx += origLineLen + 1;
	}

	return fuzzyPos; // fallback
}

// ============================================================================
// 主要编辑应用函数
// ============================================================================

export interface Edit {
	oldText: string;
	newText: string;
}

export interface EditResult {
	success: boolean;
	message: string;
}

/**
 * 对归一化的内容应用一组编辑。
 * 每个 edit 精确/模糊匹配 oldText，替换为 newText。
 * 要求每个 oldText 唯一，编辑之间不重叠。
 */
export function applyEditsToNormalizedContent(
	rawContent: string,
	edits: Edit[],
	path: string,
	options?: { requireWholeLines?: boolean },
): { baseContent: string; newContent: string } {
	// 确保内容已归一化到 LF
	const normalizedContent = normalizeToLF(rawContent);
	const wholeLines = options?.requireWholeLines === true;

	for (let i = 0; i < edits.length; i++) {
		if (edits[i].oldText.length === 0) {
			throw new Error(
				edits.length === 1
					? `oldText must not be empty in ${path}.`
					: `edits[${i}].oldText must not be empty in ${path}.`,
			);
		}
	}

	// 判断是否需要模糊匹配——只需要用于位置查找，不用于替换
	const initialMatches = edits.map((edit) =>
		fuzzyFindText(normalizedContent, edit.oldText, wholeLines),
	);
	const usedFuzzyMatch = initialMatches.some((m) => m.usedFuzzyMatch);

	// 模糊内容只用于位置查询；替换永远在 normalizedContent 上进行
	const positionBase = usedFuzzyMatch
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent;

	const matchedEdits: Array<{
		editIndex: number;
		matchIndex: number;
		matchLength: number;
		newText: string;
	}> = [];

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		const matchResult = fuzzyFindText(positionBase, edit.oldText, wholeLines);
		if (!matchResult.found) {
			throw new Error(
				`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
			);
		}

		const occurrences = countOccurrences(positionBase, edit.oldText, wholeLines);
		if (occurrences > 1) {
			throw new Error(
				`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context.`,
			);
		}

		// 将位置从模糊内容空间映射回原始 normalized 内容空间
		let matchIndex = matchResult.index;
		if (usedFuzzyMatch) {
			matchIndex = fuzzyToOriginalPos(normalizedContent, positionBase, matchResult.index);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex,
			matchLength: edit.oldText.length, // 始终使用原始 oldText 长度
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const prev = matchedEdits[i - 1];
		const cur = matchedEdits[i];
		if (prev.matchIndex + prev.matchLength > cur.matchIndex) {
			throw new Error(
				`edits[${prev.editIndex}] and edits[${cur.editIndex}] overlap in ${path}. Merge them into one edit.`,
			);
		}
	}

	// 替换永远在 normalizedContent 上进行（不是模糊内容）
	const baseContent = normalizedContent;
	const newContent = applyTextReplacements(normalizedContent, matchedEdits);

	if (baseContent === newContent) {
		throw new Error(`No changes made to ${path}. The replacement produced identical content.`);
	}

	return { baseContent, newContent };
}
