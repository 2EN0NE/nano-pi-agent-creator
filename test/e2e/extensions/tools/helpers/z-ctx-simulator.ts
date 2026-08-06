/**
 * Test helper: simulates context-mode MCP tools that register AFTER session_start.
 *
 * Context-mode tools (ctx_search, ctx_execute, ctx_fetch_and_index, etc.) are
 * provided by a separate MCP server and may connect AFTER pi extensions have
 * already loaded. This simulator mimics that late-registration pattern.
 *
 * Behavior:
 * 1. Registers ctx_search tool immediately (simulating early MCP connect)
 * 2. After a delay, registers ctx_execute (simulating late MCP connect)
 *
 * This allows testing tools.ts's ability to:
 * - Auto-enable newly discovered tools
 * - Persistently block tools the user explicitly disabled
 * - Handle re-registration of previously-disabled tools
 *
 * Usage with tools.ts in e2e tests:
 *   pi -a --no-session -e ./extensions/tools.ts -e ./test/extensions/tools/helpers/ctx-simulator.ts -p "hi"
 */

import type { ExtensionAPI, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('ctx-simulator');

export default function ctxSimulator(pi: ExtensionAPI) {
	// Tool 1: registered synchronously (may run before pi-logger is ready)
	pi.registerTool({
		name: 'ctx_search',
		label: 'CTX Search',
		description: 'Search indexed knowledge base (simulated context-mode tool)',
		parameters: {
			type: 'object',
			properties: {
				queries: {
					type: 'array',
					items: { type: 'string' },
					description: 'Search queries',
				},
			},
			required: ['queries'],
		},
		execute: async (
			_toolCallId: string,
			params: { queries?: string[] },
		): Promise<AgentToolResult<unknown>> => {
			log.info('ctx_search executed', { queries: params.queries });
			return {
				content: [
					{
						type: 'text' as const,
						text: `ctx_search results for: ${(params.queries ?? []).join(', ')}`,
					},
				],
				details: undefined,
			};
		},
	});

	// Log on session_start (pi-logger is definitely ready by then)
	pi.on('session_start', () => {
		log.info('ctx_search registered (simulating early connect)');
	});

	// Tool 2: registers after a delay (simulating late MCP connect)
	setTimeout(() => {
		pi.registerTool({
			name: 'ctx_execute',
			label: 'CTX Execute',
			description: 'Run code in sandbox (simulated late-registering context-mode tool)',
			parameters: {
				type: 'object',
				properties: {
					language: {
						type: 'string',
						description: 'Programming language',
					},
					code: {
						type: 'string',
						description: 'Code to execute',
					},
				},
				required: ['language', 'code'],
			},
			execute: async (
				_toolCallId: string,
				params: { language?: string; code?: string },
			): Promise<AgentToolResult<unknown>> => {
				log.info('ctx_execute executed', {
					language: params.language,
				});
				return {
					content: [
						{
							type: 'text' as const,
							text: `ctx_execute output in ${params.language ?? 'unknown'}`,
						},
					],
					details: undefined,
				};
			},
		});
		log.info('ctx_execute registered (simulating late connect)');
	}, 2000);
}
