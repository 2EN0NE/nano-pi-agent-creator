/**
 * control 运行时开关（ADR-0043 D1）
 *
 * 在岗入口：已开着的 pi 无法热切换 socket（pi 的扩展 API 没有 setFlag，只有 getFlag），
 * 因此 control 需要一个**运行时**开关，让本进程在「建 socket / 不建」之间切换。
 *
 * 这里覆盖该开关的**纯逻辑**（命令解析 + 启用判定）；
 * socket 真的建/拆由 index.ts 的 refreshServer 落地，另由 e2e 验证。
 */
import { describe, it, expect } from 'vitest';
import {
	parseControlToggle,
	resolveControlEnabled,
	socketOrigin,
	CONTROL_STATUS_KEY,
} from '../../../extensions/auto/control/switch.js';

describe('parseControlToggle', () => {
	it('空参数 → status（不带参数时查状态，不改变开关）', () => {
		expect(parseControlToggle('')).toEqual({ action: 'status' });
		expect(parseControlToggle('   ')).toEqual({ action: 'status' });
	});

	it('on / off → 对应动作（大小写与空白不敏感）', () => {
		expect(parseControlToggle('on')).toEqual({ action: 'on' });
		expect(parseControlToggle('OFF')).toEqual({ action: 'off' });
		expect(parseControlToggle('  On  ')).toEqual({ action: 'on' });
	});

	it('无法识别的参数 → 报错并附用法', () => {
		const r = parseControlToggle('maybe');
		expect(r).toMatchObject({ action: 'error' });
		if (r.action === 'error') expect(r.message).toContain('/control [on|off]');
	});
});

describe('resolveControlEnabled', () => {
	it('无运行时 override → 跟随启动 flag', () => {
		expect(resolveControlEnabled({ flagValue: true, override: null })).toBe(true);
		expect(resolveControlEnabled({ flagValue: undefined, override: null })).toBe(false);
		expect(resolveControlEnabled({ flagValue: false, override: null })).toBe(false);
	});

	it('override=on → 即使启动时没带 flag 也启用（热切换上岗）', () => {
		expect(resolveControlEnabled({ flagValue: undefined, override: 'on' })).toBe(true);
		expect(resolveControlEnabled({ flagValue: false, override: 'on' })).toBe(true);
	});

	it('override=off → 即使启动时带了 flag 也停用（热切换离岗）', () => {
		expect(resolveControlEnabled({ flagValue: true, override: 'off' })).toBe(false);
	});

	it('override=status 不参与判定（它不改变开关）', () => {
		expect(resolveControlEnabled({ flagValue: true, override: 'status' })).toBe(true);
		expect(resolveControlEnabled({ flagValue: undefined, override: 'status' })).toBe(false);
	});
});

describe('CONTROL_STATUS_KEY', () => {
	it('状态栏键与既有 control 状态栏一致（不新增键，避免顶掉既有显示）', () => {
		expect(CONTROL_STATUS_KEY).toBe('session-control');
	});
});

describe('socketOrigin（ADR-0046 D4/B5：如实上报启用来源）', () => {
	it('未干预（跟随启动 flag）→ startup', () => {
		expect(socketOrigin(null)).toBe('startup');
	});

	it('运行中人工切换 → runtime', () => {
		expect(socketOrigin('on')).toBe('runtime');
		expect(socketOrigin('off')).toBe('runtime');
	});

	it('status（仅查询，不是一次真实启用）→ runtime：保守不触发对方的自动上岗', () => {
		expect(socketOrigin('status')).toBe('runtime');
	});
});
