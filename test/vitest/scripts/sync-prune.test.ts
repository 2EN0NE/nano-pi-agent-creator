/**
 * sync-prune — Vitest 单元测试
 *
 * 覆盖 ADR-0037 的纯逻辑与渲染（不 import sync-to-local-pi.ts，因其底部执行 main()）：
 *   - classifyDeletionCandidates  （受管 vs 第三方 vs 保护名单 vs 有效集合）
 *   - computeDeletionDecision     （--purge 全量 / profile 默认严格剪枝 / inline 默认不删）
 *   - collectConfigResetCandidates（删除 ∩ 有 config.json；ADR-0037 修订：更新不再进候选）
 *   - renderMultiSelect           （光标 / 勾选标记渲染）
 *   - resetConfigProfiles         （勾选删 config.json，先备份、仅保留最新 N 份，保留 session 文件）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
	classifyDeletionCandidates,
	computeDeletionDecision,
	collectConfigResetCandidates,
	renderMultiSelect,
	resetConfigProfiles,
	findExtensionFormConflicts,
	MAX_CONFIG_BACKUPS,
} from '../../../scripts/lib/sync-prune.js';

// ============================================================================
// classifyDeletionCandidates
// ============================================================================

describe('classifyDeletionCandidates', () => {
	const inventory = new Set(['edit', 'review', 'sandbox']);

	it('受管资产（∈ 源清单且不在有效集合）→ managed', () => {
		const r = classifyDeletionCandidates(
			['edit', 'review'],
			new Set(['other']),
			inventory,
			undefined,
		);
		expect(r.managed).toEqual(['edit', 'review']);
		expect(r.thirdParty).toEqual([]);
	});

	it('第三方资产（∉ 源清单）→ thirdParty', () => {
		const r = classifyDeletionCandidates(
			['herdr-installed', 'some-third-party'],
			new Set(['other']),
			inventory,
			undefined,
		);
		expect(r.managed).toEqual([]);
		expect(r.thirdParty).toEqual(['herdr-installed', 'some-third-party']);
	});

	it('在有效集合中的资产不进入任何候选', () => {
		const r = classifyDeletionCandidates(
			['edit', 'review'],
			new Set(['edit']),
			inventory,
			undefined,
		);
		expect(r.managed).toEqual(['review']);
		expect(r.thirdParty).toEqual([]);
	});

	it('保护名单中的资产被完全跳过（既不 managed 也不 thirdParty）', () => {
		const r = classifyDeletionCandidates(
			['edit', 'herdr-agent-state'],
			new Set(),
			inventory,
			new Set(['herdr-agent-state']),
		);
		expect(r.managed).toEqual(['edit']);
		expect(r.thirdParty).toEqual([]);
	});

	it('输出按名字排序', () => {
		const r = classifyDeletionCandidates(
			['review', 'edit', 'zzz-third'],
			new Set(),
			inventory,
			undefined,
		);
		expect(r.managed).toEqual(['edit', 'review']);
		expect(r.thirdParty).toEqual(['zzz-third']);
	});
});

// ============================================================================
// computeDeletionDecision
// ============================================================================

describe('computeDeletionDecision', () => {
	const managed = ['edit'];
	const thirdParty = ['third'];

	it('--purge → 全量镜像：受管 + 第三方都删', () => {
		expect(computeDeletionDecision(managed, thirdParty, true, false)).toEqual({
			toDelete: ['edit', 'third'],
			toKeep: [],
		});
	});

	it('profile 默认（无 purge）→ 严格剪枝：仅删受管', () => {
		expect(computeDeletionDecision(managed, thirdParty, false, false)).toEqual({
			toDelete: ['edit'],
			toKeep: ['third'],
		});
	});

	it('inline 默认（无 purge）→ 不删：全部保留', () => {
		expect(computeDeletionDecision(managed, thirdParty, false, true)).toEqual({
			toDelete: [],
			toKeep: ['edit', 'third'],
		});
	});
});

// ============================================================================
// collectConfigResetCandidates
// ============================================================================

describe('collectConfigResetCandidates', () => {
	let targetDir: string;

	beforeEach(() => {
		targetDir = join(tmpdir(), `sync-prune-test-${randomBytes(4).toString('hex')}`);
		mkdirSync(targetDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(targetDir, { recursive: true, force: true });
	});

	function seedConfig(plugin: string) {
		const dir = join(targetDir, 'extensions-data', plugin);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'config.json'), '{}');
		writeFileSync(join(dir, 'some-session.json'), '{}'); // session 文件应保留
	}

	it('被删除 + 有 config.json → 进列表（reason=deleted）', () => {
		seedConfig('edit');
		const r = collectConfigResetCandidates(targetDir, ['edit']);
		expect(r).toHaveLength(1);
		expect(r[0].plugin).toBe('edit');
		expect(r[0].reason).toBe('deleted');
		expect(r[0].configPath).toContain('config.json');
	});

	it('被更新不再进列表（ADR-0037 修订：更新不重置配置）', () => {
		seedConfig('review');
		const r = collectConfigResetCandidates(targetDir, []);
		expect(r).toHaveLength(0);
	});

	it('无 config.json 的插件不进列表', () => {
		const r = collectConfigResetCandidates(targetDir, ['edit']);
		expect(r).toHaveLength(0);
	});

	it('重复名去重', () => {
		seedConfig('edit');
		const r = collectConfigResetCandidates(targetDir, ['edit', 'edit']);
		expect(r).toHaveLength(1);
	});
});

// ============================================================================
// renderMultiSelect
// ============================================================================

describe('renderMultiSelect', () => {
	const items = ['pi-lab [deleted]', 'review [deleted]'];

	it('渲染标题、光标标记与勾选标记', () => {
		const selected = new Set([1]);
		const text = renderMultiSelect('T', items, 0, selected);
		expect(text).toContain('T');
		expect(text).toContain('> [ ] pi-lab [deleted]'); // 光标在第 0 项，未勾选
		expect(text).toContain('  [x] review [deleted]'); // 第 1 项勾选，无光标
	});

	it('全不选时所有项为 [ ]', () => {
		const text = renderMultiSelect('T', items, 0, new Set());
		expect(text).toContain('[ ] pi-lab [deleted]');
		expect(text).toContain('[ ] review [deleted]');
	});

	it('包含操作提示 footer', () => {
		const text = renderMultiSelect('T', items, 0, new Set());
		expect(text).toContain('Enter=确认');
		expect(text).toContain('Space=切换');
	});

	it('不使用双宽 emoji（字符白名单）', () => {
		const text = renderMultiSelect('T', items, 0, new Set());
		expect(text).not.toMatch(/📋|📜|✅|❌|⭐|🔍|▼|▊|⚙|✎|☑|☐|✓|✗/u);
	});
});

// ============================================================================
// findExtensionFormConflicts
// ============================================================================

describe('findExtensionFormConflicts', () => {
	let targetDir: string;

	beforeEach(() => {
		targetDir = join(tmpdir(), `sync-prune-test-${randomBytes(4).toString('hex')}`);
		mkdirSync(join(targetDir, 'extensions'), { recursive: true });
	});

	afterEach(() => {
		rmSync(targetDir, { recursive: true, force: true });
	});

	it('源是目录、目标是单文件 .ts → 判为残留（review.ts 场景）', () => {
		writeFileSync(join(targetDir, 'extensions', 'review.ts'), 'old');
		const conflicts = findExtensionFormConflicts(
			join(targetDir, 'extensions'),
			new Map([['review', true]]),
		);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].name).toBe('review');
		expect(conflicts[0].sourceIsDir).toBe(true);
		expect(conflicts[0].targetIsDir).toBe(false);
		expect(conflicts[0].path).toContain('review.ts');
	});

	it('源是单文件、目标是目录 → 判为残留', () => {
		mkdirSync(join(targetDir, 'extensions', 'edit'), { recursive: true });
		writeFileSync(join(targetDir, 'extensions', 'edit', 'index.ts'), '');
		const conflicts = findExtensionFormConflicts(
			join(targetDir, 'extensions'),
			new Map([['edit', false]]),
		);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].name).toBe('edit');
		expect(conflicts[0].targetIsDir).toBe(true);
	});

	it('形态一致时不判残留（源目录=目标目录）', () => {
		mkdirSync(join(targetDir, 'extensions', 'review'), { recursive: true });
		writeFileSync(join(targetDir, 'extensions', 'review', 'index.ts'), '');
		const conflicts = findExtensionFormConflicts(
			join(targetDir, 'extensions'),
			new Map([['review', true]]),
		);
		expect(conflicts).toHaveLength(0);
	});

	it('源清单里没有的名字不算形态冲突', () => {
		writeFileSync(join(targetDir, 'extensions', 'third-party.ts'), '');
		const conflicts = findExtensionFormConflicts(
			join(targetDir, 'extensions'),
			new Map([['review', true]]),
		);
		expect(conflicts).toHaveLength(0);
	});
});

// ============================================================================
// resetConfigProfiles
// ============================================================================

describe('resetConfigProfiles', () => {
	let targetDir: string;

	beforeEach(() => {
		targetDir = join(tmpdir(), `sync-prune-test-${randomBytes(4).toString('hex')}`);
		mkdirSync(targetDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(targetDir, { recursive: true, force: true });
	});

	function seedConfig(plugin: string): string {
		const dir = join(targetDir, 'extensions-data', plugin);
		mkdirSync(dir, { recursive: true });
		const configPath = join(dir, 'config.json');
		const sessionPath = join(dir, 'some-session.json');
		writeFileSync(configPath, '{}');
		writeFileSync(sessionPath, '{}');
		return configPath;
	}

	it('勾选项删 config.json，未勾选项保留', () => {
		const a = seedConfig('a');
		const b = seedConfig('b');
		const candidates = [
			{ plugin: 'a', reason: 'deleted' as const, configPath: a },
			{ plugin: 'b', reason: 'deleted' as const, configPath: b },
		];
		const logs: string[] = [];
		const reset = resetConfigProfiles(candidates, new Set([0]), (lvl, msg) =>
			logs.push(`${lvl}:${msg}`),
		);
		expect(reset).toEqual(['a']);
		expect(existsSync(a)).toBe(false);
		expect(existsSync(b)).toBe(true);
		expect(logs.some((l) => l.includes('[CONFIG RESET] a'))).toBe(true);
	});

	it('仅删 config.json，保留同目录 session 文件', () => {
		const a = seedConfig('a');
		const sessionPath = join(targetDir, 'extensions-data', 'a', 'some-session.json');
		resetConfigProfiles(
			[{ plugin: 'a', reason: 'deleted', configPath: a }],
			new Set([0]),
			() => {},
		);
		expect(existsSync(a)).toBe(false);
		expect(existsSync(sessionPath)).toBe(true);
	});

	it('删除前备份 config.json 到 .bak-<ts>', () => {
		const a = seedConfig('a');
		resetConfigProfiles(
			[{ plugin: 'a', reason: 'deleted', configPath: a }],
			new Set([0]),
			() => {},
		);
		expect(existsSync(a)).toBe(false);
		const bakFiles = readdirSync(join(targetDir, 'extensions-data', 'a')).filter((f) =>
			f.startsWith('config.json.bak-'),
		);
		expect(bakFiles).toHaveLength(1);
	});

	it('仅保留最新 N 份备份，清理更早的；非时间戳备份不受影响', () => {
		const a = seedConfig('a');
		const dir = join(targetDir, 'extensions-data', 'a');
		// 预置 4 份更早的时间戳备份 + 1 份非时间戳（手写）备份
		for (let i = 1; i <= 4; i++) {
			writeFileSync(`${a}.bak-2020010${i}-000000`, 'old');
		}
		writeFileSync(`${a}.bak-manual`, 'manual');
		const logs: string[] = [];
		resetConfigProfiles(
			[{ plugin: 'a', reason: 'deleted', configPath: a }],
			new Set([0]),
			(lvl, msg) => logs.push(`${lvl}:${msg}`),
		);
		const all = readdirSync(dir);
		const tsBackups = all.filter((f) => /^config\.json\.bak-\d{8}-\d{6}$/.test(f));
		expect(tsBackups).toHaveLength(MAX_CONFIG_BACKUPS);
		// 保留最新：新建备份与最新的旧备份；最旧的两份被清理
		expect(tsBackups).toContain('config.json.bak-20200104-000000');
		expect(tsBackups).not.toContain('config.json.bak-20200101-000000');
		// 非时间戳备份不被误删
		expect(all).toContain('config.json.bak-manual');
		expect(logs.some((l) => l.startsWith('WARN:') && l.includes('pruned stale backup'))).toBe(
			true,
		);
	});
});
