/**
 * e2e 探针扩展：把每轮「LLM 真实可见面」追加写入 `$LLM_SURFACE_DUMP_FILE`。
 *
 * 为什么用 `before_agent_start` 而不是 `before_provider_request`：
 * e2e 用 mock-llm（`registerFauxProvider`）替代真实服务商，faux provider 不走
 * provider payload 构造路径，`before_provider_request` 不触发。`before_agent_start`
 * 的 `systemPromptOptions` 是与服务商无关的**权威可见面**（激活工具 / 已加载技能 /
 * 系统提示全文）。
 *
 * 用途：断言 org 在岗门控的效果——
 *   - 未在岗：`tools` 不含 `dispatch_task`，`skills` 不含 org 技能；
 *   - 在岗：二者都出现，且系统提示里含在岗简报的静态块。
 *
 * 仅测试使用；只返回 undefined（不改动系统提示与消息）。
 */
import { appendFileSync } from 'node:fs';
import { createLogger } from '@zenone/pi-logger';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const log = createLogger('llm-surface-dump');

/** 从（形状不确定的）skills 字段里抽出技能名数组 */
function skillNamesOf(skills: unknown): string[] {
	if (!Array.isArray(skills)) return [];
	return skills.map((s) => {
		if (typeof s === 'string') return s;
		if (s && typeof s === 'object') {
			const o = s as { name?: unknown; id?: unknown };
			if (typeof o.name === 'string') return o.name;
			if (typeof o.id === 'string') return o.id;
		}
		return '';
	});
}

/** 把（形状不确定的）LLM 上下文消息压成纯文本，便于断言"模型看得到什么" */
function messagesToText(messages: unknown): string {
	if (!Array.isArray(messages)) return '';
	const out: string[] = [];
	const walk = (v: unknown): void => {
		if (typeof v === 'string') {
			out.push(v);
			return;
		}
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (v && typeof v === 'object') {
			const o = v as Record<string, unknown>;
			// 可见文本有两种承载：`content: [{type:'text'|'toolResult', text}]` 与
			// message 级 `content: string`。只跟随 content 会漏掉前者 →
			// contextText 假空 → "据实告知"类断言假阴性（ADR-0048 E3 曾因此失败）。
			if (typeof o.text === 'string') out.push(o.text);
			if (o.content !== undefined) walk(o.content);
		}
	};
	for (const m of messages) walk(m);
	return out.join('\n');
}

export default function (pi: ExtensionAPI) {
	const file = process.env.LLM_SURFACE_DUMP_FILE;
	if (!file) {
		log.info('未设置 LLM_SURFACE_DUMP_FILE，探针不生效');
		return;
	}
	// before_agent_start 里拿得到的东西：用户轮次文本、激活工具、已加载技能
	let lastPrompt = '';
	let lastTools: string[] | null = null;
	let lastSkills: string[] = [];
	pi.on('before_agent_start', (event) => {
		const e = event as unknown as {
			prompt?: string;
			systemPromptOptions?: { selectedTools?: string[]; skills?: unknown };
		};
		lastPrompt = e.prompt ?? '';
		lastTools = e.systemPromptOptions?.selectedTools ?? null;
		lastSkills = skillNamesOf(e.systemPromptOptions?.skills);
		return undefined;
	});

	// 在 agent_start 落一条记录：此时**所有** before_agent_start 处理链已跑完，
	// ctx.getSystemPrompt() 才是"最终发给服务商"的系统提示（含本扩展的静态简报）。
	pi.on('agent_start', (_event, ctx) => {
		try {
			appendFileSync(
				file,
				`${JSON.stringify({
					tools: lastTools,
					skillNames: lastSkills,
					systemPrompt: ctx.getSystemPrompt() ?? '',
					prompt: lastPrompt,
				})}\n`,
				'utf8',
			);
		} catch (e) {
			log.warn('可见面写入失败', { err: e instanceof Error ? e.message : String(e) });
		}
		return undefined;
	});

	// 追加一条"上下文"记录：**消息级**可见面（系统提示之外的 custom/user 消息）。
	// 用途：断言消息级可见面（成员消息带发送者头、未在岗告知**不**污染上下文等）。
	// 注：`context` 在 agent_start 之后才触发，故不能并入上面那条记录。
	pi.on('context', (event) => {
		try {
			const messages = (event as unknown as { messages?: unknown }).messages;
			appendFileSync(
				file,
				`${JSON.stringify({ phase: 'context', contextText: messagesToText(messages) })}\n`,
				'utf8',
			);
		} catch (e) {
			log.warn('上下文写入失败', { err: e instanceof Error ? e.message : String(e) });
		}
		return undefined;
	});
	log.info('llm-surface-dump 就绪', { file });
}
