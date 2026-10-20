/**
 * permission-gate — 提升的采纳与撤销（Ticket 08 / Ticket 09）
 *
 * 采纳会同时动两处，撤销必须**成对回滚**：
 *   1. **层级提升**：把该键所在的计数层迁到用户层（跨目录可见）——复用既有 `moveRuleKey`
 *   2. **范围扩大**：选了父目录/目标根时，把该根写入**用户级**信任范围，可挂出处条件
 *
 * 用户级配置只改 `dynamicPolicy` 里的两个键（scope / promoted），
 * **不写回合并后的整份配置**（那会把项目级的值抄进用户级）。
 */

import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readJsonFile, writeJsonAtomic } from '@zenone/pi-config';
import { createLogger } from '@zenone/pi-logger';
import {
	deleteRuleKeyScoped,
	getRuleCountsByLayer,
	getRuleCountsWithScope,
	moveRuleKey,
} from './approval-store.js';
import {
	normalizeScope,
	resolveConfigPath,
	scopeProvenance,
	type PromotedRule,
	type TrustRoot,
} from './config.js';
import type { PromotionCandidate } from './promotion.js';
import { isPromotableTier } from './promotion.js';

const log = createLogger('permission-gate:promotion-adopt');

/** 提升台阶（ADR-0060：①具体路径 ← 默认 ②父目录 ③目标根） */
export type PromotionLevel = 'leaf' | 'parent' | 'root';

const LEVEL_LABEL: Record<PromotionLevel, string> = {
	leaf: '具体路径',
	parent: '父目录',
	root: '目标根',
};

/**
 * 已知临时区根（实测覆盖本仓 100% 的可归类 rm 目标）：
 * 系统临时目录、`/tmp`、项目内 `.pi/tmp`、lens 缓存。
 * **认不出的路径不给第 ③ 级**——不猜（ADR-0060）。
 */
export function knownRoots(cwd: string): string[] {
	return [
		resolve(tmpdir()),
		'/tmp',
		join(resolve(cwd), '.pi', 'tmp'),
		join(homedir(), '.pi-lens'),
	];
}

/**
 * 从叶子向上推算可用台阶。
 * 第 ③ 级只在目标落在已知临时区根内时提供（否则只给两级）。
 */
export function promotionLevels(
	dir: string,
	cwd: string,
): Array<{ level: PromotionLevel; path: string }> {
	const abs = resolve(dir);
	const levels: Array<{ level: PromotionLevel; path: string }> = [{ level: 'leaf', path: abs }];

	const parent = resolve(abs, '..');
	if (parent !== abs) levels.push({ level: 'parent', path: parent });

	const root = knownRoots(cwd)
		// 最具体（最长）的根优先：越窄越安全，且不会把 `cwd/.pi/tmp` 误归到系统临时目录
		.filter((r) => abs === r || abs.startsWith(r + sep))
		.sort((a, b) => b.length - a.length)[0];
	if (root && root !== abs && root !== parent) levels.push({ level: 'root', path: root });

	return levels;
}

export interface AdoptResult {
	ok: boolean;
	/** 被迁到用户层的计数键 */
	moved: string[];
	/** 新增到用户级信任范围的根（若有） */
	scopeRoot?: string;
	/** 用户级范围被项目级真实收紧遮蔽时的提示（ADR-0059 三级覆盖） */
	shadowedByProject?: boolean;
	error?: string;
}

function evidenceSummary(c: PromotionCandidate): string {
	const e = c.evidence;
	return `本会话人工 ${e.sessionManual} / 自动 ${e.sessionAuto}；历史 ${e.historyDirectories} 目录 ${e.historySessions} 会话 ${e.userDenials} 拒绝`;
}

/** 读取用户级配置原文（只读需要的两个键所在的对象，不做整份合并） */
function readUserDynamicPolicy(cwd: string, homeDir?: string): Record<string, unknown> {
	const file = resolveConfigPath(cwd, 'user', homeDir);
	const raw = readJsonFile(file);
	if (!raw || typeof raw !== 'object') return {};
	const dyn = (raw as { dynamicPolicy?: unknown }).dynamicPolicy;
	return dyn && typeof dyn === 'object' && !Array.isArray(dyn)
		? { ...(dyn as Record<string, unknown>) }
		: {};
}

function writeUserDynamicPolicy(cwd: string, dyn: Record<string, unknown>, homeDir?: string): void {
	const file = resolveConfigPath(cwd, 'user', homeDir);
	const raw = (readJsonFile(file) ?? {}) as Record<string, unknown>;
	raw.dynamicPolicy = dyn;
	writeJsonAtomic(file, raw);
}

/** 项目级是否在用一条**真实**（非等价默认值）的范围收紧遮蔽用户级 */
function projectShadowsScope(cwd: string, homeDir?: string): boolean {
	// 复用 scopeProvenance 的同一套判定：项目级 scope 与下层生效范围一致时不算声明，
	// 否则（含下层更宽的 `[cwd]` 收紧）即遮蔽用户级。
	return scopeProvenance(cwd, null, homeDir).source === 'project';
}

/**
 * 采纳一条提升候选。
 *
 * @param level 台阶：leaf 只做层级提升；parent/root 额外把该根写入用户级范围
 * @param requireProvenance 是否给新增的根挂「仅限本会话创建的路径」（默认 true）
 */
export function adoptPromotion(opts: {
	cwd: string;
	candidate: PromotionCandidate;
	level: PromotionLevel;
	requireProvenance?: boolean;
	/** 测试专用：覆盖主目录（默认 ~） */
	homeDir?: string;
}): AdoptResult {
	const { cwd, candidate, level, homeDir } = opts;
	const requireProvenance = opts.requireProvenance !== false;
	const moved: string[] = [];

	// 采纳端门禁（ADR-0058 硬约束）：即便候选对象被外部构造出来，也不允许把
	// critical（提权/凭证/不可逆）的计数迁到用户层——失败即拒绝，不静默迁层。
	if (!isPromotableTier(candidate.tier)) {
		return {
			ok: false,
			moved,
			error: `不可提升的危险等级（${candidate.tier}）：提权/凭证/不可逆类别只保留在会话层`,
		};
	}

	try {
		// ── ① 层级提升：把计数迁到用户层 ──
		const withScope = getRuleCountsWithScope();
		const entry = withScope[candidate.key];
		if (entry && entry.scope !== 'user') {
			if (!moveRuleKey(candidate.key, entry.scope, 'user')) {
				return {
					ok: false,
					moved,
					error: `迁层失败：${candidate.key}（${entry.scope} → user）`,
				};
			}
			moved.push(candidate.key);
			log.info('提升迁层：%s（%s → user）', candidate.key, entry.scope);
		}

		// ── ② 范围扩大（仅当选了父目录/目标根）──
		let scopeRoot: string | undefined;
		const dyn = readUserDynamicPolicy(cwd, homeDir);
		if (level !== 'leaf') {
			const chosen = promotionLevels(candidate.dir, cwd).find((l) => l.level === level);
			if (!chosen) {
				return {
					ok: false,
					moved,
					error: `所选台阶（${LEVEL_LABEL[level]}）不可用：认不出目标根`,
				};
			}
			scopeRoot = chosen.path;

			// 用户级本无 scope 时，生效范围来自默认 `[cwd]`；直接以空列表为起点会把
			// cwd 从生效范围里丢掉——采纳后除新根外全部退回人工确认（P1 回归）。
			const existing = normalizeScope(dyn.scope, cwd) ?? [{ root: resolve(cwd) }];
			const roots: TrustRoot[] = existing.some((r) => r.root === scopeRoot)
				? existing
				: [
						...existing,
						{
							root: scopeRoot,
							...(requireProvenance ? { requireSessionProvenance: true } : {}),
						},
					];
			dyn.scope = roots;
		}

		// ── ③ 登记（撤销要能成对回滚 + 面板要能列出）──
		const promotedRaw = Array.isArray(dyn.promoted) ? (dyn.promoted as PromotedRule[]) : [];
		const record: PromotedRule = {
			key: candidate.key,
			level,
			...(scopeRoot ? { root: scopeRoot } : {}),
			...(scopeRoot && requireProvenance ? { requireSessionProvenance: true } : {}),
			createdAt: new Date().toISOString(),
			evidence: evidenceSummary(candidate),
		};
		const promoted = [...promotedRaw.filter((r) => r.key !== candidate.key), record];
		dyn.promoted = promoted;

		if (level !== 'leaf' || promoted.length !== promotedRaw.length) {
			writeUserDynamicPolicy(cwd, dyn, homeDir);
		}

		const shadowed = scopeRoot ? projectShadowsScope(cwd, homeDir) : false;
		if (shadowed) {
			log.warn(
				'提升已写入用户级范围，但被**项目级**范围收紧遮蔽（ADR-0059）：%s',
				resolveConfigPath(cwd, 'project', homeDir),
			);
		}
		log.info(
			'采纳提升：%s（台阶=%s%s%s）',
			candidate.key,
			LEVEL_LABEL[level],
			scopeRoot ? `，范围 += ${scopeRoot}` : '',
			scopeRoot && requireProvenance ? '，挂出处条件' : '',
		);
		return {
			ok: true,
			moved,
			...(scopeRoot ? { scopeRoot } : {}),
			shadowedByProject: shadowed,
		};
	} catch (err) {
		const message = String((err as Error).message ?? err);
		log.error('采纳提升失败：%s', message);
		return { ok: false, moved, error: message };
	}
}

/** 已提升条目（Ticket 09 的列表来源：用户层计数键 + 登记表） */
export function listPromoted(cwd: string, homeDir?: string): PromotedRule[] {
	const dyn = readUserDynamicPolicy(cwd, homeDir);
	const promoted = Array.isArray(dyn.promoted) ? (dyn.promoted as PromotedRule[]) : [];
	if (promoted.length > 0) return promoted;
	// 兼容：登记表缺失时，退化为"用户层现有的计数键"。
	// 这些键大量来自 info 级按 tier→scope 的自然沉淀，并非经提升产生，
	// **不可撤销**（删除会抹掉本应永久保留的规则）——用 synthetic 标记只读展示。
	const userLayer = getRuleCountsByLayer().user;
	return Object.keys(userLayer).map((key) => ({
		key,
		level: 'leaf' as PromotionLevel,
		createdAt: '',
		evidence: '（无登记信息，可能为自然沉淀）',
		synthetic: true,
	}));
}

export interface RevokeResult {
	ok: boolean;
	removedKey: boolean;
	removedRoot?: string;
	error?: string;
}

/**
 * 撤销一条已提升条目：成对回滚（用户层计数 + 该条新增的范围根）。
 *
 * 只回滚**这一条**新增的根：仍有其他已提升条目在用同一个根时保留它
 * （否则会误伤别的条目）。
 */
export function revokePromotion(cwd: string, key: string, homeDir?: string): RevokeResult {
	try {
		const dyn = readUserDynamicPolicy(cwd, homeDir);
		const promoted = Array.isArray(dyn.promoted) ? (dyn.promoted as PromotedRule[]) : [];
		const record = promoted.find((r) => r.key === key);

		const removedKey = deleteRuleKeyScoped(key, 'user');

		let removedRoot: string | undefined;
		if (record?.root) {
			const stillNeeded = promoted.some((r) => r.key !== key && r.root === record.root);
			if (!stillNeeded) {
				const roots = normalizeScope(dyn.scope, cwd) ?? [];
				const remaining = roots.filter((r) => r.root !== record.root);
				// 采纳时若用户级本无 scope，会补上默认根 `[cwd]`；撤销后若只剩这条默认根，
				// 删除整个 scope 字段，恢复采纳前形态（成对回滚）。
				if (
					remaining.length === 1 &&
					!remaining[0]!.requireSessionProvenance &&
					remaining[0]!.root === resolve(cwd)
				) {
					delete dyn.scope;
				} else {
					dyn.scope = remaining;
				}
				removedRoot = record.root;
			}
		}

		dyn.promoted = promoted.filter((r) => r.key !== key);
		writeUserDynamicPolicy(cwd, dyn, homeDir);

		log.info(
			'撤销提升：%s（删用户层计数=%s%s）',
			key,
			removedKey,
			removedRoot ? `，移除范围根 ${removedRoot}` : '',
		);
		return { ok: true, removedKey, ...(removedRoot ? { removedRoot } : {}) };
	} catch (err) {
		const message = String((err as Error).message ?? err);
		log.error('撤销提升失败：%s', message);
		return { ok: false, removedKey: false, error: message };
	}
}
