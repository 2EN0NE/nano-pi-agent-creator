/**
 * `MOCK_LLM_TOOL_SCRIPT` 的纯逻辑（ADR-0045 D3）。
 *
 * 多 agent 自主闭环 e2e 需要 mock-LLM **按脚本注入任意工具调用**（A 派发 → B 认领/交付 →
 * A 验收），而现有 mock 只能"哑回显"或注入 bash。
 *
 * 脚本格式：JSON 数组，元素为
 *   `{"tool":"<工具名>","args":{...}}`  —— 一次工具调用
 *   `{"text":"..."}`                   —— 一段文本（用于吸收中间的 agent 轮次 / 收尾）
 * 字符串值支持 `{{taskId}}` 之类的**运行时占位符**（任务号 M-xxxx 运行时才生成，
 * 从请求消息里抽取）。
 *
 * 这里覆盖纯逻辑（解析 / 校验 / 占位符替换 / 取值）；与 faux provider 的接线在
 * `mock-llm.ts` 内，由 e2e 覆盖。
 */
import { describe, it, expect } from 'vitest';
import { applyVars, extractScriptVars, parseToolScript } from '../../e2e/helpers/mock-llm.js';

describe('parseToolScript', () => {
	it('未设置 / 空串 → 空脚本（不影响现有用例）', () => {
		expect(parseToolScript(undefined)).toEqual([]);
		expect(parseToolScript('')).toEqual([]);
		expect(parseToolScript('   ')).toEqual([]);
	});

	it('解析工具调用与文本步骤', () => {
		const script = parseToolScript(
			JSON.stringify([{ tool: 'dispatch_task', args: { title: 'T' } }, { text: 'done' }]),
		);
		expect(script).toEqual([{ tool: 'dispatch_task', args: { title: 'T' } }, { text: 'done' }]);
	});

	it('非法 JSON / 非数组 / 元素非法 → 抛错并说明（fail fast，不静默跳过）', () => {
		expect(() => parseToolScript('{oops')).toThrow(/MOCK_LLM_TOOL_SCRIPT/);
		expect(() => parseToolScript('{"tool":"x"}')).toThrow(/数组/);
		expect(() => parseToolScript('[{"args":{}}]')).toThrow(/tool|text/);
		expect(() => parseToolScript('[{"tool":123}]')).toThrow(/tool/);
	});
});

describe('extractScriptVars', () => {
	it('从请求消息里抽出任务号（M-xxxx）——运行时才生成，故不能写死在脚本里', () => {
		const messages = [
			{ role: 'user', content: '请把任务 M-ab12cd34 派给 worker-a' },
			{ role: 'tool', content: [{ type: 'text', text: 'ok' }] },
		];
		expect(extractScriptVars(messages).taskId).toBe('M-ab12cd34');
	});

	it('抽不到 → 空串（不抛错）', () => {
		expect(extractScriptVars([{ role: 'user', content: '没有任务号' }]).taskId).toBe('');
		expect(extractScriptVars(undefined).taskId).toBe('');
	});

	it('嵌套 content 数组里的文本也能抽到', () => {
		const messages = [{ role: 'user', content: [{ type: 'text', text: 'M-zz99yy88 交付' }] }];
		expect(extractScriptVars(messages).taskId).toBe('M-zz99yy88');
	});
});

describe('applyVars', () => {
	it('替换字符串里的 {{key}}（含多处、嵌套对象与数组）', () => {
		const vars = { taskId: 'M-1', who: 'boss' };
		expect(applyVars('任务 {{taskId}} 由 {{who}} 派发', vars)).toBe('任务 M-1 由 boss 派发');
		expect(applyVars({ a: ['{{taskId}}', { b: '{{who}}' }] }, vars)).toEqual({
			a: ['M-1', { b: 'boss' }],
		});
	});

	it('未知占位符替换为空串（不残留 {{}}，避免把语法泄漏给模型）', () => {
		expect(applyVars('x{{nope}}y', { taskId: 'M-1' })).toBe('xy');
	});

	it('非字符串原样返回（数字 / 布尔 / null 不受影响）', () => {
		expect(applyVars(7, {})).toBe(7);
		expect(applyVars(true, {})).toBe(true);
		expect(applyVars(null, {})).toBe(null);
	});
});
