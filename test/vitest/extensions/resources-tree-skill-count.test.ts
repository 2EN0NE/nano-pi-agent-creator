/**
 * resources-tree — 技能分母（`fsSkillCount`）回归测试
 *
 * 回归背景：preset 的 skills 白名单会**就地裁剪**事件链上共享的
 * `event.systemPromptOptions.skills`（ADR-0066），handler 顺序不同就会让分母变成
 * 「可见集」（如 preset 全禁技能时显示 `0/0`）。分母必须取 `pi.getCommands()`
 * （`source === 'skill'`，直读 resourceLoader 的完整清单），不得取事件里的 options。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import resourcesTree from '../../../extensions/context/resources-tree/index.js';
import { state } from '../../../extensions/context/resources-tree/state.js';

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeFakePi(skillCommandNames: string[]) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		appendEntry: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		getCommands: () =>
			skillCommandNames.map((name) => ({
				name: `skill:${name}`,
				source: 'skill',
				sourceInfo: { source: 'skill', scope: 'user', origin: 'top-level' },
			})),
	};
	return { pi, handlers };
}

/** 模拟「preset 已就地裁剪」后的事件：options.skills 只剩可见集。 */
function fireBeforeAgentStart(handlers: Map<string, Handler[]>, visibleSkills: string[]) {
	const handlersForEvent = handlers.get('before_agent_start') ?? [];
	const event = {
		systemPrompt: visibleSkills
			.map((n) => `<available_skills><skill><name>${n}</name></skill></available_skills>`)
			.join('\n'),
		systemPromptOptions: {
			skills: visibleSkills.map((name) => ({ name, description: `${name} desc` })),
		},
	};
	return Promise.all(handlersForEvent.map((h) => h(event, {})));
}

describe('resources-tree 技能分母（ADR-0066 跨扩展契约）', () => {
	beforeEach(() => {
		state.loadedSkills = [];
		state.xmlSkillCount = 0;
		state.fsSkillCount = 0;
	});

	it('options.skills 被 preset 裁剪后，分母仍取 pi.getCommands() 的全量', async () => {
		const { pi, handlers } = makeFakePi(['alpha', 'beta']);
		resourcesTree(pi as never);

		await fireBeforeAgentStart(handlers, ['alpha']);

		expect(state.fsSkillCount).toBe(2);
	});

	it('preset 全禁技能（options.skills 为空）时分母不变 0', async () => {
		const { pi, handlers } = makeFakePi(['alpha', 'beta']);
		resourcesTree(pi as never);

		await fireBeforeAgentStart(handlers, []);

		expect(state.fsSkillCount).toBe(2);
	});
});
