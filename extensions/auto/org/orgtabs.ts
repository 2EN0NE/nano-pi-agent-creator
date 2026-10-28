// org — org tab 行的纯逻辑（ADR-0070 `D2`/`D4`/`D5`/`D8`）
//
// 三个纯函数，全部**无 IO**（便于穷举测试）；IO 与状态由看板持有：
//   orderOrgTabs      tab 排序：所属段在前（最近派活倒序），非所属段在后（字母序）
//   brailleCount      在岗人数 → 单格盲文点阵（>8 封顶 `⣿+`）
//   remapOrgIdxByName 重排后按 org 名跟住当前 tab —— **绝不沿用旧下标**

/** tab 的排序输入（数量与顺序都只由这三个字段决定） */
export interface OrgTabEntry {
	/** org 名 */
	name: string;
	/** 是否属于打开看板的 cwd（ADR-0070 D1：成员注册表精确匹配得到的集合成员） */
	own: boolean;
	/** 该 org 最近一次派活的时刻（ISO；`null` = 尚无任务）；缺失视为最旧 */
	lastDispatchAt: string | null;
}

/** 名字母序（tie-break 与"非所属段"共用同一口径，避免两处排序规则漂移） */
function byName(a: OrgTabEntry, b: OrgTabEntry): number {
	return a.name.localeCompare(b.name);
}

/** 最近派活倒序；`null` 排在有值之后；同刻按名字母序兜底 */
function byRecentDispatch(a: OrgTabEntry, b: OrgTabEntry): number {
	const x = a.lastDispatchAt ?? '';
	const y = b.lastDispatchAt ?? '';
	if (x !== y) return y.localeCompare(x);
	return byName(a, b);
}

/**
 * tab 排序：**所属段在前**（组内按最近派活倒序）、**非所属段在后**（字母序）。
 *
 * 为什么所属不分优先级：成员记录里没有"更属于"这种关系，`joinedAt` 只是登记时间
 * （ADR-0070 D2）。所以所属集合内只用派活活跃度排序，不引入第二套归属关系。
 */
export function orderOrgTabs(entries: readonly OrgTabEntry[]): OrgTabEntry[] {
	const own = entries.filter((e) => e.own).sort(byRecentDispatch);
	const rest = entries.filter((e) => !e.own).sort(byName);
	return [...own, ...rest];
}

/**
 * 盲文点阵填充顺序：**列优先** —— dot1→2→3→7（左列自上而下），再 dot4→5→6→8（右列）。
 * 视觉上像一根从左列开始往下长的竖条，比逐行左右交替更像"人数堆起来"。
 */
const FILL_ORDER = [1, 2, 3, 7, 4, 5, 6, 8] as const;

/** 盲文基码（U+2800 = 0 点，渲染为空白但与其它盲符等宽） */
const BRAILLE_BASE = 0x2800;

/**
 * 在岗人数 → 单格盲文点阵（ADR-0070 D8）。
 *
 * - `0` → `U+2800`：**空白盲符**而非空串，保证每枚 chip 宽度恒定、点位与同行对齐；
 * - `1..8` → 按 `FILL_ORDER` 逐点填充；
 * - `>8` → `⣿+`（封顶）：单 org 成员数超过 8 在设计上已不合理，不值得引入更长编码。
 */
export function brailleCount(online: number): string {
	const n = Number.isFinite(online) ? Math.max(0, Math.floor(online)) : 0;
	if (n > FILL_ORDER.length) return `${String.fromCodePoint(BRAILLE_BASE + 0xff)}+`;
	let bits = 0;
	for (const dot of FILL_ORDER.slice(0, n)) bits |= 1 << (dot - 1);
	return String.fromCodePoint(BRAILLE_BASE + bits);
}

/**
 * 重排后按名字重新求当前 org 的下标（ADR-0070 D5）。
 *
 * `orgIdx` 是数组下标、Tab 循环靠它，因此**重排必须按名跟住**：另一进程往别家派活会让
 * 名单顺序变化，沿用旧下标会让屏幕突然换成另一家 org（与看板内「按 task id 跟住光标」
 * 同类事故，见 `remapSelectionById`）。名字消失（org 被删）才夹紧索引。
 */
export function remapOrgIdxByName(
	names: readonly string[],
	prevIdx: number,
	keepName: string | undefined,
): number {
	if (names.length === 0) return 0;
	if (keepName) {
		const found = names.indexOf(keepName);
		if (found >= 0) return found;
	}
	return Math.max(0, Math.min(prevIdx, names.length - 1));
}
