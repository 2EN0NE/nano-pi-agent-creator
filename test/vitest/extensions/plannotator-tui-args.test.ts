/**
 * plannotator-tui 的命令参数与 herdr argv — 纯函数单测。
 *
 * 契约（ticket 01）：`open | last | newest | terminal | <路径>` 行为不变；
 * `send` / `paste` 已随终端批注能力移除，只保留「已移除」提示。
 */
import { describe, expect, it } from 'vitest';
import { resolveArgument } from '../../../extensions/tui/plannotator-tui/index.js';
import { tuiArgs } from '../../../extensions/tui/plannotator-tui/herdr.js';

const alwaysExists = (): boolean => true;
const neverExists = (): boolean => false;

describe('tuiArgs', () => {
	const pane = 'w1:p2';

	it('file 目标用 herdr open 并点名 pane', () => {
		expect(tuiArgs('file', pane, '/repo/AGENTS.md')).toEqual([
			'herdr',
			'open',
			'/repo/AGENTS.md',
			'--deliver-to',
			pane,
		]);
	});

	it('last / newest / terminal 的 argv', () => {
		expect(tuiArgs('last', pane, '')).toEqual(['herdr', 'last', '--deliver-to', pane]);
		expect(tuiArgs('newest', pane, '')).toEqual([
			'herdr',
			'last',
			'--newest',
			'--deliver-to',
			pane,
		]);
		expect(tuiArgs('terminal', pane, '')).toEqual(['herdr', 'terminal', '--deliver-to', pane]);
	});
});

describe('resolveArgument', () => {
	const cwd = '/repo';

	it('open 打开当前目录（文件夹模式）', () => {
		expect(resolveArgument('open', cwd, neverExists)).toEqual({
			kind: 'review',
			reviewKind: 'file',
			target: cwd,
		});
	});

	it('评审别名直通', () => {
		for (const alias of ['last', 'newest', 'terminal']) {
			expect(resolveArgument(alias, cwd, neverExists)).toEqual({
				kind: 'review',
				reviewKind: alias,
				target: '',
			});
		}
	});

	it('已移除的终端批注参数单独识别', () => {
		for (const removed of ['send', 'send-archive', 'paste', 'paste-archive']) {
			expect(resolveArgument(removed, cwd, alwaysExists)).toEqual({
				kind: 'removed',
				argument: removed,
			});
		}
	});

	it('存在的相对路径解析成绝对路径', () => {
		expect(resolveArgument('docs/plan.md', cwd, alwaysExists)).toEqual({
			kind: 'review',
			reviewKind: 'file',
			target: '/repo/docs/plan.md',
		});
	});

	it('不存在的路径报未知', () => {
		expect(resolveArgument('nope.md', cwd, neverExists)).toEqual({
			kind: 'unknown',
			argument: 'nope.md',
		});
	});
});
