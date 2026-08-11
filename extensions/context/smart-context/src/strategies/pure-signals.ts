/**
 * Strategy: pure-signals（纯信号，无 LLM）
 * 参数从 smart-context 配置文件 strategies.pure-signals 读取。
 */
import { createLogger } from '@zenone/pi-logger';
import type { RoutingStrategy } from './registry.js';
import type { PickDecision } from '../router.js';
import { resolveProfile, getStrategyConfig, type Complexity } from '../config.js';

const log = createLogger('smart-context:strategy:pure-signals');

export const pureSignalsStrategy: RoutingStrategy = {
	name: 'pure-signals',
	async decide(_prompt, ctx, signals): Promise<PickDecision | null> {
		const cfg = getStrategyConfig(ctx.cwd)['pure-signals'];
		let s = 0;
		s += signals.branchCount * cfg.branchWeight;
		s += signals.checkpointCount * cfg.checkpointWeight;
		s += signals.compactionCount * cfg.compactionWeight;
		s += signals.toolErrorRate * 25;
		s += signals.isRetry ? 30 : 0;
		s -= signals.projectDocScore * 0.3;
		s -= signals.userEngagementScore * 0.2;
		let c: Complexity;
		if (s >= cfg.complexThreshold) c = 'complex';
		else if (s >= cfg.mediumThreshold) c = 'medium';
		else return null;
		const target = resolveProfile(ctx.cwd).routing[c];
		return {
			model: target,
			reason: 'heuristic',
			detail: `pure-signals: score=${s.toFixed(0)} ${c}`,
		};
	},
};

log.info('pure-signals strategy registered');
