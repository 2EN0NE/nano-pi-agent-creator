/**
 * Test helper: simulates dynamic tool registration (e.g., ast_grep_search / MCP tools).
 *
 * Registers a mock search tool called "mock_search" at extension load time.
 * Used together with tools.ts to verify that the tool_call blocking handler
 * can detect and block dynamically registered tools that are not in the
 * user's /tools allowlist.
 *
 * Usage:
 *   test/extensions/tools/smoke.test.sh loads this via --extensions "tools,dynamic-registrar"
 */

import type { ExtensionAPI, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('dynamic-registrar');

export default function dynamicRegistrar(pi: ExtensionAPI) {
	log.info('mock_search tool registered');

	pi.registerTool({
		name: 'mock_search',
		label: 'Mock Search',
		description: 'Fake search tool simulating ast_grep_search for testing tool blocking',
		parameters: {
			type: 'object',
			properties: {
				pattern: {
					type: 'string',
					description: 'Search pattern',
				},
			},
			required: ['pattern'],
		},
		execute: async (
			_toolCallId: string,
			params: { pattern?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		): Promise<AgentToolResult> => {
			const pattern = params.pattern ?? '';
			log.info('mock_search executed', { pattern });
			return {
				content: [
					{
						type: 'text' as const,
						text: `mock_search result for "${pattern}"`,
					},
				],
				details: undefined,
			};
		},
	});
}
