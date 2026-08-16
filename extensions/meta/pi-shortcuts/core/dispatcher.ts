/**
 * 子键分发状态机 — 前缀键按下后进入监听，累积子键序列并匹配注册表。
 *
 * 纯逻辑、依赖注入（registry + timeoutMs），无 pi runtime 依赖，可单测。
 * 状态流转：activate → (handleKey 累积) → exact 执行退出 / prefix 继续 / none 退出 / cancel 退出 / timeout 退出。
 */

import type { ShortcutRegistry } from './registry.js';

export type DeactivateReason = 'match' | 'cancel' | 'timeout' | 'nomatch';

export interface ShortcutDispatcherDeps {
	registry: ShortcutRegistry;
	/** 前缀键按下后等待子键的超时（毫秒），默认 2000。 */
	timeoutMs?: number;
	/** 退出监听时回调（供 index.ts 清理面板/提示）。 */
	onDeactivate?: (reason: DeactivateReason) => void;
}

const DEFAULT_TIMEOUT_MS = 2000;
const CANCEL_KEYS = new Set(['escape', 'ctrl+c']);

export class ShortcutDispatcher {
	private _registry: ShortcutRegistry;
	private _timeoutMs: number;
	private _onDeactivate?: (reason: DeactivateReason) => void;
	private _pressed: string[] = [];
	private _active = false;
	private _timer: ReturnType<typeof setTimeout> | null = null;
	private _ctx: unknown = undefined;

	constructor(deps: ShortcutDispatcherDeps) {
		this._registry = deps.registry;
		this._timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this._onDeactivate = deps.onDeactivate;
	}

	/** 进入子键监听（前缀键已按下）。ctx 为触发时的会话上下文，执行 handler 时透传。 */
	activate(ctx?: unknown): void {
		this._active = true;
		this._ctx = ctx;
		this._pressed = [];
		this._armTimer();
	}

	/** 处理一个已解析的子键标识（如 'f'、'escape'）。非 active 时忽略。 */
	handleKey(key: string): void {
		if (!this._active) return;

		if (CANCEL_KEYS.has(key)) {
			this._deactivate('cancel');
			return;
		}

		this._pressed.push(key);
		const result = this._registry.match(this._pressed);

		if (result.status === 'exact') {
			void result.entry.handler(this._ctx);
			this._deactivate('match');
		} else if (result.status === 'prefix') {
			this._armTimer(); // 还有子键未按，重置超时继续等待
		} else {
			this._deactivate('nomatch');
		}
	}

	isActive(): boolean {
		return this._active;
	}

	private _armTimer(): void {
		if (this._timer) clearTimeout(this._timer);
		this._timer = setTimeout(() => {
			this._deactivate('timeout');
		}, this._timeoutMs);
	}

	private _deactivate(reason: DeactivateReason): void {
		if (!this._active) return;
		this._active = false;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		this._pressed = [];
		this._onDeactivate?.(reason);
	}
}
