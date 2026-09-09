// org — /org TUI 任务看板（tickets 09/10）
// 目录绑定 agent 框架的人类操作台：公司 tab（Tab 循环本机全部 org）→ 视角（任务/人员/设置）
// → 任务视角 4 状态子 tab → 列表（选行进详情）→ 详情页（元信息 + 子任务 + 交付/验收 + 人类操作）
//
// 规范（ADR-0023 / tui-design-principles）：
//   - 字符白名单：纯文本（无双宽 emoji），选中用 `>` 前缀 + 主题色
//   - 第 0 行恒为静态标题行（防 firstChanged=0 fullRender 重影，铁律 2）
//   - 动态信息（滚动位置/操作提示/高亮 tab）放底部 footer
//   - 每行 truncateToWidth 兜底
//   - 总行数 ≤ 24 上限（铁律 1：不超终端视口），列表内部滚动
// 数据为快照式：打开加载一次 + r 手动刷新（不做后台定时器——扩展运行时 setInterval 不触发）
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { type Component, type TUI, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { OrgFile, Task } from './types.js';
import {
	effectiveDueAt,
	listTasks,
	readTask,
	saveTask,
	attestTask,
	approveWithAdoption,
	cancelTask,
} from './task.js';
import { listOrgNames, readOrg } from './orgstore.js';
import { deliverMessage } from './dispatch.js';
import { nowIso, orgRoot, readJson, writeJsonAtomic } from './util.js';

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

const TASK_TAB_NAMES = ['待办', '进行中', '等待验收', '已关闭'] as const;
const VIEW_TABS: { key: BoardView; label: string }[] = [
	{ key: 'tasks', label: '任务' },
	{ key: 'people', label: '人员' },
	{ key: 'settings', label: '设置' },
];

interface BoardPrefs {
	sortNewFirst: boolean;
	annotate: boolean;
}

interface OrgSnapshot {
	org: OrgFile;
	tasks: Task[];
	loadedAt: string;
}

export interface BoardHooks {
	/** 人类操作执行后的回调（如推送通知），接收动作描述 */
	onAction?: (org: string, taskId: string, action: string, detail: string) => void;
}

const MAX_BODY_LINES = 12; // 列表区/详情滚动区内可见行数上限
const MAX_TOTAL = 22; // 总行数上限（铁律 1：≤ 24 行视口）

export class OrgBoard implements Component {
	private meName: string;
	private tui: TUI;
	private th: BoardTheme;
	private done: (result: string | null) => void;
	private hooks: BoardHooks;

	// 加载与导航状态
	private loading = true;
	private loadError = '';
	private orgNames: string[] = [];
	private orgIdx = 0;
	private view: BoardView = 'tasks';
	private taskTab: TaskTabIdx = 0;
	private selIdx = 0; // 当前列表选中行
	private filterActive = false; // / 进入过滤输入态（与 filter 空串区分）
	private filter = ''; // 列表关键字过滤（即时）
	private snap: Map<string, OrgSnapshot> = new Map();
	private prefs: BoardPrefs = { sortNewFirst: true, annotate: true };

	// 详情/人员导航
	private detailTaskId: string | null = null; // 详情页
	private peopleSel: string | null = null; // 人员视角：选中成员 → 该成员任务清单屏
	private confirm: { kind: string; taskId: string; subId?: string; agent?: string } | null = null;

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
	) {
		this.meName = meName;
		this.tui = tui;
		this.th = makeBoardTheme(theme);
		this.done = done;
		this.hooks = hooks;
		this.loadPrefs()
			.then(() => this.initialize())
			.catch((e) => this.fail(e));
	}

	private async loadPrefs(): Promise<void> {
		// 界面偏好存 orgRoot()/.board.json（跟随 ORG_ROOT，与 org 数据同域）——
		// 有意不走 @zenone/pi-config：① 偏好为单机全局、无分层合并/会话覆盖需求；
		// ② org 全量数据（花名册/任务/映射/运行时）都在 ~/.pi/org 下，测试与 e2e 靠
		//    ORG_ROOT 一处隔离即可，拆到 extensions-data 需另布 HOME 与依赖链，收益为零。
		const raw = await readJson<Partial<BoardPrefs>>(path.join(orgRoot(), '.board.json'));
		if (raw) {
			if (typeof raw.sortNewFirst === 'boolean') this.prefs.sortNewFirst = raw.sortNewFirst;
			if (typeof raw.annotate === 'boolean') this.prefs.annotate = raw.annotate;
		}
	}

	private async initialize(): Promise<void> {
		try {
			const names = await listOrgNames();
			this.orgNames = names;
			// 默认打开：当前会话所属的第一个 org，否则第一个存在的 org
			const mineFirst = this.orgNames.indexOf(this.meOrgPref());
			this.orgIdx = mineFirst >= 0 ? mineFirst : 0;
			if (this.orgIdx >= this.orgNames.length) this.orgIdx = 0;
			this.loading = false;
			this.invalidate();
			if (this.orgNames.length > 0) {
				await this.loadCurrentOrg();
			}
			this.tui.requestRender();
		} catch (e) {
			this.fail(e);
		}
	}

	private meOrgPref(): string {
		return this.orgNames[0] ?? '';
	}

	private fail(e: unknown): void {
		this.loading = false;
		this.loadError = e instanceof Error ? e.message : String(e);
		this.invalidate();
		this.tui.requestRender();
	}

	private async loadCurrentOrg(): Promise<void> {
		const name = this.orgNames[this.orgIdx];
		if (!name || this.snap.has(name)) {
			if (name && !this.snap.has(name)) {
				const org = await readOrg(name);
				const tasks = await listTasks(name);
				this.snap.set(name, { org, tasks, loadedAt: nowIso() });
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		try {
			const org = await readOrg(name);
			const tasks = await listTasks(name);
			this.snap.set(name, { org, tasks, loadedAt: nowIso() });
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
		lines.push(L(`── org 任务看板`, th.bold)); // 第 0 行恒静态
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

		// 公司 tab 行（Tab 循环；高亮当前 org）
		const tabRow = this.orgNames
			.map((n, i) => (i === this.orgIdx ? th.selectedBg(` ${n} `) : th.dim(` ${n} `)))
			.join(' ');
		lines.push(L(`Tab公司：${tabRow}`, undefined));

		// 视角 tab（←→ 切换）
		const viewRow = VIEW_TABS.map((v) =>
			v.key === this.view ? th.accent(`[${v.label}]`) : th.dim(` ${v.label} `),
		).join(' ');
		lines.push(L(`视角：${viewRow}`, undefined));

		if (this.view === 'tasks') lines.push(...this.renderTasks(width));
		else if (this.view === 'people') lines.push(...this.renderPeople(width));
		else lines.push(...this.renderSettings(width));

		this.cached(width, lines);
		return lines;
	}

	private cached(width: number, lines: string[]): void {
		// 总行数封顶（防止小终端滚动 fullRender 重影）
		if (lines.length > MAX_TOTAL) {
			this.cachedLines = lines.slice(0, MAX_TOTAL);
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

		const tasks = (snap?.tasks ?? []).filter((t) => t.status === this.taskTabStatus());
		const ranked = this.applyFilterAndSort(tasks);
		if (ranked.length === 0) {
			out.push(L(`（${TASK_TAB_NAMES[this.taskTab]}列表为空）`, th.dim));
			return this.withFooter(
				out,
				`无任务。r 刷新 · 1-4 切状态 · ←→ 切视角 · Tab 切公司 · Esc 关闭`,
				width,
			);
		}
		if (this.selIdx >= ranked.length) this.selIdx = ranked.length - 1;
		if (this.selIdx < 0) this.selIdx = 0;

		const start = Math.max(0, Math.min(this.selIdx, ranked.length - MAX_BODY_LINES));
		const shown = ranked.slice(start, start + MAX_BODY_LINES);
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
			`↑↓ 选择 · Enter 详情 · 1-4 状态 · / 搜索 · r 刷新 · ←→ 视角 · Tab 公司 · Esc 返回/关`,
			width,
		);
	}

	private taskTabStatus(): Task['status'] {
		return (['todo', 'in_progress', 'waiting_accept', 'closed'] as const)[this.taskTab];
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
			todo: '待办',
			in_progress: '进行中',
			waiting_accept: '等待验收',
			closed: '已关闭',
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
		// 子任务与参与者
		const subLines: string[] = [];
		for (const sub of t.subTasks) {
			const dueSub = sub.dueAt || t.dueAt;
			subLines.push(
				L(
					`子 ${sub.id}${dueSub ? `(期望${dueSub.slice(0, 10)})` : ''} ${sub.description}`,
					th.bold,
				),
			);
			for (const a of sub.assignees) {
				const state = this.assigneeLabel(a.status);
				const roundTxt = a.round > 0 ? ` R${a.round}` : '';
				const stopTxt = a.stopped ? ' 停' : '';
				subLines.push(L(`  > ${a.agent}: ${state}${roundTxt}${stopTxt}`, undefined));
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
		// 记录行也计入滚动内容：整体截断到 MAX_BODY_LINES
		const recentHist = t.history.slice(-2);
		if (recentHist.length) {
			subLines.push(
				L(
					`最近: ${recentHist.map((h) => `${h.event}@${h.at.slice(5, 16)}`).join(' · ')}`,
					th.dim,
				),
			);
		}
		const bodyStart = out.length;
		for (const l of subLines) {
			if (out.length - bodyStart >= MAX_BODY_LINES) {
				out.push(L(`…（详情截断，共 ${subLines.length} 行）`, th.dim));
				break;
			}
			out.push(l);
		}

		// 人类操作提示（底部动态区）
		const acts: string[] = [];
		if (t.status === 'waiting_accept' && t.dispatcher === this.meName) {
			acts.push('a 验收通过');
			acts.push('r 打回(输原因后回车)');
		}
		if (t.status !== 'closed') {
			if (t.dispatcher === this.meName || t.dispatcher === this.meName) {
				acts.push('x 取消/关闭(确认)');
			}
		}
		acts.push('Esc 返回');
		return this.withFooter(out, acts.join(' · '), width);
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

	// ── 人员视角 ─────────────────────────────────────────────────────────────

	private renderPeople(width: number): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));
		const snap = this.snap.get(this.orgNames[this.orgIdx]);
		const members = snap?.org.members ?? [];
		const tasks = snap?.tasks ?? [];
		const out: string[] = [];

		if (this.peopleSel) {
			// 该成员名下任务清单屏
			const me = members.find((m) => m.name === this.peopleSel);
			const mine = tasks.filter((t) =>
				t.subTasks.some((s) => s.assignees.some((a) => a.agent === this.peopleSel)),
			);
			const open = mine.filter((t) => t.status !== 'closed');
			const closed = mine.filter((t) => t.status === 'closed');
			out.push(
				L(
					`成员 ${me?.name ?? this.peopleSel} 名下任务（${open.length} 未关闭 / ${mine.length} 总）`,
					th.bold,
				),
			);
			if (this.selIdx >= mine.length) this.selIdx = mine.length - 1;
			if (this.selIdx < 0) this.selIdx = 0;
			const start = Math.max(0, Math.min(this.selIdx, mine.length - MAX_BODY_LINES));
			const rows = [...open, ...closed];
			const shown = rows.slice(start, start + MAX_BODY_LINES);
			for (let i = 0; i < shown.length; i++) {
				const t = shown[i];
				const st = closed.includes(t) ? '关' : this.taskTabStatusOfTask(t);
				out.push(
					L(
						`${start + i === this.selIdx ? '>' : ' '} ${t.id} [${st}] ${t.title}`,
						start + i === this.selIdx ? th.selectedBg : undefined,
					),
				);
			}
			if (rows.length > shown.length) out.push(L(`…共 ${rows.length} 条`, th.dim));
			return this.withFooter(out, `↑↓ 选择 · Enter 任务详情 · Esc 返回成员列表`, width);
		}

		// 成员列表
		out.push(L(`成员（${members.length}）`, th.bold));
		if (members.length === 0) {
			out.push(L('（本 org 尚无成员）', th.dim));
			return this.withFooter(out, `Esc 关闭`, width);
		}
		if (this.selIdx >= members.length) this.selIdx = members.length - 1;
		const start = Math.max(0, Math.min(this.selIdx, members.length - MAX_BODY_LINES));
		for (let i = start; i < Math.min(members.length, start + MAX_BODY_LINES); i++) {
			const m = members[i];
			const cnt = tasks.filter((t) =>
				t.subTasks.some((s) =>
					s.assignees.some(
						(a) =>
							a.agent === m.name &&
							a.status !== 'cancelled' &&
							a.status !== 'rejected',
					),
				),
			).length;
			const who = m.name === this.meName ? '（我）' : '';
			const role = m.role === 'chief' ? '负责人' : '员工';
			out.push(
				L(
					`${i === this.selIdx ? '>' : ' '} ${m.name}${who} · ${role} · 任务${cnt}${m.manifest.label ? ` · ${m.manifest.label}` : ''}`,
					i === this.selIdx ? th.selectedBg : undefined,
				),
			);
		}
		return this.withFooter(
			out,
			`↑↓ 选择 · Enter 看名下任务 · ←→ 视角 · Tab 公司 · Esc 关闭`,
			width,
		);
	}

	private taskTabStatusOfTask(t: Task): string {
		return { todo: '待', in_progress: '进', waiting_accept: '等', closed: '关' }[t.status];
	}

	// ── 设置视角 ─────────────────────────────────────────────────────────────

	private renderSettings(width: number): string[] {
		const th = this.th;
		const L = (s: string, style?: (x: string) => string) =>
			truncateToWidth(style ? style(s) : s, Math.max(8, width));
		const rows: [string, string, () => void][] = [
			[
				`任务排序：${this.prefs.sortNewFirst ? '新→旧' : '旧→新'}`,
				'Enter/→ 切换',
				() => this.togglePref('sortNewFirst'),
			],
			[
				`行尾标注：${this.prefs.annotate ? '开' : '关'}`,
				'Enter/→ 切换',
				() => this.togglePref('annotate'),
			],
		];
		const out: string[] = [];
		out.push(L(`界面设置（存 ${path.join(orgRoot(), '.board.json')}）`, th.bold));
		for (let i = 0; i < rows.length; i++) {
			out.push(
				L(
					`${i === this.selIdx ? '>' : ' '} ${rows[i][0]}  ${th.dim(rows[i][1])}`,
					i === this.selIdx ? th.selectedBg : undefined,
				),
			);
		}
		return this.withFooter(out, `↑↓ 选择 · Enter 切换 · ←→ 视角 · Esc 关闭`, width);
	}

	private async togglePref(key: keyof BoardPrefs): Promise<void> {
		this.prefs[key] = !this.prefs[key];
		await writeJsonAtomic(path.join(orgRoot(), '.board.json'), this.prefs);
		this.selIdx = Math.min(this.selIdx, 1);
		this.refresh();
	}

	private withFooter(out: string[], hint: string, width: number): string[] {
		const th = this.th;
		if (out.length + 2 > MAX_TOTAL) {
			out.splice(MAX_TOTAL - 2, out.length - MAX_TOTAL + 2);
		}
		if (out.length > 0) out.push('─'.repeat(Math.max(0, width)));
		out.push(truncateToWidth(th.muted(hint), Math.max(8, width)));
		return out;
	}

	// ── 键盘 ─────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		// 确认弹层（二次确认）
		if (this.confirm) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === 'y') {
				const c = this.confirm;
				this.confirm = null;
				void this.runAction(c.kind, c.taskId, c.subId, c.agent);
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
				this.selIdx = 0;
				this.refresh();
				return;
			}
			if (data.toLowerCase() === 'a') {
				const t = this.currentTask();
				if (t && t.status === 'waiting_accept' && t.dispatcher === this.meName) {
					this.confirm = { kind: 'approve', taskId: t.id };
					this.refresh();
				}
				return;
			}
			if (data.toLowerCase() === 'r') {
				const t = this.currentTask();
				if (t && t.status === 'waiting_accept' && t.dispatcher === this.meName) {
					this.confirm = { kind: 'return', taskId: t.id };
					this.refresh();
				}
				return;
			}
			if (data.toLowerCase() === 'x') {
				const t = this.currentTask();
				if (t && t.status !== 'closed' && t.dispatcher === this.meName) {
					this.confirm = { kind: 'cancel', taskId: t.id };
					this.refresh();
				}
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
					this.filter = '';
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
				this.filterActive = true;
				this.filter = '';
				this.selIdx = 0;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const t = this.taskUnderCursor();
				if (t) {
					this.detailTaskId = t.id;
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

		// 人员视角
		if (this.view === 'people') {
			if (this.peopleSel) {
				if (matchesKey(data, Key.escape)) {
					this.peopleSel = null;
					this.selIdx = 0;
					this.refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const rows = this.memberRows();
					const t = rows[this.selIdx];
					if (t) {
						this.detailTaskId = t.id;
						this.selIdx = 0;
						this.refresh();
					}
					return;
				}
			} else if (matchesKey(data, Key.enter)) {
				const m = this.snap.get(this.orgNames[this.orgIdx])?.org.members[this.selIdx];
				if (m) {
					this.peopleSel = m.name;
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
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
				const r = ['sortNewFirst', 'annotate'][this.selIdx] as keyof BoardPrefs | undefined;
				if (r) void this.togglePref(r);
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (this.selIdx > 0) this.selIdx--;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (this.selIdx < 1) this.selIdx++;
				this.refresh();
				return;
			}
		}

		// 跨视角：r 刷新 · ←→ 视角 · Tab 公司 · Esc 关闭
		if (data.toLowerCase() === 'r') {
			this.snap.clear();
			void this.loadCurrentOrg();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			if (this.orgNames.length > 1) {
				this.orgIdx = (this.orgIdx + 1) % this.orgNames.length;
				this.detailTaskId = null;
				this.peopleSel = null;
				this.selIdx = 0;
				this.snap.clear();
				void this.loadCurrentOrg();
			}
			return;
		}
		if (matchesKey(data, Key.left)) {
			const order = VIEW_TABS.map((v) => v.key);
			const i = order.indexOf(this.view);
			this.view = order[(i - 1 + order.length) % order.length] as BoardView;
			this.detailTaskId = null;
			this.peopleSel = null;
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
			this.selIdx = 0;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done(null);
		}
	}

	// ── 数据辅助 ─────────────────────────────────────────────────────────────

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

	private memberRows(): Task[] {
		const snap = this.snap.get(this.orgNames[this.orgIdx]);
		const all = snap?.tasks ?? [];
		const mine = all.filter((t) =>
			t.subTasks.some((s) => s.assignees.some((a) => a.agent === this.peopleSel)),
		);
		return [
			...mine.filter((t) => t.status !== 'closed'),
			...mine.filter((t) => t.status === 'closed'),
		];
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
				const { stopped } = approveWithAdoption(t, this.meName, 'TUI 验收');
				await saveTask(t);
				for (const agent of stopped) {
					await deliverMessage(
						orgName,
						agent,
						`[org] 任务 ${t.id} 已完成（采纳了更早的交付），你无需继续。感谢付出。`,
					).catch((e) => log.warn('board approve 通知失败', { err: e }));
				}
				this.hooks.onAction?.(orgName, taskId, 'approve', 'TUI 验收通过');
				this.confirm = null;
			} else if (kind === 'return') {
				attestTask(t, this.meName, 'rejected', 'TUI 打回：请返工（详见任务记录）');
				await saveTask(t);
				this.hooks.onAction?.(orgName, taskId, 'return', 'TUI 打回');
			} else if (kind === 'cancel') {
				cancelTask(t, this.meName, 'TUI 取消');
				await saveTask(t);
				this.hooks.onAction?.(orgName, taskId, 'cancel', 'TUI 取消/关闭');
			}
			await saveTask(t);
			// 同步投影（关闭回写待办 done）
			const { projectTask } = await import('./todoproj.js');
			void projectTask(orgName, taskId).catch((e) => log.warn('board 投影失败', { err: e }));
			// 删除本地缓存强制刷新
			this.snap.delete(orgName);
			this.detailTaskId = null;
			this.selIdx = 0;
			await this.loadCurrentOrg();
			this.refresh();
		} catch (e) {
			this.loadError = e instanceof Error ? e.message : String(e);
			this.confirm = null;
			this.refresh();
		}
	}
}
