/**
 * Edit 工具插件 — 支持经典精确匹配 + 行脚本模糊匹配
 *
 * 内部通过 globalThis.__labApi 获取 pi-lab 实验框架实例（鸭子类型解耦，
 * 类似 preset.ts → __toolsApi 模式）。
 *
 * - classic: 精确 oldText 匹配（来自原 multi-edit.ts）
 * - row-script: 模糊行匹配 + @REPLACE/@DEL/@APPEND 等行操作（来自原 unified-edit.ts）
 *
 * 不碰 pi.setActiveTools()，不与 tools.ts / preset.ts 冲突。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createLogger } from '@zenone/pi-logger';
import { createClassicEditor, type EditItem } from './impl/classic.js';
import { createRowScriptEditor } from './impl/row-script.js';

const log = createLogger('edit');

// ── Schema ──

const editItemSchema = Type.Object({
	path: Type.Optional(
		Type.String({
			description: 'Path to the file to edit. Inherits from top-level path if omitted.',
		}),
	),
	oldText: Type.String({ description: 'Exact text to find and replace (must match exactly)' }),
	newText: Type.String({ description: 'New text to replace the old text with' }),
});

const editSchema = Type.Object({
	path: Type.Optional(
		Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
	),
	oldText: Type.Optional(
		Type.String({ description: 'Exact text to find and replace (must match exactly)' }),
	),
	newText: Type.Optional(Type.String({ description: 'New text to replace the old text with' })),
	multi: Type.Optional(
		Type.Array(editItemSchema, { description: 'Multiple edits to apply in sequence.' }),
	),
	patch: Type.Optional(
		Type.String({
			description:
				'Codex-style apply_patch payload (*** Begin Patch ... *** End Patch). Mutually exclusive with path/oldText/newText/multi.',
		}),
	),
});

// ── 初始化 ──

const classic = createClassicEditor();
const rowScript = createRowScriptEditor();

export default function editExtension(pi: ExtensionAPI) {
	// 通过 globalThis 获取 pi-lab 单例（鸭子类型，类似 preset.ts → __toolsApi）
	const piLabApi = (globalThis as any).__labApi?.getExperimentManager?.();
	let labSelect: (() => Promise<string>) | undefined;
	let labRecord: ((armId: string, outcome: any) => Promise<void>) | undefined;

	if (piLabApi) {
		const editExp = piLabApi.registerExperiment({
			name: 'edit-strategy',
			contextKey: (ctx: ExtensionContext) =>
				`${ctx.model?.provider ?? 'unknown'}:${ctx.model?.id ?? 'unknown'}`,
			arms: [
				{ id: 'classic', label: 'Exact text matching' },
				{ id: 'row-script', label: 'Fuzzy line matching' },
			],
			strategy: 'thompson-sampling',
		});
		labSelect = () => editExp.select();
		labRecord = (armId, outcome) => editExp.record(armId, outcome);
		log.info('Edit experiment registered via pi-lab');
	} else {
		log.warn('pi-lab not available — edit running without experiment');
	}

	// ── 注册工具 ──

	pi.registerTool({
		name: 'edit',
		label: 'edit',
		description:
			'Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Supports a `multi` parameter for batch edits across one or more files, and a `patch` parameter for Codex-style patches.',
		promptSnippet:
			'Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.',
		promptGuidelines: [
			'Use edit for precise changes (old text must match exactly)',
			'Use the `multi` parameter to apply multiple edits in a single tool call',
			'Use the `patch` parameter for Codex-style multi-file / hunk-based edits',
		],
		parameters: editSchema,

		async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
			const { path, oldText, newText, multi, patch } = params;
			const hasPatch = patch !== undefined;
			const hasClassic =
				path !== undefined ||
				oldText !== undefined ||
				newText !== undefined ||
				multi !== undefined;

			if (hasPatch && hasClassic) {
				throw new Error(
					'The `patch` parameter is mutually exclusive with path/oldText/newText/multi.',
				);
			}

			const startTime = Date.now();
			let armId = 'classic';
			let firstAttempt = true;
			let success = false;
			let result: { content: Array<{ type: 'text'; text: string }>; details: any };

			try {
				if (hasPatch) {
					armId = 'row-script';
					const r = await rowScript.execute(patch, ctx.cwd);
					const summary = r.results
						.map((res, i) => `${i + 1}. ${res.message}`)
						.join('\n');
					result = {
						content: [
							{
								type: 'text',
								text: `Applied patch with ${r.results.length} operation(s).\n${summary}`,
							},
						],
						details: { diff: r.combinedDiff, firstChangedLine: r.firstChangedLine },
					};
					success = true;
				} else {
					if (labSelect) {
						armId = await labSelect();
					}

					if (armId === 'classic' || !labSelect) {
						const edits = buildEditList(path, oldText, newText, multi);
						const r = await classic.execute(edits, ctx.cwd, signal);
						const hasFailures = r.results.some((res) => !res.success);

						if (hasFailures) {
							log.info('Classic had failures, trying row-script fallback', {
								failures: r.results.filter((r) => !r.success).length,
							});
							firstAttempt = false;
							armId = 'row-script';
							const fallbackOps = buildFallbackRows(r.results, edits);
							const fr = await rowScript.execute(fallbackOps, ctx.cwd);
							const summary = fr.results
								.map((res, i) => `${i + 1}. ${res.message}`)
								.join('\n');
							result = {
								content: [
									{
										type: 'text',
										text: `Applied ${fr.results.length} edit(s) (with fallback).\n${summary}`,
									},
								],
								details: {
									diff: fr.combinedDiff,
									firstChangedLine: fr.firstChangedLine,
								},
							};
							success = true;
						} else {
							if (r.results.length === 1) {
								result = {
									content: [{ type: 'text', text: r.results[0].message }],
									details: {
										diff: r.combinedDiff,
										firstChangedLine: r.firstChangedLine,
									},
								};
							} else {
								const summary = r.results
									.map((res, i) => `${i + 1}. ${res.message}`)
									.join('\n');
								result = {
									content: [
										{
											type: 'text',
											text: `Applied ${r.results.length} edit(s) successfully.\n${summary}`,
										},
									],
									details: {
										diff: r.combinedDiff,
										firstChangedLine: r.firstChangedLine,
									},
								};
							}
							success = true;
						}
					} else {
						firstAttempt = false;
						const edits = buildEditList(path, oldText, newText, multi);
						const rowText = editsToRowScript(edits);
						const r = await rowScript.execute(rowText, ctx.cwd);
						const summary = r.results
							.map((res, i) => `${i + 1}. ${res.message}`)
							.join('\n');
						result = {
							content: [
								{
									type: 'text',
									text: `Applied ${r.results.length} edit(s).\n${summary}`,
								},
							],
							details: { diff: r.combinedDiff, firstChangedLine: r.firstChangedLine },
						};
						success = true;
					}
				}
			} catch (err: any) {
				if (labRecord) {
					await labRecord(armId, {
						success: false,
						firstAttempt: true,
						latencyMs: Date.now() - startTime,
						errorType: 'crash',
						errorMessage: err.message ?? String(err),
					});
				}
				throw err;
			}

			if (labRecord) {
				await labRecord(armId, {
					success,
					firstAttempt,
					latencyMs: Date.now() - startTime,
				});
			}

			return result;
		},
	});
}

// ── 辅助函数 ──

function buildEditList(
	path?: string,
	oldText?: string,
	newText?: string,
	multi?: Array<{ path?: string; oldText: string; newText: string }>,
): EditItem[] {
	const edits: EditItem[] = [];
	if (path !== undefined && oldText !== undefined && newText !== undefined) {
		edits.push({ path, oldText, newText });
	}
	if (multi) {
		for (const item of multi) {
			edits.push({
				path: item.path ?? path ?? '',
				oldText: item.oldText,
				newText: item.newText,
			});
		}
	}
	if (edits.length === 0) {
		throw new Error('No edits provided. Supply path/oldText/newText or a multi array.');
	}
	for (let i = 0; i < edits.length; i++) {
		if (!edits[i].path) throw new Error(`Edit ${i + 1} is missing a path.`);
	}
	return edits;
}

function buildFallbackRows(
	results: Array<{ path: string; success: boolean }>,
	edits: EditItem[],
): string {
	const lines: string[] = [];
	for (let i = 0; i < results.length; i++) {
		if (!results[i].success) {
			const edit = edits[i];
			if (!edit) continue;
			if (i === 0 || edits[i].path !== edits[i - 1]?.path) {
				lines.push(`[${edit.path}]`);
				lines.push('@REPLACE');
			}
			lines.push(...edit.oldText.split('\n').map((l) => `-${l}`));
			lines.push(...edit.newText.split('\n').map((l) => `+${l}`));
		}
	}
	return lines.join('\n');
}

function editsToRowScript(edits: EditItem[]): string {
	const lines: string[] = [];
	let lastPath = '';
	for (const edit of edits) {
		if (edit.path !== lastPath) {
			if (lastPath) lines.push('');
			lines.push(`[${edit.path}]`);
			lines.push('@REPLACE');
			lastPath = edit.path;
		}
		lines.push(...edit.oldText.split('\n').map((l) => `-${l}`));
		lines.push(...edit.newText.split('\n').map((l) => `+${l}`));
	}
	return lines.join('\n');
}
