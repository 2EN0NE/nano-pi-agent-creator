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
		// 注意：deepMerge 对 dynamicPolicy.thresholds 使用 ??，仅覆盖显式提供的字段
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
		// 未覆盖的阈值保持默认
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
		expect(config.approvalCounts).toEqual({});
	});

	it('returns a deep clone (mutations do not affect defaults)', () => {
		const c1 = getDefaultConfig();
		const c2 = getDefaultConfig();
		c1.approvalCounts['test'] = 42;
		expect(c2.approvalCounts).toEqual({});
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
