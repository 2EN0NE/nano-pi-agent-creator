/**
 * Row-Script Edit — 行标记编辑风格的实现
 *
 * 从 unified-edit.ts 提取。
 * 接受单一 text 参数，格式为 row edit script：
 *   [filename]
 *   @REPLACE
 *   -old line
 *   +new line
 *   @INS.PRE 1
 *   +new line
 *   @DEL 20-23
 *   @APPEND
 *   +new line
 */

import { isAbsolute, resolve } from 'node:path';
import { createRealWorkspace, createVirtualWorkspace, normalizeToLF } from '../shared/workspace.js';
import { generateDiffString } from '../shared/diff.js';
import { applyEditsToNormalizedContent, deriveUpdatedContent } from '../shared/matcher.js';
import type { UpdateChunk } from '../shared/matcher.js';
import type { Edit } from '../shared/matcher.js';

// ============================================================================
// Types
// ============================================================================

export interface RowScriptResult {
	path: string;
	kind: 'update' | 'add' | 'delete';
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

type RowGroup = {
	marker: '+' | '-' | ' ' | '@@';
	lines: string[];
};

type RawRowOperation =
	| { kind: 'insertBefore'; line: number; rows: string[] }
	| { kind: 'insertAfter'; line: number; rows: string[] }
	| { kind: 'insertBeforeAnchor'; groups: RowGroup[] }
	| { kind: 'insertAfterAnchor'; groups: RowGroup[] }
	| { kind: 'append'; rows: string[] }
	| { kind: 'delete'; startLine: number; endLine: number }
	| { kind: 'replace'; groups: RowGroup[] };

interface RawFileScript {
	path: string;
	ops: RawRowOperation[];
}

type PatchOperation =
	| { kind: 'add'; path: string; contents: string }
	| { kind: 'delete'; path: string }
	| { kind: 'update'; path: string; chunks: UpdateChunk[] };

export type RowScriptMode = 'rows' | 'patch';

export interface ParsedPlan {
	mode: RowScriptMode;
	changes: Array<{
		path: string;
		absolutePath: string;
		kind: 'update' | 'add' | 'delete';
		oldText: string;
		newText: string;
	}>;
}

// ============================================================================
// 行脚本解析
// ============================================================================

function normalizePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) throw new Error('文件路径不能为空。');
	return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function parseRowScript(text: string): RawFileScript[] {
	const lines = normalizeToLF(text).split('\n');
	const files: RawFileScript[] = [];
	let currentFile: RawFileScript | undefined;
	let currentOp: RawRowOperation | undefined;

	function finishOp() {
		if (!currentOp) return;
		if (!currentFile) throw new Error('内部解析器错误');
		if ('rows' in currentOp && currentOp.rows.length === 0) {
			throw new Error(`${currentFile.path} 中的 ${currentOp.kind} 没有 + 行。`);
		}
		if ('groups' in currentOp && currentOp.groups.length === 0) {
			const opName =
				currentOp.kind === 'replace'
					? '@REPLACE'
					: currentOp.kind === 'insertBeforeAnchor'
						? '@INS.BEFORE'
						: '@INS.AFTER';
			throw new Error(`${currentFile.path} 中的 ${opName} 没有 + 或 - 行。`);
		}
		currentFile.ops.push(currentOp);
		currentOp = undefined;
	}

	function requireFile(lineNumber: number): RawFileScript {
		if (!currentFile) throw new Error(`第 ${lineNumber} 行：应为 [filename] 头部`);
		return currentFile;
	}

	function pushGroup(marker: RowGroup['marker'], linesToAdd: string[]): void {
		if (!currentOp || !('groups' in currentOp)) throw new Error('内部解析器错误');
		if (marker === '@@') {
			currentOp.groups.push({ marker, lines: [] });
			return;
		}
		const lastGroup = currentOp.groups[currentOp.groups.length - 1];
		if (lastGroup && lastGroup.marker === marker) lastGroup.lines.push(...linesToAdd);
		else currentOp.groups.push({ marker, lines: [...linesToAdd] });
	}

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const lineNumber = i + 1;
		const trimmed = raw.trim();
		if (trimmed === '') continue;

		const fileMatch = /^\[(.+)]\s*$/.exec(trimmed);
		if (fileMatch) {
			finishOp();
			currentFile = { path: normalizePath(fileMatch[1]), ops: [] };
			files.push(currentFile);
			continue;
		}

		if (raw.startsWith('@@')) {
			if (currentOp && 'groups' in currentOp) pushGroup('@@', []);
			continue;
		}

		if (raw.startsWith('@')) {
			const file = requireFile(lineNumber);
			finishOp();

			const insertMatch = /^@INS\.(PRE|POST)\s+(\d+)\s*$/i.exec(trimmed);
			if (insertMatch) {
				const line = Number(insertMatch[2]);
				if (!Number.isSafeInteger(line) || line < 1)
					throw new Error(`第 ${lineNumber} 行：插入行号必须 >= 1。`);
				currentOp =
					insertMatch[1].toUpperCase() === 'PRE'
						? { kind: 'insertBefore', line, rows: [] }
						: { kind: 'insertAfter', line, rows: [] };
				continue;
			}

			if (/^@INS\.BEFORE\s*$/i.test(trimmed)) {
				currentOp = { kind: 'insertBeforeAnchor', groups: [] };
				continue;
			}
			if (/^@INS\.AFTER\s*$/i.test(trimmed)) {
				currentOp = { kind: 'insertAfterAnchor', groups: [] };
				continue;
			}
			if (/^@APPEND\s*$/i.test(trimmed)) {
				currentOp = { kind: 'append', rows: [] };
				continue;
			}
			if (/^@REPLACE\s*$/i.test(trimmed)) {
				currentOp = { kind: 'replace', groups: [] };
				continue;
			}

			const delMatch = /^@DEL\s+(\d+)(?:(?:\s*-\s*|\s*\.\.=?\s*|\s*\.=\s*)(\d+))?\s*$/i.exec(
				trimmed,
			);
			if (delMatch) {
				const startLine = Number(delMatch[1]);
				const endLine = delMatch[2] === undefined ? startLine : Number(delMatch[2]);
				if (startLine < 1 || endLine < startLine)
					throw new Error(`第 ${lineNumber} 行：无效范围。`);
				file.ops.push({ kind: 'delete', startLine, endLine });
				continue;
			}

			throw new Error(`第 ${lineNumber} 行：未知操作 ${trimmed}`);
		}

		if (raw.startsWith('+') || raw.startsWith('-')) {
			requireFile(lineNumber);
			if (!currentOp) throw new Error(`第 ${lineNumber} 行：行出现在操作之前。`);
			const marker = raw[0] as '+' | '-';
			const body = raw.slice(1);

			if ('rows' in currentOp) {
				if (marker !== '+')
					throw new Error(`第 ${lineNumber} 行：${currentOp.kind} 只接受 + 行。`);
				currentOp.rows.push(body);
				continue;
			}
			if (!('groups' in currentOp)) throw new Error(`第 ${lineNumber} 行：意外的行。`);
			pushGroup(marker, [body]);
			continue;
		}

		if (raw.startsWith(' ') && currentOp && 'groups' in currentOp) {
			requireFile(lineNumber);
			if (currentOp.kind === 'replace') pushGroup(' ', [raw.slice(1)]);
			continue;
		}

		throw new Error(`第 ${lineNumber} 行：无效的行脚本行。`);
	}

	finishOp();
	if (files.length === 0) throw new Error('行编辑脚本必须至少包含一个 [filename] 节。');
	for (const file of files) {
		if (file.ops.length === 0) throw new Error(`文件节 [${file.path}] 没有操作。`);
	}
	return files;
}

// ============================================================================
// 行操作应用
// ============================================================================

function getReplacePairs(
	path: string,
	op: Extract<RawRowOperation, { kind: 'replace' }>,
): Array<{ oldLines: string[]; newLines: string[] }> {
	const groups = op.groups.filter((g) => g.marker === '@@' || g.lines.length > 0);
	if (groups.length === 0) throw new Error(`${path} 中的 @REPLACE 没有行。`);

	const hasContext = groups.some((g) => g.marker === ' ' || g.marker === '@@');
	if (hasContext) return getContextualReplacePairs(path, groups);

	const changeGroups = groups as Array<RowGroup & { marker: '+' | '-' }>;
	if (changeGroups.length === 1) {
		if (changeGroups[0].marker === '-')
			return [{ oldLines: changeGroups[0].lines, newLines: [] }];
		throw new Error(`${path} 中的 @REPLACE 有 + 行但没有 - 行。`);
	}
	if (changeGroups.length % 2 !== 0) throw new Error(`${path} 中的 @REPLACE 有奇数个 +/- 块。`);

	const pairs: Array<{ oldLines: string[]; newLines: string[] }> = [];
	for (let i = 0; i < changeGroups.length; i += 2) {
		const a = changeGroups[i];
		const b = changeGroups[i + 1];
		if (a.marker === b.marker) throw new Error(`${path} 中的 @REPLACE：应为配对的 + 和 - 块。`);
		pairs.push({
			oldLines: a.marker === '-' ? a.lines : b.lines,
			newLines: a.marker === '+' ? a.lines : b.lines,
		});
	}
	return pairs;
}

function getContextualReplacePairs(
	path: string,
	groups: RowGroup[],
): Array<{ oldLines: string[]; newLines: string[] }> {
	const hunks: RowGroup[][] = [[]];
	for (const group of groups) {
		if (group.marker === '@@') {
			if (hunks[hunks.length - 1].length > 0) hunks.push([]);
			continue;
		}
		if (group.lines.length > 0) hunks[hunks.length - 1].push(group);
	}

	const pairs: Array<{ oldLines: string[]; newLines: string[] }> = [];
	for (let i = 0; i < hunks.length; i++) {
		const hunk = hunks[i];
		if (hunk.length === 0) continue;
		const oldLines: string[] = [];
		const newLines: string[] = [];
		let hasChange = false;

		for (const group of hunk) {
			if (group.marker === ' ') {
				oldLines.push(...group.lines);
				newLines.push(...group.lines);
			} else if (group.marker === '-') {
				oldLines.push(...group.lines);
				hasChange = true;
			} else if (group.marker === '+') {
				newLines.push(...group.lines);
				hasChange = true;
			}
		}

		if (!hasChange) throw new Error(`${path} 中的 @REPLACE 块 ${i + 1} 没有 + 或 - 行。`);
		if (oldLines.length === 0)
			throw new Error(`${path} 中的 @REPLACE 块 ${i + 1} 没有 - 或上下文行。`);
		pairs.push({ oldLines, newLines });
	}
	if (pairs.length === 0) throw new Error(`${path} 中的 @REPLACE 没有行。`);
	return pairs;
}

function applyRowOperations(path: string, content: string, ops: RawRowOperation[]): string {
	const doc = splitContent(content);

	for (const op of ops) {
		switch (op.kind) {
			case 'insertBefore':
			case 'insertAfter': {
				const index = op.kind === 'insertBefore' ? op.line - 1 : op.line;
				if (index < 0 || index > doc.lines.length) {
					throw new Error(
						`${op.kind === 'insertBefore' ? '@INS.PRE' : '@INS.POST'} ${op.line} 超出 ${path} 范围；文件有 ${doc.lines.length} 行。`,
					);
				}
				doc.lines.splice(index, 0, ...op.rows);
				if (index + op.rows.length === doc.lines.length) doc.finalNewline = true;
				break;
			}
			case 'append':
				doc.lines.push(...op.rows);
				doc.finalNewline = true;
				break;
			case 'delete':
				if (op.endLine > doc.lines.length) {
					throw new Error(
						`@DEL ${op.startLine}-${op.endLine} 超出 ${path} 范围；文件有 ${doc.lines.length} 行。`,
					);
				}
				doc.lines.splice(op.startLine - 1, op.endLine - op.startLine + 1);
				if (doc.lines.length === 0) doc.finalNewline = false;
				break;
			case 'replace': {
				const pairs = getReplacePairs(path, op);
				const nextContent = joinContent(doc);
				let updated = nextContent;
				for (const pair of pairs) {
					// When deleting (newLines empty), we must consume the trailing \n
					// to avoid leaving a blank line. However, if the deletion targets
					// the last lines of a file that has no trailing newline, the \n
					// would cause a match failure. Check if oldLines are at the end
					// of content without trailing newline and skip the \n in that case.
					const joinedOldLines = pair.oldLines.join('\n');
					const isLastLines =
						!doc.finalNewline &&
						doc.lines.slice(-pair.oldLines.length).join('\n') === joinedOldLines;
					const oldText =
						pair.newLines.length === 0
							? joinedOldLines + (isLastLines ? '' : '\n')
							: joinedOldLines;
					const edit: Edit = {
						oldText,
						newText: pair.newLines.join('\n'),
					};
					updated = applyEditsToNormalizedContent(updated, [edit], path).newContent;
				}
				Object.assign(doc, splitContent(updated));
				break;
			}
			case 'insertBeforeAnchor':
			case 'insertAfterAnchor': {
				const groups = op.groups.filter(
					(g): g is RowGroup & { marker: '+' | '-' } =>
						(g.marker === '+' || g.marker === '-') && g.lines.length > 0,
				);
				if (groups.length !== 2 || groups[0].marker === groups[1].marker) {
					throw new Error(
						`${path} 中的 ${op.kind === 'insertBeforeAnchor' ? '@INS.BEFORE' : '@INS.AFTER'} 需要一个 - 锚点和一个 + 插入。`,
					);
				}
				const anchorText = (groups[0].marker === '-' ? groups[0] : groups[1]).lines.join(
					'\n',
				);
				const insertText = (groups[0].marker === '+' ? groups[0] : groups[1]).lines.join(
					'\n',
				);
				const newText =
					op.kind === 'insertBeforeAnchor'
						? `${insertText}\n${anchorText}`
						: `${anchorText}\n${insertText}`;
				const updated = applyEditsToNormalizedContent(
					joinContent(doc),
					[{ oldText: anchorText, newText }],
					path,
					{ requireWholeLines: true },
				).newContent;
				Object.assign(doc, splitContent(updated));
				break;
			}
		}
	}

	return joinContent(doc);
}

function splitContent(content: string): { lines: string[]; finalNewline: boolean } {
	const finalNewline = content.endsWith('\n');
	const body = finalNewline ? content.slice(0, -1) : content;
	return { lines: body.length === 0 ? [] : body.split('\n'), finalNewline };
}

function joinContent(doc: { lines: string[]; finalNewline: boolean }): string {
	const body = doc.lines.join('\n');
	return doc.finalNewline ? `${body}\n` : body;
}

// ============================================================================
// 补丁解析
// ============================================================================

function parsePatch(patchText: string): PatchOperation[] {
	const lines = normalizeToLF(patchText).trim().split('\n');
	if (lines.length < 2) throw new Error('补丁为空或无效');
	if (lines[0].trim() !== '*** Begin Patch') throw new Error("第一行必须是 '*** Begin Patch'");
	if (lines[lines.length - 1].trim() !== '*** End Patch')
		throw new Error("最后一行必须是 '*** End Patch'");

	const operations: PatchOperation[] = [];
	let i = 1;
	const lastContentLine = lines.length - 2;

	while (i <= lastContentLine) {
		if (lines[i].trim() === '') {
			i++;
			continue;
		}
		const line = lines[i].trim();

		if (line.startsWith('*** Add File: ')) {
			const path = normalizePath(line.slice('*** Add File: '.length));
			i++;
			const contentLines: string[] = [];
			while (i <= lastContentLine) {
				const next = lines[i];
				if (next.trim().startsWith('*** ')) break;
				if (!next.startsWith('+')) throw new Error(`无效的添加文件行：'${next}'`);
				contentLines.push(next.slice(1));
				i++;
			}
			operations.push({
				kind: 'add',
				path,
				contents: contentLines.length > 0 ? `${contentLines.join('\n')}\n` : '',
			});
			continue;
		}

		if (line.startsWith('*** Delete File: ')) {
			operations.push({
				kind: 'delete',
				path: normalizePath(line.slice('*** Delete File: '.length)),
			});
			i++;
			continue;
		}

		if (line.startsWith('*** Update File: ')) {
			const path = normalizePath(line.slice('*** Update File: '.length));
			i++;
			if (i <= lastContentLine && lines[i].trim().startsWith('*** Move to: ')) {
				throw new Error('不支持补丁移动操作。');
			}
			const chunks: import('../shared/matcher.js').UpdateChunk[] = [];
			while (i <= lastContentLine) {
				if (lines[i].trim() === '') {
					i++;
					continue;
				}
				if (lines[i].trim().startsWith('*** ')) break;
				const parsed = parseUpdateChunk(lines, i, lastContentLine, chunks.length === 0);
				chunks.push(parsed.chunk);
				i = parsed.nextIndex;
			}
			if (chunks.length === 0) throw new Error(`'${path}' 的更新文件块为空`);
			operations.push({ kind: 'update', path, chunks });
			continue;
		}

		throw new Error(`无效的块头：'${line}'`);
	}

	return operations;
}

function parseUpdateChunk(
	lines: string[],
	startIndex: number,
	lastContentLine: number,
	allowMissingContext: boolean,
): { chunk: UpdateChunk; nextIndex: number } {
	let i = startIndex;
	let changeContext: string | undefined;
	const first = lines[i].trimEnd();

	if (first === '@@') i++;
	else if (first.startsWith('@@ ')) {
		changeContext = first.slice(3);
		i++;
	} else if (!allowMissingContext) throw new Error(`应为 @@ 上下文标记，实际是：'${lines[i]}'`);

	const oldLines: string[] = [];
	const newLines: string[] = [];
	let parsed = 0;
	let isEndOfFile = false;

	while (i <= lastContentLine) {
		const raw = lines[i];
		const trimmed = raw.trimEnd();
		if (trimmed === '*** End of File') {
			if (parsed === 0) throw new Error('更新块没有行');
			isEndOfFile = true;
			i++;
			break;
		}
		if (parsed > 0 && (trimmed.startsWith('@@') || trimmed.startsWith('*** '))) break;
		if (raw.length === 0) {
			oldLines.push('');
			newLines.push('');
			parsed++;
			i++;
			continue;
		}

		const marker = raw[0];
		const body = raw.slice(1);
		if (marker === ' ') {
			oldLines.push(body);
			newLines.push(body);
		} else if (marker === '-') oldLines.push(body);
		else if (marker === '+') newLines.push(body);
		else if (parsed === 0) throw new Error(`意外的块行：'${raw}'`);
		else break;
		parsed++;
		i++;
	}

	if (parsed === 0) throw new Error('更新块没有行');
	return { chunk: { changeContext, oldLines, newLines, isEndOfFile }, nextIndex: i };
}

// ============================================================================
// 主入口
// ============================================================================

export function createRowScriptEditor() {
	async function execute(
		text: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<{
		results: RowScriptResult[];
		combinedDiff: string;
		firstChangedLine?: number;
		plan: ParsedPlan;
	}> {
		// Parse
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		const plan = await buildPlan(text, cwd);

		// Preflight via virtual workspace
		await applyPlanToWorkspace(plan, createVirtualWorkspace(cwd));

		// Execute for real
		const results = await applyPlanToWorkspace(plan, createRealWorkspace(), {
			collectDiff: true,
		});

		const combinedDiff = results
			.filter((r) => r.diff)
			.map((r) => r.diff)
			.join('\n\n');
		const firstChanged = results.find(
			(r) => r.firstChangedLine !== undefined,
		)?.firstChangedLine;

		return { results, combinedDiff, firstChangedLine: firstChanged, plan };
	}

	return { execute };
}

async function buildPlan(text: string, cwd: string): Promise<ParsedPlan> {
	const isPatch = normalizeToLF(text).trimStart().startsWith('*** Begin Patch');

	if (isPatch) {
		return buildPatchPlan(text, cwd);
	}

	return buildRowPlan(text, cwd);
}

async function buildRowPlan(text: string, cwd: string): Promise<ParsedPlan> {
	const scripts = parseRowScript(text);
	const changes: ParsedPlan['changes'] = [];

	for (const script of scripts) {
		const absolutePath = isAbsolute(script.path)
			? resolve(script.path)
			: resolve(cwd, script.path);
		const original = await readExisting(script.path, absolutePath);
		const updated = applyRowOperations(script.path, original, script.ops);

		if (original !== updated) {
			changes.push({
				path: script.path,
				absolutePath,
				kind: 'update',
				oldText: original,
				newText: updated,
			});
		}
	}

	if (changes.length === 0) throw new Error('行编辑脚本没有产生变更。');
	return { mode: 'rows', changes };
}

async function buildPatchPlan(text: string, cwd: string): Promise<ParsedPlan> {
	const operations = parsePatch(text);
	const changes: ParsedPlan['changes'] = [];

	for (const op of operations) {
		const absolutePath = isAbsolute(op.path) ? resolve(op.path) : resolve(cwd, op.path);

		if (op.kind === 'add') {
			const contents = normalizeToLF(op.contents);
			changes.push({
				path: op.path,
				absolutePath,
				kind: 'add',
				oldText: '',
				newText: contents.endsWith('\n') ? contents : `${contents}\n`,
			});
			continue;
		}

		if (op.kind === 'delete') {
			const original = await maybeReadExisting(absolutePath);
			if (original === null) throw new Error(`无法删除 ${op.path}：文件未找到。`);
			changes.push({
				path: op.path,
				absolutePath,
				kind: 'delete',
				oldText: original,
				newText: '',
			});
			continue;
		}

		// update
		const original = await readExisting(op.path, absolutePath);
		const updated = deriveUpdatedContent(op.path, original, op.chunks);
		changes.push({
			path: op.path,
			absolutePath,
			kind: 'update',
			oldText: original,
			newText: updated,
		});
	}

	if (changes.length === 0) throw new Error('补丁没有产生变更。');
	return { mode: 'patch', changes };
}

async function readExisting(path: string, absolutePath: string): Promise<string> {
	const { readFile } = await import('node:fs/promises');
	try {
		const raw = await readFile(absolutePath, 'utf-8');
		return normalizeToLF(raw);
	} catch (err: any) {
		throw new Error(`无法读取 ${path}：${err.code ?? err.message}`);
	}
}

async function maybeReadExisting(absolutePath: string): Promise<string | null> {
	const { readFile } = await import('node:fs/promises');
	try {
		return normalizeToLF(await readFile(absolutePath, 'utf-8'));
	} catch {
		return null;
	}
}

async function applyPlanToWorkspace(
	plan: ParsedPlan,
	workspace: import('../shared/workspace.js').Workspace,
	options?: { collectDiff?: boolean },
): Promise<RowScriptResult[]> {
	const results: RowScriptResult[] = [];
	const collectDiff = options?.collectDiff ?? false;

	for (const change of plan.changes) {
		if (change.kind === 'add') {
			await workspace.writeText(change.absolutePath, change.newText);
			results.push({ path: change.path, kind: 'add', message: `已添加 ${change.path}。` });
			continue;
		}
		if (change.kind === 'delete') {
			await workspace.deleteFile(change.absolutePath);
			results.push({ path: change.path, kind: 'delete', message: `已删除 ${change.path}。` });
			continue;
		}
		// update
		const current = await workspace.readText(change.absolutePath);
		if (current !== change.oldText) {
			throw new Error(`文件 ${change.path} 在预检后已变更。`);
		}
		await workspace.writeText(change.absolutePath, change.newText);
		const r: RowScriptResult = {
			path: change.path,
			kind: 'update',
			message: `已编辑 ${change.path}。`,
		};
		if (collectDiff) {
			const diffResult = generateDiffString(change.oldText, change.newText);
			r.diff = diffResult.diff;
			r.firstChangedLine = diffResult.firstChangedLine;
		}
		results.push(r);
	}

	return results;
}
