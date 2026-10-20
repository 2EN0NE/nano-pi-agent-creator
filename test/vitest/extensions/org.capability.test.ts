/**
 * org 能力收 / 放（ADR-0043 D4，细化 ADR-0041 D2）。
 *
 * 工具**注册**只在首次在岗时发生一次；此后在岗状态的热切换靠 `setActiveTools`：
 * 离岗 → 把 org 工具移出活动集（工具仍在注册表里，但 LLM 看不到、系统提示也不列）；
 * 在岗 → 加回。
 *
 * 注意：pi 的 `registerTool` 内部会调 `refreshTools()`，新注册的工具会自动进入活动集，
 * 所以「放」不需要额外调用；「收」必须显式 `setActiveTools`。
 *
 * 这里用 fake pi 覆盖纯逻辑；真实 pi 的行为由 e2e（ADR-0045 L4）验证。
 */
import { describe, it, expect } from 'vitest';
import {
	applyOrgCapability,
	isOrgTool,
	ORG_TOOL_NAMES,
} from '../../../extensions/auto/org/capability.js';

function fakePi(active: string[]) {
	const calls: string[][] = [];
	let current = [...active];
	return {
		calls,
		api: {
			getActiveTools: () => [...current],
			setActiveTools: (names: string[]) => {
				calls.push([...names]);
				current = [...names];
			},
		},
		get active() {
			return [...current];
		},
	};
}

describe('ORG_TOOL_NAMES', () => {
	// 本文件只校验**常量清单**；「真实注册/活动集与常量一致」由 e2e 断言
	// （`test/e2e/extensions/org/smoke.test.sh` 用例 8：在岗可见面 = org_tool_names 抽取值），
	// 防止这里只是把常量与同一份字面量自证。
	it('就是这 11 个 org 工具（常量清单；ADR-0048 加 org_wake，ADR-0053 加 org_abort，ADR-0055 加 org_urgent）', () => {
		expect([...ORG_TOOL_NAMES].sort()).toEqual(
			[
				'dispatch_task',
				'org_abort',
				'org_urgent',
				'org_accept',
				'org_claim',
				'org_fleet',
				'org_wake',
				'org_my_tasks',
				'org_reject',
				'org_report',
				'org_review',
			].sort(),
		);
	});

	it('isOrgTool 只认这 9 个', () => {
		expect(isOrgTool('dispatch_task')).toBe(true);
		expect(isOrgTool('bash')).toBe(false);
		expect(isOrgTool('send_to_session')).toBe(false);
	});
});

describe('applyOrgCapability', () => {
	it('离岗：把 org 工具移出活动集，非 org 工具原样保留', () => {
		const pi = fakePi(['bash', 'org_claim', 'read', 'org_review']);
		applyOrgCapability(pi.api, false);
		expect(pi.active).toEqual(['bash', 'read']);
	});

	it('在岗：把 8 个 org 工具加回，且不丢别的、不重复', () => {
		const pi = fakePi(['bash', 'org_claim']);
		applyOrgCapability(pi.api, true);
		expect(pi.active).toContain('bash');
		expect(pi.active.filter((n) => n === 'org_claim')).toHaveLength(1);
		for (const n of ORG_TOOL_NAMES) expect(pi.active).toContain(n);
	});

	it('幂等：状态已经正确时不要调 setActiveTools（避免无谓重建系统提示）', () => {
		const off = fakePi(['bash', 'read']);
		applyOrgCapability(off.api, false);
		expect(off.calls).toHaveLength(0);

		const on = fakePi(['bash', ...ORG_TOOL_NAMES]);
		applyOrgCapability(on.api, true);
		expect(on.calls).toHaveLength(0);
	});

	it('离岗不误伤别的扩展的工具（只移除 org 的）', () => {
		const pi = fakePi(['bash', 'send_to_session', 'list_sessions', 'org_fleet']);
		applyOrgCapability(pi.api, false);
		expect(pi.active).toEqual(['bash', 'send_to_session', 'list_sessions']);
	});
});
