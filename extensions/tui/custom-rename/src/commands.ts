import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { openRenameSettings } from './ui.js';

/**
 * 注册 /auto-rename 命令：打开 TUI 配置面板（开关 + 选择模型等全部在面板内完成）。
 *
 * 不再提供 on/off/status 子命令——开关与模型配置统一由 TUI 面板承接
 * （见 src/ui.ts 的 RenameSettingsPanel）。
 */
export function registerAutoRenameCommand(pi: ExtensionAPI): void {
	pi.registerCommand('auto-rename', {
		description: '自动重命名设置（TUI 面板：开关 / 模型 / 标题长度 / thinking）',
		handler: async (_args: string, ctx) => {
			openRenameSettings(ctx);
		},
	});
}
