/**
 * permission-gate — 通道无关的外部确认接口（T7，ADR-0028）
 *
 * 通过 globalThis.__permissionGateApi 暴露程序化确认接口，
 * 使任何插件（wechatbot 等）能订阅待确认请求并程序化确认，等效人工 TUI 选择。
 *
 * 接口：
 *   onPendingRequest(cb) -> unsubscribe    订阅待确认请求
 *   confirm(requestId, decision) -> bool   程序化确认（allow/deny）
 *   listPending() -> ConfirmRequest[]      通道重连时同步
 */

import { randomInt } from 'node:crypto';
import type { DangerTier } from './config.js';

export interface ConfirmRequest {
	/** 唯一 request/control ID（与审计日志一致） */
	requestId: string;
	/** 短码（供外部通道如微信回复 #ab12cd 使用） */
	shortCode: string;
	tool: string;
	command: string;
	level: DangerTier;
	reasons: string[];
}

export type ConfirmDecision = 'allow' | 'deny';
type PendingListener = (req: ConfirmRequest) => void;

// SAFETY: globalThis 上挂载通道无关 API 的桥接类型，运行时由本模块唯一写入
type PermissionGateGlobal = { __permissionGateApi?: PermissionGateApi };

function gateGlobal(): PermissionGateGlobal {
	// SAFETY: 桥接对象由本模块 installPermissionGateApi 唯一写入，形状由 PermissionGateApi 约束
	return globalThis as unknown as PermissionGateGlobal;
}

export interface PermissionGateApi {
	onPendingRequest(cb: PendingListener): () => void;
	confirm(requestId: string, decision: ConfirmDecision): Promise<boolean>;
	listPending(): ConfirmRequest[];
}

let pendingRequests: ConfirmRequest[] = [];
const pendingResolvers = new Map<string, (decision: ConfirmDecision) => void>();
const listeners = new Set<PendingListener>();

function genShortCode(): string {
	// 6 位 base36，如 ab12cd；与 pending 中已有短码去重，
	// 避免外部通道（微信 #ab12cd 等）凭短码确认时命中错误请求。
	// 使用 crypto.randomInt（密码学安全），非可预测的 Math.random——短码
	// 是外部通道凭以确认危险命令执行的凭据，不可被猜中。
	let code = '';
	do {
		code = '';
		for (let i = 0; i < 6; i++) {
			code += randomInt(36).toString(36);
		}
	} while (pendingRequests.some((r) => r.shortCode === code));
	return code;
}

/** 暴露 globalThis.__permissionGateApi（幂等，可重复调用） */
export function installPermissionGateApi(): void {
	const api = {
		onPendingRequest(cb: PendingListener): () => void {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
		confirm(requestId: string, decision: ConfirmDecision): Promise<boolean> {
			return Promise.resolve(resolvePendingRequest(requestId, decision));
		},
		listPending(): ConfirmRequest[] {
			return [...pendingRequests];
		},
	};
	gateGlobal().__permissionGateApi = api;
}

/**
 * 注册一个待确认请求（拦截发生时调用）。
 * 返回 shortCode 与竞争结果 Promise（外部确认或 TUI 选择，谁先来谁生效）。
 */
export function registerPendingRequest(req: Omit<ConfirmRequest, 'shortCode'>): {
	shortCode: string;
	result: Promise<ConfirmDecision>;
} {
	const shortCode = genShortCode();
	const full: ConfirmRequest = { ...req, shortCode };
	pendingRequests.push(full);
	for (const cb of listeners) {
		try {
			cb(full);
		} catch {
			// 通道订阅回调异常不影响主流程
		}
	}
	const result = new Promise<ConfirmDecision>((resolve) => {
		pendingResolvers.set(req.requestId, resolve);
	});
	return { shortCode, result };
}

/** 解析待确认请求（外部 confirm() 或 TUI 选择结果均可调用） */
export function resolvePendingRequest(requestId: string, decision: ConfirmDecision): boolean {
	const resolve = pendingResolvers.get(requestId);
	if (!resolve) return false;
	pendingResolvers.delete(requestId);
	pendingRequests = pendingRequests.filter((r) => r.requestId !== requestId);
	resolve(decision);
	return true;
}

/** 测试专用：重置全局状态 */
export function resetConfirmApi(): void {
	pendingRequests = [];
	pendingResolvers.clear();
	listeners.clear();
	delete gateGlobal().__permissionGateApi;
}
