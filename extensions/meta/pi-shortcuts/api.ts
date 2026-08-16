/**
 * @zenone/pi-shortcuts 公共 API
 *
 * 消费方接入方式（方案 A — 弱依赖，通过 globalThis.__shortcutsApi 桥接）：
 *
 *   const hub = (globalThis as any).__shortcutsApi;
 *   if (hub?.register) {
 *       hub.register({ name: 'files', subKey: 'f', description: '文件浏览器', handler });
 *   } else {
 *       pi.registerShortcut('ctrl+shift+o', { description, handler }); // 降级键
 *   }
 *
 * 本模块仅供强依赖（方案 B）消费方 import 类型。
 */

export type { ShortcutEntry, RegisterResult, MatchResult } from './core/registry.js';
export { ShortcutRegistry } from './core/registry.js';
export type { DeactivateReason, ShortcutDispatcherDeps } from './core/dispatcher.js';
export { ShortcutDispatcher } from './core/dispatcher.js';
export type { ShortcutsConfig } from './config.js';
export { createShortcutsConfig, DEFAULT_CONFIG } from './config.js';
