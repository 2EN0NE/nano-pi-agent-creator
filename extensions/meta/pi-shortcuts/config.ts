/**
 * pi-shortcuts 配置 — 双层合并（用户级 + 项目级覆盖默认）。
 *
 * 使用 @zenone/pi-config 标准双层路径：
 *   项目级 <cwd>/.pi/extensions-data/pi-shortcuts/config.json 覆盖
 *   用户级 ~/.pi/agent/extensions-data/pi-shortcuts/config.json 覆盖
 *   默认值（prefixKey=alt+., paletteOnPrefix=true）。
 */

import { createConfigStore, type ConfigStore } from '@zenone/pi-config';
import type { RemapRule } from './core/registry.js';

export interface ShortcutsConfig {
	/** 前缀键（leader key），如 'ctrl+shift+space' */
	prefixKey: string;
	/** 按下前缀键后是否弹出快捷面板（false = 静默等待子键） */
	paletteOnPrefix: boolean;
	/** 用户自定义子键重映射（name + from 默认子键 → to 新子键） */
	remap: RemapRule[];
}

export const DEFAULT_CONFIG: ShortcutsConfig = {
	prefixKey: 'alt+.',
	paletteOnPrefix: true,
	remap: [],
};

export function createShortcutsConfig(options?: {
	cwd?: string;
	homeDir?: string;
}): ConfigStore<ShortcutsConfig> {
	return createConfigStore<ShortcutsConfig>({
		pluginName: 'pi-shortcuts',
		defaults: DEFAULT_CONFIG,
		cwd: options?.cwd,
		homeDir: options?.homeDir,
	});
}
