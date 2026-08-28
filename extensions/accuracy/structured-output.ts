/**
 * Structured Output Tool
 *
 * Demonstrates `terminate: true` so the agent can end on a tool call
 * without paying for an extra follow-up LLM turn.
 */

import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('structured-output');

log.debug('Extension loaded');

interface StructuredOutputDetails {
	headline: string;
	summary: string;
	actionItems: string[];
}

const structuredOutputTool = defineTool({
	name: 'structured_output',
	label: '结构化输出',
	description:
		'返回最终的结构化答案。当用户要求结构化输出、类 JSON 输出或机器可读的摘要时，将其作为你的最后一个动作使用。',
	promptSnippet: '输出一个最终结构化答案作为终止工具结果',
	promptGuidelines: [
		'当用户要求结构化输出、类 JSON 输出或机器可读摘要时，将 structured_output 作为你的最后一个动作。',
		'调用 structured_output 后，不要在同一轮中再输出另一个 assistant 响应。',
	],
	parameters: Type.Object({
		headline: Type.String({ description: '结果的简短标题' }),
		summary: Type.String({ description: '一段式摘要' }),
		actionItems: Type.Array(Type.String(), {
			description: '具体下一步或关键要点',
		}),
	}),

	async execute(_toolCallId, params) {
		return {
			content: [{ type: 'text', text: `已保存结构化输出：${params.headline}` }],
			details: {
				headline: params.headline,
				summary: params.summary,
				actionItems: params.actionItems,
			} satisfies StructuredOutputDetails,
			terminate: true,
		};
	},

	renderResult(result, _options, theme) {
		const details = result.details as StructuredOutputDetails | undefined;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === 'text' ? text.text : '', 0, 0);
		}

		const lines = [
			theme.fg('toolTitle', theme.bold(details.headline)),
			theme.fg('text', details.summary),
			'',
			...details.actionItems.map((item, index) => theme.fg('muted', `${index + 1}. ${item}`)),
		];
		return new Text(lines.join('\n'), 0, 0);
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(structuredOutputTool);
}
