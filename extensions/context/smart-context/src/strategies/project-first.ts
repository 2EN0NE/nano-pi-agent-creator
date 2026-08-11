/**
 * Strategy: project-first（工程优先）
 * 参数从 smart-context 配置文件 strategies.project-first 读取。
 */
import { createLogger } from '@zenone/pi-logger';
import type { RoutingStrategy } from './registry.js';
import type { PickDecision } from '../router.js';
import { resolveProfile, getStrategyConfig, type Complexity } from '../config.js';

const log = createLogger('smart-context:strategy:project-first');
const ORDER: Complexity[] = ['trivial', 'simple', 'medium', 'complex'];
const esc = (a: Complexity, b: Complexity) => ORDER[Math.max(ORDER.indexOf(a), ORDER.indexOf(b))];

export const projectFirstStrategy: RoutingStrategy = {
	name: 'project-first',
	async decide(_prompt, ctx, signals): Promise<PickDecision | null> {
		const cfg = getStrategyConfig(ctx.cwd)['project-first'];
		let b: Complexity;
		if (signals.projectDocScore < cfg.sparseDocThreshold) b = 'medium';
		else if (signals.projectDocScore < cfg.goodDocThreshold) b = 'simple';
		else b = 'trivial';
		if (signals.branchCount >= cfg.extremeBranchThreshold) b = esc(b, 'complex');
		if (signals.isRetry) b = esc(b, 'medium');
		if (b === 'trivial' || b === 'simple') return null;
		const target = resolveProfile(ctx.cwd).routing[b];
		return {
			model: target,
			reason: 'heuristic',
			detail: `project-first: docScore=${signals.projectDocScore} ${b}`,
		};
	},
};

log.info('project-first strategy registered');
