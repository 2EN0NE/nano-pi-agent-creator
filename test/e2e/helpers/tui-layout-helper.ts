/**
 * pi-lab TUI layout e2e 测试辅助扩展
 *
 * 注册多个带 namespace + metrics 的实验，用于验证两列布局和竖线对齐。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-lab-tui-helper');

export default function (pi: ExtensionAPI) {
	pi.on('session_start', async () => {
		const mgr = (globalThis as any).__labApi?.getExperimentManager?.();
		if (!mgr) {
			log.warn('pi-lab not available, cannot register test experiments');
			return;
		}

		// 无 namespace 的实验
		mgr.registerWeakExperiment({
			name: 'standalone-exp',
			contextKey: 'global',
			arms: [
				{ id: 'a', label: 'Arm A' },
				{ id: 'b', label: 'Arm B' },
			],
			metrics: [
				{ id: 'score', type: 'continuous', direction: 'maximize', label: '综合得分' },
			],
		});

		// smart-context 命名空间下的两个实验
		const exp1 = mgr.registerWeakExperiment({
			name: 'turn-routing',
			namespace: 'smart-context',
			contextKey: 'global',
			arms: [
				{ id: 'classifier', label: 'classifier (C)' },
				{ id: 'tree-escal', label: 'tree-escalation (T)' },
				{ id: 'pure-sig', label: 'pure-signals (P)' },
			],
			metrics: [
				{
					id: 'composite_score',
					type: 'continuous',
					direction: 'maximize',
					label: '综合得分',
				},
				{
					id: 'tool_error_rate',
					type: 'continuous',
					direction: 'minimize',
					label: '工具错误率',
				},
			],
		});

		// 写入一些数据让表格有东西可渲染
		exp1.record('classifier', {
			metrics: { composite_score: 0.8, tool_error_rate: 0.02 },
			success: true,
		});
		exp1.record('tree-escal', {
			metrics: { composite_score: 0.3, tool_error_rate: 0.08 },
			success: false,
		});
		exp1.record('classifier', {
			metrics: { composite_score: 0.7, tool_error_rate: 0.01 },
			success: true,
		});

		const exp2 = mgr.registerWeakExperiment({
			name: 'session-init',
			namespace: 'smart-context',
			contextKey: 'global',
			arms: [
				{ id: 'fast', label: 'fast-profile' },
				{ id: 'balanced', label: 'balanced-profile' },
			],
			metrics: [
				{ id: 'score', type: 'continuous', direction: 'maximize', label: '综合得分' },
			],
		});
		exp2.record('fast', { metrics: { score: 0.9 }, success: true });
		exp2.record('balanced', { metrics: { score: 0.5 }, success: true });
		exp2.record('balanced', { metrics: { score: 0.6 }, success: true });

		log.info('TUI test experiments registered (3 experiments, 2 namespaces)');
	});
}
