/**
 * Strategy: conservative（保守升级）
 * 参数从 smart-context 配置文件 strategies.conservative 读取。
 */
import { createLogger } from '@zenone/pi-logger';
import type { RoutingStrategy } from './registry.js';
import type { PickDecision } from '../router.js';
import { resolveProfile, getStrategyConfig } from '../config.js';

const log = createLogger('smart-context:strategy:conservative');

export const conservativeStrategy: RoutingStrategy = {
	name: 'conservative',
	async decide(_prompt, ctx, signals): Promise<PickDecision | null> {
		const cfg = getStrategyConfig(ctx.cwd).conservative;
		let t = 0;
		if (signals.branchCount >= cfg.branchThreshold) t++;
		if (signals.checkpointCount >= cfg.checkpointThreshold) t++;
		if (signals.compactionCount >= cfg.compactionThreshold) t++;
		if (signals.isRetry) t++;
		if (signals.contextPercent !== null && signals.contextPercent > cfg.contextPercentThreshold)
			t++;
		if (t < cfg.minTriggers) return null;
		const target = resolveProfile(ctx.cwd).routing.medium;
		return {
			model: target,
			reason: 'heuristic',
			detail: `conservative: ${t} triggers → medium`,
		};
	},
};

log.info('conservative strategy registered');
