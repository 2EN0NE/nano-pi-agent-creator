/**
 * bash-timeout — Vitest 单元测试
 *
 * 覆盖：
 *   - applyDefaultTimeout 纯函数（注入/不覆盖/边界值）
 *   - tool_call 钩子接线（bash 注入、显式值不覆盖、非 bash 不碰、配置生效）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @zenone/pi-logger ──
vi.mock('@zenone/pi-logger', () => ({
	createLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

// ── Mock @zenone/pi-config（store.get() 返回可控制的配置值） ──
const { storeGet } = vi.hoisted(() => ({
	storeGet: vi.fn(),
}));
vi.mock('@zenone/pi-config', () => ({
	createConfigStore: () => ({
		get: storeGet,
		save: vi.fn(),
		reload: vi.fn(),
	}),
}));

import bashTimeout, { applyDefaultTimeout } from '../../../extensions/accuracy/bash-timeout';

describe('applyDefaultTimeout — 纯函数', () => {
	it('timeout 为空（undefined）时注入默认值', () => {
		const input: { timeout?: number | null } = {};
		const changed = applyDefaultTimeout(input, 300);
		expect(changed).toBe(true);
		expect(input.timeout).toBe(300);
	});

	it('timeout 为 null 时注入默认值', () => {
		const input: { timeout?: number | null } = { timeout: null };
		applyDefaultTimeout(input, 300);
		expect(input.timeout).toBe(300);
	});

	it('agent 显式传了 timeout 时不覆盖', () => {
		const input: { timeout?: number | null } = { timeout: 600 };
		const changed = applyDefaultTimeout(input, 300);
		expect(changed).toBe(false);
		expect(input.timeout).toBe(600);
	});

	it('agent 显式传 timeout=0 时尊重（不注入）', () => {
		const input: { timeout?: number | null } = { timeout: 0 };
		const changed = applyDefaultTimeout(input, 300);
		expect(changed).toBe(false);
		expect(input.timeout).toBe(0);
	});

	it('默认值 <= 0 时禁用注入', () => {
		const input: { timeout?: number | null } = {};
		expect(applyDefaultTimeout(input, 0)).toBe(false);
		expect(applyDefaultTimeout(input, -1)).toBe(false);
		expect(input.timeout).toBeUndefined();
	});
});

describe('bash-timeout tool_call 钩子接线', () => {
	// 捕获扩展注册的 tool_call handler
	let handler:
		((event: { toolName: string; input: Record<string, unknown> }) => unknown) | undefined;

	beforeEach(() => {
		handler = undefined;
		storeGet.mockReset();
		storeGet.mockReturnValue({ defaultTimeoutSeconds: 300 });

		const pi = {
			on: (event: string, h: unknown) => {
				if (event === 'tool_call') handler = h as typeof handler;
			},
		};
		bashTimeout(pi as never);
	});

	it('bash 工具且 timeout 为空 → 注入配置值', () => {
		const input: { command: string; timeout?: number } = { command: 'ls' };
		handler?.({ toolName: 'bash', input });
		expect(input.timeout).toBe(300);
	});

	it('bash 工具但 agent 已显式传 timeout → 不覆盖', () => {
		const input: { command: string; timeout?: number } = {
			command: 'npm install',
			timeout: 600,
		};
		handler?.({ toolName: 'bash', input });
		expect(input.timeout).toBe(600);
	});

	it('非 bash 工具 → 不注入', () => {
		const input: { command: string; timeout?: number } = { command: 'pattern' };
		handler?.({ toolName: 'rg', input });
		expect(input.timeout).toBeUndefined();
	});

	it('配置 defaultTimeoutSeconds 变化时，注入值随之变化', () => {
		storeGet.mockReturnValue({ defaultTimeoutSeconds: 60 });
		const input: { command: string; timeout?: number } = { command: 'ls' };
		handler?.({ toolName: 'bash', input });
		expect(input.timeout).toBe(60);
	});

	it('配置 defaultTimeoutSeconds=0 时，不注入（禁用）', () => {
		storeGet.mockReturnValue({ defaultTimeoutSeconds: 0 });
		const input: { command: string; timeout?: number } = { command: 'ls' };
		handler?.({ toolName: 'bash', input });
		expect(input.timeout).toBeUndefined();
	});
});
