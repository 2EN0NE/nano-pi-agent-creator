/**
 * Test helper: 在扩展加载期同步注册一个「动态」工具（模拟 MCP / org 等运行时注册方）。
 *
 * 用于验证 preset overlay 的封闭集语义（ADR-0049 决策 3 / ADR-0050 决策 2）：
 * preset 激活且声明 tools 白名单时，运行时注册的工具应被遮罩为不可用。
 *
 * 与工具侧 `test/e2e/extensions/tools/helpers/dynamic-registrar.ts` 同源（注册 mock_search），
 * 但放在 `test/e2e/helpers/` 以便 `tui_copy_extensions` 按名字拷贝到 TUI 沙箱。
 */
import type { ExtensionAPI, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('dynamic-tool');

export default function dynamicTool(pi: ExtensionAPI) {
	log.info('mock_search tool registered');
	pi.registerTool({
		name: 'mock_search',
		label: 'Mock Search',
		description: 'Fake search tool simulating a dynamic MCP tool',
		parameters: {
			type: 'object',
			properties: { pattern: { type: 'string', description: 'Search pattern' } },
			required: ['pattern'],
		},
		execute: async (
			_toolCallId: string,
			params: { pattern?: string },
		): Promise<AgentToolResult<unknown>> => {
			const pattern = params.pattern ?? '';
			log.info('mock_search executed', { pattern });
			return {
				content: [{ type: 'text' as const, text: `mock_search result for "${pattern}"` }],
				details: undefined,
			};
		},
	});
}
