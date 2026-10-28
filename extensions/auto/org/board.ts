// org — /org TUI 任务看板（tickets 09/10）
// 目录绑定 agent 框架的人类操作台：公司 tab（Tab 循环本机全部 org）→ 视角（任务/成员/设置）
// → 任务视角 4 状态子 tab → 列表（选行进详情）→ 详情页（元信息 + 子任务 + 交付/验收 + 人类操作）
//
// 规范（ADR-0023 / tui-design-principles）：
//   - 字符白名单：纯文本（无双宽 emoji），选中用 `>` 前缀 + 主题色
//   - 第 0 行恒为静态标题行（防 firstChanged=0 fullRender 重影，铁律 2）
//   - 动态信息（滚动位置/操作提示/高亮 tab）放底部 footer
//   - 每行 truncateToWidth 兜底
//   - 总行数 ≤ 24 上限（铁律 1：不超终端视口），列表内部滚动
// 数据为快照式：打开加载一次 + `r` 手动刷新 + 在岗巡检定时器（presence polling，ADR-0040 D4/F1）
import * as os from 'node:os';
import {
	orgConfigStore,
	DEFAULT_BOARD_PREFS,
	defaultMemberLaunchArgs,
	type BoardPrefs,
} from './config.js';
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import {
	type Component,
	type TUI,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { OrgFile, Task } from './types.js';
import { loadManifest } from './manifest.js';
import {
	effectiveDueAt,
	isOverdueMarked,
	listTasks,
	queueLengthFor,
	readTask,
	saveTask,
	attestTask,
	approveWithAdoption,
	cancelTask,
	humanReassign,
	lastDispatchAt,
} from './task.js';
import {
	createOrg,
	defaultAgentName,
	findOrgsForDir,
	joinOrg,
	leaveOrg,
	listOrgNames,
	readOrg,
	removeOrg,
	renameOrg,
	transferChief,
} from './orgstore.js';
import { deliverMessage, retrySubTask } from './dispatch.js';
import { setAutoWake } from './orgstore.js';
import { setBackground } from './orgstore.js';
import { refreshAllMemberManifests } from './orgstore.js';
import { setMemberLaunchArgs } from './orgstore.js';
import { splitLaunchArgs } from './launch-args.js';
import {
	DIR_MISSING_WORD,
	inspectMembers,
	onlineFor,
	PRESENCE_POLL_MS,
	sweepStaleRuntime,
	countOnlineByPid,
	type MemberPresence,
	type PresenceState,
	PRESENCE_WORDS,
} from './presence.js';
import { brailleCount, orderOrgTabs, remapOrgIdxByName, type OrgTabEntry } from './orgtabs.js';
import { readSlot, type SlotRecord } from './slot.js';
import { resolveMemberQueueCap } from './config.js';
import { remainingText } from './briefing.js';
import {
	readLastSession,
	sameDir,
	stopMember,
	tmuxManagedMembers,
	wakeMember,
} from './lifecycle.js';
import { tmuxSessionName } from './tmux.js';
import {
	ACTIVITY_DETAIL_LIMIT,
	ACTIVITY_FAIL_TEXT,
	ACTIVITY_LIST_LIMIT,
	WarnOnce,
	fetchActivity,
	formatActivityLine,
	interruptMember,
	summariseForList,
	type ActivityEntry,
} from './activity.js';
import { dirExists, nowIso, realDir } from './util.js';

const log = createLogger('org-board');

export interface BoardTheme {
	dim: (s: string) => string;
	bold: (s: string) => string;
	accent: (s: string) => string;
	success: (s: string) => string;
	warning: (s: string) => string;
	error: (s: string) => string;
	muted: (s: string) => string;
	selectedBg: (s: string) => string;
}

/** theme 宽松签名以兼容真实 pi Theme 与 headless mock */
export function makeBoardTheme(theme: {
	fg: (color: any, text: string) => string;
	bold: (text: string) => string;
	bg?: (color: any, text: string) => string;
}): BoardTheme {
	return {
		dim: (s) => theme.fg('dim', s),
		bold: (s) => theme.bold(s),
		accent: (s) => theme.fg('accent', s),
		success: (s) => theme.fg('success', s),
		warning: (s) => theme.fg('warning', s),
		error: (s) => theme.fg('error', s),
		muted: (s) => theme.fg('muted', s),
		selectedBg: (s) => (theme.bg ? theme.bg('selectedBg', s) : theme.fg('accent', s)),
	};
}

export type BoardView = 'tasks' | 'people' | 'settings';
export type TaskTabIdx = 0 | 1 | 2 | 3; // todo/in_progress/waiting_accept/closed

const TASK_TAB_NAMES = ['TODO', 'DOING', 'WAITING', 'CLOSED'] as const;
const VIEW_TABS: { key: BoardView; label: string }[] = [
	{ key: 'tasks', label: '任务' },
	{ key: 'people', label: '成员' },
	{ key: 'settings', label: '设置' },
];

/**
 * 所属集合为空时的语义尾注（ADR-0070 D3/D6）。
 * 必要性：D3 要求此时整排 tab 压暗，而「全暗」没有对比项，容易被读成「这些组织都不可用/没权限」。
 */
const NOT_OWN_ORG_NOTE = '本目录未加入任何组织';

/** 一次探测的完整结果（状态 + 诊断缓存），供原子提交 */
interface PresenceBundle {
	next: Map<string, MemberPresence>;
	managed: Set<string>;
	lastSessions: Map<string, string | null>;
}

interface OrgSnapshot {
	org: OrgFile;
	tasks: Task[];
	loadedAt: string;
}

/** 上岗能力（由 org 侧注入；缺省 → 看板不显示上岗入口，headless / 测试友好） */
export interface BoardDuty {
	/** 当前态（ADR-0046 D2）：不可上岗（无 socket）/ 可上岗未上岗 / 在岗 */
	state: () => 'unavailable' | 'eligible' | 'on';
	/** 上岗（on=true）/ 离岗；返回给人看的回报文本 */
	toggle: (on: boolean) => Promise<{ ok: boolean; message: string }>;
}

export interface BoardHooks {
	/** 人类操作执行后的回调（如推送通知），接收动作描述 */
	onAction?: (org: string, taskId: string, action: string, detail: string) => void;
	/** 上岗入口（设置行 + `o` 键；ADR-0046 D3） */
	duty?: BoardDuty;
}

const MAX_BODY_LINES = 10; // 列表区可见行数下限（实际值随终端高度自适应，见 listRows()）
/** 详情屏「最近动态」显示行数（拉 10 条，屏上只留最近几条；ADR-0052 D4） */
const ACTIVITY_DETAIL_ROWS = 3;

/** 四态中文词（成员详情标题行用） */
/**
 * 账本重载后按 **task id** 找回原选中行（列表按 `updatedAt` 排序，交付/改派都会重排）。
 *
 * 找不到该 id（任务被删、或**已移出当前状态 tab**——例如刚被认领就从「待处理」跳到「进行中」）时
 * 才夹紧索引：此时光标落到邻居行是预期的，因为原任务已不在这张列表里。
 */
export function remapSelectionById<T extends { id: string }>(
	list: T[],
	prevIdx: number,
	keepId: string | undefined,
): number {
	if (list.length === 0) return 0;
	if (keepId) {
		const found = list.findIndex((t) => t.id === keepId);
		if (found >= 0) return found;
	}
	return Math.max(0, Math.min(prevIdx, list.length - 1));
}

/**
 * 四态圆点（ADR-0040 D5/D12①）：颜色一律走主题 token，禁止写死颜色。
 * 暗空心 `dim` / 空闲默认色空心 / 工作中 `accent` 实心 / 待验收默认色实心。
 * 字符 ●○ 宽度均为 1（`visibleWidth` 实测），且不在 ADR-0023 门禁的双宽 emoji 范围内。
 */
function presenceDot(state: PresenceState, th: BoardTheme): string {
	if (state === 'sleeping') return th.dim('○');
	if (state === 'working') return th.accent('●');
	return state === 'delivered' ? '●' : '○';
}
// 总行数上限改为随终端高度自适应（见 maxTotal()）——铁律 1：组件总高 ≤ 视口

export class OrgBoard implements Component {
	/** 人类操作台身份：human@<打开面板目录 basename>（ADR-0039 H1——人操作不分 org/派发人） */
	private readonly humanId: string;
	private meName: string;
	private tui: TUI;
	private th: BoardTheme;
	private done: (result: string | null) => void;
	private hooks: BoardHooks;

	// 加载与导航状态
	private loading = true;
	private loadError = '';
	/**
	 * org 名单，**顺序即 tab 顺序**（ADR-0070 D2）：所属段在前（最近派活倒序），
	 * 非所属段在后（字母序）。任何重排都必须同时按名校正 `orgIdx`（见 `reorderOrgTabs`）。
	 */
	private orgNames: string[] = [];
	private orgIdx = 0;
	/** 打开看板的 cwd 所属的 org 集合（ADR-0070 D1；可能为空集，也可能多元素） */
	private ownOrgs: Set<string>;
	/** 各 org 最近一次派活的时刻（排序键；缺失 = 尚无任务，ADR-0070 D4） */
	private lastDispatchAt = new Map<string, string | null>();
	/** 各 org 的在岗人数（D7/D8）：当前 org 走权威判据，其余走廉价判据 */
	private onlineByOrg = new Map<string, number>();
	private view: BoardView = 'tasks';
	private taskTab: TaskTabIdx = 0;
	private selIdx = 0; // 当前列表选中行
	private filterActive = false; // / 进入过滤输入态（与 filter 空串区分）
	private filterBeforeEdit = ''; // 进入过滤输入态前的值（Esc 还原用）
	private filter = ''; // 列表关键字过滤（即时）
	private snap: Map<string, OrgSnapshot> = new Map();
	// 可感知状态：仅缓存**当前 org**成员（ADR-0040 D4/D5）；巡检只读刷新，不唤醒不杀停
	private presence = new Map<string, MemberPresence>();
	/**
	 * `presence` 这份权威快照属于哪家 org。
	 * 用途：巡检是异步的，探测期间人可能切了公司——`refreshOnlineCounts` 若无条件把这些旧状态
	 * 当作"当前 org"的权威计数，切换后的一拍就会显示错误数字（与 `computePresence` 里
	 * 「探测期间人类可能切了公司 → 丢弃过期结果」同源的坑）。
	 */
	private presenceOrg = '';
	private presenceTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;
	// 瞬态提示（唤醒/睡眠结果）：任何下一次按键即清除；noticeSeq 丢弃过期异步结果
	private notice = '';
	private noticeSeq = 0;
	// 诊断缓存（成员详情屏）：tmux 托管成员 + 各成员上次会话 id（随巡检刷新）
	private tmuxManaged = new Set<string>();
	/** 成员最近动态（只读观测；随巡检刷新，见 refreshActivity；ADR-0052）——键为 `org/成员`，跨 org 不串 */
	private activity = new Map<string, ActivityEntry[]>();
	/** 执行槽缓存（ADR-0055 `D2`：成员"在跑什么"）——随巡检刷新，渲染期只读；键为 `org/成员` */
	private slots = new Map<string, SlotRecord | null>();
	/** 成员动态刷新在途标志：串行 RPC 慢时跳过本轮，避免叠加到下一巡检节拍 */
	private activityRefreshing = false;
	/** 账本重载在途标志（同类防护：重读 IO 慢时跳过本轮） */
	private ledgerReloading = false;
	/**
	 * 各 org 上次账本指纹：内容没变就不重绘。
	 * 键为 org 名（切换 org / 多公司共存时互不干扰）。
	 */
	private ledgerFp = new Map<string, string>();
	/** 动态拉取失败的留痕闸门：每个成员只 warn 一次（ADR-0052 D8） */
	private activityWarn = new WarnOnce();
	private lastSessions = new Map<string, string | null>();
	private prefs: BoardPrefs = { ...DEFAULT_BOARD_PREFS };

	// 详情/成员导航
	private detailTaskId: string | null = null; // 详情页
	private drillCursors: number[] = []; // 下钻前的列表光标（返回时恢复）
	private detailFocus = 0; // 详情页参与者焦点（active assignee 平铺索引；-1 无焦点）
	private peopleSel: string | null = null; // 成员视角：选中成员 → 该成员任务清单屏
	// 二次确认：携带展示文案与待执行动作（所有破坏性操作统一走这里，屏上可见）
	private confirm: { title: string; detail?: string; run: () => void } | null = null;
	private reassignMode = false; // 详情内改派候选选择（G2 第二级）
	private reassignSel = 0;
	// 设置视角：TUI 内公司操作（新建/改名输入态、加入公司选择态）
	private inputMode: 'create' | 'rename' | 'join-pick' | 'background' | 'launch-args' | null =
		null;
	private orgNameInput = '';
	private backgroundInput = '';
	/**
	 * 启动参数编辑会话：目标成员 + 打开时的存量值 + 正在编辑的值。
	 * 三者合成一个对象是刻意的——分开存时存在「目标已清、输入框仍有值」这类非法组合，
	 * 任何一条早退路径漏清一个字段都会残留到下次打开；合成后只有"有会话/无会话"两态。
	 */
	private launchArgsEdit: { target: string; before: string; value: string } | null = null;
	private createErr = '';
	private joinCands: string[] = [];
	private joinSel = 0;

	// 渲染缓存
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		meName: string,
		tui: TUI,
		theme: {
			fg: (color: any, text: string) => string;
			bold: (text: string) => string;
			bg?: (color: any, text: string) => string;
		},
		done: (result: string | null) => void,
		hooks: BoardHooks = {},
		/**
		 * 打开看板的 cwd 所属的 org 集合（ADR-0070 D1）。由命令层用成员注册表精确匹配算出后传入——
		 * 看板自己不再从 `orgNames` 反推"我的组织"（旧 `meOrgPref()` 就是这么错的）。
		 */
		ownOrgs: readonly string[] = [],
	) {
		this.ownOrgs = new Set(ownOrgs);
		this.meName = meName;
		this.humanId = `human@${path.basename(process.cwd()) || 'local'}`;
		this.tui = tui;
		this.th = makeBoardTheme(theme);
		this.done = done;
		this.hooks = hooks;
		this.loadPrefs()
			.then(() => this.initialize())
			.catch((e) => this.fail(e));
	}

	private async loadPrefs(): Promise<void> {
		// 界面偏好走 @zenone/pi-config（用户级；见 org/config.ts 头注释：为何不用项目/会话级）
		const raw = orgConfigStore.get();
		if (typeof raw.sortNewFirst === 'boolean') this.prefs.sortNewFirst = raw.sortNewFirst;
		if (typeof raw.annotate === 'boolean') this.prefs.annotate = raw.annotate;
	}

	private async initialize(): Promise<void> {
		try {
			const names = await listOrgNames();
			// 排序键（ADR-0070 D4）：各 org 最近派活时刻，打开时并发算一次。
			// 当前 org 之后随账本重载实时更新；其余 org 保持此值（陈旧只影响非当前 org 的
			// 相对次序，不影响"人正在看的那家"）。
			const dispatchPairs = await Promise.all(
				names.map(async (n): Promise<[string, string | null]> => [
					n,
					await this.dispatchKeyOf(n),
				]),
			);
			this.lastDispatchAt = new Map(dispatchPairs);
			this.orgNames = this.orderTabNames(names);
			// 默认打开：所属段首位（即所属中最近派活的那家）；无所属则回落字母序第一（ADR-0070 D1/D2）
			this.orgIdx = 0;
			if (this.orgNames.length > 0) {
				const firstOwn = this.orgNames.findIndex((n) => this.ownOrgs.has(n));
				this.orgIdx = firstOwn >= 0 ? firstOwn : 0;
			}
			// 快照就绪前不得清 loading：否则看板会以"已加载"姿态渲染空成员表，
			// 此时按键（w/s/m/d）取不到成员 → **静默 no-op**（org T3「唤醒幂等」曾因此偶发失败：
			// 按 w 时 hasSnap=false，既无"正在唤醒…"也无任何提示）。
			if (this.orgNames.length > 0) {
				await this.loadCurrentOrg();
				await this.refreshOnlineCounts();
			}
			this.loading = false;
			this.invalidate();
			this.startPresencePolling();
			this.tui.requestRender();
		} catch (e) {
			this.fail(e);
		}
	}

	/** 按当前排序键把 org 名单排成 tab 顺序（ADR-0070 D2：所属段在前，段内按最近派活倒序） */
	private orderTabNames(names: readonly string[]): string[] {
		const entries: OrgTabEntry[] = names.map((n) => ({
			name: n,
			own: this.ownOrgs.has(n),
			lastDispatchAt: this.lastDispatchAt.get(n) ?? null,
		}));
		return orderOrgTabs(entries).map((e) => e.name);
	}

	/**
	 * 读某 org 的「最近派活」排序键（ADR-0070 D4）。
	 * 读失败留 debug 痕迹后按"无派活"处理：排序键坏掉不该阻断看板，但也不能静默把故障
	 * 显示成事实（"这家从来没派过活"）。
	 */
	private async dispatchKeyOf(name: string): Promise<string | null> {
		try {
			return await lastDispatchAt(name);
		} catch (e) {
			log.debug('排序键读取失败（按无派活处理）', { org: name, err: String(e) });
			return null;
		}
	}

	/**
	 * 重算「所属组织」集合（ADR-0070 D1：目录精确匹配成员注册表）。
	 * **必须可重算**：新建/改名/加入公司都会改变"本目录属于谁"（新建与加入会把 cwd 登记为成员，
	 * 改名会换掉 ownOrgs 里存的 org 名），只留构造期快照会让新组织仍被当成"非所属"压暗，
	 * 甚至继续显示「本目录未加入任何组织」。
	 */
	private async refreshOwnOrgs(): Promise<void> {
		try {
			const found = await findOrgsForDir(process.cwd());
			this.ownOrgs = new Set(found.map((o) => o.name));
		} catch (e) {
			log.warn('重算所属组织失败（沿用旧值）', { err: String(e) });
			return;
		}
		this.reorderOrgTabs();
	}

	/**
	 * 按最新排序键重排 tab，并**按 org 名跟住当前 tab**（ADR-0070 D5）。
	 * 返回是否真的换了顺序（调用方据此决定是否重绘）。
	 */
	private reorderOrgTabs(): boolean {
		const next = this.orderTabNames(this.orgNames);
		const same =
			next.length === this.orgNames.length && next.every((n, i) => n === this.orgNames[i]);
		if (same) return false;
		const keepName = this.orgNames[this.orgIdx];
		this.orgNames = next;
		this.orgIdx = remapOrgIdxByName(next, this.orgIdx, keepName);
		return true;
	}

	/** 所属段长度（所属恒排在前面，故它就是两段之间分隔符的位置） */
	private ownOrgCount(): number {
		let n = 0;
		for (const name of this.orgNames) if (this.ownOrgs.has(name)) n += 1;
		return n;
	}

	/**
	 * 单枚 org chip（ADR-0070 D6/D8）。三条轴互不覆盖：
	 * - **所属** → 名字段色调强弱（所属 muted / 非所属 dim）；
	 * - **当前** → accent + bold（比任何 dim 都亮，故四态可分）；
	 * - **在岗人数** → 点阵，**独立着色**（有在线 muted / 无在线 dim）——若跟着 chip 一起 dim，
	 *   暗盲文点会糊成一团。因此点阵必须拆出来单独上色，不能整枚 chip 一次串色。
	 */
	private orgChip(name: string, active: boolean): string {
		const th = this.th;
		const own = this.ownOrgs.has(name);
		const style = active ? (s: string) => th.accent(th.bold(s)) : own ? th.muted : th.dim;
		const online = this.onlineByOrg.get(name) ?? 0;
		const glyph = brailleCount(online);
		const dot = online > 0 ? th.muted(glyph) : th.dim(glyph);
		return `${style(`[ ${name} `)}${dot}${style(' ]')}`;
	}

	/**
	 * 刷新各 org 的在岗计数（ADR-0070 D7/D8）：当前 org 取权威四态里的"非睡眠"数，
	 * 其余 org 走廉价 pid 判据。返回是否变化。
	 */
	private async refreshOnlineCounts(): Promise<boolean> {
		const cur = this.orgNames[this.orgIdx];
		// 只有 presence 确实属于当前 org 时才可当权威计数；否则（刚切过来、巡检还没回来）
		// 对 cur 也先用廉价判据兜一拍，下一拍权威结果到位即替换。
		const authoritative = cur !== '' && this.presenceOrg === cur;
		const others = await Promise.all(
			this.orgNames
				.filter((n) => n !== cur || !authoritative)
				.map(async (n): Promise<[string, number]> => {
					try {
						return [n, await countOnlineByPid(n)];
					} catch (e) {
						log.debug('在岗计数读取失败（按 0 人处理）', { org: n, err: String(e) });
						return [n, 0];
					}
				}),
		);
		// 探测期间人可能切了公司 → 丢弃过期结果（与 computePresence 的「探测期间切公司」同源）：
		// 否则旧 cur 的计数会用新 org 的 presence 算出，还可能晚于切 org 那次调用落盘。
		if (this.orgNames[this.orgIdx] !== cur) return false;
		const next = new Map<string, number>(others);
		if (cur && authoritative) {
			let online = 0;
			for (const p of this.presence.values()) if (p.state !== 'sleeping') online += 1;
			next.set(cur, online);
		}
		let changed = next.size !== this.onlineByOrg.size;
		if (!changed) {
			for (const [n, c] of next) {
				if (this.onlineByOrg.get(n) !== c) {
					changed = true;
					break;
				}
			}
		}
		this.onlineByOrg = next;
		return changed;
	}

	private fail(e: unknown): void {
		this.loading = false;
		this.loadError = e instanceof Error ? e.message : String(e);
		this.invalidate();
		this.tui.requestRender();
	}

	/**
	 * 探测当前 org 全部成员的可感知状态（只读）。
	 * sweep=true 时顺带清理 stale runtime（进程被 SIGKILL 时 clearRuntime 跑不到）。
	 * 返回"状态是否变化"——调用方据此决定要不要重绘（无变化不惊动渲染器）。
	 */
	private async computePresence(
		name: string,
		snap: OrgSnapshot,
		opts?: { sweep?: boolean },
	): Promise<PresenceBundle | null> {
		const memberNames = snap.org.members.map((m) => m.name);
		const next = await inspectMembers(name, memberNames, snap.tasks);
		if (opts?.sweep) await sweepStaleRuntime(name, next);
		// 诊断信息：非睡眠成员探测 tmux 托管；全部成员读 last-session（供详情屏据实展示）
		const onlineNames = [...next].filter(([, p]) => p.state !== 'sleeping').map(([n]) => n);
		const managed = await tmuxManagedMembers(name, onlineNames);
		const lastEntries = await Promise.all(
			memberNames.map(
				async (n) => [n, (await readLastSession(name, n))?.sessionId ?? null] as const,
			),
		);
		// 探测期间人类可能切了公司——丢弃过期结果，避免旧 org 的状态覆盖新 org
		if (this.orgNames[this.orgIdx] !== name) return null;
		return { next, managed, lastSessions: new Map(lastEntries) };
	}

	/** 提交探测结果，返回"状态是否变化"（供巡检决定要不要重绘） */
	private commitPresence(org: string, bundle: PresenceBundle): boolean {
		const changed =
			bundle.next.size !== this.presence.size ||
			[...bundle.next].some(([n, p]) => this.presence.get(n)?.state !== p.state);
		this.presence = bundle.next;
		this.presenceOrg = org;
		this.tmuxManaged = bundle.managed;
		this.lastSessions = bundle.lastSessions;
		return changed;
	}

	/** 巡检用的刷新（快照已在内存） */
	private async refreshPresence(opts?: { sweep?: boolean }): Promise<boolean> {
		const name = this.orgNames[this.orgIdx];
		const snap = name ? this.snap.get(name) : undefined;
		if (!name || !snap) return false;
		const bundle = await this.computePresence(name, snap, opts);
		if (!bundle) return false;
		return this.commitPresence(name, bundle);
	}

	/**
	 * 刷新成员动态（只读观测，ADR-0052）：
	 * - 详情屏关注的成员拉 `ACTIVITY_DETAIL_LIMIT` 条，其余在岗成员拉 `ACTIVITY_LIST_LIMIT` 条（=1）；
	 * - **不在岗成员不发 RPC**，动态清空（显示"（无动态）"）；
	 * - 任何失败只降级 + 每成员一次 warn，**绝不影响四态与派活**。
	 */
	private async refreshActivity(): Promise<void> {
		const name = this.orgNames[this.orgIdx];
		const snap = name ? this.snap.get(name) : undefined;
		if (!name || !snap) return;
		// 串行 RPC 可能慢于巡检节拍（成员数 ≥4 且普遍无响应时单次刷新 > 4s）：
		// 上一轮未完成就跳过本轮，避免并发 RPC 与 refresh() 叠加
		if (this.activityRefreshing) return;
		this.activityRefreshing = true;
		try {
			const focus = this.peopleSel ?? this.focusedMember();
			let changed = false;
			// 顺序拉取：成员数少（几人），每人一条 RPC；顺序写省去并发分支，失败互不影响
			for (const m of snap.org.members) {
				const changedOne = await this.refreshOneActivity(name, m.name, focus);
				if (changedOne) changed = true;
			}
			if (changed && !this.closed) this.refresh();
		} finally {
			this.activityRefreshing = false;
		}
	}

	/** 缓存键：跨 org 同名成员不得串数据（同一台机器可同时加入多个 org，ADR-0052/0055） */
	private cacheKey(member: string): string {
		return `${this.orgNames[this.orgIdx]}/${member}`;
	}

	/** 刷新执行槽缓存（只读；失败降级为空，不影响渲染与四态） */
	private async refreshSlots(): Promise<void> {
		const name = this.orgNames[this.orgIdx];
		const snap = name ? this.snap.get(name) : undefined;
		if (!name || !snap) return;
		for (const m of snap.org.members) {
			this.slots.set(`${name}/${m.name}`, await readSlot(name, m.name).catch(() => null));
		}
	}

	/** 拉取单个成员的动态；返回"展示内容是否变化" */
	private async refreshOneActivity(
		orgName: string,
		member: string,
		focus: string | null,
	): Promise<boolean> {
		const p = this.presence.get(member);
		const socketPath = p?.runtime?.socketPath;
		const key = `${orgName}/${member}`;
		if (!p || p.state === 'sleeping' || !socketPath) {
			this.activityWarn.forget(key);
			return this.activity.delete(key);
		}
		const limit = focus === member ? ACTIVITY_DETAIL_LIMIT : ACTIVITY_LIST_LIMIT;
		const res = await fetchActivity(socketPath, limit);
		if (!res.ok) {
			if (this.activityWarn.shouldWarn(key)) {
				log.warn('成员动态拉取失败（降级为无动态）', {
					org: orgName,
					member,
					reason: res.reason,
				});
			}
			return this.activity.delete(key);
		}
		this.activityWarn.forget(key);
		const prev = JSON.stringify(this.activity.get(key) ?? []);
		const next = JSON.stringify(res.entries);
		if (prev === next) return false;
		this.activity.set(key, res.entries);
		return true;
	}

	/** 列表页：某成员的"最近一句话"（无动态时据实说明；沿用列表缩进） */
	private memberActivityLine(member: string): string {
		const state = this.presence.get(member)?.state;
		if (!state || state === 'sleeping') return '（无动态：不在岗）';
		const s = summariseForList(this.activity.get(this.cacheKey(member)) ?? []);
		return s ? `最近 ${s.text}` : '（无动态）';
	}

	/** 详情屏：最近动态若干行（纯文本；最新在下，像"跟读"） */
	private activityRowsFor(member: string | null): string[] {
		if (!member) return [];
		const state = this.presence.get(member)?.state;
		if (!state || state === 'sleeping') return ['  （无动态：成员不在岗）'];
		const entries = this.activity.get(this.cacheKey(member)) ?? [];
		if (entries.length === 0) return ['  （无动态）'];
		return entries.slice(-ACTIVITY_DETAIL_ROWS).map((e) => `  ${formatActivityLine(e)}`);
	}

	/**
	 * 中断某成员的**当前轮次**（人操作台：看板键；ADR-0053）。
	 * 据实回报：不在岗 / 失败原因都写进通知行并留痕——**绝不静默假装成功**。
	 */
	private async runInterrupt(member: string): Promise<void> {
		const seq = ++this.noticeSeq;
		this.notice = `正在中断 ${member} 的当前轮…`;
		this.refresh();
		const settle = (text: string) => {
			if (this.noticeSeq !== seq) return;
			this.notice = text;
			this.refresh();
		};
		const p = this.presence.get(member);
		const socketPath = p?.runtime?.socketPath;
		if (!p || p.state === 'sleeping' || !socketPath) {
			log.info('中断跳过：成员不在岗', { org: this.orgNames[this.orgIdx], member });
			settle(`${member} 不在岗（无需中断）。`);
			return;
		}
		const res = await interruptMember(socketPath);
		if (res.ok) {
			log.info('人类从看板中断成员当前轮', { org: this.orgNames[this.orgIdx], member });
			settle(`已中断 ${member} 的当前轮（进程与会话保留，可继续派活）。`);
			return;
		}
		log.warn('成员中断失败', {
			org: this.orgNames[this.orgIdx],
			member,
			reason: res.reason,
		});
		settle(`${member} 中断失败：${ACTIVITY_FAIL_TEXT[res.reason]}。`);
	}

	/** 巡检：只刷新状态显示（感知与动作分离，ADR-0040 D4）；看板打开期间运行，关闭即停 */
	private startPresencePolling(): void {
		if (this.presenceTimer) return;
		this.presenceTimer = setInterval(() => {
			if (this.closed) return;
			void this.refreshPresence({ sweep: true })
				.then(async (changed) => {
					// tab 上的在岗计数（ADR-0070 D7）：当前 org 读权威四态、其余走廉价判据。
					// 放在权威探测之后，保证当前 org 的数字与成员列表来自同一拍。
					const countsChanged = await this.refreshOnlineCounts().catch(() => false);
					if (changed || countsChanged) this.refresh();
				})
				.catch((e: unknown) => {
					log.debug('巡检失败（忽略，下一轮重试）', { err: String(e) });
				});
			// 成员动态：独立于状态巡检；失败静默（见 refreshActivity）
			// 执行槽：谁在跑什么（ADR-0055 `D2`/`D5`）；只读、失败静默
			void this.refreshSlots().catch(() => {});
			// 账本：看板必须自己跟上**别的进程**写的状态（成员认领/交付、巡检标记逾期、派发人改派），
			// 否则只有成员动态是新的、任务/参与者状态停在打开看板那一刻（用户可见的"状态没更新"）
			void this.reloadLedger()
				.then((changed) => {
					if (changed) this.refresh();
				})
				.catch((e: unknown) => {
					log.debug('账本重载失败（忽略，下一轮重试）', { err: String(e) });
				});
			void this.refreshActivity().catch((e: unknown) => {
				log.debug('动态刷新失败（忽略，下一轮重试）', { err: String(e) });
			});
		}, PRESENCE_POLL_MS);
	}

	private stopPresencePolling(): void {
		if (this.presenceTimer) clearInterval(this.presenceTimer);
		this.presenceTimer = null;
	}

	/** 关闭看板：先停巡检再归还控制权（不留定时器） */
	private close(): void {
		this.closed = true;
		this.stopPresencePolling();
		this.done(null);
	}

	/**
	 * `r` 刷新：先把全体成员简档与各自 `pi.agent.json` 对齐（**人类显式动作**，
	 * 不违反 ADR-0040 D4「感知不写副作用」），再重载快照 — ADR-0042 D6②。
	 */
	private async reloadWithManifestSync(): Promise<void> {
		const org = this.orgNames[this.orgIdx];
		if (org) {
			try {
				const changed = await refreshAllMemberManifests(org);
				if (changed > 0)
					this.notice = `已刷新 ${changed} 名成员的简介（读自各自 pi.agent.json）`;
			} catch (e) {
				this.notice = `成员简档刷新失败：${e instanceof Error ? e.message : String(e)}`;
			}
		}
		// 排序键一起重算（ADR-0070 D4）：`initialize` 只在打开面板时算过一次，
		// 别家 org 之后又派了活时，只按"打开那一刻"的顺序排会让 `r` 显得没生效。
		const pairs = await Promise.all(
			this.orgNames.map(async (n): Promise<[string, string | null]> => [
				n,
				await this.dispatchKeyOf(n),
			]),
		);
		this.lastDispatchAt = new Map(pairs);
		// 注意：这里**不**重算所属（ADR-0070 D4 同源取舍）——所属是「打开面板那一刻的目录事实」，
		// 面板内的新建/改名/加入/删除/踢退自己会各自重算（见 refreshOwnOrgs）；外部进程改注册表不在本拍覆盖范围。
		this.reorderOrgTabs();
		this.snap.clear();
		await this.loadCurrentOrg();
		await this.refreshOnlineCounts();
	}

	private async loadCurrentOrg(): Promise<void> {
		const name = this.orgNames[this.orgIdx];
		if (!name || this.snap.has(name)) {
			await this.refreshPresence({ sweep: true });
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		try {
			const org = await readOrg(name);
			const tasks = await listTasks(name);
			const snap: OrgSnapshot = { org, tasks, loadedAt: nowIso() };
			// 先探测再一次性提交：避免"成员已渲染但状态未就绪"造成的圆点空白闪烁
			const bundle = await this.computePresence(name, snap, { sweep: true });
			this.snap.set(name, snap);
			if (bundle) this.commitPresence(name, bundle);
		} catch (e) {
			this.loadError = e instanceof Error ? e.message : String(e);
		}
		this.invalidate();
		this.tui.requestRender();
	}

	// ── Component ────────────────────────────────────────────────────────────

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) => {
			const line = style ? style(s) : s;
			return truncateToWidth(line, Math.max(8, width));
		};

		const lines: string[] = [];
		// 第 0 行：标题嵌入顶边框（ADR-0023/0039）——`org:<公司名>`，
		// 仅 Tab 切换公司（显式上下文切换）时该行变更；同公司内恒定（防滚动重影）
		const curOrg = this.orgNames[this.orgIdx];
		const title = curOrg ? `── org:${curOrg} ` : '── org ';
		lines.push(
			truncateToWidth(
				th.accent(title + '─'.repeat(Math.max(0, width - visibleWidth(title)))),
				Math.max(8, width),
			),
		);
		if (this.loading) {
			lines.push(L('加载中…', th.dim));
			this.cached(width, lines);
			return lines;
		}
		if (this.loadError) {
			lines.push(L(`加载失败：${this.loadError}`, th.error));
			this.cached(width, lines);
			return lines;
		}
		if (this.orgNames.length === 0) {
			lines.push(
				L('本机还没有任何组织。在负责人目录执行 /org create <组织名> 创建。', th.dim),
			);
			this.cached(width, lines);
			return lines;
		}

		// 公司 tab 行：仅当本机加入 >1 个 org 才显示（Tab / Shift+Tab 循环切换，高亮当前）
		// 单 org 不渲染该行——避免「只有一个 tab 的假 tab 栏」（TUI 002 反馈）
		const ownCount = this.ownOrgCount();
		if (this.orgNames.length > 1) {
			const parts: string[] = [];
			this.orgNames.forEach((n, i) => {
				// 所属段与非所属段之间的分界：让「从第几家开始不是我的」显性可见（ADR-0070 D6）。
				// 所属为空时不画——「整排没有分界」本身就是「没有所属段」的信号。
				if (ownCount > 0 && i === ownCount) parts.push(th.dim('│'));
				parts.push(this.orgChip(n, i === this.orgIdx));
			});
			lines.push(L(parts.join(' ')));
		}
		// 所属为空时的语义尾注：否则整排压暗会被读成「全部不可用/没权限」（ADR-0070 D3/D6）。
		// **单 org 也显示**——那时连 tab 行都不渲染，人本来零提示。
		if (this.orgNames.length > 0 && ownCount === 0) {
			lines.push(L(` ${NOT_OWN_ORG_NOTE}`, th.dim));
		}

		// 视角 tab 行（←→ 切换；样式同 todos TabBar：[当前] accent，其余 muted）
		lines.push(
			L(
				VIEW_TABS.map((v) =>
					v.key === this.view
						? th.accent(th.bold(`[ ${v.label} ]`))
						: th.muted(`[ ${v.label} ]`),
				).join(th.muted(' ')),
			),
		);
		// tab 栏下分隔横线（②）：内部线——左空 2 格缩进 + dim 暗色（外框线保持 accent 满宽）
		lines.push(
			truncateToWidth(th.dim('  ' + '─'.repeat(Math.max(0, width - 2))), Math.max(8, width)),
		);

		// 瞬态提示行（唤醒/睡眠结果）：出现时占 1 行预算，listRows/detailPageSize 已相应收缩
		if (this.notice) lines.push(L(`  ${this.notice}`, th.dim));

		if (this.confirm) lines.push(...this.renderConfirm(width));
		else if (this.view === 'tasks') lines.push(...this.renderTasks(width));
		else if (this.view === 'people') lines.push(...this.renderPeople(width));
		else lines.push(...this.renderSettings(width));

		this.cached(width, lines);
		return lines;
	}

	private cached(width: number, lines: string[]): void {
		// 总行数封顶（防止小终端滚动 fullRender 重影）
		const cap = this.maxTotal();
		if (lines.length > cap) {
			this.cachedLines = lines.slice(0, cap);
			this.cachedWidth = width;
			return;
		}
		this.cachedLines = lines;
		this.cachedWidth = width;
	}

	// ── 任务视角 ─────────────────────────────────────────────────────────────

	private renderTasks(width: number): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));

		const snap = this.snap.get(this.orgNames[this.orgIdx]);
		// 详情页
		if (this.detailTaskId) {
			const detail = snap?.tasks.find((t) => t.id === this.detailTaskId);
			if (!detail) {
				this.detailTaskId = null;
				this.refresh();
				return [];
			}
			return this.renderTaskDetail(width, detail);
		}

		// 状态子 tab 行
		const tabLine = `状态 ${TASK_TAB_NAMES.map((n, i) => (i === this.taskTab ? th.accent(`[${i + 1} ${n}]`) : th.dim(`[${i + 1} ${n}]`))).join(' ')}  ${th.dim(`排序:${this.prefs.sortNewFirst ? '新→旧' : '旧→新'}${this.prefs.annotate ? ' 标注:开' : ' 标注:关'}`)}`;
		const out: string[] = [L(tabLine)];
		if (this.filterActive) {
			out.push(L(`过滤: ${this.filter}_（退格删 · Esc 退出）`, th.warning));
		}

		const tasks = this.tasksOfTab(snap?.tasks ?? []);
		const ranked = this.applyFilterAndSort(tasks);
		if (ranked.length === 0) {
			out.push(L(`  无 ${TASK_TAB_NAMES[this.taskTab]} 任务`, th.dim));
			return this.withFooter(
				out,
				`无任务。/ 搜索 · r 刷新 · 1-4 切状态 · ←→ 视角 · Esc 关闭${this.dutyHint()}${this.tabHint()}`,
				width,
			);
		}
		if (this.selIdx >= ranked.length) this.selIdx = ranked.length - 1;
		if (this.selIdx < 0) this.selIdx = 0;

		const page = this.listRows();
		const start = Math.max(0, Math.min(this.selIdx, ranked.length - page));
		const shown = ranked.slice(start, start + page);
		for (let i = 0; i < shown.length; i++) {
			const idx = start + i;
			const t = shown[i];
			const line = this.taskLine(t);
			out.push(idx === this.selIdx ? L(`> ${line}`, th.selectedBg) : L(`  ${line}`));
		}
		if (ranked.length > shown.length) {
			out.push(L(`…共 ${ranked.length} 条（↑↓ 滚动）`, th.dim));
		}
		return this.withFooter(
			out,
			`↑↓/j/k 选择 · Enter 详情 · 1-4 状态 · / 搜索 · r 刷新 · ←→ 视角 · Esc 返回/关${this.dutyHint()}${this.tabHint()}`,
			width,
		);
	}

	private taskTabStatus(): Task['status'] {
		return (['todo', 'in_progress', 'waiting_accept', 'closed'] as const)[this.taskTab];
	}

	/** 当前状态子 tab 的任务集合（渲染与"按 id 保选择"共用同一口径） */
	private tasksOfTab(tasks: Task[]): Task[] {
		return tasks.filter((t) => t.status === this.taskTabStatus());
	}

	/**
	 * 账本指纹：只为回答"这一拍内容变了吗"。用 `updatedAt`（每次 `saveTask` 都会刷新）+ 任务身份，
	 * 比逐字段深比较便宜且够用——漏判的后果只是晚一拍重绘，不会画错。
	 */
	private fingerprintOf(tasks: Task[]): string {
		return tasks
			.map((t) => `${t.id}:${t.status}:${t.updatedAt}:${t.history.length}`)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			.join('|');
	}

	/**
	 * 账本重载：让看板跟上**别的进程**写的状态（成员认领/交付、巡检标记逾期、派发人改派）。
	 *
	 * 为什么必须做：看板原先只在按键 / 切 org / 自己执行动作后重读账本，于是同伴进程改的状态
	 * 不会自己反映——屏上"成员动态"是新的（走 RPC），任务与参与者状态却停在打开看板那一刻。
	 *
	 * 两条安全线：
	 * - **按 task id 保持选中行**：列表按 `updatedAt` 排序，交付/改派都会重排，沿用旧索引会跳到别的任务；
	 * - 内容没变（指纹相同）则不重绘，避免每拍无意义重排屏幕。
	 *
	 * ⚠ `selIdx` 是**全视角共用**的游标（任务列表 / 成员列表 / 成员详情 / 设置页都用它）。
	 * 因此"按 id 跟住光标"只在**任务列表**视角成立：在成员/设置视角下按任务列表重排，
	 * 会把光标静默挪到另一个成员/开关上（成员视角的 `w`/`x`、设置页 `Enter` 无二次确认，
	 * 按错即作用到错误对象）。其余视角只换 `snap.tasks`，光标原样保留。
	 */
	private async reloadLedger(): Promise<boolean> {
		if (this.ledgerReloading || this.closed) return false;
		const name = this.orgNames[this.orgIdx];
		const snap = name ? this.snap.get(name) : undefined;
		if (!name || !snap) return false;
		this.ledgerReloading = true;
		try {
			const tasks = await listTasks(name);
			const fp = this.fingerprintOf(tasks);
			if (fp === this.ledgerFp.get(name)) return false;
			const onTaskList = this.view === 'tasks' && this.detailTaskId === null;
			// 重排前先记住"光标下是谁"；替换后按 id 找回，找不到（任务已移出本 tab / 被删）才夹紧索引
			const keepId = onTaskList
				? this.applyFilterAndSort(this.tasksOfTab(snap.tasks))[this.selIdx]?.id
				: undefined;
			snap.tasks = tasks;
			snap.loadedAt = nowIso();
			// 排序键保鲜（ADR-0070 D4）：只更新当前 org —— 它是唯一被持续重读账本的一家。
			// 新任务即新派活，因此这一步顺带让「最近派活」排序跟着动；
			// reorderOrgTabs 内部按 org 名跟住当前 tab，不会把屏幕换到别家（D5）。
			this.lastDispatchAt.set(
				name,
				tasks.reduce<string | null>(
					(acc, t) => (t.createdAt && (!acc || t.createdAt > acc) ? t.createdAt : acc),
					null,
				),
			);
			this.reorderOrgTabs();
			if (onTaskList) {
				this.selIdx = remapSelectionById(
					this.applyFilterAndSort(this.tasksOfTab(tasks)),
					this.selIdx,
					keepId,
				);
			}
			this.ledgerFp.set(name, fp);
			// 快照已换 → 渲染缓存作废：调用方（巡检拍）随后 requestRender，直接调用者也能立刻看到新数据
			this.invalidate();
			return true;
		} finally {
			this.ledgerReloading = false;
		}
	}

	private applyFilterAndSort(tasks: Task[]): Task[] {
		let list = tasks;
		if (this.filter) {
			const q = this.filter.toLowerCase();
			list = list.filter(
				(t) =>
					t.title.toLowerCase().includes(q) ||
					t.id.toLowerCase().includes(q) ||
					t.background.toLowerCase().includes(q),
			);
		}
		list = [...list].sort((a, b) => {
			const cmp = a.updatedAt.localeCompare(b.updatedAt);
			return this.prefs.sortNewFirst ? -cmp : cmp;
		});
		return list;
	}

	private taskLine(t: Task): string {
		const annot = this.prefs.annotate ? this.annotations(t) : '';
		const head = `${t.id} ${t.title}`;
		const sub = t.subTasks.length > 1 ? ` ${t.subTasks.length}子` : '';
		return `${head}${sub}${annot}`;
	}

	private annotations(t: Task): string {
		const notes: string[] = [];
		const now = Date.now();
		for (const sub of t.subTasks) {
			for (const a of sub.assignees) {
				if (a.status === 'claimed' || a.status === 'returned') {
					const due = effectiveDueAt(t, sub);
					if (due && !Number.isNaN(Date.parse(due)) && Date.now() > Date.parse(due)) {
						notes.push('[超时]');
						break;
					}
					void now;
				}
				if (a.status === 'returned' && a.round >= 3) notes.push('[返工3]');
				if ((a.status === 'rejected' || a.status === 'cancelled') && t.status !== 'closed')
					notes.push('[需改派]');
			}
		}
		const multi = t.subTasks.some(
			(s) =>
				s.assignees.length > 1 &&
				s.assignees.some((a) => !a.stopped && a.status === 'delivered') &&
				s.assignees.some(
					(a) =>
						!a.stopped &&
						a.status !== 'delivered' &&
						a.status !== 'rejected' &&
						a.status !== 'cancelled',
				),
		);
		if (multi) notes.push('[多人同做]');
		return notes.length ? notes.map((n) => ` ${n}`).join('') : '';
	}

	// ── 详情页 ───────────────────────────────────────────────────────────────

	private renderTaskDetail(width: number, t: Task): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));

		const out: string[] = [];
		const statusLabel: Record<string, string> = {
			todo: 'TODO',
			in_progress: 'DOING',
			waiting_accept: 'WAITING',
			closed: 'CLOSED',
		};
		out.push(L(`${t.id} ${t.title}`, th.bold));
		const st = th.success(statusLabel[t.status]);
		const dueText = t.dueAt ? ` 期望:${t.dueAt.slice(0, 16).replace('T', ' ')}` : '';
		out.push(
			L(
				`[${st}] 派发:${t.dispatcher}${dueText}${t.acceptance ? ` 轮次:${t.acceptance.round}` : ''}`,
				undefined,
			),
		);
		if (t.background) out.push(L(`背景: ${t.background}`));
		if (t.items.length) {
			out.push(L(`清单:`));
			for (const it of t.items.slice(0, 4)) out.push(L(`  ${it}`));
			if (t.items.length > 4) out.push(L(`  …另 ${t.items.length - 4} 条`, th.dim));
		}
		// 子任务与参与者：active 参与者为可聚焦行（详情页 ↑↓ 指认，改派/强制操作对象）
		// 构建时记录每个聚焦行在 subLines 中的行号；终态参与者（rejected/cancelled）弱显不可聚焦
		const subLines: string[] = [];
		const focusLineNo: number[] = [];
		for (const sub of t.subTasks) {
			const dueSub = sub.dueAt || t.dueAt;
			subLines.push(
				L(
					`子 ${sub.id}${dueSub ? `(${remainingText(dueSub)})` : ''} ${sub.description}`,
					th.bold,
				),
			);
			for (const a of sub.assignees) {
				const state = this.assigneeLabel(a.status);
				const roundTxt = a.round > 0 ? ` R${a.round}` : '';
				const stopTxt = a.stopped ? ' 停' : '';
				if (a.status === 'rejected' || a.status === 'cancelled') {
					subLines.push(L(`  ${a.agent}: ${state}${roundTxt}（终态）`, th.dim));
					continue;
				}
				focusLineNo.push(subLines.length);
				const overdueMark = dueSub && isOverdueMarked(t, sub, a.agent) ? ' [逾期]' : '';
				subLines.push(
					L(`  ${a.agent}: ${state}${roundTxt}${stopTxt}${overdueMark}`, undefined),
				);
				const lastD = a.deliveries[a.deliveries.length - 1];
				if (lastD) {
					subLines.push(
						L(
							`    交付(${lastD.at.slice(0, 16).replace('T', ' ')}): ${lastD.summary.slice(0, 60)}`,
							th.dim,
						),
					);
					for (const f of lastD.files.slice(0, 2))
						subLines.push(
							L(`    产出: ${f.path}${f.lines ? `:${f.lines}` : ''}`, th.muted),
						);
				}
			}
		}
		// 记录行也计入滚动内容
		const recentHist = t.history.slice(-2);
		if (recentHist.length) {
			subLines.push(
				L(
					`最近: ${recentHist.map((h) => `${h.event}@${h.at.slice(5, 16)}`).join(' · ')}`,
					th.dim,
				),
			);
		}
		// 焦点越界兜底；窗口起点随焦点滚动保证焦点行可见（detail 区有限行高内滚动，不整树滚动）
		if (focusLineNo.length === 0) this.detailFocus = -1;
		else if (this.detailFocus < 0) this.detailFocus = 0;
		else if (this.detailFocus >= focusLineNo.length) this.detailFocus = focusLineNo.length - 1;
		const focusRow = this.detailFocus >= 0 ? focusLineNo[this.detailFocus] : -1;
		const start = focusRow > 0 ? Math.max(0, focusRow - 1) : 0;
		let shownCount = 0;
		for (let i = start; i < subLines.length; i++) {
			if (shownCount >= this.listRows()) {
				out.push(L(`…（详情余 ${subLines.length - i} 行，↑↓ 聚焦滚动）`, th.dim));
				break;
			}
			const isFocus = i === focusRow;
			out.push(isFocus ? L(`> ${subLines[i].trim()}`, th.selectedBg) : subLines[i]);
			shownCount++;
		}
		if (shownCount === 0 && subLines.length > 0) {
			for (const l of subLines.slice(0, this.listRows())) out.push(l);
		}

		// 人类操作提示（底部动态区）：人操作台——按状态显隐，不区分派发人（ADR-0039）
		if (this.reassignMode) {
			return this.renderReassignCandidates(width, t);
		}
		const acts: string[] = [];
		if (t.status === 'closed') {
			acts.push('(铁终态，不可重开)');
		} else {
			const hasDelivered = t.subTasks.some((su) =>
				su.assignees.some((a) => a.status === 'delivered'),
			);
			acts.push(`a 验收${this.meName === t.dispatcher ? '' : '(人类强制)'}`);
			if (hasDelivered) acts.push('r 打回');
			acts.push('x 取消');
			if (this.detailFocus >= 0) {
				acts.push('g 改派');
				const foc = this.detailFocusRows()[this.detailFocus];
				if (foc && foc.status !== 'delivered') acts.push('t 重试');
			}
		}
		acts.push('↑↓ 选参与者');
		acts.push('Esc 返回');
		return this.withFooter(out, acts.join(' · '), width);
	}

	/** 改派候选屏（G2 第二级）：org 成员列表（排除焦点参与者所在子任务里已有的人） */
	private renderReassignCandidates(width: number, t: Task): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));
		const snap = this.snap.get(this.orgNames[this.orgIdx]);
		const members = snap?.org.members ?? [];
		const focusRows = this.detailFocusRows();
		const focus = focusRows[this.detailFocus];
		const sub = focus ? t.subTasks.find((su) => su.id === focus.subId) : undefined;
		const alreadyIn = new Set((sub?.assignees ?? []).map((a) => a.agent));
		const cands = members.filter((m) => !alreadyIn.has(m.name)).map((m) => m.name);
		const out: string[] = [];
		out.push(
			L(
				`改派：${t.id} 子任务 ${focus?.subId ?? ''} 焦点 ${focus?.agent ?? '(无)'} → 选新处理人（Esc 取消）`,
				th.bold,
			),
		);
		if (cands.length === 0) {
			out.push(L('（无可选成员——所有成员都已在处理该子任务或组织为空）', th.dim));
			return this.withFooter(out, `Esc 返回详情`, width);
		}
		if (this.reassignSel >= cands.length) this.reassignSel = cands.length - 1;
		if (this.reassignSel < 0) this.reassignSel = 0;
		const page = this.listRows();
		const start = Math.max(0, Math.min(this.reassignSel, cands.length - page));
		for (let i = start; i < Math.min(cands.length, start + page); i++) {
			out.push(
				L(
					`${i === this.reassignSel ? '>' : ' '} ${cands[i]}`,
					i === this.reassignSel ? th.selectedBg : undefined,
				),
			);
		}
		if (cands.length > page) out.push(L(`…共 ${cands.length} 名成员（↑↓ 滚动）`, th.dim));
		return this.withFooter(out, `↑↓ 选择 · Enter 确认改派 · Esc 取消`, width);
	}

	private assigneeLabel(s: string): string {
		return (
			{
				invited: '待领取',
				claimed: '进行中',
				delivered: '已交付',
				returned: '返工中',
				rejected: '已拒绝',
				cancelled: '已取消',
			}[s] ?? s
		);
	}

	// ── 成员视角 ─────────────────────────────────────────────────────────────

	private renderPeople(width: number): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));
		const snap = this.snap.get(this.orgNames[this.orgIdx]);
		const members = snap?.org.members ?? [];
		const tasks = snap?.tasks ?? [];
		const out: string[] = [];

		// 启动参数编辑屏（从成员面板进入；ADR-0051 D3/D4）
		if (this.inputMode === 'launch-args') return this.renderLaunchArgsInput(width);
		if (this.detailTaskId) {
			const detail = snap?.tasks.find((t) => t.id === this.detailTaskId);
			if (detail) return this.renderTaskDetail(width, detail);
		}

		if (this.peopleSel) {
			// 成员详情：上下两区块「派发 / 接收」——两区块数据独立、不联动；
			// 每区块独立窗口（自适应 pageSize），单一 ↑↓ 光标跨区块连续移动，Enter 打开所选任务详情。
			const whoMember = members.find((m) => m.name === this.peopleSel);
			const who = whoMember?.name ?? this.peopleSel;
			const openFirst = (arr: Task[]) => [
				...arr.filter((t) => t.status !== 'closed'),
				...arr.filter((t) => t.status === 'closed'),
			];
			const recvRows = openFirst(
				tasks.filter((t) =>
					t.subTasks.some((s) => s.assignees.some((a) => a.agent === this.peopleSel)),
				),
			);
			const dispRows = openFirst(tasks.filter((t) => t.dispatcher === this.peopleSel));
			const total = dispRows.length + recvRows.length;
			const whoState = this.presence.get(who)?.state ?? 'sleeping';
			out.push(
				L(
					`成员 ${who}  ${presenceDot(whoState, th)} ${PRESENCE_WORDS[whoState]}  派发 ${dispRows.length} · 接收 ${recvRows.length}`,
					th.bold,
				),
			);
			// 成员简介全貌（折行不截断；空则显式标注）— ADR-0042 D7
			const desc = (whoMember?.manifest.description ?? '').trim();
			for (const line of wrapTextWithAnsi(
				`简介：${desc || '（未填写）'}`,
				Math.max(8, width),
			)) {
				out.push(L(line));
			}
			const diag = this.diagLine(who);
			if (diag) out.push(L(diag, th.dim));
			// 启动参数（ADR-0051 D7：当前用什么参数启动可查；成员视角只读）
			out.push(
				L(
					`  启动参数：${whoMember?.launchArgs?.trim() || '（无）'}${
						whoMember?.launchArgsUpdatedAt
							? ` · 改于 ${whoMember.launchArgsUpdatedAt.slice(5, 16).replace('T', ' ')}`
							: ''
					}`,
					th.dim,
				),
			);
			// 协作事实（ADR-0055 `D2`/`D4`/`D3`）：手上在跑什么、队列多长、期限如何
			// 只在有信息时出现——避免空占位把光标挤出视口
			const slot = this.slots.get(this.cacheKey(who));
			if (slot) {
				out.push(
					L(
						`  手上：正在执行 ${slot.taskId}${slot.subTaskId ? `/${slot.subTaskId}` : ''}`,
						th.dim,
					),
				);
			}
			const cap = resolveMemberQueueCap(orgConfigStore.get().memberQueueCap);
			const queue = queueLengthFor(tasks, who);
			if (queue > 0 || cap !== undefined) {
				out.push(
					L(`  队列：${queue}${cap === undefined ? '' : `/${cap}`}（待领取）`, th.dim),
				);
			}
			const nowMs = Date.now();
			const dueRows: string[] = [];
			for (const t of tasks) {
				if (t.status === 'closed') continue;
				for (const sub of t.subTasks) {
					const a = sub.assignees.find((x) => x.agent === who);
					if (!a || a.stopped) continue;
					if (a.status !== 'invited' && a.status !== 'claimed' && a.status !== 'returned')
						continue;
					const dueAt = effectiveDueAt(t, sub);
					if (!dueAt) continue;
					const overdue = isOverdueMarked(t, sub, who) ? '（已逾期·已标记）' : '';
					dueRows.push(`${sub.id} ${remainingText(dueAt, nowMs)}${overdue}`);
				}
			}
			if (dueRows.length > 0) {
				out.push(L(`  期限：${dueRows.slice(0, 3).join(' · ')}`, th.dim));
			}
			if (total === 0) {
				out.push(L('  该成员暂无派发/接收任务', th.dim));
				out.push(L('  最近动态：', th.bold));
				for (const line of this.activityRowsFor(who)) out.push(L(line, th.dim));
				return this.withFooter(
					out,
					`Esc 返回成员列表 · ←→ 视角${this.launchArgsHint()}${this.dutyHint()}${this.tabHint()}`,
					width,
				);
			}
			if (this.selIdx >= total) this.selIdx = total - 1;
			if (this.selIdx < 0) this.selIdx = 0;
			const page = this.memberDetailPageSize();
			const inDisp = this.selIdx < dispRows.length;
			const dCur = inDisp ? this.selIdx : 0;
			const rCur = inDisp ? 0 : this.selIdx - dispRows.length;
			// 光标所在区块的窗口跟随光标（未所在区块显示窗口首部）——独立、不联动
			const dStart = inDisp ? Math.max(0, Math.min(dCur, dispRows.length - page)) : 0;
			const rStart = inDisp ? 0 : Math.max(0, Math.min(rCur, recvRows.length - page));
			const section = (
				label: string,
				rows: Task[],
				start: number,
				cursorIdx: number,
				hasCursor: boolean,
			) => {
				out.push(L(`  ${label}（${rows.length}）`, th.bold));
				if (rows.length === 0) {
					out.push(L('    无', th.dim));
					return;
				}
				const shown = rows.slice(start, start + page);
				for (let i = 0; i < shown.length; i++) {
					const t = shown[i];
					const sel = hasCursor && start + i === cursorIdx;
					out.push(
						L(
							`${sel ? '>' : ' '} ${t.id} [${this.taskTabStatusOfTask(t)}] ${t.title}`,
							sel ? th.selectedBg : undefined,
						),
					);
				}
				const hidden = rows.length - shown.length;
				if (hidden > 0) out.push(L(`    …余 ${hidden} 条（↑↓ 滚动）`, th.dim));
			};
			section('派发', dispRows, dStart, dCur, inDisp);
			section('接收', recvRows, rStart, rCur, !inDisp);
			out.push(L('  最近动态：', th.bold));
			for (const line of this.activityRowsFor(who)) out.push(L(line, th.dim));
			return this.withFooter(
				out,
				`↑↓ 选择 · Enter 任务详情${this.lifecycleHint(this.peopleSel)} · r 刷新 · Esc 返回成员列表 · ←→ 视角${this.launchArgsHint()}${this.dutyHint()}${this.tabHint()}`,
				width,
			);
		}

		// 成员列表：四态圆点 + 名字（[负责人] / （我））+ **成员简介缩略列** + 工作目录（home 化）
		// 简介列宽随终端降级（ADR-0042 D7）：≥100 列 → 20 列；≥80 列 → 10 列；更窄 → 隐藏。
		const descCol = width >= 100 ? 20 : width >= 80 ? 10 : 0;
		if (members.length === 0) {
			out.push(L('    暂无成员', th.dim));
			return this.withFooter(out, `Esc 关闭${this.dutyHint()}${this.tabHint()}`, width);
		}
		if (this.selIdx >= members.length) this.selIdx = members.length - 1;
		// 每个成员占两行（主行 + 最近动态摘要），可见成员数相应减半——否则会撑破总高上限（铁律 1）
		const page = Math.max(2, Math.floor(this.listRows() / 2));
		const start = Math.max(0, Math.min(this.selIdx, members.length - page));
		for (let i = start; i < Math.min(members.length, start + page); i++) {
			const m = members[i];
			// 行尾标签：负责人优先于「我」。styled 供渲染、plain 供宽度计算——
			// 两处文案同源，避免「改了带色的忘了改参与宽度计算的」漂移。
			let tag = '';
			let plainTag = '';
			if (m.role === 'chief') {
				tag = th.accent(th.bold('[负责人]'));
				plainTag = '[负责人]';
			} else if (m.name === this.meName) {
				tag = th.muted('（我）');
				plainTag = '（我）';
			}
			// 未探测到的成员不臆断状态：留空位（列宽恒为 2，不破坏对齐）
			const state = this.presence.get(m.name)?.state;
			const dot = state ? presenceDot(state, th) : ' ';
			// 简介缩略（定宽，不足补空格 → 目录列右端对齐；空显示 (无)）
			const descCell = descCol > 0 ? this.fitDesc(m.manifest.description, descCol) : '';
			// 注册目录已失效：不能只显示「睡眠」——那会让人/agent 按 w 白试一次（唤醒必失败）
			const dirGone = !dirExists(m.dir);
			// plain 用定宽占位（●○ 宽度均为 1）参与宽度计算，供 fitDir 留出目录空间
			const plain = `${i === this.selIdx ? '>' : ' '} ○ ${m.name}${plainTag}${
				descCol > 0 ? `  ${descCell}` : ''
			}${dirGone ? `  [${DIR_MISSING_WORD}]` : ''}`;
			const dirShown = th.dim(
				this.fitDir(m.dir, Math.max(8, width - visibleWidth(plain) - 2)),
			);
			const parts = [`${i === this.selIdx ? '>' : ' '} ${dot} ${m.name}${tag}`];
			if (descCol > 0) parts.push(th.dim(descCell));
			if (dirGone) parts.push(th.error(`[${DIR_MISSING_WORD}]`));
			parts.push(dirShown);
			out.push(L(parts.join('  '), i === this.selIdx ? th.selectedBg : undefined));
			out.push(L(`    ${this.memberActivityLine(m.name)}`, th.dim));
		}
		if (members.length > page) {
			out.push(L(`      …共 ${members.length} 名成员（↑↓ 滚动）`, th.dim));
		}
		return this.withFooter(
			out,
			`↑↓ 选择 · Enter 看名下任务 · d 踢退 · m 设负责人${this.lifecycleHint(this.focusedMember())} · r 刷新 · ←→ 视角 · Esc 关闭${this.launchArgsHint()}${this.dutyHint()}${this.tabHint()}`,
			width,
		);
	}

	private taskTabStatusOfTask(t: Task): string {
		return { todo: 'TODO', in_progress: 'DOING', waiting_accept: 'WAIT', closed: 'CLOSED' }[
			t.status
		];
	}

	// ── 设置视角 ─────────────────────────────────────────────────────────────

	private renderSettings(width: number): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));
		const out: string[] = [];

		// 输入屏：组织背景
		if (this.inputMode === 'background') {
			const org = this.orgNames[this.orgIdx] ?? '(无公司)';
			out.push(L(`组织背景（本组织：${org}）`, th.bold));
			out.push(L('  写入本组织 org.json，供在岗成员的在岗简报引用；留空保存 = 清除', th.dim));
			out.push(L('背景：'));
			const avail = Math.max(8, width - 2);
			for (const line of wrapTextWithAnsi(`${this.backgroundInput}_`, avail)) {
				out.push(L(`  ${line}`));
			}
			if (this.createErr) out.push(L(this.createErr, th.error));
			return this.withFooter(
				out,
				'输入 · 退格删 · Esc 取消 · Enter 保存（清空=清除）',
				width,
			);
		}

		// 输入屏：新建 / 重命名公司
		if (this.inputMode === 'create' || this.inputMode === 'rename') {
			const isCreate = this.inputMode === 'create';
			out.push(
				L(
					isCreate
						? '新建公司：把当前目录登记为新公司负责人'
						: `重命名公司（当前：${this.orgNames[this.orgIdx]}，直接回车保留）`,
					th.bold,
				),
			);
			out.push(
				L(
					isCreate
						? `  成员名: ${this.meName || path.basename(process.cwd())}`
						: '  成员工作目录不受影响；建议成员睡眠时改名',
					th.dim,
				),
			);
			out.push(L(`公司名: ${this.orgNameInput}_`));
			if (this.createErr) out.push(L(this.createErr, th.error));
			return this.withFooter(
				out,
				`输入公司名 · 退格删 · Esc 取消 · Enter ${isCreate ? '创建' : '改名'}${this.dutyHint()}${this.tabHint()}`,
				width,
			);
		}

		// 加入公司：候选列表（本机中当前目录尚未加入的公司）
		if (this.inputMode === 'join-pick') {
			out.push(L('加入公司：用当前目录加入本机其他公司', th.bold));
			if (this.joinCands.length === 0) {
				out.push(L('  没有可加入的公司（本机所有公司都已包含当前目录）', th.dim));
				return this.withFooter(out, 'Esc 取消', width);
			}
			if (this.joinSel >= this.joinCands.length) this.joinSel = this.joinCands.length - 1;
			const jPage = this.listRows();
			for (let i = 0; i < Math.min(this.joinCands.length, jPage); i++) {
				out.push(
					L(
						`${i === this.joinSel ? '>' : ' '} ${this.joinCands[i]}`,
						i === this.joinSel ? th.selectedBg : undefined,
					),
				);
			}
			if (this.joinCands.length > jPage) {
				out.push(L(`    …共 ${this.joinCands.length} 家公司（↑↓ 滚动）`, th.dim));
			}
			return this.withFooter(out, '↑↓ 选择 · Enter 加入 · Esc 取消', width);
		}

		const rows = this.settingsRows();
		if (this.selIdx >= rows.length) this.selIdx = rows.length - 1;
		out.push(
			L('  设置（界面项存用户级 config.json，带「本组织」的项存本组织 org.json）', th.bold),
		);
		for (let i = 0; i < rows.length; i++) {
			out.push(
				L(
					`${i === this.selIdx ? '>' : ' '} ${rows[i].label}  ${th.dim(rows[i].sub)}`,
					i === this.selIdx ? th.selectedBg : undefined,
				),
			);
		}
		return this.withFooter(
			out,
			`↑↓ 选择 · Enter 执行 · r 刷新 · ←→ 视角 · Esc 关闭${this.dutyHint()}${this.tabHint()}`,
			width,
		);
	}

	private beginInput(mode: 'create' | 'rename'): void {
		this.inputMode = mode;
		// 编辑心智（交互规范 §3.3）：重命名预填当前名，用户基于现有值改
		this.orgNameInput = mode === 'rename' ? (this.orgNames[this.orgIdx] ?? '') : '';
		this.createErr = '';
		this.refresh();
	}

	/** 提交输入态：新建公司 / 重命名公司 */
	private async commitInput(): Promise<void> {
		const name = this.orgNameInput.trim();
		const mode = this.inputMode;
		const old = this.orgNames[this.orgIdx];
		// 编辑心智（交互规范 §3.3）：重命名时「空输入 / 未改动」= 保留当前值并退出，不算错误
		if (mode === 'rename' && (!name || name === old)) {
			this.inputMode = null;
			this.orgNameInput = '';
			this.createErr = '';
			this.refresh();
			return;
		}
		// 新建：空名仍是错误（无"当前值"可保留）
		if (!name) {
			this.createErr = '公司名不能为空';
			this.refresh();
			return;
		}
		try {
			if (mode === 'create') {
				const dir = process.cwd();
				// 身份以目录的 pi.agent.json 为准（与命令面 /org create 同源）；无 manifest 时
				// 回落到本会话已知成员名 / 目录 basename
				const manifest = (await loadManifest(dir)) ?? {};
				const memberName = manifest.name ?? (this.meName || defaultAgentName(dir));
				await createOrg(name, {
					name: memberName,
					dir,
					label: manifest.label,
					description: manifest.description,
					launchArgs: defaultMemberLaunchArgs(),
				});
			} else if (mode === 'rename') {
				if (!old) throw new Error('当前没有公司可改名。');
				await renameOrg(old, name);
			} else {
				return;
			}
			this.inputMode = null;
			this.orgNameInput = '';
			this.createErr = '';
			// 新建 / 改名都会改变「本目录属于谁」（新建把 cwd 登记为负责人；改名换掉 ownOrgs 里存的名字）
			// → 先重算所属，再按 tab 顺序重建名单（ADR-0070 D1/D2），否则新组织仍被当成"非所属"压暗
			await this.refreshOwnOrgs();
			const names = await listOrgNames();
			this.lastDispatchAt.set(name, await this.dispatchKeyOf(name));
			this.orgNames = this.orderTabNames(names);
			this.orgIdx = Math.max(0, this.orgNames.indexOf(name));
			this.view = 'tasks';
			this.selIdx = 0;
			this.snap.clear();
			await this.loadCurrentOrg();
			// 新建/改名后当前 org 换了，tab 上的在岗计数要跟着重算（否则点阵停在旧 org 的数字，最长等一拍）
			await this.refreshOnlineCounts();
			this.refresh();
		} catch (e) {
			this.createErr = e instanceof Error ? e.message : String(e);
			this.refresh();
		}
	}

	/** 加入公司：列出本机中当前目录尚未加入的 org */
	private async beginJoinOrg(): Promise<void> {
		const dir = realDir(process.cwd());
		const cands: string[] = [];
		for (const n of this.orgNames) {
			try {
				const org = await readOrg(n);
				if (!org.members.some((m) => realDir(m.dir) === dir)) cands.push(n);
			} catch {
				// 读取失败的公司跳过
			}
		}
		this.joinCands = cands;
		this.joinSel = 0;
		this.inputMode = 'join-pick';
		this.refresh();
	}

	private async commitJoinOrg(): Promise<void> {
		const orgName = this.joinCands[this.joinSel];
		if (!orgName) return;
		try {
			const dir = process.cwd();
			// 身份以目录的 pi.agent.json 为准（与命令面 /org join 同源）；无 manifest 时
			// joinOrg 内 memberFromManifest 走 basename / member 回落
			const manifest = (await loadManifest(dir)) ?? {};
			const res = await joinOrg(orgName, {
				manifest,
				dir,
				launchArgs: defaultMemberLaunchArgs(),
			});
			if (res.dispositionRequired) {
				this.createErr = `该目录在「${orgName}」有历史档案：请改用命令 /org join ${orgName} --inherit|--fresh`;
				this.inputMode = null;
				this.refresh();
				return;
			}
			this.inputMode = null;
			// 加入公司把 cwd 登记为成员 → 所属变了（ADR-0070 D1），必须重算后再排 tab
			await this.refreshOwnOrgs();
			const names = await listOrgNames();
			this.lastDispatchAt.set(orgName, await this.dispatchKeyOf(orgName));
			this.orgNames = this.orderTabNames(names);
			this.orgIdx = Math.max(0, this.orgNames.indexOf(orgName));
			this.view = 'tasks';
			this.selIdx = 0;
			this.snap.clear();
			await this.loadCurrentOrg();
			// 加入后当前 org 就是新加入这家，点阵要立刻按权威判据重算（否则停在上一次的廉价值）
			await this.refreshOnlineCounts();
			this.refresh();
		} catch (e) {
			this.createErr = e instanceof Error ? e.message : String(e);
			this.inputMode = null;
			this.refresh();
		}
	}

	private confirmDeleteOrg(): void {
		const orgName = this.orgNames[this.orgIdx];
		if (!orgName) return;
		this.confirm = {
			title: `删除公司 ${orgName}？`,
			detail: '整棵数据归档到 ~/.pi/org/.trash（可人工恢复）',
			run: () => void this.runDeleteOrg(orgName),
		};
		this.refresh();
	}

	private async runDeleteOrg(orgName: string): Promise<void> {
		try {
			const res = await removeOrg(orgName);
			if (!res.removed) {
				this.loadError = `公司 ${orgName} 不存在。`;
				this.refresh();
				return;
			}
			this.hooks.onAction?.(orgName, '', 'delete-org', res.archivedTo ?? '');
			// 删除会改变「本目录属于谁」（可能删掉的正是我的组织）→ 先重算所属再排 tab
			await this.refreshOwnOrgs();
			this.lastDispatchAt.delete(orgName);
			const names = this.orderTabNames(await listOrgNames());
			this.orgNames = names;
			this.orgIdx = Math.min(this.orgIdx, Math.max(0, names.length - 1));
			this.view = 'tasks';
			this.selIdx = 0;
			this.snap.clear();
			if (names.length > 0) await this.loadCurrentOrg();
			// 名单变了（删掉一家）→ 点阵表也要跟着重建，别把已删 org 的计数留在 map 里
			await this.refreshOnlineCounts();
			this.refresh();
		} catch (e) {
			this.loadError = e instanceof Error ? e.message : String(e);
			this.refresh();
		}
	}

	/** 踢退成员（人类强制 leaveOrg；保留回归档案） */
	private async runKickMember(memberName: string): Promise<void> {
		const orgName = this.orgNames[this.orgIdx];
		const snap = this.snap.get(orgName);
		const m = snap?.org.members.find((x) => x.name === memberName);
		if (!m) {
			this.loadError = `成员 ${memberName} 不存在。`;
			this.refresh();
			return;
		}
		try {
			await leaveOrg(orgName, m.dir, `人类踢退（${this.humanId}）`);
			this.hooks.onAction?.(orgName, '', 'kick', memberName);
			this.snap.delete(orgName);
			// 踢退可能踢掉的是**本目录自己** → 「本目录属于谁」变了，必须和新建/改名/加入/删除同源重算
			await this.refreshOwnOrgs();
			await this.loadCurrentOrg();
			this.refresh();
		} catch (e) {
			this.loadError = e instanceof Error ? e.message : String(e);
			this.refresh();
		}
	}

	/** 负责人转移（人类强制；原负责人降为普通成员） */
	private async runTransferChief(newChief: string): Promise<void> {
		const orgName = this.orgNames[this.orgIdx];
		try {
			await transferChief(orgName, newChief);
			this.hooks.onAction?.(orgName, '', 'transfer-chief', newChief);
			this.snap.delete(orgName);
			await this.loadCurrentOrg();
			this.refresh();
		} catch (e) {
			this.loadError = e instanceof Error ? e.message : String(e);
			this.refresh();
		}
	}

	private async togglePref(key: keyof BoardPrefs): Promise<void> {
		this.prefs[key] = !this.prefs[key];
		// 全量合并写回：本文件同时承载行为默认（如成员启动参数初值），不能把相邻字段抹掉
		orgConfigStore.save({ ...orgConfigStore.get(), ...this.prefs }, 'user');
		this.refresh();
	}

	/** 终端可视行数（测试 mock 无 terminal → 兜底 24） */
	private termRows(): number {
		return (this.tui as { terminal?: { rows?: number } }).terminal?.rows ?? 24;
	}

	/** 总行数上限：随终端高度自适应（铁律 1） */
	private maxTotal(): number {
		return Math.max(14, Math.min(40, this.termRows() - 1));
	}

	/** 列表区可见行数：随终端高度自适应（下限 MAX_BODY_LINES，上限 30）
	 *  预留约 8 行给标题/tab/两条分隔线/footer；终端越高列表越长 */
	private listRows(): number {
		return Math.max(MAX_BODY_LINES, Math.min(30, this.maxTotal() - 8 - this.noticeRows()));
	}

	/** 瞬态提示行占用的行预算（铁律 1：组件总高 ≤ 视口） */
	private noticeRows(): number {
		return this.notice ? 1 : 0;
	}

	/** 进入二级（详情）前记录一级列表光标位置 */
	private pushDrill(): void {
		this.drillCursors.push(this.selIdx);
	}

	/** 返回一级并恢复进入前的位置（长列表里处理完不必重新滚回去） */
	private popDrill(): number {
		return this.drillCursors.pop() ?? 0;
	}

	/** 成员详情每区块窗口行数：随终端高度自适应（3–7 行） */
	private memberDetailPageSize(): number {
		return Math.max(3, Math.min(7, Math.floor((this.termRows() - 12 - this.noticeRows()) / 2)));
	}

	/** 公司切换提示后缀：仅当本机加入多个 org 时提示 Tab 键 */
	private tabHint(): string {
		return this.orgNames.length > 1 ? ' · Tab 切公司' : '';
	}

	/** 二次确认屏（破坏性操作统一呈现：问题 + 后果 + y/Esc） */
	private renderConfirm(width: number): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));
		const out: string[] = [];
		out.push(L(`确认：${this.confirm?.title ?? ''}`, th.error));
		if (this.confirm?.detail) out.push(L(`  ${this.confirm.detail}`, th.warning));
		return this.withFooter(out, 'y / Enter 确认 · Esc 取消', width);
	}

	private withFooter(out: string[], hint: string, width: number): string[] {
		const th = this.th;
		const cap = this.maxTotal();
		if (out.length + 3 > cap) {
			out.splice(cap - 3, out.length - cap + 3);
		}
		if (out.length > 0) {
			// footer 上界分隔线（③）：内部线——左空 2 格缩进 + dim 暗色
			out.push(
				truncateToWidth(
					th.dim('  ' + '─'.repeat(Math.max(0, width - 2))),
					Math.max(8, width),
				),
			);
		}
		out.push(truncateToWidth(th.muted(hint), Math.max(8, width)));
		// 底横线（④）
		out.push(truncateToWidth(th.accent('─'.repeat(Math.max(0, width))), Math.max(8, width)));
		return out;
	}

	/** 目录显示：home 化 ~ + 超宽时保留尾部截断 */
	/**
	 * 成员详情诊断行（ADR-0040 D12②）：按态据实，不显示不存在的字段。
	 * 在岗 `pid · 在岗时长 · tmux 会话名/手工启动 · 会话前 6 位`；睡眠 `已睡眠 · 上次会话 …`。
	 */
	private diagLine(member: string): string {
		const p = this.presence.get(member);
		const org = this.orgNames[this.orgIdx];
		if (!p || p.state === 'sleeping') {
			const last = this.lastSessions.get(member);
			const tail = last ? ` · 上次会话 ${last.slice(0, 6)}…` : ' · 无历史会话';
			// 进程仍在但 socket 不可连 = 陈旧 runtime（崩溃 / SIGKILL 残留）→ 据实说明，
			// 否则会被读成"睡眠"，并让人误按 w 想拉起（那是重复进程）
			if (p?.runtime && p.pidAlive) {
				return `  进程在（pid ${p.runtime.pid}）· 控制 socket 不可连（疑似陈旧 runtime）${tail}`;
			}
			return `  已睡眠${tail}`;
		}
		const rt = p.runtime;
		if (!rt) return '';
		const parts = [`pid ${rt.pid}`];
		const elapsed = onlineFor(p);
		if (elapsed) parts.push(`在岗 ${elapsed}`);
		parts.push(
			this.tmuxManaged.has(member)
				? `tmux attach -t ${tmuxSessionName(org ?? '', member)}（Ctrl-b d 返回）`
				: '手工启动（无 tmux 会话）',
		);
		if (rt.sessionId) parts.push(`会话 ${rt.sessionId.slice(0, 6)}…`);
		return `  ${parts.join(' · ')}`;
	}

	/** 当前成员视角关注的对象：详情屏 = 该成员；列表 = 选中行 */
	private focusedMember(): string | null {
		if (this.peopleSel) return this.peopleSel;
		const members = this.snap.get(this.orgNames[this.orgIdx])?.org.members ?? [];
		return members[this.selIdx]?.name ?? null;
	}

	/** footer 的唤醒/睡眠提示：按态只显示可用者（ADR-0040 D12③） */
	private lifecycleHint(member: string | null): string {
		if (!member) return '';
		const state = this.presence.get(member)?.state;
		if (!state) return '';
		return state === 'sleeping' ? ' · w 唤醒' : ' · s 睡眠 · x 中断';
	}

	/** 设置页行定义：渲染与按键共用同一来源（避免两处索引错位） */
	private settingsRows(): { label: string; sub: string; enter: () => void }[] {
		const rows: { label: string; sub: string; enter: () => void }[] = [
			{
				label: `任务排序：${this.prefs.sortNewFirst ? '新→旧' : '旧→新'}`,
				sub: 'Enter 切换',
				enter: () => void this.togglePref('sortNewFirst'),
			},
			{
				label: `行尾标注：${this.prefs.annotate ? '开' : '关'}`,
				sub: 'Enter 切换',
				enter: () => void this.togglePref('annotate'),
			},
			{
				label: `自动唤醒（本组织）：${this.autoWakeOn() ? '开' : '关'}`,
				sub: '负责人派活时自动拉起睡眠成员（存本组织 org.json）',
				enter: () => void this.toggleAutoWake(),
			},
			{
				label: '组织背景（本组织）',
				sub: this.backgroundSummary(),
				enter: () => this.beginBackgroundInput(),
			},
			{
				label: '新建公司',
				sub: '把当前目录设为负责人工作区',
				enter: () => this.beginInput('create'),
			},
			{
				label: '重命名公司',
				sub: '公司名 + 目录/任务档案同步迁移',
				enter: () => this.beginInput('rename'),
			},
			{
				label: '加入公司',
				sub: '用当前目录加入本机其他公司',
				enter: () => void this.beginJoinOrg(),
			},
			{
				label: '删除公司',
				sub: '归档到 ~/.pi/org/.trash（可恢复）',
				enter: () => this.confirmDeleteOrg(),
			},
		];
		// 上岗入口（ADR-0046 D3①）：置顶为一级操作行（仅当 org 侧注入了上岗能力）
		if (this.hooks.duty) {
			rows.unshift({
				label: `上岗状态：${this.dutyWord()}`,
				sub: this.dutySub(),
				enter: () => void this.runToggleDuty(),
			});
		}
		return rows;
	}

	/** 组织背景的设置页摘要（读当前快照） */
	private backgroundSummary(): string {
		const org = this.orgNames[this.orgIdx];
		const bg = org ? this.snap.get(org)?.org.background : undefined;
		if (!bg) return '（未填写）· Enter 编辑（供在岗简报引用）';
		return `${truncateToWidth(bg, 40)} · Enter 编辑`;
	}

	/** 进入组织背景输入态（预填当前值，编辑心智 §3.3） */
	private beginBackgroundInput(): void {
		const org = this.orgNames[this.orgIdx];
		this.backgroundInput = (org ? this.snap.get(org)?.org.background : '') ?? '';
		this.createErr = '';
		this.inputMode = 'background';
		this.refresh();
	}

	/** 提交组织背景：写入本组织 org.json（清空 = 删除该字段） */
	private async commitBackground(): Promise<void> {
		const org = this.orgNames[this.orgIdx];
		if (!org) return;
		const trimmed = this.backgroundInput.trim();
		try {
			await setBackground(org, this.backgroundInput);
			const snap = this.snap.get(org);
			if (snap) {
				if (trimmed) snap.org.background = trimmed;
				else delete snap.org.background;
			}
			this.notice = trimmed ? '已保存组织背景（本组织）' : '已清除组织背景（本组织）';
			this.inputMode = null;
			this.backgroundInput = '';
			this.createErr = '';
		} catch (e) {
			this.createErr = e instanceof Error ? e.message : String(e);
		}
		this.refresh();
	}

	/**
	 * 启动参数编辑屏（从成员面板进入）：**先展示存盘现值**再允许改（编辑类输入必显当前值）。
	 * 留空保存 = 不带额外参数（删除默认项）；引号不成对在本屏报错、保留原值。
	 */
	private renderLaunchArgsInput(width: number): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));
		const out: string[] = [];
		const org = this.orgNames[this.orgIdx] ?? '(无公司)';
		out.push(L(`成员启动参数（${this.launchArgsEdit?.target ?? '?'} @ ${org}）`, th.bold));
		out.push(
			L(
				'  唤醒时追加在固定启动项（-a --session-control）之后；留空保存 = 不带额外参数',
				th.dim,
			),
		);
		out.push(L('  空格分隔，可用成对引号包住带空格的参数（引号须成对）', th.dim));
		out.push(L(''));
		out.push(L(`  当前值：${(this.launchArgsEdit?.before ?? '').trim() || '（无）'}`));
		out.push(L('  新值：'));
		const avail = Math.max(8, width - 4);
		for (const line of wrapTextWithAnsi(`${this.launchArgsEdit?.value ?? ''}_`, avail)) {
			out.push(L(`    ${line}`));
		}
		if (this.createErr) out.push(L(this.createErr, th.error));
		return this.withFooter(
			out,
			'输入 · 退格删 · Esc 取消 · Enter 保存（清空=不带参数）',
			width,
		);
	}

	/**
	 * 本机在当前展示的组织里是不是「成员视角」——即 cwd 是否命中**该组织名册**。
	 *
	 * 为何不看全局身份：一个 pi 会话可以属于多个组织（甚至 cwd 属于别的组织的成员目录）。
	 * 用全局身份会让「人在 A 组织成员目录里、打开 B 组织看板」时改不了 B 的成员参数；
	 * 而 ADR-0051 D4 的措辞本来就是「cwd 不在本组织名册」（提示文案也是这么写的）。
	 */
	private isMemberView(): boolean {
		const snap = this.snap.get(this.orgNames[this.orgIdx]);
		if (!snap) return false;
		const cwd = process.cwd();
		return snap.org.members.some((m) => sameDir(m.dir, cwd));
	}

	/** 成员面板底部提示：仅人类操作台显示（ADR-0051 D4） */
	private launchArgsHint(): string {
		return this.isMemberView() ? '' : ' · p 启动参数';
	}

	/**
	 * 文本输入态共用的键位处理：Esc 取消 / Enter 提交 / 退格删 / 可打印字符追加（限宽）。
	 *
	 * 三处输入屏（新建·改名公司、组织背景、成员启动参数）原先各抄了一份逐字相同的按键分支，
	 * 差异只有：值存在哪、提交做什么、限宽多少（公司名 64、其余 500）、额外拒绝哪些字符。
	 * 屏上的标题/提示/现值展示仍留在各自的 render 里——那些内容本就不同，不该硬抽象成一份。
	 */
	private handleTextInputKey(
		data: string,
		opts: {
			value: () => string;
			set: (v: string) => void;
			commit: () => void;
			maxWidth?: number;
			/** 额外拒绝的字符（如公司名不接受路径分隔符） */
			reject?: RegExp;
		},
	): void {
		if (matchesKey(data, Key.escape)) {
			this.cancelTextInput();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			opts.commit();
			return;
		}
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			opts.set(opts.value().slice(0, -1));
			this.refresh();
			return;
		}
		if (
			data.length === 1 &&
			data >= ' ' &&
			data !== '\x7f' &&
			!/[\u0000-\u001f]/.test(data) &&
			!(opts.reject?.test(data) ?? false) &&
			visibleWidth(opts.value() + data) <= (opts.maxWidth ?? 500)
		) {
			opts.set(opts.value() + data);
			this.refresh();
		}
	}

	/**
	 * 退出文本输入态：三处 Esc 语义一致（丢编辑、清错误提示）。各屏的暂存值由各自的"打开"函数
	 * 重新赋值，故这里只需清掉会话对象——启动参数编辑的三个字段随会话一起消失，不留残态。
	 */
	private cancelTextInput(): void {
		this.inputMode = null;
		this.launchArgsEdit = null;
		this.createErr = '';
		this.refresh();
	}

	/**
	 * 进入启动参数编辑态（预填当前值，编辑心智 §3.3）。
	 * 仅人类操作台可改（ADR-0051 D4）：成员视角不提示，按下则拒绝并说明。
	 */
	private beginLaunchArgsEdit(member: string): void {
		if (this.isMemberView()) {
			this.notice = '仅人类操作台（cwd 不在本组织名册）可改成员启动参数';
			this.noticeSeq++;
			this.refresh();
			return;
		}
		const m = this.snap
			.get(this.orgNames[this.orgIdx])
			?.org.members.find((x) => x.name === member);
		if (!m) return;
		const before = m.launchArgs ?? '';
		this.launchArgsEdit = { target: member, before, value: before };
		this.createErr = '';
		this.inputMode = 'launch-args';
		this.refresh();
	}

	/** 提交启动参数：写成员记录（清空 = 删除该字段 ⇒ 唤醒不带额外参数），并留修改时间 */
	private async commitLaunchArgsEdit(): Promise<void> {
		const member = this.launchArgsEdit?.target;
		const org = this.orgNames[this.orgIdx];
		const raw = (this.launchArgsEdit?.value ?? '').trim();
		if (!member || !org) {
			this.inputMode = null;
			this.launchArgsEdit = null;
			this.refresh();
			return;
		}
		// 引号不成对 ⇒ 拒绝保存、保留原值（不猜、不截断；ADR-0051 D3）
		if (raw) {
			const split = splitLaunchArgs(raw);
			if (!split.ok) {
				this.createErr = split.error;
				this.refresh();
				return;
			}
		}
		try {
			const updated = await setMemberLaunchArgs(org, member, raw);
			const m = this.snap.get(org)?.org.members.find((x) => x.name === member);
			if (m) {
				m.launchArgs = updated.launchArgs;
				m.launchArgsUpdatedAt = updated.launchArgsUpdatedAt;
			}
			this.notice = `${member} 启动参数已更新：${raw || '（无，唤醒时不带额外参数）'}`;
			this.noticeSeq++;
			this.inputMode = null;
			this.launchArgsEdit = null;
			this.createErr = '';
		} catch (e) {
			this.createErr = e instanceof Error ? e.message : String(e);
		}
		this.refresh();
	}

	/** 该 org 是否开启「自动唤醒」（读当前快照，缺省关） */
	private autoWakeOn(): boolean {
		return this.snap.get(this.orgNames[this.orgIdx])?.org.settings?.autoWake === true;
	}

	/** 切换本组织「自动唤醒」开关（ADR-0040 D8） */
	private async toggleAutoWake(): Promise<void> {
		const org = this.orgNames[this.orgIdx];
		if (!org) return;
		const next = !this.autoWakeOn();
		try {
			await setAutoWake(org, next);
			const snap = this.snap.get(org);
			if (snap) snap.org.settings = { ...snap.org.settings, autoWake: next };
			this.notice = `已${next ? '开启' : '关闭'}「自动唤醒」（本组织${
				next ? '：负责人派活会拉起睡眠成员）' : '）'
			}`;
		} catch (e) {
			this.notice = `设置失败：${e instanceof Error ? e.message : String(e)}`;
		}
		this.refresh();
	}

	// ── 上岗入口（ADR-0046 D3：设置行 + `o` 键共用同一段切换逻辑）──────────────
	/** 当前上岗态（未注入 duty 能力时按不可上岗视之） */
	private dutyState(): 'unavailable' | 'eligible' | 'on' {
		return this.hooks.duty?.state() ?? 'unavailable';
	}

	/** 状态词（设置行标题） */
	private dutyWord(): string {
		const s = this.dutyState();
		if (s === 'on') return '在岗';
		if (s === 'eligible') return '可上岗（未上岗）';
		return '不可上岗（未连接）';
	}

	/** 副标题：给出下一步出路 */
	private dutySub(): string {
		const s = this.dutyState();
		if (s === 'on') return 'Enter 离岗（/org off）';
		if (s === 'eligible') return 'Enter 上岗（/org on）';
		return '需先 /control on（本会话没有控制 socket）';
	}

	/** 底部图例片段：仅可切换时显示 */
	private dutyHint(): string {
		if (!this.hooks.duty) return '';
		const s = this.dutyState();
		if (s === 'unavailable') return '';
		return s === 'on' ? ' · o 离岗' : ' · o 上岗';
	}

	/** 上岗 / 离岗（设置行与 `o` 键共用）；不可上岗时据实给出出路，不静默 */
	private async runToggleDuty(): Promise<void> {
		const duty = this.hooks.duty;
		if (!duty) return;
		// 不在看板里另做判定：能否上岗由 org 侧 setDuty 单一裁定，并把原因回报上来
		// （R4：避免"第二套可上岗判定"与文案漂移）
		const seq = ++this.noticeSeq;
		const res = await duty.toggle(this.dutyState() !== 'on');
		if (this.noticeSeq !== seq) return; // 已被新的按键/提示取代，丢弃
		this.notice = res.message;
		this.refresh();
	}

	/** 唤醒（幂等；据实回报跳过原因与失败） */
	private async runWake(member: string): Promise<void> {
		const org = this.orgNames[this.orgIdx];
		if (!org) return;
		const seq = ++this.noticeSeq;
		this.notice = `正在唤醒 ${member}…`;
		this.refresh();
		const res = await wakeMember(org, member, { selfDir: process.cwd() });
		const settle = async (text: string) => {
			if (this.noticeSeq !== seq) return; // 已被新的按键/提示取代，丢弃
			this.notice = text;
			await this.refreshPresence({ sweep: true });
			this.refresh();
		};
		if (res.skipped === 'online') return settle(`${member} 已在岗（无需唤醒）。`);
		if (res.skipped === 'session-exists') {
			return settle(`${member} 正在拉起中（tmux ${res.sessionName}）。`);
		}
		// 06：唤醒返回前已校验「起来没有」——失败带原因、成功区分在岗/尚在启动。
		// 这里不再重复等 15s：那会把「进程已死」拖成一句含糊的「尚未在岗」。
		if (res.error) {
			// 失败原因可能很长（含终端输出）：看板只给一眼能读的重点，全文在唤醒日志里
			const brief = res.error.length > 160 ? `${res.error.slice(0, 160)}…` : res.error;
			return settle(`${member} 唤醒失败：${brief}`);
		}
		await settle(
			(res.online
				? `已唤起 ${member}（tmux ${res.sessionName}，已在岗）。`
				: `已唤起 ${member}（进程已拉起，尚在启动）——可 tmux attach -t ${res.sessionName} 观察。`) +
				// 07：降级过就说清楚（只影响本次拉起）
				(res.degradedFrom?.length
					? `已忽略不被识别的：${res.degradedFrom.join(' ')}。`
					: ''),
		);
	}

	/** 睡眠入口：二次确认（工作中额外警示）；不在岗直接据实提示 */
	private requestStop(member: string): void {
		const p = this.presence.get(member);
		if (!p || p.state === 'sleeping') {
			this.notice = `${member} 当前不在岗（无需睡眠）。`;
			this.refresh();
			return;
		}
		const busyWarn =
			p.state === 'working' ? '该成员正在处理任务，中断可能丢弃当前上下文。' : '';
		this.confirm = {
			title: `让 ${member} 睡眠？`,
			detail: [busyWarn, '将停止其 pi 进程（之后可再唤醒，会续接上次会话）']
				.filter((x) => x.length > 0)
				.join('；'),
			run: () => void this.runStop(member),
		};
		this.refresh();
	}

	/** 睡眠执行（杀停限人类，ADR-0040 D2） */
	private async runStop(member: string): Promise<void> {
		const org = this.orgNames[this.orgIdx];
		if (!org) return;
		const seq = ++this.noticeSeq;
		const res = await stopMember(org, member, { selfDir: process.cwd() });
		if (this.noticeSeq !== seq) return;
		this.notice = res.stopped
			? `${member} 已睡眠（${res.via === 'tmux' ? 'tmux 会话已关闭' : '进程已停止'}）${
					res.sessionId ? '，下次唤醒续接上次会话' : ''
				}。`
			: (res.error ?? '停止失败。');
		await this.refreshPresence({ sweep: true });
		this.refresh();
	}

	/** 成员简介缩略：定宽 colWidth 显示列；超出以 … 截断、不足补空格（空简介显示 (无)） */
	private fitDesc(desc: string | undefined, colWidth: number): string {
		const text = (desc ?? '').trim();
		return truncateToWidth(text || '(无)', colWidth, '…', true);
	}

	private fitDir(dir: string, avail: number): string {
		if (avail < 8) return '…';
		const home = os.homedir();
		const s = dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
		if (visibleWidth(s) <= avail) return s;
		const out: string[] = [];
		let w = 0;
		for (const ch of [...s].reverse()) {
			const cw = visibleWidth(ch);
			if (w + cw > avail - 1) break;
			out.unshift(ch);
			w += cw;
		}
		return '…' + out.join('');
	}

	// ── 键盘 ─────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		// 提示为瞬态：下一次按键先清除（并作废在途异步结果），本轮产生的提示不受影响
		if (this.notice) {
			this.notice = '';
			this.noticeSeq++;
			this.refresh();
		}
		// 确认弹层（二次确认）
		if (this.confirm) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === 'y') {
				const c = this.confirm;
				this.confirm = null;
				c.run();
				return;
			}
			if (
				matchesKey(data, Key.escape) ||
				matchesKey(data, Key.ctrl('c')) ||
				data.toLowerCase() === 'n'
			) {
				this.confirm = null;
				this.refresh();
			}
			return;
		}

		// 详情页
		if (this.detailTaskId) {
			if (matchesKey(data, Key.escape)) {
				this.detailTaskId = null;
				// 改派候选屏与本屏共用 Esc：必须同时退出候选模式，否则模式泄漏到
				// 下一次打开详情（直接显示候选屏、Enter 会误改派）。
				this.reassignMode = false;
				this.reassignSel = 0;
				this.selIdx = this.popDrill();
				this.refresh();
				return;
			}
			// 改派候选屏（G2 第二级）优先拦截：该屏 footer 只声明 ↑↓ / Enter / Esc，
			// 故 a/r/x/g 在此不生效——与屏上文案一致，也保证 Esc 分支可达（在下文）。
			if (this.reassignMode) {
				const snapM = this.snap.get(this.orgNames[this.orgIdx]);
				const members = snapM?.org.members ?? [];
				const fRows = this.detailFocusRows();
				const fSel = fRows[this.detailFocus];
				const subM = fSel
					? this.currentTask()?.subTasks.find((su) => su.id === fSel.subId)
					: undefined;
				const alreadyM = new Set((subM?.assignees ?? []).map((a) => a.agent));
				const cands = members.filter((m) => !alreadyM.has(m.name)).map((m) => m.name);
				if (matchesKey(data, Key.escape)) {
					this.reassignMode = false;
					this.refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const target = cands[this.reassignSel];
					const subId = fSel?.subId;
					const removeAgent = fSel?.agent ?? null;
					const tgt = this.currentTask();
					if (tgt && subId && target && removeAgent && fSel?.status !== 'delivered') {
						this.reassignMode = false;
						void this.runReassign(tgt.id, subId, removeAgent, target);
					}
					return;
				}
				if (matchesKey(data, Key.up) && this.reassignSel > 0) this.reassignSel--;
				if (matchesKey(data, Key.down) && this.reassignSel < cands.length - 1)
					this.reassignSel++;
				this.refresh();
				return;
			}
			if (data.toLowerCase() === 'a') {
				const t = this.currentTask();
				if (t && t.status !== 'closed') {
					this.confirm = {
						title: `验收任务 ${t.id}？`,
						detail: '采纳已交付项、叫停未交付项并关闭（落账 human@，铁终态）',
						run: () => void this.runAction('approve', t.id),
					};
					this.refresh();
				}
				return;
			}
			if (data.toLowerCase() === 'r') {
				const t = this.currentTask();
				const hasDelivered = !!t?.subTasks.some((su) =>
					su.assignees.some((a) => a.status === 'delivered'),
				);
				if (t && t.status !== 'closed' && hasDelivered) {
					this.confirm = {
						title: `打回任务 ${t.id}？`,
						detail: '返工轮次 +1，已交付项退回处理人',
						run: () => void this.runAction('return', t.id),
					};
					this.refresh();
				}
				return;
			}
			if (data.toLowerCase() === 't') {
				const t = this.currentTask();
				const foc = this.detailFocusRows()[this.detailFocus];
				if (t && t.status !== 'closed' && foc && foc.status !== 'delivered') {
					this.confirm = {
						title: `重试任务 ${t.id}（${foc.agent}）？`,
						detail: '把任务重新投递给该成员（附"上次中断/失败"说明；任务编号与账本状态不变）',
						run: () => void this.runRetry(t.id, foc.subId, foc.agent),
					};
					this.refresh();
				}
				return;
			}
			if (data.toLowerCase() === 'x') {
				const t = this.currentTask();
				if (t && t.status !== 'closed') {
					this.confirm = {
						title: `取消任务 ${t.id}？`,
						detail: '任务关闭（铁终态，不可重开）',
						run: () => void this.runAction('cancel', t.id),
					};
					this.refresh();
				}
				return;
			}
			// g：进入改派候选（G2 第二级；delivered 焦点不可改派——应走验收/打回）
			if (data.toLowerCase() === 'g') {
				const focG = this.detailFocusRows();
				const f = focG[this.detailFocus];
				const tG = this.currentTask();
				if (tG && tG.status !== 'closed' && f && f.status !== 'delivered') {
					this.reassignMode = true;
					this.reassignSel = 0;
					this.refresh();
				}
				return;
			}
			// ↑↓：参与者焦点移动（改派指认用，G2/04）
			const foc = this.detailFocusRows();
			if (matchesKey(data, Key.up)) {
				if (this.detailFocus > 0) this.detailFocus--;
				else if (foc.length > 0) this.detailFocus = 0;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (foc.length > 0)
					this.detailFocus = Math.min(this.detailFocus + 1, foc.length - 1);
				this.refresh();
				return;
			}
			return;
		}

		// 任务视角
		if (this.view === 'tasks') {
			if (this.filterActive) {
				// 过滤输入态
				if (matchesKey(data, Key.escape)) {
					this.filterActive = false;
					this.filter = this.filterBeforeEdit; // Esc = 还原编辑前的过滤
					this.selIdx = 0;
					this.refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					this.filterActive = false; // 锁定当前过滤，退出输入态
					this.selIdx = 0;
					this.refresh();
					return;
				}
				if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
					this.filter = this.filter.slice(0, -1);
					this.selIdx = 0;
					this.refresh();
					return;
				}
				if (data.length === 1 && data >= ' ' && data !== '\x7f') {
					this.filter += data;
					this.selIdx = 0;
					this.refresh();
				}
				return;
			}
			if (data === '/') {
				// 再次进入搜索保留既有过滤（编辑心智 §3.3），Esc 可还原
				this.filterBeforeEdit = this.filter;
				this.filterActive = true;
				this.selIdx = 0;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const t = this.taskUnderCursor();
				if (t) {
					this.pushDrill();
					this.detailTaskId = t.id;
					this.detailFocus = 0;
					this.selIdx = 0;
					this.refresh();
				}
				return;
			}
			if (['1', '2', '3', '4'].includes(data)) {
				this.taskTab = (Number(data) - 1) as TaskTabIdx;
				this.selIdx = 0;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.up) || matchesKey(data, 'k')) {
				if (this.selIdx > 0) this.selIdx--;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down) || matchesKey(data, 'j')) {
				this.selIdx++;
				this.refresh();
				return;
			}
		}

		// 成员视角
		if (this.view === 'people') {
			// 启动参数编辑态：所有按键归输入框（Esc 取消 / Enter 保存）
			if (this.inputMode === 'launch-args') {
				this.handleTextInputKey(data, {
					value: () => this.launchArgsEdit?.value ?? '',
					set: (v) => {
						if (this.launchArgsEdit) this.launchArgsEdit.value = v;
					},
					commit: () => void this.commitLaunchArgsEdit(),
				});
				return;
			}
			if (this.peopleSel) {
				if (matchesKey(data, Key.escape)) {
					this.peopleSel = null;
					this.selIdx = this.popDrill();
					this.refresh();
					return;
				}
				if (data.toLowerCase() === 'w') {
					void this.runWake(this.peopleSel);
					return;
				}
				if (data.toLowerCase() === 'x') {
					void this.runInterrupt(this.peopleSel);
					return;
				}
				if (data.toLowerCase() === 's') {
					this.requestStop(this.peopleSel);
					return;
				}
				if (data.toLowerCase() === 'p') {
					this.beginLaunchArgsEdit(this.peopleSel);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const rows = this.memberDetailTaskList();
					const t = rows[this.selIdx];
					if (t) {
						this.pushDrill();
						this.detailTaskId = t.id;
						this.detailFocus = 0;
						this.selIdx = 0;
						this.refresh();
					}
					return;
				}
			} else if (data.toLowerCase() === 'd') {
				// 踢退：人类强制 leaveOrg（保留回归档案；未结任务留在任务池待改派）
				const snap = this.snap.get(this.orgNames[this.orgIdx]);
				const m = snap?.org.members[this.selIdx];
				const members = snap?.org.members ?? [];
				if (!m) return;
				if (m.role === 'chief') {
					this.loadError = '负责人不可踢退，请先用 m 转移负责人。';
					this.refresh();
				} else if (members.length <= 1) {
					this.loadError = '最后一名成员不可踢退（公司会无主）。';
					this.refresh();
				} else {
					this.confirm = {
						title: `踢退成员 ${m.name}？`,
						detail: '移出公司（保留回归档案）；其未结任务留在任务池待派发人改派',
						run: () => void this.runKickMember(m.name),
					};
					this.refresh();
				}
				return;
			} else if (data.toLowerCase() === 'm') {
				// 负责人转移：被指者升 chief，原负责人自动降为普通成员
				const snap = this.snap.get(this.orgNames[this.orgIdx]);
				const m = snap?.org.members[this.selIdx];
				if (m && m.name !== snap?.org.chiefName) {
					this.confirm = {
						title: `将 ${m.name} 设为负责人？`,
						detail: `原负责人 ${snap?.org.chiefName ?? '(无)'} 自动降为普通成员`,
						run: () => void this.runTransferChief(m.name),
					};
					this.refresh();
				}
				return;
			} else if (data.toLowerCase() === 'w') {
				const m = this.snap.get(this.orgNames[this.orgIdx])?.org.members[this.selIdx];
				if (m) void this.runWake(m.name);
				return;
			} else if (data.toLowerCase() === 'x') {
				const m = this.snap.get(this.orgNames[this.orgIdx])?.org.members[this.selIdx];
				if (m) void this.runInterrupt(m.name);
				return;
			} else if (data.toLowerCase() === 's') {
				const m = this.snap.get(this.orgNames[this.orgIdx])?.org.members[this.selIdx];
				if (m) this.requestStop(m.name);
				return;
			} else if (data.toLowerCase() === 'p') {
				const m = this.snap.get(this.orgNames[this.orgIdx])?.org.members[this.selIdx];
				if (m) this.beginLaunchArgsEdit(m.name);
				return;
			} else if (matchesKey(data, Key.enter)) {
				const m = this.snap.get(this.orgNames[this.orgIdx])?.org.members[this.selIdx];
				if (m) {
					this.pushDrill();
					this.peopleSel = m.name;
					void this.refreshActivity();
					this.selIdx = 0;
					this.refresh();
				}
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (this.selIdx > 0) this.selIdx--;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.selIdx++;
				this.refresh();
				return;
			}
		}

		// 设置视角
		if (this.view === 'settings') {
			if (this.inputMode === 'join-pick') {
				if (matchesKey(data, Key.escape)) {
					this.inputMode = null;
					this.refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					void this.commitJoinOrg();
					return;
				}
				if (matchesKey(data, Key.up) && this.joinSel > 0) {
					this.joinSel--;
					this.refresh();
					return;
				}
				if (matchesKey(data, Key.down) && this.joinSel < this.joinCands.length - 1) {
					this.joinSel++;
					this.refresh();
					return;
				}
				return;
			}
			if (this.inputMode === 'background') {
				this.handleTextInputKey(data, {
					value: () => this.backgroundInput,
					set: (v) => {
						this.backgroundInput = v;
					},
					commit: () => void this.commitBackground(),
				});
				return;
			}
			if (this.inputMode === 'create' || this.inputMode === 'rename') {
				this.handleTextInputKey(data, {
					value: () => this.orgNameInput,
					set: (v) => {
						this.orgNameInput = v;
					},
					commit: () => void this.commitInput(),
					maxWidth: 64, // 公司名限宽（比通用 500 紧）
					reject: /[/\\]/, // 公司名不接受路径分隔符
				});
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.settingsRows()[this.selIdx]?.enter();
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (this.selIdx > 0) this.selIdx--;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (this.selIdx < this.settingsRows().length - 1) this.selIdx++;
				this.refresh();
				return;
			}
		}

		// 跨视角：o 上岗/离岗 · r 刷新 · ←→ 视角 · Tab 公司 · Esc 关闭
		if (data.toLowerCase() === 'o' && this.hooks.duty) {
			void this.runToggleDuty();
			return;
		}
		if (data.toLowerCase() === 'r') {
			void this.reloadWithManifestSync();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, 'shift+tab')) {
			if (this.orgNames.length > 1) {
				const dir = matchesKey(data, 'shift+tab') ? -1 : 1;
				this.orgIdx = (this.orgIdx + dir + this.orgNames.length) % this.orgNames.length;
				this.detailTaskId = null;
				this.peopleSel = null;
				this.drillCursors = [];
				this.selIdx = 0;
				this.snap.clear();
				// 切 org 后重算 tab 上的在岗计数：新 org 用权威判据、旧 org 退回廉价判据
				void this.loadCurrentOrg()
					.then(() => this.refreshOnlineCounts())
					.catch((e: unknown) => {
						log.debug('切换 org 后的计数刷新失败（忽略）', { err: String(e) });
					});
			}
			return;
		}
		if (matchesKey(data, Key.left)) {
			const order = VIEW_TABS.map((v) => v.key);
			const i = order.indexOf(this.view);
			this.view = order[(i - 1 + order.length) % order.length] as BoardView;
			this.detailTaskId = null;
			this.peopleSel = null;
			this.drillCursors = [];
			this.selIdx = 0;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.right)) {
			const order = VIEW_TABS.map((v) => v.key);
			const i = order.indexOf(this.view);
			this.view = order[(i + 1) % order.length] as BoardView;
			this.detailTaskId = null;
			this.peopleSel = null;
			this.drillCursors = [];
			this.selIdx = 0;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.close();
		}
	}

	// ── 数据辅助 ─────────────────────────────────────────────────────────────

	/** 详情页可聚焦参与者（active：invited/claimed/returned/delivered；终态 rejected/cancelled 不可改派不聚焦） */
	private detailFocusRows(): { subId: string; agent: string; status: string }[] {
		const t = this.currentTask();
		if (!t) return [];
		const rows: { subId: string; agent: string; status: string }[] = [];
		for (const sub of t.subTasks) {
			for (const a of sub.assignees) {
				if (a.status === 'rejected' || a.status === 'cancelled') continue;
				rows.push({ subId: sub.id, agent: a.agent, status: a.status });
			}
		}
		return rows;
	}

	private currentTask(): Task | null {
		if (!this.detailTaskId) return null;
		return (
			this.snap
				.get(this.orgNames[this.orgIdx])
				?.tasks.find((t) => t.id === this.detailTaskId) ?? null
		);
	}

	private taskUnderCursor(): Task | null {
		const snap = this.snap.get(this.orgNames[this.orgIdx]);
		if (!snap) return null;
		const ranked = this.applyFilterAndSort(
			snap.tasks.filter((t) => t.status === this.taskTabStatus()),
		);
		return ranked[this.selIdx] ?? null;
	}

	/** 成员详情的光标映射表：派发行在前、接收行在后（与渲染顺序一致） */
	private memberDetailTaskList(): Task[] {
		const snap = this.snap.get(this.orgNames[this.orgIdx]);
		const all = snap?.tasks ?? [];
		const openFirst = (arr: Task[]) => [
			...arr.filter((t) => t.status !== 'closed'),
			...arr.filter((t) => t.status === 'closed'),
		];
		const recv = all.filter((t) =>
			t.subTasks.some((s) => s.assignees.some((a) => a.agent === this.peopleSel)),
		);
		const disp = all.filter((t) => t.dispatcher === this.peopleSel);
		return [...openFirst(disp), ...openFirst(recv)];
	}

	// ── 人类改派执行（G2）──────────────────────────────────────────────────────

	/** 重试（ADR-0053 `D5`）：把任务重新投递给**焦点参与者**——不改编号、不改状态 */
	private async runRetry(taskId: string, subId: string, agent: string): Promise<void> {
		const orgName = this.orgNames[this.orgIdx];
		const res = await retrySubTask(orgName, taskId, subId, agent, {
			by: this.humanId,
			note: '人类从看板发起重试',
		});
		// retrySubTask 的成功消息自带「已重试：」前缀，这里不再重复拼（否则出现「已重试：已重试：…」）
		this.notice = res.ok ? res.message : `重试失败：${res.message}`;
		if (res.ok) this.hooks.onAction?.(orgName, taskId, 'retry', `${subId} → ${agent}`);
		this.refresh();
	}

	private async runReassign(
		taskId: string,
		subId: string,
		removeAgent: string,
		newAgent: string,
	): Promise<void> {
		const orgName = this.orgNames[this.orgIdx];
		const t = await readTask(orgName, taskId);
		if (!t) {
			this.loadError = `任务 ${taskId} 不存在`;
			this.refresh();
			return;
		}
		try {
			humanReassign(t, this.humanId, subId, removeAgent, newAgent);
			await saveTask(t);
			this.hooks.onAction?.(orgName, taskId, 'reassign', `${removeAgent} → ${newAgent}`);
			// 通知新处理人（与命令面 /org reassign 一致）——否则被改派者不会开工
			const reassignedSub = t.subTasks.find((s) => s.id === subId);
			void deliverMessage(
				orgName,
				newAgent,
				`[org:task] 人类将任务 ${taskId} 的子任务 ${subId} 改派给你：\n` +
					`任务：${t.title}\n你负责：${reassignedSub?.description ?? ''}`,
			).catch((e) => log.warn('board 改派通知失败', { err: e, agent: newAgent }));
			const { projectTask } = await import('./todoproj.js');
			void projectTask(orgName, taskId).catch((e) =>
				log.warn('board 改派投影失败', { err: e }),
			);
			this.snap.delete(orgName);
			this.reassignMode = false;
			this.detailTaskId = null;
			this.selIdx = this.popDrill();
			await this.loadCurrentOrg();
			this.refresh();
		} catch (e) {
			this.loadError = e instanceof Error ? e.message : String(e);
			this.reassignMode = false;
			this.refresh();
		}
	}

	// ── 人类操作执行 ─────────────────────────────────────────────────────────

	private async runAction(
		kind: string,
		taskId: string,
		_subId?: string,
		_agent?: string,
	): Promise<void> {
		const orgName = this.orgNames[this.orgIdx];
		const t = await readTask(orgName, taskId);
		if (!t) {
			this.loadError = `任务 ${taskId} 不存在`;
			this.refresh();
			return;
		}
		try {
			if (kind === 'approve') {
				const { stopped } = approveWithAdoption(t, this.humanId, '人类验收（TUI）', {
					humanBy: this.humanId,
				});
				await saveTask(t);
				for (const agent of stopped) {
					await deliverMessage(
						orgName,
						agent,
						`[org] 任务 ${t.id} 已完成（采纳了更早的交付），你无需继续。感谢付出。`,
					).catch((e) => log.warn('board approve 通知失败', { err: e }));
				}
				this.hooks.onAction?.(orgName, taskId, 'approve', '人类验收通过');
				this.confirm = null;
			} else if (kind === 'return') {
				attestTask(t, this.humanId, 'rejected', '人类打回（TUI）：请返工', undefined, {
					humanBy: this.humanId,
				});
				await saveTask(t);
				this.hooks.onAction?.(orgName, taskId, 'return', '人类打回');
			} else if (kind === 'cancel') {
				cancelTask(t, this.humanId, '人类取消（TUI）', { humanBy: this.humanId });
				await saveTask(t);
				this.hooks.onAction?.(orgName, taskId, 'cancel', '人类取消/关闭');
			}
			// 三个分支都已各自 saveTask（含乐观锁校验）；此处不再重复写盘——
			// 否则第二次写会与并发修改撞乐观锁，把已成功的操作报成误导性错误。
			// 同步投影（关闭回写待办 done）
			const { projectTask } = await import('./todoproj.js');
			void projectTask(orgName, taskId).catch((e) => log.warn('board 投影失败', { err: e }));
			// 删除本地缓存强制刷新
			this.snap.delete(orgName);
			this.detailTaskId = null;
			this.selIdx = this.popDrill();
			await this.loadCurrentOrg();
			this.refresh();
		} catch (e) {
			this.loadError = e instanceof Error ? e.message : String(e);
			this.confirm = null;
			this.refresh();
		}
	}
}
