/**
 * smart-context 路由：自定义触发的 run 不得进入复杂度分类
 *
 * 背景（pi 1.2+）：`before_agent_start` 变成联合类型 —— 用户提交的 prompt 带
 * `event.prompt`，而 `pi.sendMessage(..., { triggerTurn: true })` 发起的 run
 * （loop / goal / org 等续跑）只有 `event.message`，没有 `event.prompt`。
 *
 * 决策：这类续跑**不重新分类**，沿用父任务已选定的模型；但**大上下文保护必须
 * 仍生效**（该判断与 prompt 无关，位于分类之前）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRouter } from '../../../extensions/context/smart-context/src/router.ts';
import { clearCache } from '../../../extensions/context/smart-context/src/config.ts';

const THRESHOLD = 1_000;

const PROFILE_CONFIG = {
	activeProfile: 'vitest-profile',
	profiles: {
		'vitest-profile': {
			classifier: { provider: 'test-provider', model: 'test-classifier' },
			routing: {
				trivial: { provider: 'test-provider', model: 'test-trivial' },
				simple: { provider: 'test-provider', model: 'test-simple' },
				medium: { provider: 'test-provider', model: 'test-medium' },
				complex: { provider: 'test-provider', model: 'test-complex' },
			},
			largeContext: {
				thresholdTokens: THRESHOLD,
				model: { provider: 'test-provider', model: 'test-large-context' },
			},
		},
	},
};

let cwd = '';

/** 记录 modelRegistry 查询次数：分类器若被调用必然先查 registry */
function makeCtx(tokens: number) {
	const registryCalls: Array<[string, string]> = [];
	const ctx = {
		cwd,
		getContextUsage: () => ({ tokens }),
		modelRegistry: {
			find: (provider: string, model: string) => {
				registryCalls.push([provider, model]);
				// 返回 null 即“分类器模型不在 registry”，走到 warn + return null；
				// 只要断言 registryCalls 为空，就证明根本没进入分类分支。
				return null;
			},
			getApiKeyAndHeaders: async () => ({ ok: false }),
		},
		ui: { setWorkingMessage: () => {}, notify: () => {} },
	};
	return { ctx, registryCalls };
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'smart-context-router-'));
	const dir = join(cwd, '.pi', 'extensions-data', 'smart-context');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'config.json'), JSON.stringify(PROFILE_CONFIG), 'utf8');
	clearCache();
});

afterEach(() => {
	if (cwd) rmSync(cwd, { recursive: true, force: true });
	clearCache();
});

describe('smart-context router — 自定义触发 run 不分类', () => {
	it('没有用户 prompt 时跳过分类，且不查询分类器模型', async () => {
		const { ctx, registryCalls } = makeCtx(THRESHOLD - 1);
		const router = createRouter({} as any);

		const decision = await router.pick(undefined, ctx);

		expect(decision).toBeNull();
		expect(registryCalls).toEqual([]);
	});

	it('没有用户 prompt 但上下文超阈值时，仍切大上下文模型（保护不回退）', async () => {
		const { ctx } = makeCtx(THRESHOLD + 1);
		const router = createRouter({} as any);

		const decision = await router.pick(undefined, ctx);

		expect(decision).not.toBeNull();
		expect(decision?.reason).toBe('largeContext');
		expect(decision?.model).toEqual({
			provider: 'test-provider',
			model: 'test-large-context',
		});
	});

	it('有用户 prompt 且超阈值时，大上下文保护优先于分类（回归）', async () => {
		const { ctx, registryCalls } = makeCtx(THRESHOLD + 1);
		const router = createRouter({} as any);

		const decision = await router.pick('重构整个认证模块', ctx);

		expect(decision?.reason).toBe('largeContext');
		expect(registryCalls).toEqual([]);
	});
});
