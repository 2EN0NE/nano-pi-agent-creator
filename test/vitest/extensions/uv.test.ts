/**
 * uv 扩展 — tool_call 拦截逻辑测试
 *
 * 验证 uv.ts 的 bash 工具拦截：
 *   - pip / pip3 / poetry / python -m pip / python -m venv / python -m py_compile 被 block
 *   - 非 bash 工具不拦截、普通命令不拦截
 *   - PATH prepend 指向真实存在的 intercepted-commands 目录（回归：路径修正 .. → ../..）
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import uvExtension from '../../../extensions/accuracy/uv.js';

interface ToolCallEvent {
	toolName: string;
	input: { command: string };
}

function makeFakePi() {
	const toolCallHandlers: Array<(event: ToolCallEvent, ctx: unknown) => unknown> = [];
	const pi = {
		on: (event: string, handler: (e: ToolCallEvent, ctx: unknown) => unknown) => {
			if (event === 'tool_call') toolCallHandlers.push(handler);
		},
	};
	uvExtension(pi as never);
	return { handler: toolCallHandlers[0] };
}

function runToolCall(
	handler: (e: ToolCallEvent, ctx: unknown) => unknown,
	toolName: string,
	command: string,
) {
	const event: ToolCallEvent = { toolName, input: { command } };
	const result = handler(event, {});
	return { event, result };
}

describe('uv 扩展 — 拦截规则', () => {
	const { handler } = makeFakePi();

	it('pip install 被拦截，提示改用 uv', () => {
		const { result } = runToolCall(handler, 'bash', 'pip install requests');
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain('pip 已被禁用');
	});

	it('pip3 被拦截', () => {
		const { result } = runToolCall(handler, 'bash', 'pip3 install requests');
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain('pip3 已被禁用');
	});

	it('poetry 被拦截', () => {
		const { result } = runToolCall(handler, 'bash', 'poetry add requests');
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain('poetry 已被禁用');
	});

	it('python -m pip 被拦截', () => {
		const { result } = runToolCall(handler, 'bash', 'python -m pip install requests');
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain('python -m pip');
	});

	it('python -m venv 被拦截', () => {
		const { result } = runToolCall(handler, 'bash', 'python -m venv .venv');
		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain('python -m venv');
	});

	it('python -m py_compile 被拦截', () => {
		const { result } = runToolCall(handler, 'bash', 'python -m py_compile a.py');
		expect(result).toMatchObject({ block: true });
	});

	it('非 bash 工具不拦截', () => {
		const { result } = runToolCall(handler, 'edit', 'pip install requests');
		expect(result).toBeUndefined();
	});

	it('普通命令不拦截，但 prepend PATH', () => {
		const { event, result } = runToolCall(handler, 'bash', 'echo hi');
		expect(result).toBeUndefined();
		expect(event.input.command).toContain('export PATH=');
	});

	it('命令中段的分号后 pip 也被拦截（shell segment 匹配）', () => {
		const { result } = runToolCall(handler, 'bash', 'echo done; pip install requests');
		expect(result).toMatchObject({ block: true });
	});
});

describe('uv 扩展 — PATH prepend 指向真实目录（回归：.. → ../.. 修正）', () => {
	it('prepend 的 intercepted-commands 路径真实存在', () => {
		const { handler } = makeFakePi();
		const { event } = runToolCall(handler, 'bash', 'echo hi');
		const m = event.input.command.match(/export PATH="([^"]+):\$PATH"/);
		expect(m).toBeTruthy();
		expect(m![1]).toContain('intercepted-commands');
		expect(existsSync(m![1])).toBe(true);
	});
});
