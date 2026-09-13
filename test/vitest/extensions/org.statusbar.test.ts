/**
 * org 状态栏（ADR-0043 D3）：`|org: x/y/z成员`
 *
 *   x = 在岗且忙（busy=true，主题亮色）
 *   y = 在岗数量（正常色）
 *   z = 本 org 注册成员数（暗色 dim）
 *
 * 三段各自配色，故格式化函数接受一个着色器（真实调用传入 theme.fg，测试传记录器）。
 * 纯函数：不读盘、不探测 socket（在岗数量由调用方从 presence 快照算出）。
 */
import { describe, it, expect } from 'vitest';
import {
	countOrgStatus,
	formatOrgStatus,
	type OrgStatusTone,
} from '../../../extensions/auto/org/statusbar.js';
import type { PresenceState } from '../../../extensions/auto/org/presence.js';

describe('countOrgStatus', () => {
	it('四态归类：睡眠不计入在岗；工作中计入在岗且忙', () => {
		const states: PresenceState[] = ['working', 'idle', 'sleeping', 'delivered'];
		expect(countOrgStatus(states)).toEqual({ working: 1, online: 3, total: 4 });
	});

	it('全部睡眠 → 0/0/n（成员数仍如实显示）', () => {
		expect(countOrgStatus(['sleeping', 'sleeping'])).toEqual({
			working: 0,
			online: 0,
			total: 2,
		});
	});

	it('空组织 → 0/0/0', () => {
		expect(countOrgStatus([])).toEqual({ working: 0, online: 0, total: 0 });
	});
});

describe('formatOrgStatus', () => {
	it('默认（无着色）→ `|org: x/y/z成员`（必须以半角 | 开头，见 TUI 规范 §2.1）', () => {
		expect(formatOrgStatus({ working: 1, online: 2, total: 3 })).toBe('|org: 1/2/3成员');
		expect(formatOrgStatus({ working: 0, online: 0, total: 0 })).toBe('|org: 0/0/0成员');
	});

	it('三段分别着色：x=busy（亮）、y=onDuty（正常）、z=dim（暗）', () => {
		const seen: { tone: OrgStatusTone; text: string }[] = [];
		const out = formatOrgStatus({ working: 4, online: 5, total: 6 }, (tone, text) => {
			seen.push({ tone, text });
			return `<${text}>`;
		});
		expect(seen).toEqual([
			{ tone: 'busy', text: '4' },
			{ tone: 'onDuty', text: '5' },
			{ tone: 'dim', text: '6' },
		]);
		expect(out).toBe('|org: <4>/<5>/<6>成员');
	});
});
