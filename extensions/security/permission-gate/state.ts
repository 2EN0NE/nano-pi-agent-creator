/**
 * PermissionGateState — 显式状态容器，封装状态变更及对应 IO 持久化。
 *
 * 状态（config / counts / totalRecords）通过属性暴露，便于测试时构造。
 * recordEntry / recordBlocked 同时更新内存状态和持久化到磁盘（approvals.json），
 *   由内部委托给 records.ts 实现。
 *
 * 生命周期：
 *   在 extension factory 的闭包中由 session_start 创建，
 *   通过参数传递给所有 handler（纯函数风格）。
 *
 * 测试用法：
 *   const state = new PermissionGateState({ config, counts, totalRecords });
 *   state.recordEntry(cwd, entry);  // 模拟记录追加（会写磁盘！如要纯内存测试需 mock）
 *   expect(state.counts[cmdKey]).toBe(1);
 */

import type { ApprovalEntry } from './records.js';
import { appendRecord, appendBlockedRecord } from './records.js';
import type { PermissionGateConfig } from './config.js';

export class PermissionGateState {
	config: PermissionGateConfig;
	counts: Record<string, number>;
	totalRecords: number;

	constructor(initial: {
		config: PermissionGateConfig;
		counts: Record<string, number>;
		totalRecords: number;
	}) {
		this.config = initial.config;
		this.counts = initial.counts;
		this.totalRecords = initial.totalRecords;
	}

	/**
	 * 记录一条自动放行/用户确认的记录，更新内存 counts 和 totalRecords。
	 * 持久化由内部的 appendRecord 负责（写入 approvals.json）。
	 */
	recordEntry(cwd: string, entry: ApprovalEntry): void {
		appendRecord(cwd, entry, this.counts);
		this.totalRecords++;
	}

	/**
	 * 记录一条被拦截/拒绝的记录，不参与 counts（仅供审计）。
	 */
	recordBlocked(cwd: string, entry: ApprovalEntry): void {
		appendBlockedRecord(cwd, entry);
	}

	/**
	 * 替换 counts 和 totalRecords（用于策略删除后的重建）。
	 */
	replaceCounts(counts: Record<string, number>, totalRecords: number): void {
		this.counts = counts;
		this.totalRecords = totalRecords;
	}
}
