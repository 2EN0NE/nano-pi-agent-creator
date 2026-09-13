/**
 * tool-range 实验臂（core）的工具集解析契约固定
 *
 * tools.ts 的 resolveCoreToolNames：core 臂 = 基础 4 工具 + 搜索 3 工具，
 * 搜索部分按候选优先级动态解析（增强工具 rg/ffgrep/fffind 优先，缺失回退
 * pi 内置 grep/find/ls），保证任何环境下 core 臂都有搜索能力且恒为 7 个。
 */
import { describe, it, expect } from 'vitest';
import { resolveCoreToolNames } from '../../../extensions/meta/preset/tools.js';

describe('tool-range core 臂工具集契约', () => {
	it('core 臂 = 基础 4 + 搜索 3（恒为 7 个）', () => {
		const all = [
			'read',
			'bash',
			'edit',
			'write',
			'rg',
			'ffgrep',
			'fffind',
			'grep',
			'find',
			'ls',
			'powershell',
		];
		const core = resolveCoreToolNames(all);
		expect(core).toHaveLength(7);
		expect(core).toEqual(['read', 'bash', 'edit', 'write', 'rg', 'ffgrep', 'fffind']);
	});

	it('增强搜索工具缺失时回退 pi 内置搜索工具（保证搜索能力不缺失）', () => {
		const all = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
		expect(resolveCoreToolNames(all)).toEqual([
			'read',
			'bash',
			'edit',
			'write',
			'grep',
			'find',
			'ls',
		]);
	});
});
