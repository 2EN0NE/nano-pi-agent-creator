/**
 * worktree v2 — TUI 交互测试
 *
 * 使用 TuiRunner（node-pty + PI_TUI_WRITE_LOG）验证：
 * - 切换器面板渲染
 * - help 输出
 * - widget 切换
 *
 * 如果 node-pty 在当前平台不可用（如 Linux 无预编译二进制），测试自动跳过。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { withTui } from '../helpers/tui-runner.js';

// 同步检测 node-pty 是否可用（Vitest 需要 describe/import 在顶层同步执行）
const _nodePtyAvailable = (() => {
	try {
		const _require = createRequire(import.meta.url);
		const pty = _require('node-pty');
		return typeof pty.spawn === 'function';
	} catch {
		return false;
	}
})();

// 如果 node-pty 不可用（如 Linux 无预编译二进制），跳过所有测试
const itOrSkip = _nodePtyAvailable ? it : it.skip;
const describeOrSkip = _nodePtyAvailable ? describe : describe.skip;

describeOrSkip('worktree v2 extension (TUI mode via node-pty)', () => {
	itOrSkip('loads in TUI mode without crash', async () => {
		await withTui({ extensions: 'pi-logger,worktree', useMockLLM: true }, async (tui) => {
			await tui.waitForOutput('mock-model-1', 6000);
		});
	});

	itOrSkip('/worktree (no args) opens switcher panel', async () => {
		await withTui({ extensions: 'pi-logger,worktree', useMockLLM: true }, async (tui) => {
			await tui.send('/worktree');
			await tui.waitForOutput('main', 10000);
			await tui.waitForOutput('Switch', 8000);
			await tui.sendRaw('\x1b');
		});
	});

	itOrSkip('/worktree help shows commands', async () => {
		await withTui({ extensions: 'pi-logger,worktree', useMockLLM: true }, async (tui) => {
			await tui.send('/worktree help');
			await tui.waitForOutput('create', 10000);
			const text = tui.getText();
			expect(text).toContain('Usage:');
			expect(text).toContain('create');
			expect(text).toContain('delete');
			expect(text).toContain('widget');
			expect(text).not.toContain('/stop');
		});
	});

	itOrSkip('/worktree widget on/off', async () => {
		await withTui({ extensions: 'pi-logger,worktree', useMockLLM: true }, async (tui) => {
			await tui.send('/worktree widget off');
			await tui.waitForOutput('hidden', 10000);
			await tui.send('/worktree widget on');
			await tui.waitForOutput('visible', 10000);
		});
	});
});
