/**
 * Strategy: classifier（基准策略）
 *
 * 仅用 D1 信号（LLM 分类 prompt+上下文），
 * 不参考任何树/工程/进度信号。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import type { RoutingStrategy, SessionSignals } from './registry.js';
import type { PickDecision } from '../router.js';
import type { Complexity } from '../config.js';

const log = createLogger('smart-context:strategy:classifier');

// 简化版分类器（与 router.ts 中的 classify 逻辑一致，但不调用 host-ai）
// 这里返回 null 表示"不覆盖，让现有 router 处理"
export const classifierStrategy: RoutingStrategy = {
	name: 'classifier',

	async decide(
		_prompt: string,
		_ctx: ExtensionContext,
		_signals: SessionSignals,
	): Promise<PickDecision | null> {
		// 基准策略：不做任何事，让现有 classifier router 正常处理
		// 这个 arm 代表"不加额外判断，信任 LLM 分类器"
		return null;
	},
};

log.info('classifier strategy registered');
