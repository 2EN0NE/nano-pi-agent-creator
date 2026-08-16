import { describe, it, expect } from 'vitest';
import {
	ShortcutRegistry,
	groupByPlugin,
} from '../../../extensions/meta/pi-shortcuts/core/registry.ts';

describe('ShortcutRegistry — 子键注册表 + 冲突裁决', () => {
	it('注册单个 entry 后 getEntries 能查到', () => {
		const reg = new ShortcutRegistry();
		const entry = { name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} };
		const result = reg.register(entry);

		expect(result.ok).toBe(true);
		expect(reg.getEntries()).toHaveLength(1);
		expect(reg.getEntries()[0]!.name).toBe('files');
		expect(reg.getEntries()[0]!.keys).toEqual(['f']);
	});

	it('不同 keys 的两个 entry 都能注册', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });
		const result = reg.register({
			name: 'prompt-editor',
			keys: ['p'],
			description: 'Prompt 编辑器',
			handler: () => {},
		});

		expect(result.ok).toBe(true);
		expect(reg.getEntries()).toHaveLength(2);
	});

	it('相同 keys 的第二个 entry 被拒，返回冲突的已有 entry', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });
		const result = reg.register({
			name: 'finder',
			keys: ['f'],
			description: '另一个 f 键插件',
			handler: () => {},
		});

		expect(result.ok).toBe(false);
		expect(result.conflict?.name).toBe('files');
		expect(result.conflict?.keys).toEqual(['f']);
		// 第一个仍然生效，第二个未注册
		expect(reg.getEntries()).toHaveLength(1);
		expect(reg.getEntries()[0]!.name).toBe('files');
	});

	it('同名插件不同 keys（多功能插件）都能注册', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f', 'o'],
			description: '打开文件浏览器',
			handler: () => {},
		});
		const result = reg.register({
			name: 'files',
			keys: ['f', 'r'],
			description: 'Reveal 最新引用',
			handler: () => {},
		});

		expect(result.ok).toBe(true);
		expect(reg.getEntries()).toHaveLength(2);
	});
});

describe('ShortcutRegistry — 前缀冲突与 match', () => {
	it('前缀冲突：注册 ["f"] 与已有 ["f","o"] 冲突被拒', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler: () => {} });
		const result = reg.register({
			name: 'finder',
			keys: ['f'],
			description: '单功能 f',
			handler: () => {},
		});

		expect(result.ok).toBe(false);
		expect(result.conflict?.name).toBe('files');
		expect(reg.getEntries()).toHaveLength(1);
	});

	it('match 精确匹配单个 entry', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });

		const r = reg.match(['f']);
		expect(r.status).toBe('exact');
		if (r.status === 'exact') {
			expect(r.entry.name).toBe('files');
		}
	});

	it('match 前缀匹配（还有子键未按）', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler: () => {} });

		expect(reg.match(['f']).status).toBe('prefix');
	});

	it('match 多级前缀直到 exact', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f', 'o', 'd'],
			description: 'diff',
			handler: () => {},
		});

		expect(reg.match(['f']).status).toBe('prefix');
		expect(reg.match(['f', 'o']).status).toBe('prefix');
		const exact = reg.match(['f', 'o', 'd']);
		expect(exact.status).toBe('exact');
		if (exact.status === 'exact') {
			expect(exact.entry.name).toBe('files');
		}
	});

	it('match 无匹配返回 none', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });

		expect(reg.match(['x']).status).toBe('none');
		expect(reg.match(['f', 'x']).status).toBe('none');
	});
});

describe('ShortcutRegistry — remap（用户自定义子键重映射）', () => {
	it('remap 命中：from 匹配时用 to 替换 keys', () => {
		const reg = new ShortcutRegistry([{ name: 'files', from: ['f', 'o'], to: ['x', 'o'] }]);
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler: () => {} });

		expect(reg.getEntries()[0]!.keys).toEqual(['x', 'o']);
	});

	it('remap 未命中：keys 保持默认', () => {
		const reg = new ShortcutRegistry([{ name: 'files', from: ['f', 'o'], to: ['x', 'o'] }]);
		reg.register({ name: 'files', keys: ['f', 'r'], description: 'reveal', handler: () => {} });

		expect(reg.getEntries()[0]!.keys).toEqual(['f', 'r']);
	});

	it('remap 后冲突：to 被占用时拒绝并返回冲突 entry', () => {
		const reg = new ShortcutRegistry([{ name: 'files', from: ['f', 'o'], to: ['x'] }]);
		reg.register({ name: 'continue', keys: ['x'], description: 'continue', handler: () => {} });
		const result = reg.register({
			name: 'files',
			keys: ['f', 'o'],
			description: '打开',
			handler: () => {},
		});

		expect(result.ok).toBe(false);
		expect(result.conflict?.name).toBe('continue');
		// files 未注册（remap 后冲突被拒）
		expect(reg.getEntries()).toHaveLength(1);
	});

	it('remap 匹配时 match 用新 keys', () => {
		const reg = new ShortcutRegistry([{ name: 'files', from: ['f', 'o'], to: ['x', 'o'] }]);
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler: () => {} });

		expect(reg.match(['x', 'o']).status).toBe('exact');
		expect(reg.match(['f', 'o']).status).toBe('none');
	});
});

describe('ShortcutRegistry — setRemap（运行时改键）', () => {
	it('setRemap 更新生效 keys（无冲突时成功）', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler: () => {} });
		reg.register({ name: 'continue', keys: ['c'], description: 'continue', handler: () => {} });

		const result = reg.setRemap([{ name: 'files', from: ['f', 'o'], to: ['x', 'o'] }]);
		expect(result.ok).toBe(true);
		const files = reg.getEntries().find((e) => e.name === 'files');
		expect(files!.keys).toEqual(['x', 'o']);
		// continue 不受影响
		const cont = reg.getEntries().find((e) => e.name === 'continue');
		expect(cont!.keys).toEqual(['c']);
	});

	it('setRemap 冲突时拒绝并回滚', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler: () => {} });
		reg.register({ name: 'continue', keys: ['c'], description: 'continue', handler: () => {} });

		// files 改到 ['c']，与 continue 冲突
		const result = reg.setRemap([{ name: 'files', from: ['f', 'o'], to: ['c'] }]);
		expect(result.ok).toBe(false);
		expect(result.conflict?.name).toBe('continue');
		// 回滚：files 仍用默认 keys
		const files = reg.getEntries().find((e) => e.name === 'files');
		expect(files!.keys).toEqual(['f', 'o']);
	});

	it('setRemap 空数组恢复默认 keys', () => {
		const reg = new ShortcutRegistry([{ name: 'files', from: ['f', 'o'], to: ['x', 'o'] }]);
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler: () => {} });

		const result = reg.setRemap([]);
		expect(result.ok).toBe(true);
		expect(reg.getEntries()[0]!.keys).toEqual(['f', 'o']);
	});
});

describe('groupByPlugin — 按插件名分组', () => {
	it('同 name 的多个 entry 聚到一组，保持首次出现顺序', () => {
		const entries = [
			{ name: 'answer', keys: ['a'], description: '', handler: () => {} },
			{ name: 'files', keys: ['f', 'o'], description: '', handler: () => {} },
			{ name: 'files', keys: ['f', 'r'], description: '', handler: () => {} },
			{ name: 'continue', keys: ['c'], description: '', handler: () => {} },
			{ name: 'files', keys: ['f', 'q'], description: '', handler: () => {} },
		];
		const groups = groupByPlugin(entries);
		expect(groups.map((g) => g.name)).toEqual(['answer', 'files', 'continue']);
		expect(groups[1]!.entries).toHaveLength(3);
		expect(groups[1]!.entries.map((e) => e.keys.join(' '))).toEqual(['f o', 'f r', 'f q']);
	});

	it('单 entry 插件各成一组', () => {
		const entries = [
			{ name: 'a', keys: ['a'], description: '', handler: () => {} },
			{ name: 'b', keys: ['b'], description: '', handler: () => {} },
		];
		const groups = groupByPlugin(entries);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.name).toBe('a');
	});
});
