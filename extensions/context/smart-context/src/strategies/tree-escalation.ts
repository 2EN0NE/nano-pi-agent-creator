/**
 * Strategy: tree-escalation（树信号升级）
 * 参数从 smart-context 配置文件 strategies.tree-escalation 读取。
 */
import { createLogger } from '@zenone/pi-logger';
import type { RoutingStrategy } from './registry.js';
import type { PickDecision } from '../router.js';
import { resolveProfile, getStrategyConfig, type Complexity } from '../config.js';

const log = createLogger('smart-context:strategy:tree-escalation');
const ORDER: Complexity[] = ['trivial', 'simple', 'medium', 'complex'];
const esc = (a: Complexity, b: Complexity) => ORDER[Math.max(ORDER.indexOf(a), ORDER.indexOf(b))];

export const treeEscalationStrategy: RoutingStrategy = {
	name: 'tree-escalation',
	async decide(_prompt, ctx, signals): Promise<PickDecision | null> {
		const cfg = getStrategyConfig(ctx.cwd)['tree-escalation'];
		let c: Complexity = 'simple';
		if (signals.branchCount >= cfg.branchThreshold) c = esc(c, 'medium');
		if (signals.checkpointCount >= cfg.checkpointThreshold) c = esc(c, 'medium');
		if (signals.compactionCount >= cfg.compactionThreshold) c = esc(c, 'medium');
		if (signals.isRetry && signals.branchCount >= 2) c = esc(c, 'medium');
		if (signals.contextPercent !== null && signals.contextPercent > cfg.contextPercentThreshold)
			c = esc(c, 'medium');
		if (c === 'simple') return null;
		const target = resolveProfile(ctx.cwd).routing[c];
		return {
			model: target,
			reason: 'heuristic',
			detail: `tree-escalation: ${c} b=${signals.branchCount} cp=${signals.checkpointCount}`,
		};
	},
};

log.info('tree-escalation strategy registered');
