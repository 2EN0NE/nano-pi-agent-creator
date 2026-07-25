/**
 * edit 核心匹配引擎测试
 *
 * 覆盖：
 * - matcher: fuzzy/exact matching, getLineSpans, applyEditsToNormalizedContent
 * - classic: applyClassicEdits
 * - row-script: parseRowScript, applyRowOperations
 */

import { describe, it, expect } from 'vitest';

// ── matcher ──

import {
	applyEditsToNormalizedContent,
	seekSequence,
	deriveUpdatedContent,
} from '../../../extensions/accuracy/edit/shared/matcher.js';
import type { UpdateChunk } from '../../../extensions/accuracy/edit/shared/matcher.js';

describe('edit: matcher — applyEditsToNormalizedContent', () => {
	it('exact match replaces text', () => {
		const result = applyEditsToNormalizedContent(
			'hello world',
			[{ oldText: 'world', newText: 'there' }],
			'test.txt',
		);
		expect(result.newContent).toBe('hello there');
	});

	it('rejects empty oldText', () => {
		expect(() =>
			applyEditsToNormalizedContent('hello', [{ oldText: '', newText: 'world' }], 'test.txt'),
		).toThrow('oldText must not be empty');
	});

	it('throws when oldText not found', () => {
		expect(() =>
			applyEditsToNormalizedContent(
				'hello',
				[{ oldText: 'nope', newText: 'world' }],
				'test.txt',
			),
		).toThrow('Could not find');
	});

	it('throws when oldText is ambiguous (multiple matches)', () => {
		expect(() =>
			applyEditsToNormalizedContent('a a a', [{ oldText: 'a', newText: 'b' }], 'test.txt'),
		).toThrow('Found 3 occurrences');
	});

	it('fuzzy match: trailing whitespace difference', () => {
		const result = applyEditsToNormalizedContent(
			'hello world\n',
			[{ oldText: 'hello world', newText: 'hi there' }],
			'test.txt',
		);
		expect(result.newContent).toBe('hi there\n');
	});

	it('fuzzy match: unicode dash normalization', () => {
		const result = applyEditsToNormalizedContent(
			'hello – world',
			[{ oldText: 'hello - world', newText: 'hi' }],
			'test.txt',
		);
		expect(result.newContent).toBe('hi');
	});

	it('fuzzy match: smart quotes', () => {
		const result = applyEditsToNormalizedContent(
			'it\u2019s fine',
			[{ oldText: "it's fine", newText: 'ok' }],
			'test.txt',
		);
		expect(result.newContent).toBe('ok');
	});

	it('exact match with requireWholeLines', () => {
		const content = 'line1\nline2\nline3\n';
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: 'line2', newText: 'modified' }],
			'test.txt',
			{ requireWholeLines: true },
		);
		expect(result.newContent).toBe('line1\nmodified\nline3\n');
	});

	it('requireWholeLines rejects partial line match', () => {
		const content = 'line1\nline2\nline3\n';
		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[{ oldText: 'ine2', newText: 'x' }],
				'test.txt',
				{ requireWholeLines: true },
			),
		).toThrow('Could not find');
	});

	it('multiple edits on same file work sequentially', () => {
		const content = 'a\nb\nc\n';
		const result = applyEditsToNormalizedContent(
			content,
			[
				{ oldText: 'a', newText: 'x' },
				{ oldText: 'c', newText: 'z' },
			],
			'test.txt',
			{ requireWholeLines: true },
		);
		expect(result.newContent).toBe('x\nb\nz\n');
	});

	it('overlapping edits are rejected', () => {
		const content = 'abc';
		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[
					{ oldText: 'ab', newText: 'x' },
					{ oldText: 'bc', newText: 'y' },
				],
				'test.txt',
			),
		).toThrow('overlap');
	});

	it('identical content throws no-change error', () => {
		expect(() =>
			applyEditsToNormalizedContent(
				'hello',
				[{ oldText: 'hello', newText: 'hello' }],
				'test.txt',
			),
		).toThrow('No changes');
	});

	it('replacement that produces same result throws', () => {
		// 'a' → 'a' with extra whitespace normalization
		expect(() =>
			applyEditsToNormalizedContent(' a ', [{ oldText: 'a', newText: 'a' }], 'test.txt'),
		).toThrow('No changes');
	});

	it('respects requireWholeLines: trailing newline consumption', () => {
		const content = 'keep\ndelete\nkeep\n';
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: 'delete\n', newText: '' }],
			'test.txt',
			{ requireWholeLines: true },
		);
		// "delete\n" as a whole-line boundary match
		expect(result.newContent).toBe('keep\nkeep\n');
	});

	it('preserves content outside replacements', () => {
		const content = 'prefix\nmiddle\nsuffix\n';
		const result = applyEditsToNormalizedContent(
			content,
			[{ oldText: 'middle', newText: 'changed' }],
			'test.txt',
			{ requireWholeLines: true },
		);
		expect(result.newContent).toBe('prefix\nchanged\nsuffix\n');
	});

	it('fuzzy match normalizes NBSP to space', () => {
		const result = applyEditsToNormalizedContent(
			'hello\u00A0world',
			[{ oldText: 'hello world', newText: 'hi' }],
			'test.txt',
		);
		expect(result.newContent).toBe('hi');
	});

	it('handles CRLF normalization', () => {
		const result = applyEditsToNormalizedContent(
			'hello\r\nworld\r\n',
			[{ oldText: 'hello\nworld', newText: 'hi' }],
			'test.txt',
		);
		expect(result.newContent).toBe('hi\n');
	});
});

describe('edit: matcher — seekSequence', () => {
	const lines = ['a', 'b', 'c', 'd', 'e'];

	it('finds exact match at start', () => {
		expect(seekSequence(lines, ['a', 'b'], 0, false)).toBe(0);
	});

	it('finds exact match in middle', () => {
		expect(seekSequence(lines, ['c', 'd'], 0, false)).toBe(2);
	});

	it('finds exact match at end', () => {
		expect(seekSequence(lines, ['d', 'e'], 0, false)).toBe(3);
	});

	it('returns undefined for non-existent pattern', () => {
		expect(seekSequence(lines, ['x', 'y'], 0, false)).toBeUndefined();
	});

	it('respects start offset', () => {
		expect(seekSequence(lines, ['a'], 1, false)).toBeUndefined();
	});

	it('eof mode searches from end', () => {
		expect(seekSequence(lines, ['d', 'e'], 0, true)).toBe(3);
	});

	it('finds with rstrip match (trailing spaces)', () => {
		const spaced = ['a ', 'b  ', 'c'];
		expect(seekSequence(spaced, ['a', 'b'], 0, false)).toBe(0);
	});

	it('finds with full trim match', () => {
		const padded = ['  a  ', '  b  '];
		expect(seekSequence(padded, ['a', 'b'], 0, false)).toBe(0);
	});

	it('empty pattern returns start offset', () => {
		expect(seekSequence(lines, [], 5, false)).toBe(5);
	});
});

describe('edit: matcher — deriveUpdatedContent', () => {
	it('replaces a simple hunk', () => {
		const content = 'line1\nline2\nline3\n';
		const chunks: UpdateChunk[] = [
			{
				changeContext: undefined,
				oldLines: ['line2'],
				newLines: ['modified'],
				isEndOfFile: false,
			},
		];
		const result = deriveUpdatedContent('test.txt', content, chunks);
		expect(result).toBe('line1\nmodified\nline3\n');
	});

	it('replaces with context anchor', () => {
		const content = 'before\nkeep\nkeep\nlineX\nlineY\nafter\n';
		const chunks: UpdateChunk[] = [
			{
				changeContext: 'before',
				oldLines: ['lineX', 'lineY'],
				newLines: ['changed'],
				isEndOfFile: false,
			},
		];
		const result = deriveUpdatedContent('test.txt', content, chunks);
		expect(result).toBe('before\nkeep\nkeep\nchanged\nafter\n');
	});

	it('appends at end when oldLines is empty', () => {
		const content = 'line1\nline2\n';
		const chunks: UpdateChunk[] = [
			{
				changeContext: undefined,
				oldLines: [],
				newLines: ['appended'],
				isEndOfFile: true,
			},
		];
		const result = deriveUpdatedContent('test.txt', content, chunks);
		expect(result).toBe('line1\nline2\nappended\n');
	});

	it('multiple hunks', () => {
		const content = 'a\nb\nc\nd\ne\n';
		const chunks: UpdateChunk[] = [
			{
				changeContext: undefined,
				oldLines: ['b'],
				newLines: ['B'],
				isEndOfFile: false,
			},
			{
				changeContext: undefined,
				oldLines: ['d'],
				newLines: ['D'],
				isEndOfFile: false,
			},
		];
		const result = deriveUpdatedContent('test.txt', content, chunks);
		expect(result).toBe('a\nB\nc\nD\ne\n');
	});
});

// ── row-script ──

import { createRowScriptEditor } from '../../../extensions/accuracy/edit/impl/row-script.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('edit: row-script — @REPLACE', () => {
	const editor = createRowScriptEditor();

	it('basic @REPLACE', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		const file = join(dir, 'test.txt');
		writeFileSync(file, 'old\n');

		const result = await editor.execute(`[test.txt]\n@REPLACE\n-old\n+new`, dir);
		expect(result.results[0].message).toContain('Edited');
		rmSync(dir, { recursive: true });
	});

	it('@APPEND appends to end', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		const file = join(dir, 'test.txt');
		writeFileSync(file, 'line1\n');

		const result = await editor.execute(`[test.txt]\n@APPEND\n+appended`, dir);
		expect(result.results[0].message).toContain('Edited');
		rmSync(dir, { recursive: true });
	});

	it('@DEL removes line range', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		const file = join(dir, 'test.txt');
		writeFileSync(file, 'keep\ndelete\nkeep\n');

		const result = await editor.execute(`[test.txt]\n@DEL 2-2`, dir);
		expect(result.results[0].message).toContain('Edited');
		rmSync(dir, { recursive: true });
	});

	it('@INS.PRE inserts before line', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		const file = join(dir, 'test.txt');
		writeFileSync(file, 'b\nc\n');

		const result = await editor.execute(`[test.txt]\n@INS.PRE 1\n+a`, dir);
		expect(result.results[0].message).toContain('Edited');
		rmSync(dir, { recursive: true });
	});

	it('row script with multiple operations', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		const file = join(dir, 'test.txt');
		writeFileSync(file, 'a\nb\nc\n');

		const result = await editor.execute(
			'[test.txt]\n@REPLACE\n-a\n+x\n@DEL 3-3\n@APPEND\n+z',
			dir,
		);
		expect(result.results[0].message).toContain('Edited');
		rmSync(dir, { recursive: true });
	});

	it('handles errors gracefully', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		await expect(editor.execute('[nonexist.txt]\n@REPLACE\n-a\n+b', dir)).rejects.toThrow();
		rmSync(dir, { recursive: true });
	});
});

// ── classic ──

import { createClassicEditor } from '../../../extensions/accuracy/edit/impl/classic.js';

describe('edit: classic — exact matching', () => {
	const editor = createClassicEditor();

	it('basic replacement', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		const file = join(dir, 'test.txt');
		writeFileSync(file, 'hello world\n');

		const result = await editor.execute(
			[{ path: file, oldText: 'world', newText: 'there' }],
			dir,
		);
		expect(result.results[0].success).toBe(true);
		expect(result.results[0].message).toContain('Edited');
		rmSync(dir, { recursive: true });
	});

	it('fails when oldText not found', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		const file = join(dir, 'test.txt');
		writeFileSync(file, 'hello\n');

		const result = await editor.execute([{ path: file, oldText: 'nope', newText: 'x' }], dir);
		expect(result.results[0].success).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it('multi edit on same file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'edit-test-'));
		const file = join(dir, 'test.txt');
		writeFileSync(file, 'a\nb\nc\n');

		const result = await editor.execute(
			[
				{ path: file, oldText: 'a', newText: 'x' },
				{ path: file, oldText: 'c', newText: 'z' },
			],
			dir,
		);
		expect(result.results.every((r) => r.success)).toBe(true);
		rmSync(dir, { recursive: true });
	});
});
