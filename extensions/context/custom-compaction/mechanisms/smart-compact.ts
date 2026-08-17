/**
 * Smart Compact (EESV) Adapter
 *
 * Collaborates with the pi-smart-compact extension.
 *
 * Since pi-smart-compact registers its own session_before_compact handler,
 * this adapter does NOT import or call runSmartCompact directly.
 * Instead, it tells custom-compaction to pass through — smart_compact's
 * own handler will run the EESV pipeline when ctx.compact() is called.
 *
 * Prerequisites:
 *   1. pi-smart-compact must be loaded (in the extensions list)
 *   2. smart_compact's autoTrigger setting is respected:
 *      - true  (default): smart_compact will run inside session_before_compact
 *      - false: compaction will fall through to Pi's default behavior
 *
 * ⚠️ 实验注意：本 adapter 是 collaboration pass-through（beforeCompact 恒返回
 * false），不会真实拦截压缩。mechanism-strategy 实验要求 adapter 声明
 * `handlesCompaction: true` 才有真实机制对比度——本 adapter 不声明，
 * 因此机制实验在当前形态下不会注册（见 lab.ts initExperiments）。
 *
 * Usage in profile:
 *   { trigger: { type: "context_percent", threshold: 70 },
 *     mechanism: { type: "adapter", adapterId: "smart_compact" } }
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import type { CompactionProfile } from '../types.js';
import { registerAdapter } from './index.js';

const log = createLogger('custom-compaction:adapter:smart-compact');

registerAdapter({
	id: 'smart_compact',
	name: 'Smart Compact (EESV)',
	description:
		'EESV pipeline with deterministic extraction, exploration, synthesis, verification (requires pi-smart-compact extension)',

	register: (_pi: ExtensionAPI) => {
		log.info('Adapter registered (collaboration mode)');
		log.info('Requires pi-smart-compact to be loaded separately for actual compaction logic');
	},

	beforeCompact: async (
		_ctx: ExtensionContext,
		_profile: CompactionProfile,
	): Promise<boolean> => {
		// Return false → do NOT intercept.
		// Let smart_compact's own session_before_compact handler (or Pi default) run.
		log.info('████ adapter invoked, passing through to smart_compact handler');
		return false;
	},
});
