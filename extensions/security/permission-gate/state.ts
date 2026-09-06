/**
 * PermissionGateState — 显式状态容器，持有会话内配置。
 *
 * counts 不再由本类维护——放行规则计数统一由 approval-store（pi-state 三层）持久化，
 * 读取统一走 getRuleCounts()（ADR-0025）。本类只持有 config，并把"确认/放行"封装为
 * 对 approval-store 的计数累加。
 *
 * 生命周期：
 *   在 extension factory 的闭包中由 session_start 创建，通过参数传递给所有 handler。
 */

import type { DangerTier, PermissionGateConfig } from './config.js';
import { makeCommandKey, makeFolderKey, makeToolKey } from './config.js';
import { recordApproval } from './approval-store.js';

export class PermissionGateState {
	config: PermissionGateConfig;

	constructor(config: PermissionGateConfig) {
		this.config = config;
	}

	/**
	 * 记录一次自动放行/用户确认，累加三个维度的计数到对应 tier 的层级（pi-state）。
	 * 审计记录由调用方通过 appendAudit 单独写入 audit JSONL（ADR-0027）。
	 */
	recordApprovalFor(sub: { cmd: string; tool: string; dir: string }, tier: DangerTier): void {
		recordApproval(tier, [
			makeCommandKey(sub.cmd),
			makeToolKey(sub.tool),
			makeFolderKey(sub.dir),
		]);
	}
}
