/**
 * @zenone/pi-shortcuts — 快捷键中心（leader-key 前缀模式）
 *
 * 职责：持有前缀键注册、子键注册表、子键分发（静默模式），冲突裁决。
 * 消费方通过 globalThis.__shortcutsApi 弱依赖注册，中心缺失时回退自身降级键。
 *
 * 默认前缀键 alt+.（备用 ctrl+shift+space）。前缀键依赖终端的 Option/Alt 键
 * 产生 ESC 前缀序列（Meta 协议）；mac 终端需把 Option 设为 Esc+ 模式，
 * 详见 README「终端兼容性（mac 终端 Option 键）」。
 *
 * 设计见 docs/adr/0015-shortcut-hub-architecture.md
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseKey } from '@earendil-works/pi-tui';
import { createLogger } from '@zenone/pi-logger';
import { createShortcutsConfig } from './config.js';
import { ShortcutRegistry, type ShortcutEntry } from './core/registry.js';
import { ShortcutDispatcher } from './core/dispatcher.js';
import { showPalette } from './ui/palette.js';
import { showEditor } from './ui/editor.js';

const log = createLogger('pi-shortcuts');

const DEFAULT_TIMEOUT_MS = 2000;

export default function piShortcuts(pi: ExtensionAPI): void {
	const configStore = createShortcutsConfig();
	let config = configStore.get();
	const registry = new ShortcutRegistry(config.remap);

	// ── 挂载桥接（消费方通过 globalThis.__shortcutsApi 弱依赖注册） ──
	(globalThis as any).__shortcutsApi = {
		register: (entry: ShortcutEntry) => {
			const result = registry.register(entry);
			if (result.ok) {
				log.info(`Shortcut registered: ${entry.name} ${entry.keys.join(' ')}`);
			} else {
				log.warn(`Shortcut conflict: ${entry.name} ${entry.keys.join(' ')}`, {
					conflict: result.conflict,
				});
			}
			return result;
		},
		getRegistry: () => registry,
	};

	// ── 子键分发状态机 ──
	const dispatcher = new ShortcutDispatcher({
		registry,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		onDeactivate: (reason) => {
			log.debug('dispatcher deactivate', { reason });
		},
	});

	// ── 前缀键 handler（palette 面板 / 静默两模式）──
	const prefixHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		if (config.paletteOnPrefix) {
			await showPalette(ctx, registry, config.prefixKey);
			return;
		}

		// 静默模式：dispatcher 累积子键
		dispatcher.activate();
		const hint = buildHint(registry);
		if (hint) ctx.ui.notify(`扩展快捷键 ${hint}`, 'info');

		const unsub = ctx.ui.onTerminalInput((data) => {
			const key = (parseKey(data) ?? '').toLowerCase();
			if (!key) return undefined; // 无法解析的键不消费
			dispatcher.handleKey(key);
			if (!dispatcher.isActive()) unsub();
			return { consume: true };
		});
	};

	// ── 前缀键注册（config.prefixKey + ctrl+shift+space 备用，Set 去重）──
	const prefixKeys = new Set<string>();
	if (config.prefixKey) prefixKeys.add(config.prefixKey);
	prefixKeys.add('ctrl+shift+space'); // 备用前缀键（ADR 0015）
	for (const key of prefixKeys) {
		pi.registerShortcut(key as Parameters<typeof pi.registerShortcut>[0], {
			description: '扩展快捷键',
			handler: prefixHandler,
		});
	}

	// ── /shortcuts 命令（可编辑面板；print 模式降级为列出）──
	pi.registerCommand('shortcuts', {
		description: '编辑扩展快捷键',
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				const entries = registry.getEntries();
				if (entries.length === 0) {
					ctx.ui.notify('暂无扩展快捷键', 'info');
					return;
				}
				const lines = entries.map(
					(e) =>
						`${config.prefixKey || '(前缀键已禁用)'} ${e.keys.join(' ')} — ${e.description}`,
				);
				ctx.ui.notify(lines.join('\n'), 'info');
				return;
			}
			await showEditor(ctx, registry, configStore, () => {
				config = configStore.reload();
			});
		},
	});

	log.info('Extension loaded', {
		prefixKey: config.prefixKey,
		paletteOnPrefix: config.paletteOnPrefix,
	});
}

/** 生成一级子键提示，如 "f=文件 o=打开"。多级子键取首键去重。 */
function buildHint(registry: ShortcutRegistry): string {
	const entries = registry.getEntries();
	if (entries.length === 0) return '';
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const e of entries) {
		const top = e.keys[0];
		if (top === undefined || seen.has(top)) continue;
		seen.add(top);
		parts.push(`${top}=${e.description}`);
	}
	return parts.join(' ');
}
