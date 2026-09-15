/**
 * permission-gate — 信任范围多根化 Vitest 测试（Ticket 02 / ADR-0059）
 *
 * 覆盖：scope 规范化（字符串 / 数组 / 对象 / `~` / 相对路径 / 不可识别）、
 * 多根匹配（任一根命中、不允许跨根拼凑）、三层覆盖、
 * 项目级 no-op scope 的迁移清理与幂等。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
	formatScope,
	isNoopScopeValue,
	loadConfig,
	normalizeScope,
	parseScopeInput,
	pruneNoopProjectScope,
	type TrustRoot,
} from '../../../extensions/security/permission-gate/config';
import { matchScope } from '../../../extensions/security/permission-gate/index';

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

function readProjectJson(): { dynamicPolicy?: { scope?: unknown; thresholds?: unknown } } {
	return JSON.parse(readFileSync(projectFile(), 'utf-8')) as {
		dynamicPolicy?: { scope?: unknown; thresholds?: unknown };
	};
}

beforeEach(() => {
	tmpDir = join(tmpdir(), `pg-scope-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	tmpCwd = join(tmpDir, 'cwd');
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('normalizeScope — 规范化', () => {
	it('单个字符串 → 单元素根列表', () => {
		expect(normalizeScope('/abs', tmpCwd)).toEqual([{ root: '/abs' }]);
	});

	it('相对路径按 cwd 解析为绝对路径', () => {
		expect(normalizeScope('./sub', tmpCwd)).toEqual([{ root: resolve(tmpCwd, 'sub') }]);
	});

	it('~ 与 ~/x 展开到主目录', () => {
		expect(normalizeScope('~', tmpCwd)).toEqual([{ root: resolve(homedir()) }]);
		expect(normalizeScope('~/.cache', tmpCwd)).toEqual([
			{ root: resolve(join(homedir(), '.cache')) },
		]);
	});

	it('字符串数组 → 多个根', () => {
		expect(normalizeScope(['/a', '/b'], tmpCwd)).toEqual([{ root: '/a' }, { root: '/b' }]);
	});

	it('对象数组 → 保留出处条件', () => {
		expect(
			normalizeScope([{ root: '/tmp', requireSessionProvenance: true }, '/b'], tmpCwd),
		).toEqual([{ root: '/tmp', requireSessionProvenance: true }, { root: '/b' }]);
	});

	it('空数组 / 不可识别值 → null（不静默改写成默认值）', () => {
		expect(normalizeScope([], tmpCwd)).toBeNull();
		expect(normalizeScope(42, tmpCwd)).toBeNull();
		expect(normalizeScope(null, tmpCwd)).toBeNull();
		expect(normalizeScope({ requireSessionProvenance: true }, tmpCwd)).toBeNull();
	});

	it('数组里混入不可识别项 → 整体不可识别（不静默丢掉用户写的根）', () => {
		expect(normalizeScope(['/a', 42], tmpCwd)).toBeNull();
	});
});

describe('isNoopScopeValue — 等价默认值判定', () => {
	it('cwd 自身（含 . 写法）等价默认值', () => {
		expect(isNoopScopeValue('.', tmpCwd)).toBe(true);
		expect(isNoopScopeValue(tmpCwd, tmpCwd)).toBe(true);
		expect(isNoopScopeValue([{ root: tmpCwd }], tmpCwd)).toBe(true);
	});

	it('另一个目录不是等价默认值', () => {
		expect(isNoopScopeValue('/other', tmpCwd)).toBe(false);
	});

	it('带条件或多根 → 不是等价默认值', () => {
		expect(isNoopScopeValue([{ root: tmpCwd, requireSessionProvenance: true }], tmpCwd)).toBe(
			false,
		);
		expect(isNoopScopeValue([{ root: tmpCwd }, { root: '/tmp' }], tmpCwd)).toBe(false);
	});

	it('未设置 → 不是等价默认值（无需清理）', () => {
		expect(isNoopScopeValue(undefined, tmpCwd)).toBe(false);
	});
});

describe('pruneNoopProjectScope — 迁移清理', () => {
	it('项目级 scope = 项目自身目录 → 清除并落盘，dynamicPolicy 其余键保留', () => {
		writeJson(projectFile(), {
			dynamicPolicy: { scope: tmpCwd, thresholds: { sameCommand: 9 } },
		});

		expect(pruneNoopProjectScope(tmpCwd, tmpHome)).toBe(true);

		const after = readProjectJson();
		expect(after.dynamicPolicy?.scope).toBeUndefined();
		expect(after.dynamicPolicy?.thresholds).toEqual({ sameCommand: 9 });
	});

	it('幂等：重复运行不再写盘、返回 false', () => {
		writeJson(projectFile(), { dynamicPolicy: { scope: '.' } });
		expect(pruneNoopProjectScope(tmpCwd, tmpHome)).toBe(true);
		const first = readFileSync(projectFile(), 'utf-8');
		expect(pruneNoopProjectScope(tmpCwd, tmpHome)).toBe(false);
		expect(readFileSync(projectFile(), 'utf-8')).toBe(first);
	});

	it('真实收紧（指向别的目录）不被清理', () => {
		writeJson(projectFile(), { dynamicPolicy: { scope: '/other-root' } });
		expect(pruneNoopProjectScope(tmpCwd, tmpHome)).toBe(false);
		expect(readProjectJson().dynamicPolicy?.scope).toBe('/other-root');
	});

	it('带出处条件的根不被清理', () => {
		writeJson(projectFile(), {
			dynamicPolicy: { scope: [{ root: tmpCwd, requireSessionProvenance: true }] },
		});
		expect(pruneNoopProjectScope(tmpCwd, tmpHome)).toBe(false);
	});

	it('用户级含无条件的项目外根 → 不清理（fail-open 防护）', () => {
		writeJson(userFile(), { dynamicPolicy: { scope: [{ root: '/user-root' }] } });
		writeJson(projectFile(), { dynamicPolicy: { scope: tmpCwd } });
		expect(pruneNoopProjectScope(tmpCwd, tmpHome)).toBe(false);
		expect(readProjectJson().dynamicPolicy?.scope).toBe(tmpCwd);
	});

	it('用户级只有带条件的项目外根 → 清理（提升的核心用途）', () => {
		writeJson(userFile(), {
			dynamicPolicy: { scope: [tmpCwd, { root: '/tmp', requireSessionProvenance: true }] },
		});
		writeJson(projectFile(), { dynamicPolicy: { scope: tmpCwd } });
		expect(pruneNoopProjectScope(tmpCwd, tmpHome)).toBe(true);
	});

	it('无项目级配置文件 → 不报错、返回 false', () => {
		expect(pruneNoopProjectScope(tmpCwd, tmpHome)).toBe(false);
	});
});

describe('loadConfig — 三层覆盖与清理的配合', () => {
	it('用户级含无条件的项目外根 → 项目级 [cwd] 是真实收紧，不清理（fail-safe）', () => {
		writeJson(userFile(), { dynamicPolicy: { scope: [{ root: '/user-root' }] } });
		writeJson(projectFile(), { dynamicPolicy: { scope: tmpCwd } });

		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dynamicPolicy.scope).toEqual([{ root: resolve(tmpCwd) }]);
	});

	it('用户级只有带条件的项目外根 → 清理项目级 no-op（提升照常生效）', () => {
		writeJson(userFile(), {
			dynamicPolicy: { scope: [tmpCwd, { root: '/tmp', requireSessionProvenance: true }] },
		});
		writeJson(projectFile(), { dynamicPolicy: { scope: tmpCwd } });

		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dynamicPolicy.scope).toEqual([
			{ root: resolve(tmpCwd) },
			{ root: '/tmp', requireSessionProvenance: true },
		]);
	});

	it('项目级真实收紧 → 覆盖用户级', () => {
		writeJson(userFile(), { dynamicPolicy: { scope: [{ root: '/user-root' }] } });
		writeJson(projectFile(), { dynamicPolicy: { scope: '/proj-root' } });

		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dynamicPolicy.scope).toEqual([{ root: '/proj-root' }]);
	});

	it('项目级多根可带条件并保留', () => {
		writeJson(projectFile(), {
			dynamicPolicy: {
				scope: ['/proj-root', { root: '/tmp', requireSessionProvenance: true }],
			},
		});
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dynamicPolicy.scope).toEqual([
			{ root: '/proj-root' },
			{ root: '/tmp', requireSessionProvenance: true },
		]);
	});

	it('不可识别的 scope → 兜底为最小范围（仅 cwd，失败即拒绝方向）', () => {
		writeJson(projectFile(), { dynamicPolicy: { scope: { bogus: true } } });
		const c = loadConfig(tmpCwd, tmpHome);
		expect(c.dynamicPolicy.scope).toEqual([{ root: resolve(tmpCwd) }]);
	});
});

describe('matchScope — 多根判定', () => {
	const roots = (...r: string[]): TrustRoot[] => r.map((root) => ({ root }));

	it('cwd 与目标同在一个根内 → 命中', () => {
		const m = matchScope('rm -rf /proj/a', '/proj', roots('/proj'));
		expect(m.inScope).toBe(true);
		expect(m.root?.root).toBe('/proj');
	});

	it('目标在根外 → 不命中，且原因可读', () => {
		const m = matchScope('rm -rf /tmp/a', '/proj', roots('/proj'));
		expect(m.inScope).toBe(false);
		expect(m.reason).toContain('/tmp/a');
	});

	it('多根：cwd 与目标各自被不同的根覆盖 → 命中（「项目内工作、删 /tmp 临时目录」主路径）', () => {
		const m = matchScope('rm -rf /tmp/a', '/proj', roots('/proj', '/tmp'));
		expect(m.inScope).toBe(true);
		expect(m.root?.root).toBe('/proj'); // 返回 cwd 命中的根（日志用）
	});

	it('目标不被任何根覆盖 → 不命中', () => {
		const m = matchScope('rm -rf /other/a', '/proj', roots('/proj', '/tmp'));
		expect(m.inScope).toBe(false);
		expect(m.reason).toContain('/other/a');
	});

	it('cwd 不在任何根内 → 不命中（即使目标在根内）', () => {
		const m = matchScope('rm -rf /tmp/a', '/elsewhere', roots('/proj', '/tmp'));
		expect(m.inScope).toBe(false);
		expect(m.reason).toContain('cwd');
	});

	it('无目标路径时仅依赖 cwd', () => {
		const m = matchScope('ls -la', '/proj', roots('/proj'));
		expect(m.inScope).toBe(true);
	});

	it('空范围 → 不命中', () => {
		const m = matchScope('rm -rf /proj/a', '/proj', []);
		expect(m.inScope).toBe(false);
		expect(m.reason).toContain('为空');
	});

	it('带出处条件的根在条件接入前一律不命中（失败即拒绝）', () => {
		const m = matchScope('rm -rf /tmp/a', '/tmp', [
			{ root: '/tmp', requireSessionProvenance: true },
		]);
		expect(m.inScope).toBe(false);
	});

	it('只读命令含未解析变量 → 不因此出范围（只约束 mutator 目标）', () => {
		const m = matchScope('grep x "$f"', '/proj', roots('/proj'));
		expect(m.inScope).toBe(true);
	});

	it('mutator 命令含未解析变量 → 需出处条件（无条件根不满足）', () => {
		const m = matchScope('rm -rf "$T"', '/proj', roots('/proj'));
		expect(m.inScope).toBe(false);
		expect(m.reason).toContain('$T');
	});
});

describe('formatScope — 展示', () => {
	it('多根逗号连接，带条件的根带标记', () => {
		expect(
			formatScope([{ root: '/a' }, { root: '/tmp', requireSessionProvenance: true }]),
		).toBe('/a, /tmp [仅本会话创建]');
	});

	it('空范围有可读表示', () => {
		expect(formatScope([])).toBe('(空)');
	});
});

describe('parseScopeInput — formatScope 的逆（面板范围编辑往返）', () => {
	it('剥离展示注解并恢复出处条件（编辑一次不再丢条件）', () => {
		expect(parseScopeInput('/a, /tmp [仅本会话创建]', tmpCwd)).toEqual([
			{ root: '/a' },
			{ root: '/tmp', requireSessionProvenance: true },
		]);
	});

	it('formatScope → parseScopeInput 往返保持不变', () => {
		const roots: TrustRoot[] = [
			{ root: resolve(tmpCwd) },
			{ root: '/tmp', requireSessionProvenance: true },
		];
		expect(parseScopeInput(formatScope(roots), tmpCwd)).toEqual(roots);
	});

	it('不可识别输入 → null（不静默改写成默认值）', () => {
		expect(parseScopeInput('[仅本会话创建]', tmpCwd)).toBeNull();
	});
});
