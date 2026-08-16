/**
 * 子键注册表 — 持有所有扩展注册的快捷键 entry，并做冲突裁决。
 *
 * 纯逻辑、无 pi runtime 依赖，可直接单测。
 * 设计：存原始 entries（默认子键）+ remap 规则，getEntries/match 动态应用 remap，
 * 因此支持运行时改键（setRemap），改键后立即生效。
 * 冲突规则：生效 keys 序列完全相同 → 先注册者胜，后者被拒并返回冲突的已有 entry。
 */

/** 快捷键触发处理函数签名：接收会话上下文（跨 pi 边界透传，any 为等价类型） */
export type ShortcutHandler = (ctx: any) => void | Promise<void>;

export interface ShortcutEntry {
	/** 插件名（唯一标识，如 'files'） */
	name: string;
	/** 子键序列：单功能 ['f']，多功能 ['f','o'] */
	keys: string[];
	/** 人类可读说明 */
	description: string;
	/** 触发处理函数（ctx 为触发时的会话上下文，由分发器透传） */
	handler: ShortcutHandler;
}

export interface RegisterResult {
	ok: boolean;
	/** 冲突时指向已存在的 entry */
	conflict?: { name: string; keys: string[] };
}

/** 用户自定义子键重映射规则：把 name 插件的 from 默认子键改到 to。 */
export interface RemapRule {
	/** 插件名（与 ShortcutEntry.name 对应） */
	name: string;
	/** 原始默认子键（二段式的硬编码值，稳定标识） */
	from: string[];
	/** 用户自定义的新子键 */
	to: string[];
}

export type MatchResult =
	{ status: 'exact'; entry: ShortcutEntry } | { status: 'prefix' } | { status: 'none' };

export class ShortcutRegistry {
	/** 原始 entries（默认子键），注册时存此值；生效 keys 由 remap 动态计算 */
	private _rawEntries: ShortcutEntry[] = [];
	private _remap: RemapRule[] = [];

	/**
	 * @param remap 用户自定义子键重映射规则（可选）。getEntries/match 时动态应用。
	 */
	constructor(remap: RemapRule[] = []) {
		this._remap = remap;
	}

	/**
	 * 注册一个快捷键 entry（存原始 keys）。
	 * 冲突裁决基于「生效 keys」（应用 remap 后）：完全相同、或互为前缀（会造成歧义）时拒绝。
	 * 幂等：相同 name + 生效 keys 已注册时返回成功（session_start 重复触发场景）。
	 */
	register(entry: ShortcutEntry): RegisterResult {
		const effectiveKeys = this._effectiveKeys(entry);

		const same = this._rawEntries.find(
			(e) =>
				e.name === entry.name &&
				this._serialize(this._effectiveKeys(e)) === this._serialize(effectiveKeys),
		);
		if (same) return { ok: true };

		const conflict = this._rawEntries.find((e) => {
			const ek = this._effectiveKeys(e);
			return (
				this._serialize(ek) === this._serialize(effectiveKeys) ||
				this._isPrefix(ek, effectiveKeys) ||
				this._isPrefix(effectiveKeys, ek)
			);
		});
		if (conflict) {
			return {
				ok: false,
				conflict: { name: conflict.name, keys: this._effectiveKeys(conflict) },
			};
		}
		this._rawEntries.push(entry);
		return { ok: true };
	}

	/**
	 * 运行时更新 remap 并校验冲突。冲突则拒绝并保持原 remap（回滚）。
	 * 成功后 getEntries/match 立即用新 remap 计算生效 keys。
	 */
	setRemap(remap: RemapRule[]): RegisterResult {
		const oldRemap = this._remap;
		this._remap = remap;

		// 只检查被 remap 影响的 entry（name 匹配任何规则）的新 keys 是否与其他 entry 冲突
		const remappedNames = new Set(remap.map((r) => r.name));
		for (const entry of this._rawEntries) {
			if (!remappedNames.has(entry.name)) continue;
			const ek = this._effectiveKeys(entry);
			for (const other of this._rawEntries) {
				if (other === entry) continue;
				const ok = this._effectiveKeys(other);
				if (
					this._serialize(ok) === this._serialize(ek) ||
					this._isPrefix(ok, ek) ||
					this._isPrefix(ek, ok)
				) {
					this._remap = oldRemap; // 回滚
					return { ok: false, conflict: { name: other.name, keys: ok } };
				}
			}
		}
		return { ok: true };
	}

	/** 返回所有已注册 entry（按注册顺序），keys 已应用 remap。 */
	getEntries(): ShortcutEntry[] {
		return this._rawEntries.map((e) => this._applyRemap(e));
	}

	/** 返回原始 entries（默认 keys，未应用 remap）。编辑面板用它构造 remap 的 from。 */
	getRawEntries(): ShortcutEntry[] {
		return this._rawEntries;
	}

	/**
	 * 分发匹配：给定已按下的子键序列，返回匹配状态（基于生效 keys）。
	 * - exact：keys 精确命中某 entry
	 * - prefix：keys 是某 entry 的严格前缀（还有子键未按，应继续等待）
	 * - none：无任何匹配
	 */
	match(keys: string[]): MatchResult {
		const entries = this.getEntries();
		const exact = entries.find((e) => this._serialize(e.keys) === this._serialize(keys));
		if (exact) return { status: 'exact', entry: exact };

		const hasPrefix = entries.some((e) => this._isPrefix(keys, e.keys));
		if (hasPrefix) return { status: 'prefix' };

		return { status: 'none' };
	}

	/** 计算 entry 的生效 keys（应用 remap，命中 name+from 则用 to）。 */
	private _effectiveKeys(entry: ShortcutEntry): string[] {
		const rule = this._remap.find(
			(r) => r.name === entry.name && this._serialize(r.from) === this._serialize(entry.keys),
		);
		return rule ? rule.to : entry.keys;
	}

	/** 返回应用 remap 后的 entry（命中则 keys 替换为 to）。 */
	private _applyRemap(entry: ShortcutEntry): ShortcutEntry {
		const rule = this._remap.find(
			(r) => r.name === entry.name && this._serialize(r.from) === this._serialize(entry.keys),
		);
		return rule ? { ...entry, keys: rule.to } : entry;
	}

	private _serialize(keys: string[]): string {
		return keys.join('+');
	}

	/** a 是否为 b 的严格前缀（长度更短且逐元素相等）。 */
	private _isPrefix(a: string[], b: string[]): boolean {
		if (a.length >= b.length) return false;
		return a.every((k, i) => k === b[i]);
	}
}

/** 同一插件的多个子键功能聚成一组，供列表渲染时用竖线串起来。 */
export interface PluginGroup {
	name: string;
	entries: ShortcutEntry[];
}

/**
 * 按插件名（entry.name）分组，保持首次出现顺序。
 * 同一 name 的多个 entry（如 files 的 f o / f r / f q）聚到同一组，
 * 供 editor/palette 渲染时用「│ / └」竖线串起来，让用户一眼看出归属同一插件。
 */
export function groupByPlugin(entries: ShortcutEntry[]): PluginGroup[] {
	const groups: PluginGroup[] = [];
	const map = new Map<string, PluginGroup>();
	for (const entry of entries) {
		let g = map.get(entry.name);
		if (!g) {
			g = { name: entry.name, entries: [] };
			map.set(entry.name, g);
			groups.push(g);
		}
		g.entries.push(entry);
	}
	return groups;
}
