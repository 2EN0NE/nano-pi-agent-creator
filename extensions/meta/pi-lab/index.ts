/**
 * @zenone/pi-lab — 实验框架 Extension Entry
 *
 * 完整设计文档见 README.md
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { createSessionTreeWithPi } from '@zenone/pi-session-tree';
import { getExperimentManager } from './core/manager.js';
import { logExtractor, tagExtractor } from './core/ingestion.js';
import { extractLifecycleDelta, TurnAttributor } from './core/lifecycle.js';
import { showPanel } from './ui/panel.js';

const log = createLogger('pi-lab');

export default function piLabExtension(pi: ExtensionAPI) {
	const manager = getExperimentManager();

	// 挂载到 globalThis，供 edit 等消费方通过鸭子类型访问（不依赖模块导入）
	(globalThis as any).__labApi = {
		getExperimentManager: () => manager,
	};

	// 内建信号源：会话树 TAG 与 pi-log 日志（registerIngestionSource 扩展点，消费方可注册更多）
	manager.registerIngestionSource('session-tree-tag', tagExtractor);
	manager.registerIngestionSource('pi-log', logExtractor);

	// turn 级归因：select 登记活跃臂 → 生命周期事件累积 → turn_end flush 通用过程指标
	const attributor = new TurnAttributor();
	manager.setSelectObserver((experimentName, armId) => {
		attributor.noteSelect(experimentName, armId);
	});

	log.info('Extension loaded');

	let lastStatus: string | undefined;
	let logSignalSubscribed = false;
	let logSignalUnsubscribe: (() => void) | undefined;

	// ── /lab 命令 ──

	pi.registerCommand('lab', {
		description: '管理pi插件相关的实验',
		handler: async (_args, ctx) => {
			if (ctx.mode !== 'tui') {
				ctx.ui.notify('/lab 命令需要 TUI 模式', 'error');
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

		// 订阅 pi-logger 日志事件，实时采集 [pi-lab-signal] 静默信号（防重复订阅）。
		// 日志体系适用于不需用户感知的静默上报（如 edit 工具执行结果）。
		if (!logSignalSubscribed) {
			logSignalSubscribed = true;
			logSignalUnsubscribe = pi.events.on('log', (data: unknown) => {
				const event = data as { message?: string; source?: unknown; details?: unknown };
				if (!event) return;
				// [pi-lab-signal] 静默信号（消费方日志上报）
				if (
					typeof event.message === 'string' &&
					event.message.includes('[pi-lab-signal]')
				) {
					void ingestLogSignal(event.message);
					return;
				}
				// __lifecycle__ 被动过程信号（pi-logger 结构化事件 → 通用指标增量）
				const delta = extractLifecycleDelta(event);
				if (delta) attributor.noteLifecycle(delta);
			});
		}
	});

	// turn 级归因：turn 开始时重置活跃臂与累积
	pi.on('turn_start', (event: { turnIndex: number }) => {
		attributor.startTurn(`turn-${event.turnIndex}`);
	});

	// 信号入口接线：turn_end 时 flush lifecycle 通用指标 + 从会话树采集 TAG 信号。
	// ctxKey 缺省 'global'（TAG 节点不直接携带 model 信息，完整提取留待后续）。
	pi.on('turn_end', async (_event, ctx) => {
		// ① lifecycle 被动信号 flush（turn 级归因，独立于 TAG 采集）
		await flushLifecycle();

		try {
			const sm = ctx.sessionManager as Parameters<typeof createSessionTreeWithPi>[0];
			const tree = createSessionTreeWithPi(sm);
			const labels = tree.extractLabels();
			if (labels.length === 0) return;

			// targetId 随节点传入，作为 TAG 信号的幂等键，避免每次 turn_end 重复摄入历史 TAG
			const nodes = labels.map((l) => ({
				label: l.label,
				ctxKey: 'global',
				targetId: l.targetId,
			}));
			const experiments = manager.getAllExperiments();
			if (experiments.length === 0) return;

			let total = 0;
			for (const { name } of experiments) {
				total += await manager.ingest(name, 'session-tree-tag', nodes);
			}
			if (total > 0) log.debug('TAG signals ingested', { total });
		} catch (err) {
			// 采集失败是编程/契约错误（如 pi-session-tree API 变化），不应被 debug 遮蔽
			log.warn('TAG ingestion failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	pi.on('session_shutdown', async () => {
		// 反注册 log 信号监听，避免 /reload 后旧实例监听器残留导致重复 ingest
		logSignalUnsubscribe?.();
		logSignalUnsubscribe = undefined;
		logSignalSubscribed = false;
		log.debug('Flushing experiment data');
		await manager.flushAll();
	});

	// lifecycle 被动信号 flush：把该 turn 聚合的通用指标写入各活跃实验的活跃臂。
	// 逐实验隔离写盘：遥测类写入 fail-open（单实验失败告警后继续），但不让一个坏实验
	// 的 appendEvent 抛错拖垮整轮其它实验的归因。
	async function flushLifecycle(): Promise<void> {
		const results = attributor.endTurn();
		if (results.length === 0) return;
		let flushed = 0;
		for (const r of results) {
			try {
				const exp = manager.getExperimentRaw(r.experimentName);
				if (!exp) continue;
				exp.appendEvent({
					armId: r.armId,
					ctxKey: r.ctxKey,
					metrics: r.metrics,
					metadata: r.metadata,
				});
				flushed++;
			} catch (err) {
				log.warn('Lifecycle flush failed for experiment', {
					experimentName: r.experimentName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		log.debug('Lifecycle signals flushed', { experiments: flushed });
	}

	// 日志信号：单条 [pi-lab-signal] 日志行 → 各实验 ingest（静默上报）
	async function ingestLogSignal(message: string): Promise<void> {
		try {
			const lines = [message];
			for (const { name } of manager.getAllExperiments()) {
				await manager.ingest(name, 'pi-log', lines);
			}
		} catch (err) {
			// 日志信号采集是边界：第三方 logExtractor（registerIngestionSource 扩展点）
			// 抛错不应产生 unhandled rejection 影响扩展生命周期，告警后继续（与 turn_end 一致）
			log.warn('Log signal ingestion failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// ── 状态栏 ──

	function updateStatusBar(ctx: {
		ui: { setStatus: (name: string, text: string | undefined, theme?: string) => void };
	}) {
		const status = manager.status;
		// 状态栏文案中文化（内部枚举值 off/collecting/switched 保持英文标识）
		const statusLabel: Record<string, string> = {
			off: '关闭',
			collecting: '采集中',
			switched: '已切换',
		};
		const text = `|lab:${statusLabel[status] ?? status}`;

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
