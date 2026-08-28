/**
 * Edit 工具插件 — 支持经典精确匹配 + 行脚本模糊匹配
 *
 * 实验框架接入：方案 A（弱依赖），通过 globalThis.__labApi 桥接，
 * 在 session_start 中延迟注册，消除加载顺序竞险。
 * pi-lab 不可用时自然降级（回退 classic + 纯 exact match）。
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
			description: '要编辑的文件路径。省略时继承顶层的 path。',
		}),
	),
	oldText: Type.String({ description: '要查找并替换的精确文本（必须完全匹配）' }),
	newText: Type.String({ description: '替换旧文本的新文本' }),
});

const editSchema = Type.Object({
	path: Type.Optional(Type.String({ description: '要编辑的文件路径（相对或绝对）' })),
	oldText: Type.Optional(Type.String({ description: '要查找并替换的精确文本（必须完全匹配）' })),
	newText: Type.Optional(Type.String({ description: '替换旧文本的新文本' })),
	multi: Type.Optional(Type.Array(editItemSchema, { description: '按顺序应用的多个编辑。' })),
	patch: Type.Optional(
		Type.String({
			description:
				'Codex 风格的 apply_patch 载荷（*** Begin Patch ... *** End Patch）。与 path/oldText/newText/multi 互斥。',
		}),
	),
});

// ── 初始化 ──

const classic = createClassicEditor();
const rowScript = createRowScriptEditor();

/** 通过 pi-logger 日志上报实验信号（[pi-lab-signal] 行，由 pi-lab 日志 adapter 静默采集） */
function reportSignal(armId: string, ctxKey: string, metricId: string, value: number): void {
	log.info(`[pi-lab-signal] arm=${armId} metric=${metricId} value=${value} ctx=${ctxKey}`);
}

export default function editExtension(pi: ExtensionAPI) {
	// labSelect 在 session_start 中初始化（延迟注册消除加载顺序竞险）。
	// 信号上报走 pi-logger 日志（[pi-lab-signal] 行），由 pi-lab 日志 adapter 静默采集。
	let labSelect: ((context?: unknown) => Promise<string>) | undefined;

	// 在 session_start 中通过 globalThis 桥接注册实验（方案 A — 弱依赖）
	// pi-lab 不可用时自然降级
	pi.on('session_start', async (_event, _ctx) => {
		const mgr = (globalThis as any).__labApi?.getExperimentManager?.();
		if (!mgr) {
			log.warn('pi-lab not available — edit running without experiment');
			return;
		}
		try {
			const editExp = mgr.registerWeakExperiment({
				owner: 'edit',
				name: 'edit-strategy',
				// 分组键 = 模型（分析时按模型分层，控制模型效应混杂）
				contextKey: (ctx: ExtensionContext) =>
					`${ctx.model?.provider ?? 'unknown'}:${ctx.model?.id ?? 'unknown'}`,
				// 分流键 = 会话（跨模型分布的稳定单元）：同一会话稳定同一臂，
				// 不同会话即使同模型也会 hash 到不同臂，消除「臂=模型」混杂
				assignKey: (ctx: ExtensionContext) =>
					ctx.sessionManager?.getSessionId?.() ?? 'unknown-session',
				arms: [
					{ id: 'classic', label: '精确匹配' },
					{ id: 'row-script', label: '模糊行匹配' },
				],
				metrics: [
					{
						id: 'match_success',
						type: 'binary',
						direction: 'maximize',
						description: '精确匹配是否命中（1=命中，0=未命中）',
					},
					{
						id: 'latency_ms',
						type: 'continuous',
						direction: 'minimize',
						isGuardrail: true,
						description: '编辑耗时（毫秒，护栏：越低越好）',
					},
				],
			});
			// 异 owner 撞名被阻断时返回 undefined → 降级到无实验模式
			if (editExp) {
				labSelect = (context) => editExp.select(context);
				log.info('Edit experiment registered via pi-lab');
			} else {
				labSelect = undefined;
				log.warn(
					'Edit experiment registration blocked (name conflict) — running without experiment',
				);
			}
		} catch (err) {
			log.warn('Failed to register edit experiment', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// ── 注册工具 ──

	pi.registerTool({
		name: 'edit',
		label: 'edit',
		description:
			'通过替换精确文本来编辑文件。oldText 必须完全匹配（包括空白字符）。用于精准、外科手术式的编辑。支持 `multi` 参数跨一个或多个文件批量编辑，以及 `patch` 参数进行 Codex 风格的补丁。',
		promptSnippet:
			'通过替换精确文本来编辑文件。oldText 必须完全匹配（包括空白字符）。用于精准、外科手术式的编辑。',
		promptGuidelines: [
			'使用 edit 进行精确修改（oldText 必须完全匹配）',
			'使用 `multi` 参数在一次工具调用中应用多个编辑',
			'使用 `patch` 参数进行 Codex 风格的多文件 / 基于补丁块的编辑',
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
				throw new Error('`patch` 参数与 path/oldText/newText/multi 互斥。');
			}

			const startTime = Date.now();
			// 日志信号的 ctxKey（与注册时的 contextKey fn 保持一致）
			const ctxKey = `${ctx.model?.provider ?? 'unknown'}:${ctx.model?.id ?? 'unknown'}`;
			let armId = 'classic';
			// intent-to-treat：分配臂是否命中（fallback 补救成功不等于分配臂命中）
			let armHit = false;
			let result: { content: Array<{ type: 'text'; text: string }>; details: any };

			try {
				if (hasPatch) {
					armId = 'row-script';
					const r = await rowScript.execute(patch, ctx.cwd, signal);
					const summary = r.results
						.map((res, i) => `${i + 1}. ${res.message}`)
						.join('\n');
					result = {
						content: [
							{
								type: 'text',
								text: `已应用补丁，共 ${r.results.length} 个操作。\n${summary}`,
							},
						],
						details: { diff: r.combinedDiff, firstChangedLine: r.firstChangedLine },
					};
					armHit = true;
				} else {
					if (labSelect) {
						armId = await labSelect(ctx);
					}

					if (armId === 'classic' || !labSelect) {
						const edits = buildEditList(path, oldText, newText, multi);
						const r = await classic.execute(edits, ctx.cwd, signal);
						const hasFailures = r.results.some((res) => !res.success);

						if (hasFailures) {
							log.info('Classic had failures, trying row-script fallback', {
								failures: r.results.filter((r) => !r.success).length,
							});
							// intent-to-treat：fallback 补救执行（完成任务），但臂归属仍是
							// classic，match_success 记 classic 未命中——不污染 row-script 臂
							const fallbackOps = buildFallbackRows(r.results, edits);
							const fr = await rowScript.execute(fallbackOps, ctx.cwd, signal);
							const summary = fr.results
								.map((res, i) => `${i + 1}. ${res.message}`)
								.join('\n');
							result = {
								content: [
									{
										type: 'text',
										text: `已应用 ${fr.results.length} 处编辑（含回退）。\n${summary}`,
									},
								],
								details: {
									diff: fr.combinedDiff,
									firstChangedLine: fr.firstChangedLine,
								},
							};
							armHit = false;
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
											text: `已成功应用 ${r.results.length} 处编辑。\n${summary}`,
										},
									],
									details: {
										diff: r.combinedDiff,
										firstChangedLine: r.firstChangedLine,
									},
								};
							}
							armHit = true;
						}
					} else {
						const edits = buildEditList(path, oldText, newText, multi);
						const rowText = editsToRowScript(edits);
						const r = await rowScript.execute(rowText, ctx.cwd, signal);
						const summary = r.results
							.map((res, i) => `${i + 1}. ${res.message}`)
							.join('\n');
						result = {
							content: [
								{
									type: 'text',
									text: `已应用 ${r.results.length} 处编辑。\n${summary}`,
								},
							],
							details: { diff: r.combinedDiff, firstChangedLine: r.firstChangedLine },
						};
						armHit = true;
					}
				}
			} catch (err: any) {
				// 日志静默上报失败信号（pi-lab 日志 adapter 采集）
				reportSignal(armId, ctxKey, 'match_success', 0);
				reportSignal(armId, ctxKey, 'latency_ms', Date.now() - startTime);
				throw err;
			}

			// 日志静默上报结果信号（pi-lab 日志 adapter 采集）
			reportSignal(armId, ctxKey, 'match_success', armHit ? 1 : 0);
			reportSignal(armId, ctxKey, 'latency_ms', Date.now() - startTime);

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
				path: item.path ?? path ?? '' /* empty caught by !edits[i].path check below */,
				oldText: item.oldText,
				newText: item.newText,
			});
		}
	}
	if (edits.length === 0) {
		throw new Error('未提供编辑。请提供 path/oldText/newText 或一个 multi 数组。');
	}
	for (let i = 0; i < edits.length; i++) {
		if (!edits[i].path) throw new Error(`第 ${i + 1} 个编辑缺少 path。`);
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
