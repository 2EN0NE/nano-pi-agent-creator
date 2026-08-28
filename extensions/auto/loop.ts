/**
 * Loop 扩展
 *
 * 提供 /loop 命令，启动一个带有跳出条件的持续跟进循环。
 * 该循环在每个 turn 结束时持续发送提示词，直到 agent 调用
 * signal_loop_success 工具。
 */

import { Type } from 'typebox';
import { complete, type Api, type Model, type UserMessage } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { compact } from '@earendil-works/pi-coding-agent';
import { Container, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { TitleBar } from '../../src/tui/helpers.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('loop');

log.debug('Extension loaded');

type LoopMode = 'tests' | 'custom' | 'self';

type LoopStateData = {
	active: boolean;
	mode?: LoopMode;
	condition?: string;
	prompt?: string;
	summary?: string;
	loopCount?: number;
};

const LOOP_PRESETS = [
	{ value: 'tests', label: '直到测试通过', description: '' },
	{ value: 'custom', label: '直到满足自定义条件', description: '' },
	{ value: 'self', label: '自主驱动（由 agent 决定）', description: '' },
] as const;

const LOOP_STATE_ENTRY = 'loop-state';

const HAIKU_MODEL_ID = 'claude-haiku-4-5';

const SUMMARY_SYSTEM_PROMPT = `你为状态小部件总结循环的跳出条件。
返回一个简短的短语（最多 6 个字），说明循环应该在何时停止。
仅使用纯文本，不要引号、标点或前缀。

形式可以是"条件满足时跳出"、"当……时停止"、"直到……时结束"等类似表达。
选择最适合循环条件的表达方式。
`;

function buildPrompt(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case 'tests':
			return (
				'运行所有测试。如果全部通过，则调用 signal_loop_success 工具。' +
				'否则继续直到测试全部通过。'
			);
		case 'custom': {
			const customCondition = condition?.trim() || '自定义条件已满足';
			return (
				`继续直到以下条件满足：${customCondition}。` +
				'条件满足时，调用 signal_loop_success 工具。'
			);
		}
		case 'self':
			return '继续直到你完成工作。完成后，调用 signal_loop_success 工具。';
	}
}

function summarizeCondition(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case 'tests':
			return 'tests pass';
		case 'custom': {
			const summary = condition?.trim() || 'custom condition';
			return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
		}
		case 'self':
			return 'done';
	}
}

function getConditionText(mode: LoopMode, condition?: string): string {
	switch (mode) {
		case 'tests':
			return 'tests pass';
		case 'custom':
			return condition?.trim() || 'custom condition';
		case 'self':
			return 'you are done';
	}
}

async function selectSummaryModel(
	ctx: ExtensionContext,
): Promise<{ model: Model<Api>; apiKey?: string; headers?: Record<string, string> } | null> {
	if (!ctx.model) return null;

	if (ctx.model.provider === 'anthropic') {
		const haikuModel = ctx.modelRegistry.find('anthropic', HAIKU_MODEL_ID);
		if (haikuModel) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(haikuModel);
			if (auth.ok) {
				return {
					model: haikuModel,
					apiKey: auth.apiKey,
					headers: filterHeaders(auth.headers),
				};
			}
		}
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) return null;
	return { model: ctx.model, apiKey: auth.apiKey, headers: filterHeaders(auth.headers) };
}

/**
 * getApiKeyAndHeaders() returns ProviderHeaders whose values are
 * `string | null` (null marks header deletion). Complete/compact accept plain
 * `Record<string, string>`, so strip nulls before forwarding (pi >= 0.84).
 */
function filterHeaders(
	headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value != null) out[key] = value;
	}
	return out;
}

async function summarizeBreakoutCondition(
	ctx: ExtensionContext,
	mode: LoopMode,
	condition?: string,
): Promise<string> {
	const fallback = summarizeCondition(mode, condition);
	const selection = await selectSummaryModel(ctx);
	if (!selection) return fallback;

	const conditionText = getConditionText(mode, condition);
	const userMessage: UserMessage = {
		role: 'user',
		content: [{ type: 'text', text: conditionText }],
		timestamp: Date.now(),
	};

	const response = await complete(
		selection.model,
		{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: selection.apiKey, headers: selection.headers },
	);

	if (response.stopReason === 'aborted' || response.stopReason === 'error') {
		return fallback;
	}

	const summary = response.content
		.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
		.map((c) => c.text)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();

	if (!summary) return fallback;
	return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
}

function getCompactionInstructions(mode: LoopMode, condition?: string): string {
	const conditionText = getConditionText(mode, condition);
	return `循环处于激活状态。跳出条件：${conditionText}。请在摘要中保留此循环状态和跳出条件。`;
}

function updateStatus(ctx: ExtensionContext, state: LoopStateData): void {
	if (!ctx.hasUI) return;
	if (!state.active || !state.mode) {
		ctx.ui.setWidget('loop', undefined);
		return;
	}
	const loopCount = state.loopCount ?? 0;
	const turnText = `（第 ${loopCount} 轮）`;
	const summary = state.summary?.trim();
	const text = summary ? `循环运行中：${summary} ${turnText}` : `循环运行中 ${turnText}`;
	ctx.ui.setWidget('loop', [ctx.ui.theme.fg('accent', text)]);
}

async function loadState(ctx: ExtensionContext): Promise<LoopStateData> {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type: string; customType?: string; data?: LoopStateData };
		if (entry.type === 'custom' && entry.customType === LOOP_STATE_ENTRY && entry.data) {
			return entry.data;
		}
	}
	return { active: false };
}

export default function loopExtension(pi: ExtensionAPI): void {
	let loopState: LoopStateData = { active: false };

	function persistState(state: LoopStateData): void {
		pi.appendEntry(LOOP_STATE_ENTRY, state);
	}

	function setLoopState(state: LoopStateData, ctx: ExtensionContext): void {
		loopState = state;
		persistState(state);
		updateStatus(ctx, state);
	}

	function clearLoopState(ctx: ExtensionContext): void {
		const cleared: LoopStateData = { active: false };
		loopState = cleared;
		persistState(cleared);
		updateStatus(ctx, cleared);
	}

	function breakLoop(ctx: ExtensionContext): void {
		clearLoopState(ctx);
		ctx.ui.notify('循环已结束', 'info');
	}

	function wasLastAssistantAborted(
		messages: Array<{ role?: string; stopReason?: string }>,
	): boolean {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role === 'assistant') {
				return message.stopReason === 'aborted';
			}
		}
		return false;
	}

	function triggerLoopPrompt(ctx: ExtensionContext): void {
		if (!loopState.active || !loopState.mode || !loopState.prompt) return;
		if (ctx.hasPendingMessages()) return;

		const loopCount = (loopState.loopCount ?? 0) + 1;
		loopState = { ...loopState, loopCount };
		persistState(loopState);
		updateStatus(ctx, loopState);

		pi.sendMessage(
			{
				customType: 'loop',
				content: loopState.prompt!,
				display: true,
			},
			{
				deliverAs: 'followUp',
				triggerTurn: true,
			},
		);
	}

	async function showLoopSelector(ctx: ExtensionContext): Promise<LoopStateData | null> {
		const items: SelectItem[] = LOOP_PRESETS.map((preset) => ({
			value: preset.value,
			label: preset.label,
			description: preset.description,
		}));

		const selection = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(
				new TitleBar('选择循环预设', (str) => theme.fg('accent', theme.bold(str))),
			);

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg('accent', text),
				selectedText: (text) => theme.fg('accent', text),
				description: (text) => theme.fg('muted', text),
				scrollInfo: (text) => theme.fg('dim', text),
				noMatch: (text) => theme.fg('warning', text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg('dim', '按 Enter 确认或 Esc 取消')));
			container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selection) return null;

		switch (selection) {
			case 'tests':
				return { active: true, mode: 'tests', prompt: buildPrompt('tests') };
			case 'self':
				return { active: true, mode: 'self', prompt: buildPrompt('self') };
			case 'custom': {
				const condition = await ctx.ui.editor('Enter loop breakout condition:', '');
				if (!condition?.trim()) return null;
				return {
					active: true,
					mode: 'custom',
					condition: condition.trim(),
					prompt: buildPrompt('custom', condition.trim()),
				};
			}
			default:
				return null;
		}
	}

	function parseArgs(args: string | undefined): LoopStateData | null {
		if (!args?.trim()) return null;
		const parts = args.trim().split(/\s+/);
		const mode = parts[0]?.toLowerCase();

		switch (mode) {
			case 'tests':
				return { active: true, mode: 'tests', prompt: buildPrompt('tests') };
			case 'self':
				return { active: true, mode: 'self', prompt: buildPrompt('self') };
			case 'custom': {
				const condition = parts.slice(1).join(' ').trim();
				if (!condition) return null;
				return {
					active: true,
					mode: 'custom',
					condition,
					prompt: buildPrompt('custom', condition),
				};
			}
			default:
				return null;
		}
	}

	pi.registerTool({
		name: 'signal_loop_success',
		label: '标记循环成功',
		description:
			'当跳出条件满足时停止活动循环。仅当用户、工具或系统提示明确指示时，才调用此工具。',
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!loopState.active) {
				return {
					content: [{ type: 'text', text: '没有正在运行的循环。' }],
					details: { active: false },
				};
			}

			clearLoopState(ctx);

			return {
				content: [{ type: 'text', text: '循环已结束。' }],
				details: { active: false },
			};
		},
	});

	log.debug('registerCommand: loop');
	pi.registerCommand('loop', {
		description: '启动一个后续循环，直到满足跳出条件',
		handler: async (args, ctx) => {
			let nextState = parseArgs(args);
			if (!nextState) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						'用法：/loop tests | /loop custom <条件> | /loop self',
						'warning',
					);
					return;
				}
				nextState = await showLoopSelector(ctx);
			}

			if (!nextState) {
				ctx.ui.notify('循环已取消', 'info');
				return;
			}

			if (loopState.active) {
				const confirm = ctx.hasUI
					? await ctx.ui.confirm('替换活动循环？', '已有一个活动循环。是否替换？')
					: true;
				if (!confirm) {
					ctx.ui.notify('循环未变更', 'info');
					return;
				}
			}

			const summarizedState: LoopStateData = {
				...nextState,
				summary: undefined,
				loopCount: 0,
			};
			setLoopState(summarizedState, ctx);
			ctx.ui.notify('循环运行中', 'info');
			triggerLoopPrompt(ctx);

			const mode = nextState.mode!;
			const condition = nextState.condition;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (
					!loopState.active ||
					loopState.mode !== mode ||
					loopState.condition !== condition
				)
					return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		},
	});

	pi.on('agent_end', async (event, ctx) => {
		log.debug('event: agent_end');
		if (!loopState.active) return;

		if (ctx.hasUI && wasLastAssistantAborted(event.messages)) {
			const confirm = await ctx.ui.confirm(
				'Break active loop?',
				'Operation aborted. Break out of the loop?',
			);
			if (confirm) {
				breakLoop(ctx);
				return;
			}
		}

		triggerLoopPrompt(ctx);
	});

	pi.on('session_before_compact', async (event, ctx) => {
		log.debug('event: session_before_compact');
		log.debug('event: session_before_compact');
		if (!loopState.active || !loopState.mode || !ctx.model) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) return;

		const instructionParts = [
			event.customInstructions,
			getCompactionInstructions(loopState.mode, loopState.condition),
		]
			.filter(Boolean)
			.join('\n\n');

		try {
			const compaction = await compact(
				event.preparation,
				ctx.model,
				auth.apiKey ?? '',
				filterHeaders(auth.headers),
				instructionParts,
				event.signal,
			);
			return { compaction };
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Loop compaction failed: ${message}`, 'warning');
			}
			return;
		}
	});

	async function restoreLoopState(ctx: ExtensionContext): Promise<void> {
		loopState = await loadState(ctx);
		updateStatus(ctx, loopState);

		if (loopState.active && loopState.mode && !loopState.summary) {
			const mode = loopState.mode;
			const condition = loopState.condition;
			void (async () => {
				const summary = await summarizeBreakoutCondition(ctx, mode, condition);
				if (
					!loopState.active ||
					loopState.mode !== mode ||
					loopState.condition !== condition
				)
					return;
				loopState = { ...loopState, summary };
				persistState(loopState);
				updateStatus(ctx, loopState);
			})();
		}
	}

	pi.on('session_start', async (_event, ctx) => {
		log.debug('event: session_start');
		log.debug('event: session_start');
		await restoreLoopState(ctx);
	});
}
