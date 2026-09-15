/**
 * permission-gate — 提升采纳与撤销 Vitest 测试（Ticket 08 / Ticket 09）
 *
 * 覆盖：台阶推算（叶子/父目录/目标根，认不出只给两级）、层级提升（迁到用户层）、
 * 范围扩大（写入用户级范围 + 挂出处条件）、三级覆盖的遮蔽提示、
 * 撤销的成对回滚与"不误伤共用同一个根的其它条目"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
	adoptPromotion,
	listPromoted,
	promotionLevels,
	revokePromotion,
} from '../../../extensions/security/permission-gate/promotion-adopt';
import {
	getRuleCountsByLayer,
	recordApproval,
	resetRulesStore,
} from '../../../extensions/security/permission-gate/approval-store';
import type { PromotionCandidate } from '../../../extensions/security/permission-gate/promotion';

/** 信任范围条目的结构形状（测试本地定义，不跨模块引类型） */
type ScopeEntry = { root: string; requireSessionProvenance?: boolean };

let tmpDir: string;
let tmpHome: string;
let tmpCwd: string;

const userConfigFile = () =>
	join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate', 'config.json');
const projectConfigFile = () =>
	join(tmpCwd, '.pi', 'extensions-data', 'permission-gate', 'config.json');

function readUserConfig(): { dynamicPolicy?: { scope?: ScopeEntry[]; promoted?: unknown[] } } {
	try {
		return JSON.parse(readFileSync(userConfigFile(), 'utf-8')) as {
			dynamicPolicy?: { scope?: ScopeEntry[]; promoted?: unknown[] };
		};
	} catch {
		return {};
	}
}

function candidate(dir: string, key = 'tool:rm'): PromotionCandidate {
	return {
		dimension: 'sameTool',
		key,
		tool: 'rm',
		command: 'rm -rf /tmp/probe',
		dir,
		tier: 'warning',
		evidence: {
			sessionManual: 4,
			sessionAuto: 0,
			historyDirectories: 5,
			historySessions: 9,
			userDenials: 0,
		},
	};
}

beforeEach(() => {
	tmpDir = join(tmpdir(), `pg-adopt-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	tmpCwd = join(tmpDir, 'cwd');
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
	resetRulesStore({ homeDir: tmpHome, cwd: tmpCwd });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('台阶推算（从叶子向上）', () => {
	it('已知临时区根内的路径给三级：叶子 / 父目录 / 目标根', () => {
		const levels = promotionLevels(join(tmpdir(), 'probe', 'nested'), tmpCwd);
		expect(levels.map((l) => l.level)).toEqual(['leaf', 'parent', 'root']);
		expect(levels[2]?.path).toBe(resolve(tmpdir()));
	});

	it('父目录就是目标根时不去重成一个重复台阶（只给两级）', () => {
		const levels = promotionLevels(join(tmpdir(), 'probe'), tmpCwd);
		expect(levels.map((l) => l.level)).toEqual(['leaf', 'parent']);
		expect(levels[1]?.path).toBe(resolve(tmpdir()));
	});

	it('认不出的目标根只给两级（不猜）', () => {
		const levels = promotionLevels(join(homedir(), 'pg-unknown-dir'), tmpCwd);
		expect(levels.map((l) => l.level)).toEqual(['leaf', 'parent']);
	});

	it('项目内 .pi/tmp 是已知根（最具体的根优先，不被系统临时目录抢走）', () => {
		const dir = join(tmpCwd, '.pi', 'tmp', 'sandbox');
		const levels = promotionLevels(dir, tmpCwd);
		// 父目录恰好就是该目标根 → 去重后只给两级，但父目录必须是 .pi/tmp（而不是系统临时目录）
		expect(levels.map((l) => l.level)).toEqual(['leaf', 'parent']);
		expect(levels[1]?.path).toBe(join(tmpCwd, '.pi', 'tmp'));
	});
});

describe('层级提升（台阶 = 具体路径）', () => {
	it('把计数从项目层迁到用户层，且不扩大范围', () => {
		recordApproval('warning', ['tool:rm']);
		expect(getRuleCountsByLayer().project['tool:rm']).toBe(1);

		const r = adoptPromotion({
			cwd: tmpCwd,
			candidate: candidate(join(tmpCwd, 'dist')),
			level: 'leaf',
			homeDir: tmpHome,
		});

		expect(r.ok).toBe(true);
		expect(r.moved).toEqual(['tool:rm']);
		expect(r.scopeRoot).toBeUndefined();
		const layers = getRuleCountsByLayer();
		expect(layers.user['tool:rm']).toBe(1);
		expect(layers.project['tool:rm']).toBeUndefined();
		expect(readUserConfig().dynamicPolicy?.scope).toBeUndefined();
	});

	it('登记表记录来源与证据（撤销与列表靠它）', () => {
		recordApproval('warning', ['tool:rm']);
		adoptPromotion({
			cwd: tmpCwd,
			candidate: candidate(join(tmpCwd, 'dist')),
			level: 'leaf',
			homeDir: tmpHome,
		});
		const promoted = listPromoted(tmpCwd, tmpHome);
		expect(promoted).toHaveLength(1);
		expect(promoted[0]?.key).toBe('tool:rm');
		expect(promoted[0]?.level).toBe('leaf');
		expect(promoted[0]?.evidence).toContain('本会话人工 4');
		expect(promoted[0]?.createdAt).not.toBe('');
	});
	it('critical 候选即使被外部构造出来 → 拒绝迁层（失败即拒绝）', () => {
		recordApproval('warning', ['tool:rm']);
		const r = adoptPromotion({
			cwd: tmpCwd,
			candidate: { ...candidate(join(tmpCwd, 'dist')), tier: 'critical' },
			level: 'leaf',
			homeDir: tmpHome,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain('不可提升');
		// 计数未被迁到用户层
		expect(getRuleCountsByLayer().user['tool:rm']).toBeUndefined();
	});
});

describe('范围扩大（台阶 = 父目录 / 目标根）', () => {
	it('目标根写入用户级范围，并挂上出处条件（默认勾选）', () => {
		recordApproval('warning', ['tool:rm']);
		const r = adoptPromotion({
			cwd: tmpCwd,
			candidate: candidate(join(tmpdir(), 'probe', 'nested')),
			level: 'root',
			homeDir: tmpHome,
		});

		expect(r.ok).toBe(true);
		expect(r.scopeRoot).toBe(resolve(tmpdir()));
		// 用户级本无 scope → 默认根 [cwd] 必须一并保留，否则采纳后 cwd 掉出生效范围
		expect(readUserConfig().dynamicPolicy?.scope).toEqual([
			{ root: resolve(tmpCwd) },
			{ root: resolve(tmpdir()), requireSessionProvenance: true },
		]);
	});

	it('取消勾选时不挂条件', () => {
		recordApproval('warning', ['tool:rm']);
		adoptPromotion({
			cwd: tmpCwd,
			candidate: candidate(join(tmpdir(), 'probe', 'nested')),
			level: 'root',
			requireProvenance: false,
			homeDir: tmpHome,
		});
		expect(readUserConfig().dynamicPolicy?.scope).toEqual([
			{ root: resolve(tmpCwd) },
			{ root: resolve(tmpdir()) },
		]);
	});

	it('同一根重复采纳不会写入两条', () => {
		recordApproval('warning', ['tool:rm']);
		const c = candidate(join(tmpdir(), 'probe', 'nested'));
		adoptPromotion({ cwd: tmpCwd, candidate: c, level: 'root', homeDir: tmpHome });
		adoptPromotion({ cwd: tmpCwd, candidate: c, level: 'root', homeDir: tmpHome });
		// 默认根 cwd + 目标根 tmpdir
		expect(readUserConfig().dynamicPolicy?.scope).toHaveLength(2);
	});

	it('认不出的目标根 → 失败但有可读原因（不静默）', () => {
		const r = adoptPromotion({
			cwd: tmpCwd,
			candidate: candidate(join(homedir(), 'pg-unknown-dir')),
			level: 'root',
			homeDir: tmpHome,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain('不可用');
	});

	it('项目级真实收紧会遮蔽用户级范围 → 给出提示', () => {
		recordApproval('warning', ['tool:rm']);
		mkdirSync(join(tmpCwd, '.pi', 'extensions-data', 'permission-gate'), { recursive: true });
		writeFileSync(
			projectConfigFile(),
			JSON.stringify({ dynamicPolicy: { scope: '/somewhere-else' } }),
		);

		const r = adoptPromotion({
			cwd: tmpCwd,
			candidate: candidate(join(tmpdir(), 'probe', 'nested')),
			level: 'root',
			homeDir: tmpHome,
		});
		expect(r.ok).toBe(true);
		expect(r.shadowedByProject).toBe(true);
	});
});

describe('撤销（成对回滚）', () => {
	it('删用户层计数 + 移除该条新增的范围根 + 删登记记录', () => {
		recordApproval('warning', ['tool:rm']);
		adoptPromotion({
			cwd: tmpCwd,
			candidate: candidate(join(tmpdir(), 'probe', 'nested')),
			level: 'root',
			homeDir: tmpHome,
		});
		expect(getRuleCountsByLayer().user['tool:rm']).toBe(1);

		const r = revokePromotion(tmpCwd, 'tool:rm', tmpHome);
		expect(r.ok).toBe(true);
		expect(r.removedKey).toBe(true);
		expect(r.removedRoot).toBe(resolve(tmpdir()));

		expect(getRuleCountsByLayer().user['tool:rm']).toBeUndefined();
		// 只剩采纳时补上的默认根 → 连同 scope 字段一起回滚（恢复采纳前形态）
		expect(readUserConfig().dynamicPolicy?.scope).toBeUndefined();
		expect(listPromoted(tmpCwd, tmpHome)).toHaveLength(0);
	});

	it('不误伤共用同一个根的其它已提升条目', () => {
		recordApproval('warning', ['tool:rm', 'dir:/tmp']);
		const c = candidate(join(tmpdir(), 'probe', 'nested'));
		adoptPromotion({ cwd: tmpCwd, candidate: c, level: 'root', homeDir: tmpHome });
		adoptPromotion({
			cwd: tmpCwd,
			candidate: { ...c, key: 'dir:/tmp' },
			level: 'root',
			homeDir: tmpHome,
		});

		revokePromotion(tmpCwd, 'tool:rm', tmpHome);

		// 另一条仍需要这个根 → 保留（另加默认根 cwd）
		expect(readUserConfig().dynamicPolicy?.scope).toHaveLength(2);
		expect(listPromoted(tmpCwd, tmpHome).map((p) => p.key)).toEqual(['dir:/tmp']);
	});

	it('撤销不存在的条目 → 不报错、无副作用', () => {
		const r = revokePromotion(tmpCwd, 'tool:nonexistent', tmpHome);
		expect(r.ok).toBe(true);
		expect(r.removedKey).toBe(false);
	});
});
