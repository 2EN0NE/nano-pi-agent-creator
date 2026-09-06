/**
 * tool-range 实验臂与 preset 默认工具集的契约固定
 *
 * tools.ts 的 resolveCoreToolNames（core 臂 = 基础 4 工具 + 搜索 3 工具）与
 * preset.ts 的 DEFAULT_CLEAR_TOOLS（清除预设恢复的 4 工具）存在隐含对照关系：
 * core 臂的基础部分 = preset 默认工具集，搜索部分按候选优先级动态解析
 * （增强工具 rg/ffgrep/fffind 优先，缺失回退 pi 内置 grep/find/ls）。
 * 任一侧变更（如 preset 默认集增减工具）会导致实验对照基准漂移，
 * 此测试将对照关系固定下来，变更时显式失败。
 */
import { describe, it, expect } from 'vitest';
import { resolveCoreToolNames } from '../../../extensions/meta/preset/tools.js';
import { DEFAULT_CLEAR_TOOLS } from '../../../extensions/meta/preset/index.js';

describe('tool-range 臂与 preset 默认工具集契约', () => {
	it('core 臂始终包含 preset 清除后恢复的默认工具集', () => {
		// 覆盖三种环境：增强工具齐备 / 仅 pi 内置 / 部分增强
		const cases: string[][] = [
			['read', 'bash', 'edit', 'write', 'rg', 'ffgrep', 'fffind'],
			['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
			['read', 'bash', 'edit', 'write', 'rg', 'grep', 'find', 'ls'],
		];
		for (const all of cases) {
			const core = resolveCoreToolNames(all);
			for (const tool of DEFAULT_CLEAR_TOOLS) {
				expect(core).toContain(tool);
			}
		}
	});

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
