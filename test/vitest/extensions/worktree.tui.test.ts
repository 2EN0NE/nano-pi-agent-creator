/**
 * worktree v2 — TUI 交互测试
 *
 * 使用 TuiRunner（node-pty + PI_TUI_WRITE_LOG）验证：
 * - 切换器面板渲染
 * - widget 显示
 * - help 输出
 * - 已删除命令不再出现
 */
import { describe, it, expect } from 'vitest';
import { withTui } from '../helpers/tui-runner.js';

describe('worktree v2 extension (TUI mode via node-pty)', () => {
	it('loads in TUI mode without crash', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.waitForOutput('mock-model-1', 6000);
		});
	});

	it('/worktree help shows all commands', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree help');
			await tui.waitForOutput('create', 10000);
			await tui.waitForOutput('delete', 10000);
			await tui.waitForOutput('list', 10000);
			await tui.waitForOutput('use', 10000);
			await tui.waitForOutput('merge', 10000);
			await tui.waitForOutput('widget', 10000);
			await tui.sendRaw('\x1b');
		});
	});

	it('/worktree widget off shows hidden', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree widget off');
			await tui.assertContains('hidden');
		});
	});

	it('/worktree widget on shows visible', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree widget on');
			await tui.assertContains('visible');
		});
	});

	it('switcher panel opens on /worktree', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree');
			await tui.waitForOutput('main', 8000);
			await tui.waitForOutput('Create', 8000);
			await tui.waitForOutput('Quit', 8000);
			await tui.sendRaw('\x1b');
		});
	});

	it('multiple commands in sequence', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree widget off');
			await tui.waitForOutput('hidden', 10000);
			await tui.send('/worktree help');
			await tui.waitForOutput('create', 10000);
			const text = tui.getText();
			expect(text).toContain('create');
			expect(text).toContain('delete');
		});
	});

	it('help no longer shows removed commands (stop/mode)', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree help');
			await tui.waitForOutput('create', 10000);
			const text = tui.getText();
			// stop/mode 已被删除
			// 注意：如果 help 里有字样"delete"可能包含"stop"的 substring
			// 所以用细化检查
			expect(text).not.toContain('/stop');
			expect(text).not.toContain('/mode');
			await tui.sendRaw('\x1b');
		});
	});
});
