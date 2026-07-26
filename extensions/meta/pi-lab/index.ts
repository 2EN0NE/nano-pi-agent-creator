/**
 * @zenone/pi-lab — 实验框架 Extension Entry
 *
 * 完整设计文档见 README.md
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { getExperimentManager } from './core/manager.js';
import { showPanel } from './ui/panel.js';

const log = createLogger('pi-lab');

export default function piLabExtension(pi: ExtensionAPI) {
	const manager = getExperimentManager();

	// 挂载到 globalThis，供 edit 等消费方通过鸭子类型访问（不依赖模块导入）
	(globalThis as any).__labApi = {
		getExperimentManager: () => manager,
	};

	log.info('Extension loaded');

	let lastStatus: string | undefined;

	// ── /lab 命令 ──

	pi.registerCommand('lab', {
		description: '管理pi插件相关的实验',
		handler: async (_args, ctx) => {
			if (ctx.mode !== 'tui') {
				ctx.ui.notify('/experiment requires TUI mode', 'error');
				return;
			}
			await showPanel(ctx, manager);
		},
	});

	// ── 生命周期 ──

	pi.on('session_start', async (_event, ctx) => {
		// 初始化状态栏
		updateStatusBar(ctx);

		// 冲刷缓存的冲突通知到 UI（如果可用）
		if (ctx.hasUI) {
			manager.flushConflicts((msg, level) => {
				const piLevel = level === 'warn' ? 'warning' : level;
				ctx.ui.notify(msg, piLevel);
			});
		} else {
			manager.flushConflicts(); // 只打日志
		}

		// 每次实验状态变化时刷新
		const originalSetStatus = manager.setStatus.bind(manager);
		manager.setStatus = (status) => {
			originalSetStatus(status);
			try {
				updateStatusBar(ctx);
			} catch (err) {
				log.warn('Failed to update status bar', {
					status,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};
	});

	pi.on('session_shutdown', async () => {
		log.debug('Flushing experiment data');
		await manager.flushAll();
	});

	// ── 状态栏 ──

	function updateStatusBar(ctx: {
		ui: { setStatus: (name: string, text: string | undefined, theme?: string) => void };
	}) {
		const status = manager.status;
		const text = `|lab:${status}`;

		if (status === 'off') {
			ctx.ui.setStatus('pi-lab', text, 'dim');
		} else if (status === 'switched') {
			ctx.ui.setStatus('pi-lab', text, 'accent');
		} else {
			ctx.ui.setStatus('pi-lab', text, undefined);
		}

		if (text !== lastStatus) {
			log.debug('Status updated', { status, text });
			lastStatus = text;
		}
	}
}
