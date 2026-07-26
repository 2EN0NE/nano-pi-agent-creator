/**
 * Classic Edit — 精确文本匹配编辑风格的实现
 *
 * 从 multi-edit.ts 提取。
 * 支持 path/oldText/newText 精确替换、multi 批量、patch 补丁。
 */

import { isAbsolute, resolve } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type { Workspace } from '../shared/workspace.js';
import { createRealWorkspace, createVirtualWorkspace, normalizeToLF } from '../shared/workspace.js';
import { generateDiffString } from '../shared/diff.js';
import { applyEditsToNormalizedContent } from '../shared/matcher.js';

const log = createLogger('edit:classic');

// ============================================================================
// Types
// ============================================================================

export interface EditItem {
	path: string;
	oldText: string;
	newText: string;
}

export interface ClassicResult {
	path: string;
	success: boolean;
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

// ============================================================================
// 实现
// ============================================================================

export function createClassicEditor() {
	/**
	 * 执行 classic 编辑。
	 */
	async function execute(
		edits: EditItem[],
		cwd: string,
		signal?: AbortSignal,
	): Promise<{ results: ClassicResult[]; combinedDiff: string; firstChangedLine?: number }> {
		if (edits.length === 0) {
			throw new Error('No edits provided.');
		}

		const workspace = createVirtualWorkspace(cwd);

		// Preflight
		try {
			await applyClassicEdits(edits, workspace, cwd, signal, { collectDiff: false });
		} catch (err: any) {
			throw new Error(`Preflight failed.\n${err.message ?? String(err)}`);
		}

		// Real execution
		const results = await applyClassicEdits(edits, createRealWorkspace(), cwd, signal, {
			collectDiff: true,
		});

		const combinedDiff = results
			.filter((r) => r.diff)
			.map((r) => r.diff)
			.join('\n');
		const firstChanged = results.find(
			(r) => r.firstChangedLine !== undefined,
		)?.firstChangedLine;

		return { results, combinedDiff, firstChangedLine: firstChanged };
	}

	return { execute };
}

async function applyClassicEdits(
	edits: EditItem[],
	workspace: Workspace,
	cwd: string,
	signal?: AbortSignal,
	options?: { collectDiff?: boolean },
): Promise<ClassicResult[]> {
	const collectDiff = options?.collectDiff ?? false;

	// Group by file
	const fileGroups = new Map<string, { index: number; edit: EditItem }[]>();
	const editOrder: string[] = [];

	for (let i = 0; i < edits.length; i++) {
		const abs = isAbsolute(edits[i].path)
			? resolve(edits[i].path)
			: resolve(cwd, edits[i].path);
		if (!fileGroups.has(abs)) {
			fileGroups.set(abs, []);
			editOrder.push(abs);
		}
		fileGroups.get(abs)!.push({ index: i, edit: edits[i] });
	}

	const results: ClassicResult[] = new Array(edits.length);

	// Verify write access
	for (const absPath of editOrder) {
		await workspace.checkWriteAccess(absPath);
	}

	for (const absPath of editOrder) {
		const group = fileGroups.get(absPath)!;

		if (signal?.aborted) throw new Error('Operation aborted');

		const originalContent = await workspace.readText(absPath);

		// Sort by position in content
		if (group.length > 1) {
			const positions = new Map<{ index: number; edit: EditItem }, number>();
			for (const entry of group) {
				const pos = originalContent.indexOf(entry.edit.oldText);
				positions.set(entry, pos === -1 ? Number.MAX_SAFE_INTEGER : pos);
			}
			group.sort((a, b) => positions.get(a)! - positions.get(b)!);
		}

		let content = originalContent;
		let searchOffset = 0;
		const appliedPairs = new Set<string>();

		for (const { index, edit } of group) {
			if (signal?.aborted) throw new Error('Operation aborted');

			const pos = content.indexOf(edit.oldText, searchOffset);

			if (pos === -1) {
				const pairKey = `${edit.oldText}\0${edit.newText}`;
				if (appliedPairs.has(pairKey)) {
					results[index] = {
						path: edit.path,
						success: true,
						message: `Skipped redundant edit in ${edit.path}.`,
					};
					continue;
				}
				// Not found — will be caught by caller as fallback opportunity
				results[index] = {
					path: edit.path,
					success: false,
					message: `Could not find the exact text in ${edit.path}.`,
				};
				continue;
			}

			content =
				content.slice(0, pos) + edit.newText + content.slice(pos + edit.oldText.length);
			searchOffset = pos + edit.newText.length;
			appliedPairs.add(`${edit.oldText}\0${edit.newText}`);

			results[index] = {
				path: edit.path,
				success: true,
				message: `Edited ${edit.path}.`,
			};
		}

		await workspace.writeText(absPath, content);

		if (collectDiff) {
			const diffResult = generateDiffString(originalContent, content);
			const firstIdx = group[0].index;
			results[firstIdx].diff = diffResult.diff;
			results[firstIdx].firstChangedLine = diffResult.firstChangedLine;
		}
	}

	return results;
}
