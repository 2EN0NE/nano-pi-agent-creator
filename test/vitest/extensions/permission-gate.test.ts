/**
 * permission-gate 动态策略 — Vitest 单元测试
 *
 * 测试 config.ts 中导出的纯函数：
 *   - makeCommandKey / makeToolKey / makeFolderKey
 *   - deepMerge（配置合并）
 *   - resolveConfigPath
 *   - getDefaultConfig
 */

import { describe, it, expect } from 'vitest';
import {
	makeCommandKey,
	makeToolKey,
	makeFolderKey,
	deepMerge,
	getDefaultConfig,
	resolveConfigPath,
} from '../../../extensions/security/permission-gate/config';
import type { PermissionGateConfig } from '../../../extensions/security/permission-gate/config';
import {
	getStrategySummary,
	calcWidgetContentText,
	splitCompoundCommand,
	normalizeDim,
	countNonBlockedEntries,
} from '../../../extensions/security/permission-gate/records';
import type { ApprovalEntry } from '../../../extensions/security/permission-gate/records';
import {
	pathInScope,
	extractTargetPaths,
	extractToolName,
	extractTargetDir,
	checkThreshold,
	hasGraduatedStrategy,
} from '../../../extensions/security/permission-gate/index';
import { buildStrategyItems } from '../../../extensions/security/permission-gate/two-tab-panel';

// ============================================================================
// makeCommandKey
// ============================================================================
describe('makeCommandKey', () => {
	it('generates deterministic keys for same command', () => {
		const k1 = makeCommandKey('rm -rf /tmp/test');
		const k2 = makeCommandKey('rm -rf /tmp/test');
		expect(k1).toBe(k2);
		expect(k1).toMatch(/^cmd:[a-f0-9]{16}$/);
	});

	it('normalizes whitespace', () => {
		const k1 = makeCommandKey('rm  -rf   /tmp/test');
		const k2 = makeCommandKey('rm -rf /tmp/test');
		expect(k1).toBe(k2);
	});

	it('generates different keys for different commands', () => {
		const k1 = makeCommandKey('rm -rf /tmp/a');
		const k2 = makeCommandKey('rm -rf /tmp/b');
		expect(k1).not.toBe(k2);
	});
});

// ============================================================================
// 集成测试：两个相同命令 → 2/2 → 沉淀
// ============================================================================
describe('Integration: same command twice graduates at threshold', () => {
	const thresholds = { sameCommand: 2, sameTool: 3, sameFolder: 4 };

	it('simulates appendRecord flow for identical commands', () => {
		const counts: Record<string, number> = {};
		const command = 'rm -rf /tmp/test';
		const toolName = 'rm';
		const targetDir = '/tmp';

		// 第1次
		const cmdKey1 = makeCommandKey(command);
		counts[cmdKey1] = (counts[cmdKey1] ?? 0) + 1;
		counts[makeToolKey(toolName)] = (counts[makeToolKey(toolName)] ?? 0) + 1;
		counts[makeFolderKey(targetDir)] = (counts[makeFolderKey(targetDir)] ?? 0) + 1;

		let s = getStrategySummary(counts, thresholds);
		expect(s.cmd).toEqual({ total: 1, active: 1 }); // 1 < 2 => active
		expect(calcWidgetContentText(true, true, counts, thresholds, 1)).toMatch(
			/cmd\(1\[\d+\]\):1\/2/,
		);

		// 第2次：同一命令
		counts[cmdKey1] = (counts[cmdKey1] ?? 0) + 1;
		counts[makeToolKey(toolName)] = (counts[makeToolKey(toolName)] ?? 0) + 1;
		counts[makeFolderKey(targetDir)] = (counts[makeFolderKey(targetDir)] ?? 0) + 1;

		s = getStrategySummary(counts, thresholds);
		expect(s.cmd).toEqual({ total: 1, active: 0 }); // 2 >= 2 => 沉淀
		expect(calcWidgetContentText(true, true, counts, thresholds, 2)).toMatch(
			/cmd\(1\[\d+\]\):0\/2/,
		); // 已沉淀，无活跃策略可显示，0/2

		// 第3次：同一命令，所有维度都超
		counts[cmdKey1] = (counts[cmdKey1] ?? 0) + 1;
		counts[makeToolKey(toolName)] = (counts[makeToolKey(toolName)] ?? 0) + 1;
		counts[makeFolderKey(targetDir)] = (counts[makeFolderKey(targetDir)] ?? 0) + 1;

		s = getStrategySummary(counts, thresholds);
		expect(s.tool).toEqual({ total: 1, active: 0 }); // tool: 3 >= 3 => 也沉淀
		expect(s.cmd).toEqual({ total: 1, active: 0 });
	});
});

// ============================================================================
// splitCompoundCommand
// ============================================================================
describe('splitCompoundCommand', () => {
	it('simple command stays as one', () => {
		expect(splitCompoundCommand('rm -rf /tmp')).toEqual(['rm -rf /tmp']);
	});

	it('splits on &&', () => {
		expect(splitCompoundCommand('rm -rf /tmp && echo done')).toEqual([
			'rm -rf /tmp',
			'echo done',
		]);
	});

	it('splits on ||', () => {
		expect(splitCompoundCommand('cd /tmp || exit 1')).toEqual(['cd /tmp', 'exit 1']);
	});

	it('splits on ;', () => {
		expect(splitCompoundCommand('cd /tmp; ls')).toEqual(['cd /tmp', 'ls']);
	});

	it('splits on | (pipe)', () => {
		expect(splitCompoundCommand('cat file | grep foo')).toEqual(['cat file', 'grep foo']);
	});

	it('handles multiple operators', () => {
		expect(splitCompoundCommand('rm -rf /tmp && cd /tmp || echo fail')).toEqual([
			'rm -rf /tmp',
			'cd /tmp',
			'echo fail',
		]);
	});

	it('preserves && inside single quotes', () => {
		const result = splitCompoundCommand("echo 'a && b' && echo c");
		expect(result).toEqual(["echo 'a && b'", 'echo c']);
	});

	it('preserves && inside double quotes', () => {
		const result = splitCompoundCommand('echo "a && b" && echo c');
		expect(result).toEqual(['echo "a && b"', 'echo c']);
	});

	it('preserves | inside $() subshell', () => {
		const result = splitCompoundCommand('rm -rf $(cat /tmp/list | head -1) && echo done');
		expect(result).toEqual(['rm -rf $(cat /tmp/list | head -1)', 'echo done']);
	});

	it('preserves | inside backtick command substitution', () => {
		const result = splitCompoundCommand('rm `find /tmp -name "*.log" | head -5` && echo done');
		expect(result).toEqual(['rm `find /tmp -name "*.log" | head -5`', 'echo done']);
	});

	it('handles empty/whitespace input', () => {
		expect(splitCompoundCommand('')).toEqual(['']);
		// 纯空白保留原始值（调用方会用 .trim()）
		expect(splitCompoundCommand('   ')).toEqual(['   ']);
	});

	it('no split if only trailing separator', () => {
		expect(splitCompoundCommand('ls;')).toEqual(['ls']);
	});
});

// ============================================================================
// makeToolKey
// ============================================================================
describe('makeToolKey', () => {
	it('generates tool: prefix keys', () => {
		expect(makeToolKey('rm')).toBe('tool:rm');
		expect(makeToolKey('sudo')).toBe('tool:sudo');
	});
});

// ============================================================================
// makeFolderKey
// ============================================================================
describe('makeFolderKey', () => {
	it('generates dir: prefix keys', () => {
		expect(makeFolderKey('/tmp/test')).toBe('dir:/tmp/test');
	});

	it('strips trailing slashes', () => {
		expect(makeFolderKey('/tmp/test/')).toBe('dir:/tmp/test');
		expect(makeFolderKey('/tmp/test//')).toBe('dir:/tmp/test');
	});
});

// ============================================================================
// deepMerge
// ============================================================================
describe('deepMerge', () => {
	it('merges dynamic policy thresholds', () => {
		const base = getDefaultConfig();
		const overrides = {
			dynamicPolicyEnabled: true,
			dynamicPolicy: {
				scope: '/custom',
				thresholds: {
					sameCommand: 5,
				},
			},
		} as Partial<PermissionGateConfig>;
		const merged = deepMerge(base, overrides);
		expect(merged.dynamicPolicyEnabled).toBe(true);
		expect(merged.dynamicPolicy.scope).toBe('/custom');
		expect(merged.dynamicPolicy.thresholds.sameCommand).toBe(5);
		expect(merged.dynamicPolicy.thresholds.sameTool).toBe(
			base.dynamicPolicy.thresholds.sameTool,
		);
		expect(merged.dynamicPolicy.thresholds.sameFolder).toBe(
			base.dynamicPolicy.thresholds.sameFolder,
		);
	});

	it('overrides patterns (not concat)', () => {
		const base = getDefaultConfig();
		const overrides: Partial<PermissionGateConfig> = {
			patterns: ['\\brm\\s'],
		};
		const merged = deepMerge(base, overrides);
		expect(merged.patterns).toEqual(['\\brm\\s']);
	});

	it('keeps enabled when not overridden', () => {
		const base: PermissionGateConfig = {
			...getDefaultConfig(),
			enabled: true,
		};
		const merged = deepMerge(base, {});
		expect(merged.enabled).toBe(true);
	});

	it('merges widget fields — overrides show to false while keeping detailLevel', () => {
		const base = getDefaultConfig();
		expect(base.widget).toEqual({ show: true, detailLevel: 'full' });

		const merged = deepMerge(base, {
			widget: { show: false, detailLevel: 'full' },
		});
		expect(merged.widget.show).toBe(false);
		expect(merged.widget.detailLevel).toBe('full');
	});

	it('merges widget fields — overrides detailLevel to gate while keeping show', () => {
		const base = getDefaultConfig();
		const merged = deepMerge(base, {
			widget: { show: true, detailLevel: 'gate' },
		});
		expect(merged.widget.show).toBe(true);
		expect(merged.widget.detailLevel).toBe('gate');
	});

	it('merges widget fields — overrides both show and detailLevel', () => {
		const base = getDefaultConfig();
		const merged = deepMerge(base, {
			widget: { show: false, detailLevel: 'gate' },
		});
		expect(merged.widget.show).toBe(false);
		expect(merged.widget.detailLevel).toBe('gate');
	});
});

// ============================================================================
// getDefaultConfig
// ============================================================================
describe('getDefaultConfig', () => {
	it('returns a valid config', () => {
		const config = getDefaultConfig();
		expect(config.enabled).toBe(true);
		expect(config.dynamicPolicyEnabled).toBe(false);
		expect(config.patterns.length).toBeGreaterThan(0);
		expect(config.dynamicPolicy.thresholds.sameCommand).toBe(2);
		expect(config.dynamicPolicy.thresholds.sameTool).toBe(3);
		expect(config.dynamicPolicy.thresholds.sameFolder).toBe(4);
		expect(config.dynamicPolicy.scope).toBe('.');
	});

	it('has dangerous patterns that match expected commands', () => {
		const config = getDefaultConfig();
		const checkMatch = (pattern: string, cmd: string): boolean => {
			return new RegExp(pattern, 'i').test(cmd);
		};
		expect(config.patterns.some((p) => checkMatch(p, 'rm -rf /tmp/x'))).toBe(true);
		expect(config.patterns.some((p) => checkMatch(p, 'sudo rm -rf /'))).toBe(true);
		expect(config.patterns.some((p) => checkMatch(p, 'eval ls'))).toBe(true);
		expect(config.patterns.some((p) => checkMatch(p, 'chmod +x file'))).toBe(true);
	});
});

// ============================================================================
// resolveConfigPath
// ============================================================================
describe('resolveConfigPath', () => {
	it('resolves project config path', () => {
		const path = resolveConfigPath('/my/project', 'project');
		expect(path).toContain('.pi/extensions-data/permission-gate/config.json');
		expect(path).toContain('/my/project');
	});

	it('resolves user config path', () => {
		const path = resolveConfigPath('/any/cwd', 'user');
		expect(path).toContain('/.pi/agent/extensions-data/permission-gate/config.json');
	});
});

// ============================================================================
// getStrategySummary
// ============================================================================
describe('getStrategySummary', () => {
	const thresholds = { sameCommand: 2, sameTool: 3, sameFolder: 4 };

	it('returns all zeros for empty counts', () => {
		const s = getStrategySummary({}, thresholds);
		expect(s).toEqual({
			cmd: { total: 0, active: 0 },
			tool: { total: 0, active: 0 },
			dir: { total: 0, active: 0 },
		});
	});

	it('counts cmd keys correctly (2 total, 1 active)', () => {
		const counts = {
			'cmd:abc123': 1,
			'cmd:def456': 2,
		};
		const s = getStrategySummary(counts, thresholds);
		expect(s.cmd).toEqual({ total: 2, active: 1 });
		expect(s.tool).toEqual({ total: 0, active: 0 });
		expect(s.dir).toEqual({ total: 0, active: 0 });
	});

	it('counts tool keys correctly', () => {
		const counts = {
			'tool:rm': 1,
			'tool:sudo': 3,
			'tool:chmod': 5,
		};
		const s = getStrategySummary(counts, thresholds);
		expect(s.tool).toEqual({ total: 3, active: 1 });
	});

	it('counts dir keys correctly', () => {
		const counts = {
			'dir:/tmp': 2,
			'dir:/home': 4,
		};
		const s = getStrategySummary(counts, thresholds);
		expect(s.dir).toEqual({ total: 2, active: 1 });
	});

	it('handles mixed dimensions', () => {
		const counts = {
			'cmd:abc': 0,
			'cmd:def': 1,
			'tool:rm': 2,
			'dir:/tmp': 3,
		};
		const s = getStrategySummary(counts, thresholds);
		expect(s.cmd).toEqual({ total: 2, active: 2 });
		expect(s.tool).toEqual({ total: 1, active: 1 });
		expect(s.dir).toEqual({ total: 1, active: 1 });
	});
});

// ============================================================================
// buildStrategyItems
// ============================================================================
describe('buildStrategyItems', () => {
	const thresholds = { sameCommand: 2, sameTool: 3, sameFolder: 4 };

	it('returns empty array for empty counts', () => {
		const items = buildStrategyItems({}, thresholds);
		expect(items).toEqual([]);
	});

	it('builds items with correct dimension labels', () => {
		const counts = {
			'cmd:abc123': 1,
			'tool:rm': 2,
			'dir:/tmp': 3,
		};
		const items = buildStrategyItems(counts, thresholds);
		expect(items).toHaveLength(3);

		expect(items[0]).toMatchObject({
			dimension: 'cmd',
			key: 'cmd:abc123',
			displayKey: 'abc123',
			count: 1,
			threshold: 2,
			isActive: true,
			createdAt: expect.any(String),
			subCommand: expect.any(String),
		});
		expect(items[1]).toMatchObject({
			dimension: 'tool',
			key: 'tool:rm',
			displayKey: 'rm',
			count: 2,
			threshold: 3,
			isActive: true,
			createdAt: expect.any(String),
			subCommand: expect.any(String),
		});
		expect(items[2]).toMatchObject({
			dimension: 'dir',
			key: 'dir:/tmp',
			displayKey: '/tmp',
			count: 3,
			threshold: 4,
			isActive: true,
			createdAt: expect.any(String),
			subCommand: expect.any(String),
		});
	});

	it('marks items at threshold as inactive', () => {
		const counts = {
			'cmd:full': 2,
		};
		const items = buildStrategyItems(counts, thresholds);
		expect(items[0]).toMatchObject({
			isActive: false,
			count: 2,
			threshold: 2,
		});
	});
});

// ============================================================================
// calcWidgetContentText（纯函数，无 ANSI 颜色）
// ============================================================================
describe('calcWidgetContentText', () => {
	const thresholds = { sameCommand: 2, sameTool: 3, sameFolder: 4 };

	it('renders gate off', () => {
		expect(calcWidgetContentText(false, false, {}, thresholds, 0)).toBe('|gate:off');
		expect(calcWidgetContentText(false, true, {}, thresholds, 0)).toBe('|gate:off');
	});

	it('renders gate on + dynamic off with empty counts', () => {
		expect(calcWidgetContentText(true, false, {}, thresholds, 0)).toBe('|gate:on');
	});

	it('renders gate on + dynamic off with counts', () => {
		const counts = {
			'cmd:aaa': 1,
			'cmd:bbb': 2,
			'tool:rm': 1,
			'dir:/tmp': 3,
		};
		// totalRecords=4, cmd(2),tool(1),folder(1)
		const text = calcWidgetContentText(true, false, counts, thresholds, 4);
		expect(text).toBe('|gate(4):on[cmd(2),tool(1),folder(1)]');
	});

	it('renders gate on + dynamic off with single dimension', () => {
		const counts = { 'cmd:aaa': 1 };
		const text = calcWidgetContentText(true, false, counts, thresholds, 1);
		expect(text).toBe('|gate(1):on[cmd(1)]');
	});

	it('renders dynamic on with empty counts', () => {
		expect(calcWidgetContentText(true, true, {}, thresholds, 0)).toBe('|dynamic-gate:on');
	});

	it('renders dynamic on with one active cmd strategy (1/2)', () => {
		const counts = { 'cmd:abc': 1 };
		const text = calcWidgetContentText(true, true, counts, thresholds, 1);
		expect(text).toBe('|dynamic-gate(1[0]):on[cmd(1[0]):1/2]');
	});

	it('renders dynamic on with cmd at threshold (2/2) — graduated', () => {
		const counts = { 'cmd:abc': 2 };
		const text = calcWidgetContentText(true, true, counts, thresholds, 1);
		expect(text).toBe('|dynamic-gate(1[1]):on[cmd(1[1]):0/2]');
	});

	it('renders dynamic on: two identical cmds reach 2/2 then graduate', () => {
		const counts = { 'cmd:same': 2 };
		const text = calcWidgetContentText(true, true, counts, thresholds, 1);
		expect(text).toBe('|dynamic-gate(1[1]):on[cmd(1[1]):0/2]');
	});

	it('renders dynamic on: mix of active and graduated per dimension', () => {
		const counts = {
			'cmd:aaa': 1,
			'cmd:bbb': 2,
			'tool:rm': 2,
			'tool:sudo': 3,
		};
		const text = calcWidgetContentText(true, true, counts, thresholds, 4);
		// cmd: total=2, active=1, auto=1, best=1
		// tool: total=2, active=1, auto=1, best=2
		expect(text).toBe('|dynamic-gate(4[2]):on[cmd(2[1]):1/2,tool(2[1]):2/3]');
	});

	it('renders dynamic on with threshold=0 (no strategies can graduate)', () => {
		const zeroThresholds = { sameCommand: 0, sameTool: 0, sameFolder: 0 };
		const counts = { 'cmd:aaa': 5 };
		const text = calcWidgetContentText(true, true, counts, zeroThresholds, 1);
		expect(text).toBe('|dynamic-gate(1[0]):on[cmd(1[0]):0/0]');
	});

	it('renders all three dimensions on dynamic on', () => {
		const counts = {
			'cmd:abc': 1,
			'tool:rm': 2,
			'dir:/tmp': 3,
		};
		const text = calcWidgetContentText(true, true, counts, thresholds, 3);
		expect(text).toBe('|dynamic-gate(3[0]):on[cmd(1[0]):1/2,tool(1[0]):2/3,folder(1[0]):3/4]');
	});

	it('renders graduated tool: all tool strategies at threshold', () => {
		const counts = {
			'tool:rm': 3,
			'tool:sudo': 4,
		};
		const text = calcWidgetContentText(true, true, counts, thresholds, 2);
		expect(text).toBe('|dynamic-gate(2[2]):on[tool(2[2]):0/3]');
	});
});

// ============================================================================
// hasGraduatedStrategy
// ============================================================================
describe('hasGraduatedStrategy', () => {
	it('count < threshold returns false', () => {
		const cmd = 'rm -rf /tmp';
		const counts: Record<string, number> = {};
		counts[makeCommandKey(cmd)] = 1;
		const result = hasGraduatedStrategy(cmd, counts, { sameCommand: 3 });
		expect(result).toBe(false);
	});

	it('count === threshold returns true', () => {
		const cmd = 'rm -rf /tmp';
		const counts: Record<string, number> = {};
		counts[makeCommandKey(cmd)] = 2;
		const result = hasGraduatedStrategy(cmd, counts, { sameCommand: 2 });
		expect(result).toBe(true);
	});

	it('count > threshold returns true', () => {
		const cmd = 'rm -rf /tmp';
		const counts: Record<string, number> = {};
		counts[makeCommandKey(cmd)] = 5;
		const result = hasGraduatedStrategy(cmd, counts, { sameCommand: 2 });
		expect(result).toBe(true);
	});

	it('threshold = 0 returns false (never auto-approve)', () => {
		const cmd = 'rm -rf /tmp';
		const counts: Record<string, number> = {};
		counts[makeCommandKey(cmd)] = 100;
		const result = hasGraduatedStrategy(cmd, counts, { sameCommand: 0 });
		expect(result).toBe(false);
	});

	it('no matching cmd key returns false', () => {
		const result = hasGraduatedStrategy('rm -rf /tmp', {}, { sameCommand: 2 });
		expect(result).toBe(false);
	});
});

// ============================================================================
// checkThreshold
// ============================================================================
describe('checkThreshold', () => {
	const baseConfig = {
		dynamicPolicy: {
			thresholds: {
				sameCommand: 5,
				sameTool: 5,
				sameFolder: 5,
			},
		},
	} as unknown as PermissionGateConfig;

	it('all three dimensions pass when counts are under thresholds', () => {
		const result = checkThreshold('rm -rf /tmp', 'rm', '/tmp', baseConfig, {});
		expect(result.pass).toBe(true);
		expect(result.dimensions).toEqual(['sameCommand', 'sameTool', 'sameFolder']);
	});

	it('only sameCommand passes when tool and folder exceed thresholds', () => {
		const config = {
			dynamicPolicy: {
				thresholds: { sameCommand: 5, sameTool: 1, sameFolder: 1 },
			},
		} as unknown as PermissionGateConfig;
		const toolName = 'rm';
		const counts: Record<string, number> = {};
		counts[makeCommandKey('rm -rf /tmp')] = 1; // 1 < 5 => pass
		counts[makeToolKey(toolName)] = 2; // 2 >= 1 => fail
		counts[makeFolderKey('/tmp')] = 2; // 2 >= 1 => fail
		const result = checkThreshold('rm -rf /tmp', toolName, '/tmp', config, counts);
		expect(result.pass).toBe(true);
		expect(result.dimensions).toEqual(['sameCommand']);
	});

	it('only sameTool passes when command and folder exceed thresholds', () => {
		const config = {
			dynamicPolicy: {
				thresholds: { sameCommand: 1, sameTool: 5, sameFolder: 1 },
			},
		} as unknown as PermissionGateConfig;
		const toolName = 'rm';
		const counts: Record<string, number> = {};
		counts[makeCommandKey('rm -rf /tmp')] = 2; // 2 >= 1 => fail
		counts[makeToolKey(toolName)] = 1; // 1 < 5 => pass
		counts[makeFolderKey('/tmp')] = 3; // 3 >= 1 => fail
		const result = checkThreshold('rm -rf /tmp', toolName, '/tmp', config, counts);
		expect(result.pass).toBe(true);
		expect(result.dimensions).toEqual(['sameTool']);
	});

	it('only sameFolder passes when command and tool exceed thresholds', () => {
		const config = {
			dynamicPolicy: {
				thresholds: { sameCommand: 1, sameTool: 1, sameFolder: 5 },
			},
		} as unknown as PermissionGateConfig;
		const toolName = 'rm';
		const counts: Record<string, number> = {};
		counts[makeCommandKey('rm -rf /tmp')] = 3; // 3 >= 1 => fail
		counts[makeToolKey(toolName)] = 2; // 2 >= 1 => fail
		counts[makeFolderKey('/tmp')] = 1; // 1 < 5 => pass
		const result = checkThreshold('rm -rf /tmp', toolName, '/tmp', config, counts);
		expect(result.pass).toBe(true);
		expect(result.dimensions).toEqual(['sameFolder']);
	});

	it('all dimensions exceed thresholds — pass=false, empty dimensions', () => {
		const config = {
			dynamicPolicy: {
				thresholds: { sameCommand: 1, sameTool: 1, sameFolder: 1 },
			},
		} as unknown as PermissionGateConfig;
		const toolName = 'rm';
		const counts: Record<string, number> = {};
		counts[makeCommandKey('rm -rf /tmp')] = 5; // 5 >= 1 => fail
		counts[makeToolKey(toolName)] = 5; // 5 >= 1 => fail
		counts[makeFolderKey('/tmp')] = 5; // 5 >= 1 => fail
		const result = checkThreshold('rm -rf /tmp', toolName, '/tmp', config, counts);
		expect(result.pass).toBe(false);
		expect(result.dimensions).toEqual([]);
	});
});

// ============================================================================
// pathInScope
// ============================================================================
describe('pathInScope', () => {
	it('target path inside scope', () => {
		expect(pathInScope('/a/b/c/d', '/a/b')).toBe(true);
	});

	it('target path outside scope', () => {
		expect(pathInScope('/x/y/z', '/a/b')).toBe(false);
	});

	it('target path equals scope', () => {
		expect(pathInScope('/a/b', '/a/b')).toBe(true);
	});
});

// ============================================================================
// extractTargetPaths
// ============================================================================
describe('extractTargetPaths', () => {
	it('extracts absolute paths', () => {
		const paths = extractTargetPaths('rm -rf /tmp/test /var/log');
		expect(paths).toContain('/tmp/test');
		expect(paths).toContain('/var/log');
		expect(paths).toHaveLength(2);
	});

	it('extracts relative paths (./, ../)', () => {
		const paths = extractTargetPaths('cp ./src/file ./dst/file');
		expect(paths).toContain('./src/file');
		expect(paths).toContain('./dst/file');
		expect(paths).toHaveLength(2);
	});

	it('extracts multiple path parameters', () => {
		const paths = extractTargetPaths('rm -f /a/b /c/d /e/f');
		expect(paths).toEqual(['/a/b', '/c/d', '/e/f']);
	});

	it('ignores arguments starting with -', () => {
		const paths = extractTargetPaths('ls -la --color /tmp');
		expect(paths).toEqual(['/tmp']);
	});

	it('ignores redirection symbol >', () => {
		const paths = extractTargetPaths('echo hello > /tmp/output');
		expect(paths).toContain('/tmp/output');
		expect(paths).not.toContain('>');
	});
});

// ============================================================================
// extractToolName
// ============================================================================
describe('extractToolName', () => {
	it('simple command returns the tool name', () => {
		expect(extractToolName('rm -rf /tmp')).toBe('rm');
	});

	it('skips sudo prefix', () => {
		expect(extractToolName('sudo rm -rf /')).toBe('rm');
	});

	it('skips npx prefix', () => {
		expect(extractToolName('npx jest --coverage')).toBe('jest');
	});

	it('handles docker exec specially — skips docker+exec, returns next token', () => {
		expect(extractToolName('docker exec mycontainer rm -rf /tmp')).toBe('mycontainer');
	});

	it('extracts tool name from path', () => {
		expect(extractToolName('/usr/bin/git status')).toBe('git');
	});
});

// ============================================================================
// extractTargetDir
// ============================================================================
describe('extractTargetDir', () => {
	it('absolute path returns parent directory', () => {
		expect(extractTargetDir('rm -rf /a/b/c', '/home/user')).toBe('/a/b');
	});

	it('relative path resolves and returns parent directory', () => {
		expect(extractTargetDir('rm -rf ./dir/file', '/home/user')).toBe('/home/user/dir');
	});

	it('no path parameters returns cwd', () => {
		expect(extractTargetDir('ls -la', '/home/user')).toBe('/home/user');
	});
});

// ============================================================================
// normalizeDim
// ============================================================================
describe('normalizeDim', () => {
	it('string[] input dedupes and returns', () => {
		expect(normalizeDim(['a', 'b', 'a'])).toEqual(['a', 'b']);
	});

	it('single string wraps in array', () => {
		expect(normalizeDim('foo')).toEqual(['foo']);
	});

	it('null returns null', () => {
		expect(normalizeDim(null)).toBeNull();
	});

	it('undefined returns null', () => {
		expect(normalizeDim(undefined)).toBeNull();
	});

	it('empty array returns null', () => {
		expect(normalizeDim([])).toBeNull();
	});
});

// ============================================================================
// countNonBlockedEntries
// ============================================================================
describe('countNonBlockedEntries', () => {
	it('counts only non-blocked entries in mixed list', () => {
		const entries = [
			{
				action: 'auto',
				ts: '1',
				cmd: 'rm',
				tool: 'rm',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
			{
				action: 'confirmed',
				ts: '2',
				cmd: 'rm',
				tool: 'rm',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
			{
				action: 'blocked',
				ts: '3',
				cmd: 'mv',
				tool: 'mv',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
			{
				action: 'auto',
				ts: '4',
				cmd: 'chmod',
				tool: 'chmod',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
		];
		expect(countNonBlockedEntries(entries)).toBe(3);
	});

	it('all blocked returns 0', () => {
		const entries = [
			{
				action: 'blocked',
				ts: '1',
				cmd: 'rm',
				tool: 'rm',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
			{
				action: 'blocked',
				ts: '2',
				cmd: 'mv',
				tool: 'mv',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
		];
		expect(countNonBlockedEntries(entries)).toBe(0);
	});

	it('all auto returns full count', () => {
		const entries = [
			{
				action: 'auto',
				ts: '1',
				cmd: 'rm',
				tool: 'rm',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
			{
				action: 'auto',
				ts: '2',
				cmd: 'mv',
				tool: 'mv',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
			{
				action: 'auto',
				ts: '3',
				cmd: 'chmod',
				tool: 'chmod',
				dir: '/tmp',
				dim: null,
			} as ApprovalEntry,
		];
		expect(countNonBlockedEntries(entries)).toBe(3);
	});
});
