/**
 * worktree 扩展 — TUI 交互测试
 *
 * 使用 TuiRunner（node-pty + PI_TUI_WRITE_LOG）验证：
 * - slash 命令在 TUI 中的输出
 * - mode/widget 切换
 * - help 命令完整性
 * - border 盒子结构
 * - worktree 创建 / 切换流程
 * - pi-logger 日志埋点
 *
 * 注意：Widget 内容由 pi-tui 渲染引擎绘制，不在 PI_TUI_WRITE_LOG 中。
 */
import { describe, it, expect } from 'vitest';
import { withTui } from '../helpers/tui-runner.js';

describe('worktree extension (TUI mode via node-pty)', () => {
	it('loads in TUI mode without crash', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.waitForOutput('mock-model-1', 6000);
		});
	});

	it('/worktree list shows no worktrees', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree list');
			await tui.assertContains('No worktrees');
		});
	});

	it('/worktree mode on shows ON', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree mode on');
			await tui.assertContains('Worktree mode: ON');
		});
	});

	it('/worktree help shows all commands', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree help');
			await tui.waitForOutput('Mode', 10000);
			await tui.waitForOutput('Widget', 10000);
			await tui.waitForOutput('Delete', 10000);
			await tui.waitForOutput('Help', 10000);
			await tui.waitForOutput('Quit', 10000);
			await tui.waitForOutput('List', 10000);
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

	it('PI_TUI_WRITE_LOG captures notification that script cannot', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree list');
			const output = await tui.waitForOutput('No worktrees', 10000);
			expect(output).toContain('No worktrees');
			tui.snapshot('after-list');
			const snap = tui.getSnapshots()[0]!;
			expect(snap.text).toContain('No worktrees');
		});
	});

	it('two commands in sequence', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree list');
			await tui.waitForOutput('No worktrees', 10000);
			await tui.send('/worktree help');
			await tui.waitForOutput('Create', 10000);
			const text = tui.getText();
			expect(text).toContain('No worktrees');
			expect(text).toContain('Create');
		});
	});

	// ──────────────────────────────────────────────
	// worktree 创建 / 切换 — 端到端流程
	// ──────────────────────────────────────────────
	it('creates worktree with custom name from CLI flags', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree mode on');
			await tui.send('/worktree create --repos test-repo --name e2e-custom');
			// 等待创建成功通知
			const output = await tui.waitForOutput('e2e-custom', 20000);
			expect(output).toContain('e2e-custom');
		});
	});

	it('stops active worktree and shows deactivated', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree mode on');
			await tui.send('/worktree create --repos test-repo --name e2e-stop');
			await tui.waitForOutput('e2e-stop', 20000);
			await tui.send('/worktree stop');
			await tui.assertContains('Deactivated');
		});
	});

	it('/worktree use re-activates existing worktree', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree mode on');
			await tui.send('/worktree create --repos test-repo --name e2e-use');
			await tui.waitForOutput('e2e-use', 20000);
			await tui.send('/worktree stop');
			await tui.waitForOutput('Deactivated', 10000);
			// Switch back to the previously created worktree
			await tui.send('/worktree use e2e-use');
			await tui.assertContains('Activated');
			await tui.assertContains('e2e-use');
		});
	});

	// ──────────────────────────────────────────────
	// widget 同步（切换后 widget 正确显示 worktree 名）
	// ──────────────────────────────────────────────
	it('widget syncs after switching worktree — PTY output contains worktree name', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree mode on');
			// 创建第一个 worktree
			await tui.send('/worktree create --repos test-repo --name e2e-widget-sync');
			await tui.waitForOutput('e2e-widget-sync', 20000);
			// 停止并重新激活
			await tui.send('/worktree use e2e-widget-sync');
			await tui.waitForOutput('Activated', 10000);
			// 等待 widget 渲染（pi-tui 渲染帧）
			await new Promise((r) => setTimeout(r, 1500));
			// 检查 PTY 原始输出中是否包含 widget 渲染内容
			await tui.assertPtyContains('e2e-widget-sync');
		});
	});

	// ──────────────────────────────────────────────
	// 综合行为测试
	// ──────────────────────────────────────────────

	// ──────────────────────────────────────────────
	// widget 同步
	// ──────────────────────────────────────────────

	it('widget syncs after switching worktree — PTY output contains worktree name', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree mode on');
			// 创建第一个 worktree
			await tui.send('/worktree create --repos test-repo --name e2e-widget-sync');
			await tui.waitForOutput('e2e-widget-sync', 20000);
			// 停止并重新激活
			await tui.send('/worktree use e2e-widget-sync');
			await tui.waitForOutput('Activated', 10000);
			// 等待 widget 渲染（pi-tui 渲染帧）
			await new Promise((r) => setTimeout(r, 1500));
			// 检查 PTY 原始输出中是否包含 widget 渲染内容
			await tui.assertPtyContains('e2e-widget-sync');
		});
	});

	// ──────────────────────────────────────────────
	// merge 命令
	// ──────────────────────────────────────────────
	it('/worktree merge shows usage when no worktrees', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			// No worktrees created yet in this sandbox
			await tui.send('/worktree merge');
			await tui.assertContains('No worktrees to merge');
		});
	});

	it('/worktree merge with source flag merges worktree branch to main', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree mode on');
			// Create a worktree first
			await tui.send('/worktree create --repos test-repo --name e2e-merge-src');
			await tui.waitForOutput('e2e-merge-src', 20000);
			// Merge it — wait for confirm dialog, then confirm
			await tui.send('/worktree merge --source e2e-merge-src --target main');
			await tui.waitForOutput('Yes, merge', 8000);
			await tui.send('y');
			await tui.waitForOutput('Merged', 15000);
		});
	});

	// ──────────────────────────────────────────────
	// border 盒子结构测试（允许 CJK 宽度偏差）
	// ──────────────────────────────────────────────
	it('/worktree TUI panel renders structured box', async () => {
		await withTui({ extensions: 'pi-logger,worktree' }, async (tui) => {
			await tui.send('/worktree mode on');
			await tui.send('/worktree');
			await tui.waitForOutput('\u2502', 8000);
			const text = tui.getText();

			expect(text).toContain('\u2502');
			expect(text).toContain('\u2514');
			expect(text).toContain('\u2518');
			expect(text).toContain('pi-worktree');
			expect(text).toContain('Mode:');

			const allBorders = text
				.split('\n')
				.filter(
					(l) => l.includes('\u2502') || l.includes('\u2510') || l.includes('\u2518'),
				);
			const lastTopIdx = allBorders.reduceRight(
				(found, l, i) => (found !== -1 ? found : l.includes('\u250C') ? i : -1),
				-1,
			);
			const lastBotIdx = allBorders.reduceRight(
				(found, l, i) => (found !== -1 ? found : l.includes('\u2514') ? i : -1),
				-1,
			);
			const bLines =
				lastTopIdx >= 0 && lastBotIdx > lastTopIdx
					? allBorders.slice(lastTopIdx, lastBotIdx + 1)
					: allBorders;
			expect(bLines.length).toBeGreaterThanOrEqual(3);

			const counts = bLines.map(
				(l) => (l.match(/[\u2502\u2510\u2518\u250C\u2514]/g) || []).length,
			);
			expect(
				counts.every((c) => c === 2),
				`every border line must have exactly 2 box chars. counts: ${JSON.stringify(counts)}`,
			).toBe(true);

			const contentOnly = bLines
				.filter(
					(l) => l.includes('\u2502') && !l.includes('\u250C') && !l.includes('\u2514'),
				)
				.map((l, i) => {
					const lo = l.indexOf('\u2502');
					const ro = l.lastIndexOf('\u2502');
					return { idx: i, left: lo, right: ro, width: ro - lo };
				});
			const cwVals = [...new Set(contentOnly.map((c) => c.width))];
			const cwMaxDiff = cwVals.length > 1 ? Math.max(...cwVals) - Math.min(...cwVals) : 0;
			expect(
				cwMaxDiff,
				`content line widths must not differ by >3. widths: ${JSON.stringify(contentOnly)}`,
			).toBeLessThanOrEqual(3);

			const topW =
				(bLines
					.filter((l) => l.includes('\u2510'))
					.map((l) => {
						const lo = l.indexOf('\u250C');
						const ro = l.lastIndexOf('\u2510');
						return ro - lo;
					})[0] as number | undefined) ?? 0;
			const botW =
				(bLines
					.filter((l) => l.includes('\u2518'))
					.map((l) => {
						const lo = l.indexOf('\u2514');
						const ro = l.lastIndexOf('\u2518');
						return ro - lo;
					})[0] as number | undefined) ?? 0;
			expect(
				topW > 0 && botW > 0,
				`top border (${topW}) and bottom border (${botW}) must be > 0`,
			).toBe(true);

			await tui.sendRaw('\x1b');
		});
	});
});
