/**
 * prompt-editor 扩展 — 快捷键注册降级路径
 *
 * 回归 ADR-0031：prompt-editor 移除 ctrl+shift+p 降级键后，仅通过 leader 键
 * （alt+. e，经 __shortcutsApi）与 /prompt 命令访问。验证：
 *   - 有 __shortcutsApi → session_start 注册 leader 键 e
 *   - 无 __shortcutsApi → 不注册独立快捷键（不调 registerShortcut），/prompt 命令仍注册
 */
import { describe, it, expect, afterEach } from 'vitest';
import promptEditorExtension from '../../../extensions/meta/preset/prompt-editor.js';

interface ShortcutDef {
	name: string;
	keys: string[];
	description: string;
	handler: unknown;
}

function makeFakePi() {
	const handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>> = {};
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const shortcuts: Array<{ key: unknown; def: unknown }> = [];
	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (
			name: string,
			def: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => {
			commands[name] = def.handler;
		},
		registerShortcut: (key: unknown, def: unknown) => {
			shortcuts.push({ key, def });
		},
	};
	return { pi, handlers, commands, shortcuts };
}

async function fireFirstSessionStart(
	handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>>,
) {
	for (const handler of handlers['session_start'] ?? []) {
		await handler(null, {});
	}
}

describe('prompt-editor 快捷键注册降级', () => {
	afterEach(() => {
		delete (globalThis as Record<string, unknown>).__shortcutsApi;
	});

	it('有 __shortcutsApi → session_start 注册 leader 键 e', async () => {
		const registered: ShortcutDef[] = [];
		(globalThis as Record<string, unknown>).__shortcutsApi = {
			register: (def: ShortcutDef) => {
				registered.push(def);
			},
		};
		const { pi, handlers } = makeFakePi();
		promptEditorExtension(pi as never);
		await fireFirstSessionStart(handlers);

		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({ name: 'prompt-editor', keys: ['e'] });
	});

	it('无 __shortcutsApi → 不注册独立快捷键，/prompt 命令仍注册', async () => {
		const { pi, handlers, commands, shortcuts } = makeFakePi();
		promptEditorExtension(pi as never);
		await fireFirstSessionStart(handlers);

		expect(shortcuts).toHaveLength(0);
		expect(commands['prompt']).toBeTypeOf('function');
	});
});
