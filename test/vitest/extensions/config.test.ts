/**
 * permission-gate — config 加载与迁移 Vitest 测试（ADR-0025 补充）
 *
 * 覆盖：loadConfig 双层合并（项目级 > 用户级 > 默认值）、scope 相对路径解析、
 * 旧版 patterns（string[]）→ 新版（PatternEntry[]）迁移。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadConfig, getDefaultConfig } from '../../../extensions/security/permission-gate/config';

let tmpDir: string;
let tmpHome: string;
let tmpCwd: string;

const userFile = () =>
	join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate', 'config.json');
const projectFile = () => join(tmpCwd, '.pi', 'extensions-data', 'permission-gate', 'config.json');

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, JSON.stringify(data), 'utf-8');
}

beforeEach(() => {
	tmpDir = join(tmpdir(), `pg-config-test-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	tmpCwd = join(tmpDir, 'cwd');
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig — 双层合并', () => {
	it('无配置文件时返回默认值', () => {
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.enabled).toBe(true);
		expect(c.dynamicPolicyEnabled).toBe(true);
		expect(c.defaultPersistenceScope).toBe('session');
		expect(c.patterns.length).toBeGreaterThan(0);
		expect(c.dynamicPolicy.thresholds.sameCommand).toBe(2);
	});

	it('用户级覆盖默认值', () => {
		writeJson(userFile(), { enabled: false });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.enabled).toBe(false);
	});

	it('项目级覆盖用户级', () => {
		writeJson(userFile(), { enabled: false });
		writeJson(projectFile(), { enabled: true });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.enabled).toBe(true);
	});

	it('scope 相对路径解析为绝对路径', () => {
		writeJson(projectFile(), { dynamicPolicy: { scope: './sub' } });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dynamicPolicy.scope).toBe(resolve(tmpCwd, 'sub'));
	});

	it('scope 绝对路径保持不变', () => {
		writeJson(projectFile(), { dynamicPolicy: { scope: '/abs/scope' } });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dynamicPolicy.scope).toBe('/abs/scope');
	});
});

describe('loadConfig — 旧 patterns 迁移（string[] → PatternEntry[]）', () => {
	it('旧 string[] 迁移为 PatternEntry[]，tier 归 warning', () => {
		writeJson(projectFile(), { patterns: ['\\brm\\s', '\\bsudo\\s'] });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.patterns).toEqual([
			{ pattern: '\\brm\\s', tier: 'warning' },
			{ pattern: '\\bsudo\\s', tier: 'warning' },
		]);
	});

	it('新格式 PatternEntry[] 原样保留（含 critical）', () => {
		writeJson(projectFile(), { patterns: [{ pattern: '\\brm\\s', tier: 'critical' }] });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.patterns).toEqual([{ pattern: '\\brm\\s', tier: 'critical' }]);
	});

	it('旧宽泛 /dev 模式（PatternEntry）内容迁移为收窄块设备模式，保留 critical', () => {
		const devPattern = getDefaultConfig().patterns.find((p) =>
			p.pattern.startsWith('>\\s*/dev/'),
		);
		expect(devPattern).toBeDefined();
		// 模拟已通过设置面板持久化过旧宽泛模式的用户配置
		writeJson(projectFile(), { patterns: [{ pattern: '>\\s*/dev/', tier: 'critical' }] });
		const c = loadConfig(tmpCwd, tmpHome);
		// 旧宽泛模式被迁移为与默认一致的收窄模式，而非继续数组替换覆盖默认
		expect(c.patterns).toEqual([{ pattern: devPattern!.pattern, tier: 'critical' }]);
	});

	it('旧宽泛 /dev 模式（string[]）内容迁移为收窄模式，tier 归 warning', () => {
		const devPattern = getDefaultConfig().patterns.find((p) =>
			p.pattern.startsWith('>\\s*/dev/'),
		);
		expect(devPattern).toBeDefined();
		writeJson(projectFile(), { patterns: ['>\\s*/dev/'] });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.patterns).toEqual([{ pattern: devPattern!.pattern, tier: 'warning' }]);
	});

	it('非法 tier 归 warning，非 string/object 条目被跳过', () => {
		writeJson(projectFile(), {
			patterns: [
				'\\brm\\s',
				{ pattern: '\\bsudo\\s', tier: 'bogus' },
				{ pattern: '\\beval\\s', tier: 'info' },
				42,
				null,
			],
		});
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.patterns).toEqual([
			{ pattern: '\\brm\\s', tier: 'warning' },
			{ pattern: '\\bsudo\\s', tier: 'warning' },
			{ pattern: '\\beval\\s', tier: 'info' },
		]);
	});

	it('patterns 非数组（如字符串）→ migrate 返回 null，deepMerge 数组替换语义生效', () => {
		// 非数组 patterns 无法迁移，保持 deepMerge 的数组覆盖语义
		writeJson(projectFile(), { patterns: 'not-an-array' });
		const c = loadConfig(tmpCwd, tmpHome);
		// 默认 patterns 是 PatternEntry[]，被字符串覆盖（deepMerge 非对象直接替换）
		expect(c.patterns).toBe('not-an-array');
	});
});

describe('loadConfig — 项目级 patterns 整体替换（不 concat）', () => {
	it('项目级 patterns 覆盖用户级 patterns（deepMerge 数组替换）', () => {
		writeJson(userFile(), { patterns: ['\\buser-only\\s'] });
		writeJson(projectFile(), { patterns: ['\\bproject-only\\s'] });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.patterns).toEqual([{ pattern: '\\bproject-only\\s', tier: 'warning' }]);
	});

	it('getDefaultConfig 返回深拷贝（修改不污染默认）', () => {
		const a = getDefaultConfig();
		const b = getDefaultConfig();
		a.dynamicPolicy.thresholds.sameCommand = 999;
		expect(b.dynamicPolicy.thresholds.sameCommand).toBe(2);
	});
});

describe('defaultPersistenceScope — 手动创建策略的默认层级', () => {
	it('默认值为 session', () => {
		expect(getDefaultConfig().defaultPersistenceScope).toBe('session');
	});

	it('旧配置无 defaultPersistenceScope 时补齐默认 session', () => {
		writeJson(projectFile(), { enabled: true });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.defaultPersistenceScope).toBe('session');
	});

	it('项目级覆盖用户级 defaultPersistenceScope', () => {
		writeJson(userFile(), { defaultPersistenceScope: 'user' });
		writeJson(projectFile(), { defaultPersistenceScope: 'project' });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.defaultPersistenceScope).toBe('project');
	});
});

describe('loadConfig — 命令清单对象化 + 内置解释注入', () => {
	it('旧 string[] 命令清单迁移为 CommandEntry[]', () => {
		writeJson(projectFile(), {
			dangerCommands: ['dd', 'mkfs'],
			permissionCommands: ['sudo'],
		});
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dangerCommands.map((e) => e.command)).toEqual(['dd', 'mkfs']);
		expect(c.permissionCommands.map((e) => e.command)).toEqual(['sudo']);
	});

	it('内置命令自动注入官方解释文案（note 非空）', () => {
		const c = getDefaultConfig();
		const dd = c.dangerCommands.find((e) => e.command === 'dd');
		expect(dd?.note).toContain('覆写磁盘');
		const sudo = c.permissionCommands.find((e) => e.command === 'sudo');
		expect(sudo?.note).toContain('提权');
	});

	it('用户自写 note 不被注入覆盖', () => {
		writeJson(projectFile(), {
			dangerCommands: [{ command: 'dd', note: '我的自定义说明' }],
		});
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dangerCommands.find((e) => e.command === 'dd')?.note).toBe('我的自定义说明');
	});

	it('用户覆盖清单（丢 note）后内置命令 note 被恢复，自增命令保持无 note', () => {
		writeJson(projectFile(), {
			dangerCommands: ['dd', 'ddrescue'],
		});
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dangerCommands.find((e) => e.command === 'dd')?.note).toContain('覆写磁盘');
		expect(c.dangerCommands.find((e) => e.command === 'ddrescue')?.note).toBeUndefined();
	});

	it('默认拦截模式自动注入预填解释', () => {
		const c = getDefaultConfig();
		const rm = c.patterns.find((p) => p.pattern === '\\brm\\s+(-rf?|--recursive)');
		expect(rm?.note).toContain('递归强制删除');
	});

	it('patterns 含 note 的对象原样保留', () => {
		writeJson(projectFile(), {
			patterns: [{ pattern: '\\bmycmd\\s', tier: 'warning', note: '我的说明' }],
		});
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.patterns).toEqual([{ pattern: '\\bmycmd\\s', tier: 'warning', note: '我的说明' }]);
	});
});
