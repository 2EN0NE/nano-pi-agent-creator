// org — 目录绑定 agent 框架扩展（装配入口）
// 职责：org 实体（create/join/leave/删除）、多 org 在岗注册、派发（chief 单方 / 非 chief 握手）、
//       任务/子任务/参与者状态机、交付回传与验收（approve/return）、待办投影（07 基础）、inbox 兜底。
// 依赖 control（成员侧需 --session-control 收消息）；org 数据全局 ~/.pi/org/<org名>/。
import { Type } from 'typebox';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@zenone/pi-logger';
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AgentManifest, AgentRole, OrgFile, OrgMember, Task } from './types.js';
import { dirExists, ensureDir, nowIso, readJson, writeJsonAtomic } from './util.js';
import { loadManifest } from './manifest.js';
import { buildDynamicBriefing, buildStaticBriefing } from './briefing.js';
import { wakeMember } from './lifecycle.js';
import {
	createOrg,
	findMemberByDir,
	findOrgsForDir,
	joinOrg,
	leaveOrg,
	renameOrg,
	autoWakeEnabled,
	listOrgNames,
	orgExists,
	readOrg,
	refreshMemberManifest,
	removeOrg,
	runtimeDir,
	runtimeFile,
	withOrgLock,
} from './orgstore.js';
import {
	defaultMemberLaunchArgs,
	manualStartHint,
	orgConfigStore,
	resolveMemberQueueCap,
} from './config.js';
import {
	approveWithAdoption,
	attestTask,
	findMemberOpenWork,
	findOverdue,
	hasOpenAssignment,
	listTasks,
	markOverdue,
	queueLengthFor,
	readTask,
	// 聚合状态刷新（`task.status`）与本地状态栏函数同名 → 别名区分：前者改账本，后者改终端状态栏
	refreshStatus as refreshTaskStatus,
	saveTask,
	transitionAssignee,
} from './task.js';
import {
	cancelTaskByDispatcher,
	consentCancel,
	deliverMessage,
	dispatchTask,
	reassignSubTask,
	retrySubTask,
} from './dispatch.js';
import { isSocketAlive } from './util.js';
import { projectTask, reconcileOrg } from './todoproj.js';
import { collectStartupNotes, pendingHandshakeNote } from './startup.js';
import { OrgBoard } from './board.js';
import {
	CONTROL_SOCKET_EVENT,
	type ControlSocketPayload,
	decideDutyAction,
	dutyState,
	isSelfOnDuty,
	offDutyReason,
	offDutyStatusText,
	onDutyRefusal,
	sessionSocketDir,
} from './onduty.js';
import { applyOrgCapability } from './capability.js';
import { countOrgStatus, formatOrgStatus } from './statusbar.js';
import {
	DIR_MISSING_WORD,
	inspectMembers,
	PRESENCE_POLL_MS,
	PRESENCE_WORDS,
	isPidAlive,
	readRuntime,
} from './presence.js';
import { ACTIVITY_FAIL_TEXT, interruptMember } from './activity.js';
import { commitInboxFlush, planContent, planInboxFlush } from './inbox.js';
import {
	claimSlot,
	readSlot,
	reconcileSlot,
	releaseSlot,
	releaseSlotIfStale,
	resolveAbandonedReleaseAfterMs,
} from './slot.js';
import { preemptMember } from './preempt.js';

const log = createLogger('org');

/**
 * 本扩展自带的技能目录（随扩展目录整体同步；不再声明 `pi.skills` 装进全局 `skills/`）。
 * 运行时按 `import.meta.url` 定位自身所在目录——`/reload` 后仍指向当前加载的文件。
 */
function ownSkillsDir(): string {
	try {
		return path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
	} catch {
		return '';
	}
}

interface MeState {
	dir: string;
	manifest: AgentManifest | null;
	/** 我加入的全部 org 及其成员身份 */
	orgs: { org: OrgFile; member: OrgMember }[];
}

export default function (pi: ExtensionAPI) {
	const respond = async (text: string): Promise<void> => {
		pi.sendMessage({ customType: 'org', content: text, display: true }, { triggerTurn: false });
	};

	/**
	 * 面向人的提示（ADR-0047 D2）：**不进 LLM 上下文**。
	 * 有 UI → `ui.notify`（TUI toast）；无 UI（print / 脚本 / CI）→ 回落 `respond`，信息不丢。
	 */
	const notifyHuman = async (ctx: ExtensionCommandContext, text: string): Promise<void> => {
		if (ctx.hasUI) {
			ctx.ui.notify(text, 'info');
			return;
		}
		await respond(text);
	};

	/**
	 * 显式唤醒的**唯一实现**（ADR-0048 `D3`–`D6`）：agent 工具与 `/org wake` 命令共用同一实现与文案。
	 *
	 * 门禁：该组织「自动唤醒」关闭 ⇒ **拒绝**（并给出两条出路）——开关是自主/命令唤醒的总门；
	 * 权限：限该 org 负责人（ADR-0040 `D2`）；拒绝时**据实说明**，不静默隐藏（静默会让 agent
	 * 无从知晓、转而自行发明路径——正是那次 UAT 的失败模式）。
	 */
	async function wakeForCaller(orgName: string, member: string): Promise<string> {
		const file = await readOrg(orgName).catch(() => null);
		if (!file) return `[org] 组织「${orgName}」不存在或读取失败。`;
		const me = await resolveSelf();
		const mine = me.orgs.find((o) => o.org.name === orgName);
		if (!mine) {
			log.info('显式唤醒被拒：调用者不在该组织', { org: orgName, member, caller: me.dir });
			return `[org] 你不在组织「${orgName}」中，无法唤醒其成员。`;
		}
		if (file.chiefName !== mine.member.name) {
			log.info('显式唤醒被拒：非负责人', { org: orgName, member, caller: mine.member.name });
			return `[org] 未唤醒 ${member}：唤醒权限限本 org 负责人（本组织负责人是 ${file.chiefName}）。`;
		}
		if (!autoWakeEnabled(file)) {
			log.info('显式唤醒被拒：门禁关闭（autoWake 关）', { org: orgName, member });
			return (
				`[org] 未唤醒 ${member}：本组织「自动唤醒」已关（该开关是自主/命令唤醒的总门）。` +
				`可请人类在 /org 看板 → 设置页开启「自动唤醒」，或在成员视角对 ${member} 按 w 当面唤醒。`
			);
		}
		const res = await wakeMember(orgName, member, { selfDir: process.cwd() });
		log.info('显式唤醒结果', {
			org: orgName,
			member,
			started: res.started,
			skipped: res.skipped ?? null,
			error: res.error ?? null,
		});
		// 06：唤醒返回前已校验「起来没有」——成功要区分在岗/尚在启动，失败带原因
		if (res.started) {
			// 07：降级过一次也要说清楚（只影响本次拉起，成员记录未被改写）
			const degraded = res.degradedFrom?.length
				? `注意：${res.degradedFrom.join(' ')} 未被该成员环境识别，本次已忽略后启动（成员记录未改）。`
				: '';
			return (
				(res.online
					? `[org] 已唤醒 ${member}（已在岗）。`
					: `[org] 已唤醒 ${member}（进程已拉起，尚在启动；可 tmux attach -t ${res.sessionName} 观察）。`) +
				degraded
			);
		}
		if (res.skipped === 'online') return `[org] ${member} 已在岗，无需唤醒。`;
		if (res.skipped === 'session-exists')
			return `[org] ${member} 正在拉起中（终端会话已存在），已跳过。`;
		if (res.skipped === 'self')
			return '[org] 不能唤醒自己所在的目录（一目录 = 一名成员的在岗进程）。';
		return `[org] 未唤醒 ${member}：${res.error ?? '未知原因'}`;
	}

	/**
	 * 中断成员的**当前轮次**（ADR-0053）——工具面与命令面共用的**唯一实现**。
	 *
	 * - 权限：`caller === 'agent'`（`org_abort` 工具）时**仅该 org 负责人**（与唤醒同口径，
	 *   ADR-0048 `D5`）；`caller === 'human'`（`/org abort` 命令）时**不校验负责人**——命令面
	 *   属人类操作台（ADR-0041 `D3`「人类操作台永远可用」、ADR-0053 `D2`、CONTEXT「中断」词条）；
	 * - 门禁：**不受**「自动唤醒」约束——中断是"停"不是"起"（ADR-0053 `D6`）；
	 * - 语义：只停当前轮，进程 / 会话 / 记忆都保留，随后可继续派活或重试；
	 * - 据实回报：不在岗、成员不存在、进程版本旧、超时，都说明原因，**绝不假装成功**（`D7`）。
	 */
	async function interruptForCaller(
		orgName: string,
		member: string,
		caller: 'agent' | 'human',
	): Promise<string> {
		const file = await readOrg(orgName).catch(() => null);
		if (!file) return `[org] 组织「${orgName}」不存在或读取失败。`;
		const me = await resolveSelf();
		const mine = me.orgs.find((o) => o.org.name === orgName);
		if (!mine) return `[org] 你不在组织「${orgName}」中，无法中断其成员。`;
		if (caller === 'agent' && file.chiefName !== mine.member.name) {
			return `[org] 未中断 ${member}：中断权限限本 org 负责人（本组织负责人是 ${file.chiefName}）。`;
		}
		if (!file.members.some((m) => m.name === member)) {
			return `[org] 成员 ${member} 不在组织「${orgName}」中。`;
		}
		const socketPath = (await readRuntime(orgName, member))?.socketPath;
		if (!socketPath) {
			log.info('中断跳过：成员不在岗', { org: orgName, member });
			return `[org] ${member} 不在岗（无需中断）。`;
		}
		const res = await interruptMember(socketPath);
		if (res.ok) {
			// ADR-0053 `D4`：留痕"谁（人类 / 哪个 agent）对谁做了什么"——命令面 = human，工具面 = agent
			log.info('中断成员当前轮', { org: orgName, member, by: caller });
			return `[org] 已中断 ${member} 的当前轮（进程与会话保留，可继续派活或重试）。`;
		}
		log.warn('成员中断失败', { org: orgName, member, reason: res.reason });
		return `[org] 未中断 ${member}：${ACTIVITY_FAIL_TEXT[res.reason]}。`;
	}

	/**
	 * 成员关系变更（create / join）后的**统一后置动作**：在岗则补工具 + 重装简报；
	 * 未在岗则据实告知出路（走面人通道，不进上下文）。
	 */
	async function afterMembershipChange(ctx: ExtensionCommandContext): Promise<void> {
		if (onDutyActive) {
			ensureOrgTools();
			rearmBriefing();
			await respond(SKILLS_RELOAD_HINT);
		} else {
			await notifyHuman(
				ctx,
				`[org] 注意：${offDutyReason()}——org 工具、在岗简报与状态栏在本进程不可用。`,
			);
		}
	}

	/**
	 * 会话中途 create/join 的技能提示：`resources_discover` 只在 session_start 后触发一次，
	 * 本会话已加载技能不会因中途加入而新增——静态简报里的技能指路要重启后才可 `read`。
	 */
	const SKILLS_RELOAD_HINT =
		'[org] 提示：org 技能（org-chief / org-member / org-recover）将在下次启动或 /reload 后随会话加载。';

	// ── 在岗能力门控（ADR-0041 D2）：org 工具仅在岗注册 ──────────────────────
	let toolsRegistered = false;
	function ensureOrgTools(): void {
		if (toolsRegistered) return;
		toolsRegistered = true;
		registerOrgTools();
	}

	// ── 在岗简报（ADR-0042）──────────────────────────────────────────────────
	/** 静态块（进系统提示）：会话内恒定 → 系统提示逐轮一致 → prompt cache 稳定 */
	let staticBriefing = '';
	/** 动态块的作用对象（在岗注册时确定；未在岗为空） */
	let briefingTargets: { org: string; member: string; role: AgentRole }[] = [];

	/** 装配简报：静态块缓存为字符串；动态块每轮现算（只读）。 */
	async function armBriefing(me: MeState): Promise<void> {
		briefingTargets = me.orgs.map(({ org, member }) => ({
			org: org.name,
			member: member.name,
			role: member.role,
		}));
		const blocks: string[] = [];
		for (const { org, member } of me.orgs) {
			blocks.push(
				buildStaticBriefing({
					org: org.name,
					memberName: member.name,
					role: member.role,
					// 简介**实时**读自成员目录的 pi.agent.json（只读不写回）— ADR-0042 D6③
					description: me.manifest?.description ?? member.manifest.description,
					background: org.background,
				}),
			);
		}
		staticBriefing = blocks.join('\n\n');
	}

	/** 加入组织后重装简报（失败只记日志，不打断会话） */
	function rearmBriefing(): void {
		void (async () => {
			try {
				await armBriefing(await resolveSelf());
			} catch (e) {
				log.warn('在岗简报装配失败', { err: e instanceof Error ? e.message : String(e) });
			}
		})();
	}

	/**
	 * 离开 / 删除 / 改名 org 后刷新在岗简报（ADR-0042）。
	 * 简报是会话级缓存：不重装会让本进程继续注入已离开/已改名组织的静态块，
	 * 动态块则每轮读旧名失败。仅在本进程在岗时执行（门控，ADR-0041 D2）。
	 */
	function refreshBriefingIfOnDuty(): void {
		if (!onDutyActive) return;
		rearmBriefing();
	}

	/** 惰性催办（ADR-0039 D）：处理人侧 org 操作后提示仍未决的握手（无则不打扰） */
	async function remindPendingHandshakes(orgName: string, memberName: string): Promise<void> {
		// ADR-0047 D3：面向模型的卡片只在岗时发（离岗会话不该把 org 卡片塞进上下文）
		if (!onDutyActive) return;
		try {
			const note = await pendingHandshakeNote(orgName, memberName);
			if (!note) return;
			pi.sendMessage(
				{ customType: 'org-handshake', content: note, display: true },
				{ triggerTurn: false },
			);
		} catch (e) {
			log.warn('握手惰性催办失败', {
				org: orgName,
				err: e instanceof Error ? e.message : String(e),
			});
		}
	}

	function textResult(text: string, details: Record<string, unknown>) {
		return { content: [{ type: 'text' as const, text }], details };
	}

	// ── 身份：当前目录 agent 在哪些 org、以什么名字/角色 ─────────────────────
	async function resolveSelf(): Promise<MeState> {
		const dir = process.cwd();
		const manifest = await loadManifest(dir);
		const orgs: MeState['orgs'] = [];
		const found = await findOrgsForDir(dir);
		for (const org of found) {
			const member = await findMemberByDir(org, dir);
			if (member) orgs.push({ org, member });
		}
		return { dir, manifest, orgs };
	}

	function meName(member: OrgMember): string {
		return member.manifest.label && member.manifest.label !== member.name
			? `${member.manifest.label}（${member.name}）`
			: member.name;
	}

	/** 命令的 org 上下文：rest 首项若是本机 org 名则消费之；否则取我唯一所属；再否则抛错 */
	async function pickOrg(
		me: MeState,
		rest: string[],
	): Promise<{ orgName: string; rest: string[] }> {
		if (rest.length > 0 && (await orgExists(rest[0]))) {
			return { orgName: rest[0], rest: rest.slice(1) };
		}
		if (me.orgs.length === 1) return { orgName: me.orgs[0].org.name, rest };
		if (me.orgs.length === 0) {
			throw new Error(
				'本目录未加入任何 org。先 /org create <org名>（负责人）或 /org join <org名>。',
			);
		}
		throw new Error(
			`本目录加入了多个 org（${me.orgs.map((o) => o.org.name).join('、')}），请指定要操作的 org：在命令首参传入 org 名。`,
		);
	}

	async function memberNames(orgName: string): Promise<string[]> {
		const org = await readOrg(orgName);
		return org.members.map((m) => m.name);
	}

	// ── 在岗注册（多 org）────────────────────────────────────────────────────
	async function registerRuntime(me: MeState, sessionId: string, busy: boolean): Promise<void> {
		if (!sessionId) return;
		const socketPath = path.join(sessionSocketDir(), `${sessionId}.sock`);
		const now = nowIso();
		for (const { org, member } of me.orgs) {
			await ensureDir(runtimeDir(org.name));
			await writeJsonAtomic(runtimeFile(org.name, member.name), {
				schemaVersion: 1,
				name: member.name,
				dir: me.dir,
				pid: process.pid,
				socketPath,
				sessionId,
				busy,
				startedAt: now,
				updatedAt: now,
			});
		}
	}

	async function clearRuntime(me: MeState): Promise<void> {
		for (const { org, member } of me.orgs) {
			await readJson(runtimeFile(org.name, member.name))
				.then(() => import('node:fs/promises'))
				.then((fs) => fs.unlink(runtimeFile(org.name, member.name)).catch(() => {}))
				.catch(() => {});
		}
	}

	async function setBusyAll(me: MeState | null, busy: boolean): Promise<void> {
		if (!me) return;
		for (const { org, member } of me.orgs) {
			const file = runtimeFile(org.name, member.name);
			const rt = await readJson<{ busy: boolean }>(file);
			if (rt) {
				await writeJsonAtomic(file, { ...rt, busy, updatedAt: nowIso() });
			}
		}
	}

	// ── 在岗状态机（ADR-0043 D2/D4 → 修订：ADR-0046 D1/D2/D4）────────────────
	/**
	 * 本进程当前是否在岗（org 能力已放）——**由 org 自决**（ADR-0046 D1）。
	 *
	 * 「socket 可连」只是**必要条件**（ADR-0046 D2），不构成上岗；上岗时机有两条：
	 * ① 启动时 socket 已然可连 → 自动上岗（跟随启动 flag 的启动意图，ADR-0046 D4）；
	 * ② 会话内显式 `/org on`（或看板设置行 / `o` 键）。运行中 `/control on` **不再**触发上岗。
	 */
	let onDutyActive = false;
	/** 必要条件现状：「可上岗」= control 的 socket 可连。由 session_start 探测 + 广播维护 */
	let socketUp = false;

	/**
	 * 「可上岗」判定的**唯一实现**（ADR-0046 D2）：探测本会话控制 socket 是否**真的可连**。
	 * session_start 的启动探测与 `/org on` 的必要条件复核都走这里，避免两份判定漂移。
	 * （`control:socket` 事件不走探测——它本身就是 control 广播来的物理真相。）
	 */
	async function probeSocketUp(ctx: ExtensionContext): Promise<boolean> {
		socketUp = await isSelfOnDuty(ctx.sessionManager.getSessionId() ?? '');
		return socketUp;
	}
	/** 最近一次 session_start 的 ctx（事件回调用；尚未 start 时不动作） */
	let liveCtx: ExtensionContext | null = null;

	/** 上岗时刻：自愈触发有启动宽限期，避免与"上线补投"重复触发（ADR-0054 `D4`） */
	let onDutyAt = 0;
	/** 本会话是否正在跑一轮：自愈只在空闲时触发，绝不打断在跑的轮次 */
	let turnInFlight = false;
	/** 巡检节拍：执行槽每拍对账，期限扫描降频（省 I/O） */
	let patrolTicks = 0;
	/** 宽限期防抖只留痕一次（ADR-0054 `D8`：防抖跳过也要可查，但不能每拍刷屏） */
	let selfHealGraceLogged = false;
	/** 状态栏轮询定时器（只在岗期间跑） */
	let statusTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * 刷新状态栏 `|org: x/y/z成员`（ADR-0043 D3）。
	 * 只读巡检（不唤醒、不清理）→ 守 ADR-0040 D4「感知不写副作用」。
	 * 多 org 时取第一个（落地选择：单段显示"当前 org"，见 ADR-0043 待定项①）。
	 */
	async function refreshStatus(): Promise<void> {
		const ctx = liveCtx;
		if (!ctx) return;
		const me = await resolveSelf();
		const first = me.orgs[0];
		if (!first) return;
		// 状态栏只关心「在岗 / 忙」：交付态不影响计数 → tasks 传空数组，省一次账本读
		const presences = await inspectMembers(
			first.org.name,
			first.org.members.map((m) => m.name),
			[],
		);
		const counts = countOrgStatus([...presences.values()].map((p) => p.state));
		ctx.ui.setStatus(
			'org',
			formatOrgStatus(counts, (tone, text) => {
				if (tone === 'busy') return ctx.ui.theme.fg('accent', text);
				if (tone === 'dim') return ctx.ui.theme.fg('dim', text);
				return text;
			}),
		);
	}

	/**
	 * 三态状态栏（ADR-0046 D2）：不可上岗 / 可上岗（待上岗）/ 在岗。
	 *
	 * 这是 org **唯一**面向人的「未上岗 / 不可上岗」告知通道——原先用 `pi.sendMessage`
	 * 发 `org-off-duty` 卡片，会被 pi 的 `convertToLlm` 转成 `role:"user"` 污染上下文（ADR-0047）。
	 */
	async function renderDutyStatus(): Promise<void> {
		const ctx = liveCtx;
		if (!ctx) return;
		if (onDutyActive) {
			await refreshStatus(); // 在岗：|org: x/y/z成员
			return;
		}
		const me = await resolveSelf();
		const text = offDutyStatusText({ orgCount: me.orgs.length, socketUp });
		ctx.ui.setStatus('org', ctx.ui.theme.fg('dim', text));
	}

	function stopStatusTimer(): void {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = null;
	}

	function startStatusTimer(): void {
		if (statusTimer) return;
		void refreshStatus().catch(() => {});
		statusTimer = setInterval(() => {
			void refreshStatus().catch(() => {});
			void selfHealInbox().catch(() => {});
			void patrolOnce().catch(() => {});
		}, PRESENCE_POLL_MS);
		statusTimer.unref?.(); // 不阻止进程退出
	}

	/** 自愈的启动宽限期：给"上线补投"留出时间，避免同一批消息触发两次（ADR-0054 `D4`） */
	const SELF_HEAL_GRACE_MS = 15_000;
	/** 期限扫描降频：每 N 拍一次（执行槽对账则每拍都做） */
	const PATROL_DEADLINE_EVERY = 15;

	/**
	 * 在岗自愈（ADR-0054 `D4`）：在岗 + 空闲 + 收件箱有**未注入过**的内容 → 消化并起一轮。
	 *
	 * 为什么需要：启动窗口与运行期落进收件箱的消息，旧实现里**没有消化者**（takeInbox 只在上岗那一刻跑一次），
	 * 成员于是永远不知道有事——这正是 UAT 里"唤醒后一直待领取"的另一半。
	 */
	async function selfHealInbox(): Promise<void> {
		if (!onDutyActive || turnInFlight) return;
		if (Date.now() - onDutyAt < SELF_HEAL_GRACE_MS) {
			// D8：防抖跳过也要留痕（原因可查），但每会话只记一次，避免每拍刷屏
			if (!selfHealGraceLogged) {
				selfHealGraceLogged = true;
				log.info('在岗自愈跳过', {
					reason: 'grace',
					triggered: false,
					graceMs: SELF_HEAL_GRACE_MS,
				});
			}
			return;
		}
		if (!liveCtx) return;
		const me = await resolveSelf();
		if (me.orgs.length === 0) return;
		const targets = me.orgs.map(({ org, member }) => ({ org: org.name, agent: member.name }));
		const plan = await planInboxFlush(targets);
		if (plan.total === 0) {
			// 本批没有「未注入过」的内容，但可能有**已注入未 ack** 的残留（`commitInboxFlush`
			// 在写簿记与删除之间中断）或事件去重的重复项。旧口径只问「有没有 fresh」（`hasFreshInbox`），
			// 这些残留就永远不归零（`inbox N` 计数与简报内容清单长期不消失、每轮重复出现）。
			// 有残留 → 只清账（commit），**不起轮次**。
			const cleanup = plan.entries.some((e) => e.replay.length > 0 || e.deduped.length > 0);
			if (cleanup) await commitInboxFlush(plan);
			// 无内容 = 正常空闲：用 debug 留痕（默认 info 级不刷屏），需要排障时开 debug 即可查
			log.debug('在岗自愈跳过', {
				reason: cleanup ? 'deduped' : 'empty',
				triggered: false,
				targets: targets.map((t) => `${t.org}/${t.agent}`),
			});
			return;
		}
		try {
			pi.sendMessage(
				{
					customType: 'org-inbox',
					content: `[org] 你不在岗期间收到 ${plan.total} 条任务消息：\n${planContent(plan)}`,
					display: true,
				},
				{ triggerTurn: true },
			);
			await commitInboxFlush(plan);
			log.info('在岗自愈触发', {
				members: targets.map((t) => `${t.org}/${t.agent}`),
				count: plan.total,
				triggered: true,
				reason: 'fresh',
			});
		} catch (e) {
			log.warn('在岗自愈注入失败，消息保留待下次', {
				err: e instanceof Error ? e.message : String(e),
			});
		}
	}

	/**
	 * 释放在任务侧已失效的执行槽（ADR-0055 `D2`）。
	 *
	 * 只处理**本进程**持有、且槽指向的任务/子任务上已无在手工作的槽：取消 / 叫停（`stopped`）/
	 * 改派移出 / 任务关闭都会让成员脱离非终态，槽若不释放，「一次只做一件」会把它永久挡住
	 * （`reconcileSlot` 因本进程存活永远判 held，救不回来）。
	 */
	async function releaseStaleSlotFor(orgName: string, memberName: string): Promise<boolean> {
		return releaseSlotIfStale(orgName, memberName, async (record) => {
			const task = await readTask(orgName, record.taskId);
			// 任务账本已不存在 → 槽必失效；否则看该成员在槽指向的子任务上是否还有在手工作
			if (!task) return false;
			return hasOpenAssignment(task, memberName, record.subTaskId);
		});
	}

	/**
	 * 巡检（ADR-0055）：执行槽保守对账（每拍）+ 逾期标记与通知（降频）。
	 *
	 * 逾期动作（人类裁定 `D3`）= **标记逾期 + 通知派发人与人类，不自动回落**；
	 * 通知以 `[evt:overdue:<task>:<sub>:<agent>]` 为稳定 id，接收侧据此去重（ADR-0054 `D10`）。
	 *
	 * 逾期扫描拿 per-org 写锁串行化：巡检在**每个在岗成员进程**里都会跑，而「读账本 → 查重 →
	 * 写历史 → 通知」不是原子的——两个进程若在任一 `saveTask` 前都读到未标记状态，会各发一次
	 * 提醒（在线投递带 `triggerTurn`，派发人会被重复唤醒处理同一件逾期）。
	 */
	async function patrolOnce(): Promise<void> {
		if (!onDutyActive) return;
		const me = await resolveSelf();
		if (me.orgs.length === 0) return;
		// 僵尸槽回收阈值（`false`=禁用；数值钳位 5min–24h）
		const abandoned = resolveAbandonedReleaseAfterMs(
			orgConfigStore.get().abandonedSlotReleaseAfterMs,
		);
		patrolTicks += 1;
		const scanDeadlines = patrolTicks % PATROL_DEADLINE_EVERY === 0;
		for (const { org, member } of me.orgs) {
			try {
				for (const m of org.members) {
					const res = await reconcileSlot(org.name, m.name, {
						abandonedAfterMs: abandoned,
					});
					if (res.state === 'reclaimed') {
						log.warn('执行槽回收', {
							org: org.name,
							member: m.name,
							reason: res.reason,
						});
						continue;
					}
					if (res.state === 'held') await releaseStaleSlotFor(org.name, m.name);
				}
				if (!scanDeadlines) continue;
				await withOrgLock(org.name, async () => {
					const tasks = await listTasks(org.name);
					for (const entry of findOverdue(tasks)) {
						if (!markOverdue(entry)) continue;
						await saveTask(entry.task);
						const evtId = `overdue:${entry.task.id}:${entry.sub.id}:${entry.assignee.agent}`;
						log.info('任务逾期', {
							org: org.name,
							task: entry.task.id,
							sub: entry.sub.id,
							agent: entry.assignee.agent,
							dueAt: entry.dueAt,
						});
						if (entry.task.dispatcher !== member.name) {
							await deliverMessage(
								org.name,
								entry.task.dispatcher,
								`[evt:${evtId}] [org:system] 任务 ${entry.task.id} 的 ${entry.sub.id} 已逾期（期望完成时间 ${entry.dueAt}，处理人 ${entry.assignee.agent}）。请决定：催办 / 打回 / 改派。`,
							).catch((e: unknown) => {
								// ADR-0047「不静默」：逾期事实已入 history，但"通知派发人失败"若不留痕就不可查
								log.warn('逾期通知派发人失败', {
									org: org.name,
									task: entry.task.id,
									sub: entry.sub.id,
									dispatcher: entry.task.dispatcher,
									err: e instanceof Error ? e.message : String(e),
								});
								return 'unreachable' as const;
							});
						}
						liveCtx?.ui.notify(
							`org ${org.name}：任务 ${entry.task.id}/${entry.sub.id} 逾期（处理人 ${entry.assignee.agent}）`,
							'warning',
						);
					}
				});
			} catch (e) {
				log.warn('巡检异常', {
					org: org.name,
					err: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}

	// ── 生命周期事件 ─────────────────────────────────────────────────────────
	pi.on('session_start', async (_event, ctx) => {
		liveCtx = ctx;
		const sessionId = ctx.sessionManager.getSessionId() ?? '';
		// 必要条件：control 的 socket 真的可连（ADR-0043 D2 的判据，ADR-0046 D2 降为前置条件）。
		// 启动瞬间就已然可连 ⇒ 只可能是「跟随启动 flag」建的 socket（运行中人工 /control on
		// 必然发生在此之后）⇒ 按 ADR-0046 D4 自动上岗；否则等人工 /org on。
		socketUp = await probeSocketUp(ctx);
		if (!socketUp) {
			log.info('未上岗：控制 socket 不可连（等待 /control on 或直接 /org create）', {
				sessionId,
				cwd: process.cwd(),
			});
			await renderDutyStatus(); // 告知走状态栏（ADR-0047 D1）
			return;
		}
		await goOnDuty(ctx);
	});

	/**
	 * 上岗 / 离岗的**唯一实现**（ADR-0046 D3）：`/org on|off` 命令与看板（设置行 + `o` 键）共用。
	 *
	 * 上岗前用 socket **真相**复核必要条件（不信缓存），失败时说明出路——不静默、不半上岗。
	 * 面向人的结果回报走 `ui.notify` / 命令回复（ADR-0047 D1），不发消息卡片。
	 */
	async function setDuty(
		on: boolean,
		ctx: ExtensionContext,
	): Promise<{ ok: boolean; message: string }> {
		const me = await resolveSelf();
		if (!on) {
			if (!onDutyActive) return { ok: true, message: '本会话不在岗（无需离岗）' };
			await goOffDuty();
			await renderDutyStatus();
			log.info('离岗（/org off）');
			return { ok: true, message: '已离岗：org 工具与在岗简报已收回' };
		}
		if (onDutyActive) return { ok: true, message: '本会话已在岗' };
		// 必要条件复核（ADR-0046 D2）：socket 真的可连，否则明确拒绝并给出出路
		socketUp = await probeSocketUp(ctx);
		const refusal = onDutyRefusal({ orgCount: me.orgs.length, socketUp });
		if (refusal) {
			await renderDutyStatus();
			return { ok: false, message: refusal };
		}
		await goOnDuty(ctx);
		log.info('上岗（/org on）', { sessionId: ctx.sessionManager.getSessionId() });
		return {
			ok: true,
			// org 技能由 resources_discover 在 session_start / reload 时贡献，运行中 /org on 拿不到 → 显式告知（与 create/join 同口径）
			message: `已在岗：org 工具、在岗简报与状态栏计数已生效。${SKILLS_RELOAD_HINT}`,
		};
	}

	/** 进入在岗：放能力 + 写在岗注册 + 装简报 + 补投未在岗期间的消息 + 启动骨架 */
	async function goOnDuty(ctx: ExtensionContext): Promise<void> {
		const me = await resolveSelf();
		if (me.orgs.length === 0) return; // 本目录未加入任何 org
		if (onDutyActive) return; // 幂等：重复事件不重复注册
		onDutyActive = true;
		ensureOrgTools();
		applyOrgCapability(pi, true);
		const sessionId = ctx.sessionManager.getSessionId();
		await registerRuntime(me, sessionId ?? '', false);

		// ticket 06①：在岗注册时把自己的简档快照写回 org.json
		// （成员自己的启动动作，不是感知循环 → 不违反 ADR-0040 D4）
		for (const { org } of me.orgs) {
			await refreshMemberManifest(org.name, me.dir, {
				label: me.manifest?.label,
				description: me.manifest?.description,
			});
		}
		onDutyAt = Date.now();
		selfHealGraceLogged = false;
		turnInFlight = false;
		await armBriefing(me);

		// 上线补投（ADR-0054 `D3`/`D11`）：先算（只读）→ 注入成功 → 才记账与删除。
		// 顺序不能颠倒：旧实现「先删后注入」在注入失败时会永久丢消息。
		// 有可执行内容（收件箱非空或存在启动提醒）才 `triggerTurn` —— 唤醒即可工作。
		const plan = await planInboxFlush(
			me.orgs.map(({ org, member }) => ({ org: org.name, agent: member.name })),
		);
		const chunks: string[] = [];
		if (plan.total > 0) {
			chunks.push(`[org] 你不在岗期间收到 ${plan.total} 条任务消息：\n${planContent(plan)}`);
		}
		log.info('在岗注册', {
			orgs: me.orgs.map((o) => `${o.org.name}:${o.member.name}:${o.member.role}`),
			pid: process.pid,
			sessionId,
		});

		// 会话启动骨架（07 · ADR-0039）：对账 issues（启动层触发）+ 未决握手惰性催办
		const noteLines: string[] = [];
		try {
			for (const { org, member } of me.orgs) {
				noteLines.push(...(await collectStartupNotes(org.name, member.name)));
			}
		} catch (e) {
			log.warn('启动骨架异常', { err: e instanceof Error ? e.message : String(e) });
		}
		if (noteLines.length > 0) chunks.push(`[org] 启动提醒\n${noteLines.join('\n')}`);

		if (chunks.length > 0) {
			try {
				pi.sendMessage(
					{ customType: 'org-inbox', content: chunks.join('\n\n'), display: true },
					{ triggerTurn: true },
				);
				await commitInboxFlush(plan); // 注入成功才记账 + 删除（`D11`）
				log.info('上线补投触发', {
					members: me.orgs.map((o) => `${o.org.name}/${o.member.name}`),
					count: plan.total,
					triggered: true,
					reason: plan.total > 0 ? 'fresh' : 'startup-notes',
				});
			} catch (e) {
				log.warn('上线补投注入失败，消息保留待下次', {
					err: e instanceof Error ? e.message : String(e),
				});
			}
		} else {
			log.debug('上线补投跳过', {
				members: me.orgs.map((o) => `${o.org.name}/${o.member.name}`),
				count: 0,
				triggered: false,
				reason: 'empty',
			});
		}
		startStatusTimer();
	}

	/** 离开在岗：收能力 + 清在岗注册 + 卸简报 + 清状态栏（ADR-0043 D4 的"收回路径"） */
	async function goOffDuty(): Promise<void> {
		if (!onDutyActive) return;
		onDutyActive = false;
		applyOrgCapability(pi, false);
		stopStatusTimer();
		liveCtx?.ui.setStatus('org', undefined);
		// 简报是会话级缓存：卸掉，避免离岗后仍注入已离岗组织的静态块
		staticBriefing = '';
		briefingTargets = [];
		const me = await resolveSelf();
		if (me.orgs.length > 0) await clearRuntime(me);
		// 离岗即释放执行槽：否则"幽灵在跑"会一直占着队列与上限（ADR-0055 `D2`）
		for (const { org, member } of me.orgs) {
			const slot = await readSlot(org.name, member.name);
			if (slot && slot.pid === process.pid) {
				await releaseSlot(org.name, member.name, slot.token);
			}
		}
	}

	// control 的 socket 状态变化 → 只刷新「可上岗性」；是否上岗由 org 自决（ADR-0046 D1）
	pi.events.on(CONTROL_SOCKET_EVENT, (data: unknown) => {
		const e = data as ControlSocketPayload | undefined;
		if (!e || typeof e.enabled !== 'boolean') return;
		const ctx = liveCtx;
		if (!ctx) return; // 会话尚未 start：由 session_start 的探测兜底
		socketUp = e.enabled;
		if (e.origin === undefined) {
			// 缺字段按 runtime 处理：宁可不自动上岗，也不退回「control 驱动 org」
			log.warn('control 广播缺 origin 字段，按 runtime 处理（不自动上岗）', {
				enabled: e.enabled,
			});
		}
		// 判定与副作用分离（纯函数 decideDutyAction，单测锁三条铁律）：
		// 必要条件丢失 → 强制回落；启动意图 → 自动上岗；运行中人工切换 → 只到「可上岗」
		const action = decideDutyAction(e, onDutyActive);
		void (async () => {
			if (action === 'go-off-duty') {
				log.warn('控制 socket 关闭 → 强制离岗（必要条件丢失）');
				await goOffDuty();
			} else if (action === 'go-on-duty') {
				await goOnDuty(ctx);
				return; // 上岗路径自会起状态栏轮询
			}
			await renderDutyStatus();
		})().catch((err: unknown) => {
			log.warn('在岗状态切换失败', { err: err instanceof Error ? err.message : String(err) });
		});
	});

	// 静态块：恒定追加进系统提示（会话内不变，cache 稳定）— ADR-0042 D2
	pi.on('before_agent_start', (event) => {
		if (!staticBriefing) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${staticBriefing}` };
	});

	// 动态块：追在每个用户轮次尾部（随用户消息持久化 → 不破坏前缀缓存）— ADR-0042 D3
	pi.on('input', async (event) => {
		if (briefingTargets.length === 0) return { action: 'continue' as const };
		if (event.streamingBehavior === 'steer') return { action: 'continue' as const };
		if (event.text.trimStart().startsWith('/')) return { action: 'continue' as const };
		try {
			const blocks: string[] = [];
			for (const t of briefingTargets) {
				blocks.push(await buildDynamicBriefing(t.org, t.member));
			}
			if (blocks.length === 0) return { action: 'continue' as const };
			return {
				action: 'transform' as const,
				text: `${event.text}\n\n${blocks.join('\n\n')}`,
			};
		} catch (e) {
			log.warn('在岗简报动态块生成失败', { err: e instanceof Error ? e.message : String(e) });
			return { action: 'continue' as const };
		}
	});

	// 技能门控：org 技能不再全局安装，**仅在岗时**按角色贡献（ADR-0041 D2 / ADR-0042 D4）
	pi.on('resources_discover', () => {
		if (briefingTargets.length === 0) return undefined;
		const base = ownSkillsDir();
		if (!base) return undefined;
		const wanted = new Set<string>(['org-recover']);
		for (const t of briefingTargets) {
			wanted.add(t.role === 'chief' ? 'org-chief' : 'org-member');
		}
		const paths = [...wanted].map((n) => path.join(base, n)).filter((d) => existsSync(d));
		return paths.length > 0 ? { skillPaths: paths } : undefined;
	});

	pi.on('turn_start', () => {
		turnInFlight = true;
		if (!onDutyActive) return;
		void resolveSelf().then((me) => setBusyAll(me, true));
	});
	pi.on('turn_end', () => {
		turnInFlight = false;
		if (!onDutyActive) return;
		void resolveSelf().then((me) => setBusyAll(me, false));
	});
	pi.on('session_shutdown', async () => {
		stopStatusTimer();
		if (!onDutyActive) return;
		const me = await resolveSelf();
		if (me.orgs.length > 0) await clearRuntime(me);
		onDutyActive = false;
	});

	// ── 文本视图 ─────────────────────────────────────────────────────────────
	// 词表统一（CONTEXT.md「可感知状态」）：睡眠 / 空闲 / 工作中 / 待验收
	function stateLabel(online: boolean, busy: boolean, receivable: boolean): string {
		if (!online) return PRESENCE_WORDS.sleeping;
		if (!receivable) return `${PRESENCE_WORDS.sleeping}（进程在·未开 --session-control）`;
		return busy ? PRESENCE_WORDS.working : PRESENCE_WORDS.idle;
	}

	async function fleetText(orgName: string): Promise<string> {
		const org = await readOrg(orgName);
		const tasks = await listTasks(orgName);
		const queueCap = resolveMemberQueueCap(orgConfigStore.get().memberQueueCap);
		const lines: string[] = [`## org「${orgName}」状态`, ''];
		const row = async (m: OrgMember): Promise<string> => {
			const file = runtimeFile(orgName, m.name);
			const rt = await readJson<{ pid?: number; socketPath?: string; busy?: boolean }>(file);
			const online = !!rt && typeof rt.pid === 'number' && isPidAlive(rt.pid);
			let receivable = false;
			if (online && rt?.socketPath) {
				receivable = await isSocketAlive(rt.socketPath, 1000).catch(() => false);
			}
			const flag = m.role === 'chief' ? '负责人' : '成员';
			// 注册目录已失效 → 必须与「睡眠」区分：睡眠可唤醒，这类唤醒必失败（据实标注）
			const stateWord = dirExists(m.dir)
				? stateLabel(online, rt?.busy ?? false, receivable)
				: `${DIR_MISSING_WORD}·唤醒必失败`;
			// 队列与在跑（ADR-0055 `D4`/`D5`）：排队要看得见，否则无法干预
			const queue = queueLengthFor(tasks, m.name);
			const slot = await readSlot(orgName, m.name);
			const queueWord = `队列 ${queue}${queueCap === undefined ? '' : `/${queueCap}`}`;
			const runWord = slot
				? ` 在跑 ${slot.taskId}${slot.subTaskId ? `/${slot.subTaskId}` : ''}`
				: '';
			return `- [${flag}] ${meName(m)}（${m.name}）【${stateWord}】 ${queueWord}${runWord}  ${m.dir}`;
		};
		for (const m of org.members) {
			lines.push(await row(m));
		}
		const chief = org.members.find((m) => m.role === 'chief');
		lines.unshift(
			`负责人：${chief ? meName(chief) : '未指定（人类可让新目录以负责人角色 join）'}`,
		);
		lines.push('');
		lines.push(
			`提示：派发给未在岗成员会进 inbox 排队不丢；收任务需成员以 ${manualStartHint()} 启动。`,
		);
		return lines.join('\n');
	}

	function taskStatusLabel(t: Task): string {
		switch (t.status) {
			case 'todo':
				return '待办';
			case 'in_progress':
				return '进行中';
			case 'waiting_accept':
				return '等待验收';
			case 'closed':
				return t.acceptance ? '已关闭(验收)' : '已关闭(取消)';
		}
	}

	function assigneeStatusLabel(s: string): string {
		switch (s) {
			case 'invited':
				return '待确认/待领';
			case 'claimed':
				return '进行中';
			case 'delivered':
				return '已交付';
			case 'returned':
				return '返工中';
			case 'rejected':
				return '已拒绝';
			case 'cancelled':
				return '已取消';
			default:
				return s;
		}
	}

	function taskOneLine(t: Task): string {
		const subs = t.subTasks
			.map((s) =>
				s.assignees
					.map(
						(a) =>
							`${a.agent}:${assigneeStatusLabel(a.status)}${a.round > 0 ? `×${a.round}` : ''}`,
					)
					.join(' '),
			)
			.join(' | ');
		return `- [${taskStatusLabel(t)}] ${t.id} ${t.title}（派发：${t.dispatcher}）${t.dueAt ? ` 期望 ${t.dueAt}` : ''}\n  ${subs}`;
	}

	async function taskListText(orgName: string, filter?: (t: Task) => boolean): Promise<string> {
		const tasks = await listTasks(orgName);
		const list = filter ? tasks.filter(filter) : tasks;
		if (list.length === 0) return `## org「${orgName}」任务\n（暂无）`;
		return `## org「${orgName}」任务（${list.length}）\n\n${list.map(taskOneLine).join('\n')}`;
	}

	/** 某个 agent 参与的任务（作为处理人 / 作为派发人） */
	function agentInvolved(t: Task, agent: string): boolean {
		return (
			t.subTasks.some((s) => s.assignees.some((a) => a.agent === agent)) ||
			t.dispatcher === agent
		);
	}

	// ── 命令实现 ─────────────────────────────────────────────────────────────
	const HELP = `## /org（agent 组织）
- \`/org\`（无参数）→ 打开任务看板 TUI（人类操作台；非交互终端则显示本帮助）
- \`/org on\` / \`/org off\` 上岗 / 离岗（在岗自决；先决条件：先 \`/control on\` 建好控制 socket）
- \`/org wake <成员名> [org名]\` 叫醒一个睡眠成员（同「自动唤醒」门禁；看板当面按 w 不受门禁）
- \`/org abort <成员名> [org名]\` 中断其**当前轮**（≈按 ESC；进程/会话/记忆保留；看板按 x 同款）
- \`/org urgent <成员名> <内容|任务号> [--hard]\` 把紧急事项**插给**在岗成员（默认插话不中断；--hard 先中断）
- \`/org retry <任务编号> [成员名]\` 把任务**重新投递**给尚未交付的参与者（附上次说明；已关闭任务需新开并引用）
- \`/org orgs\` 列出本机全部组织及我所属
- \`/org create <org名>\` 创建组织（登记本目录为负责人）
- \`/org join <org名> [--inherit|--fresh|--exit]\` 加入（历史同名回归需三选一）
- \`/org leave <org名> [--confirm]\` 退出（盘点未结子任务后确认）
- \`/org delete <org名>\` 删除组织（先归档，人类操作）
- \`/org rename <旧名> <新名>\` 公司改名（目录/任务账本/投影同步迁移；建议成员睡眠）
- 组织视角：\`/org status|fleet [org]\`、\`/org tasks [org]\`、\`/org my-tasks [org]\`
- 对账/时间提醒：\`/org reconcile [org]\`（补投影 + 标完成未交付提醒 + 超期弱提示）
- 处理人侧：\`/org accept <任务号> <子任务号>\`（握手同意）、\`/org reject <任务号> <子任务号> <原因>\`
- 处理人侧：\`/org claim <任务号> <子任务号>\`、\`/org report <任务号> <子任务号> <摘要> [--file 路径[:行]]\`
- 派发人侧：\`/org approve <任务号> [说明]\`（验收通过）、\`/org return <任务号> <原因>\`
- 派发人侧：\`/org cancel <任务号>\`、\`/org reassign <任务号> <子任务号> <agent> [--replace]\`
- 处理人同意取消：\`/org consent-cancel <任务号>\``;

	async function handleOrgCommand(
		sub: string,
		rest: string[],
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const me = await resolveSelf();
		switch (sub) {
			case '': {
				// 无参数：交互终端打开任务看板 TUI；非交互（print/脚本/CI）回退帮助
				if (process.stdout.isTTY) {
					const meName0 = me.orgs[0]?.member.name ?? '';
					try {
						await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
							// theme 官方窄类型与板组件的宽松签名（兼容 headless mock）之间显式桥接
							const boardTheme = theme as {
								fg: (color: unknown, text: string) => string;
								bold: (text: string) => string;
								bg?: (color: unknown, text: string) => string;
							};
							return new OrgBoard(meName0, tui, boardTheme, done, {
								onAction: (orgName, taskId, action, detail) =>
									log.info('board action', {
										org: orgName,
										task: taskId,
										action,
										detail,
									}),
								// 上岗入口（ADR-0046 D3）：看板设置行 + `o` 键共用 setDuty
								duty: {
									state: () => dutyState({ onDuty: onDutyActive, socketUp }),
									toggle: async (on: boolean) => {
										const c = liveCtx;
										if (!c)
											return {
												ok: false,
												message: '会话尚未就绪，请稍后重试',
											};
										return setDuty(on, c);
									},
								},
							});
						});
					} catch (e) {
						log.warn('/org 面板关闭或异常', {
							err: e instanceof Error ? e.message : String(e),
						});
					}
					return;
				}
				await respond(HELP);
				return;
			}
			case 'help': {
				await respond(HELP);
				return;
			}
			case 'on':
			case 'off': {
				const res = await setDuty(sub === 'on', ctx);
				await notifyHuman(ctx, `[org] ${res.message}`);
				return;
			}
			case 'orgs': {
				const all = await listOrgNames();
				const mine = me.orgs.map((o) => o.org.name);
				const lines = all.map((n) => `- ${n}${mine.includes(n) ? '（我所属）' : ''}`);
				await respond(`## 本机 org\n${lines.join('\n') || '（无）'}`);
				return;
			}
			case 'create': {
				const orgName = rest[0];
				if (!orgName) {
					await respond('[org] 用法：/org create <org名>（在负责人目录执行）');
					return;
				}
				const manifest = me.manifest ?? {};
				const name = manifest.name ?? path.basename(me.dir);
				await createOrg(orgName, {
					name,
					dir: me.dir,
					label: manifest.label,
					description: manifest.description,
					launchArgs: defaultMemberLaunchArgs(),
				});
				await respond(
					`[org] 组织「${orgName}」已创建，你（${name}）是负责人。员工请 cd 到自己目录后 /org join ${orgName}。`,
				);
				await afterMembershipChange(ctx);
				return;
			}
			case 'join': {
				const orgName = rest[0];
				if (!orgName) {
					await respond('[org] 用法：/org join <org名>');
					return;
				}
				const manifest = me.manifest ?? {};
				const disposition = rest.find((r) => r.startsWith('--'))?.replace('--', '') as
					'inherit' | 'fresh' | 'exit' | undefined;
				try {
					const res = await joinOrg(orgName, {
						manifest,
						dir: me.dir,
						disposition,
						launchArgs: defaultMemberLaunchArgs(),
					});
					if (res.dispositionRequired) {
						await respond(
							`[org] 「${orgName}」历史上存在同名 agent（${res.history?.name}，曾于 ${res.history?.leftAt} 离开）。请选择：\n` +
								`- /org join ${orgName} --inherit  （继承历史记录，继续使用）\n` +
								`- /org join ${orgName} --fresh   （清空历史重来）\n` +
								`- /org join ${orgName} --exit    （不加入；可修改 agent 名后重试）`,
						);
						return;
					}
					const role = res.member.role === 'chief' ? '负责人' : '成员';
					await respond(
						`[org] 你（${res.member.name}）已加入 org「${orgName}」，身份：${role}。` +
							(role === '成员' ? `收任务请以 ${manualStartHint()} 启动本进程。` : ''),
					);
					await afterMembershipChange(ctx);
				} catch (error) {
					await respond(
						`[org] ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			}
			case 'leave': {
				const { orgName, rest: r2 } = await pickOrg(me, rest);
				const org = await readOrg(orgName);
				const member = await findMemberByDir(org, me.dir);
				if (!member) {
					await respond(`[org] 本目录不是 org「${orgName}」的成员。`);
					return;
				}
				// 盘点未结子任务
				const tasks = await listTasks(orgName);
				const open = tasks.filter(
					(t) => t.status !== 'closed' && findMemberOpenWork(t, member.name),
				);
				if (r2.includes('--confirm')) {
					await leaveOrg(
						orgName,
						me.dir,
						r2.filter((x) => !x.startsWith('--')).join(' ') || undefined,
					);
					await respond(
						`[org] 你（${member.name}）已退出 org「${orgName}」。记录保留可指认；未结任务将留在任务池待派发人改派。`,
					);
					refreshBriefingIfOnDuty();
					return;
				}
				const head = open.length
					? `你有 ${open.length} 个未结任务（${open.map((t) => t.id).join('、')}），退出后它们会退回任务池。`
					: '你名下没有未结任务。';
				await respond(
					`[org] 确认退出 org「${orgName}」？\n${head}\n执行：/org leave ${orgName} --confirm`,
				);
				return;
			}
			case 'delete': {
				const orgName = rest[0];
				if (!orgName) {
					await respond('[org] 用法：/org delete <org名>（人类操作，删除前归档）');
					return;
				}
				const res = await removeOrg(orgName);
				await respond(
					res.removed
						? `[org] org「${orgName}」已删除，数据归档于 ${res.archivedTo}（可恢复）。`
						: `[org] org「${orgName}」不存在。`,
				);
				refreshBriefingIfOnDuty();
				return;
			}
			case 'rename': {
				const [oldName, newName] = rest;
				if (!oldName || !newName) {
					await respond('[org] 用法：/org rename <旧公司名> <新公司名>');
					return;
				}
				try {
					const res = await renameOrg(oldName, newName);
					refreshBriefingIfOnDuty();
					await notifyHuman(
						ctx,
						`[org] 公司「${res.from}」已改名为「${res.to}」（目录/任务账本/投影已迁移）。` +
							`其他成员进程建议重启以刷新公司名。`,
					);
				} catch (e) {
					await notifyHuman(ctx, `[org] ${e instanceof Error ? e.message : String(e)}`);
				}
				return;
			}
			case 'wake': {
				const { orgName, rest: wakeRest } = await pickOrg(me, rest);
				const target = wakeRest[0];
				if (!target) {
					await respond('[org] 用法：/org wake <成员名> [org名]');
					return;
				}
				// 结果面向人（ADR-0047 D1）：走通知通道，不塞进 LLM 上下文
				await notifyHuman(ctx, await wakeForCaller(orgName, target));
				return;
			}
			case 'abort':
			case 'interrupt': {
				const { orgName, rest: abortRest } = await pickOrg(me, rest);
				const target = abortRest[0];
				if (!target) {
					await respond(
						'[org] 用法：/org abort <成员名> [org名]（中断其当前轮；进程与会话保留）',
					);
					return;
				}
				// 命令面 = 人类操作台：不校验负责人（ADR-0053 D2）
				await notifyHuman(ctx, await interruptForCaller(orgName, target, 'human'));
				return;
			}
			case 'urgent': {
				const { orgName, rest: urgentRest } = await pickOrg(me, rest);
				const target = urgentRest[0];
				if (!target) {
					await respond(
						'[org] 用法：/org urgent <成员名> <内容|任务号> [--hard]\n' +
							'默认只**插话**（不中断其当前轮）；`--hard` 会先中断当前轮再投递。',
					);
					return;
				}
				const hard = urgentRest.includes('--hard');
				const body = urgentRest
					.slice(1)
					.filter((x) => x !== '--hard')
					.join(' ')
					.trim();
				if (!body) {
					await respond('[org] 请给出要插话的内容（或任务号）。');
					return;
				}
				// 命令面 = 人类操作台：不校验负责人（ADR-0041 D3、ADR-0055 D6「人类或该 org 负责人」）
				const mineName =
					me.orgs.find((o) => o.org.name === orgName)?.member.name ?? 'human';
				const msg = /^M-[a-z0-9]+$/i.test(body)
					? `【紧急】${mineName} 要求你优先处理任务 ${body}；若你正在做别的任务，请先说明当前进度再切换。`
					: `【紧急】${mineName} 插话：${body}`;
				const res = await preemptMember(orgName, target, msg, { hard, by: mineName });
				await notifyHuman(
					ctx,
					`[org] 抢占 ${target}（${hard ? '硬抢占' : '插话'}）：${res.message}`,
				);
				return;
			}
			case 'retry': {
				const { orgName, rest: retryRest } = await pickOrg(me, rest);
				const retryTaskId = retryRest[0];
				if (!retryTaskId) {
					await respond(
						'[org] 用法：/org retry <任务编号> [成员名]（把任务重新投递给该成员；已关闭任务需新开并引用）',
					);
					return;
				}
				const retryTask = await readTask(orgName, retryTaskId).catch(() => null);
				if (!retryTask) {
					await respond(`[org] 任务 ${retryTaskId} 不存在。`);
					return;
				}
				const wanted = retryRest[1];
				// 可重试 = 尚未交付的参与者（invited / claimed / returned）；
				// 已交付走「打回」，已叫停/取消走「改派」——不静默替用户决定。
				const retryTargets: { subId: string; agent: string }[] = [];
				for (const sub of retryTask.subTasks) {
					for (const a of sub.assignees) {
						if (wanted && a.agent !== wanted) continue;
						if (
							a.status === 'invited' ||
							a.status === 'claimed' ||
							a.status === 'returned'
						) {
							retryTargets.push({ subId: sub.id, agent: a.agent });
						}
					}
				}
				if (retryTargets.length === 0) {
					await respond(
						`[org] 任务 ${retryTaskId} 没有可重试的参与者（已交付的请用「打回」，已叫停/取消的请用「改派」）。`,
					);
					return;
				}
				const retryMe = me.orgs.find((o) => o.org.name === orgName)?.member.name ?? 'human';
				const retryLines: string[] = [];
				for (const tg of retryTargets) {
					const r = await retrySubTask(orgName, retryTaskId, tg.subId, tg.agent, {
						by: retryMe,
						note: '人类命令 /org retry',
					});
					retryLines.push(`${r.ok ? 'ok' : 'fail'} ${r.message}`);
				}
				await respond(`[org] 重试 ${retryTaskId}：\n${retryLines.join('\n')}`);
				return;
			}
			case 'status':
			case 'fleet': {
				const { orgName } = await pickOrg(me, rest);
				await respond(await fleetText(orgName));
				return;
			}
			case 'tasks':
			case 'missions': {
				const { orgName } = await pickOrg(me, rest);
				await respond(await taskListText(orgName));
				return;
			}
			case 'my-tasks': {
				if (me.orgs.length === 0) {
					await respond('[org] 本目录未加入任何 org。');
					return;
				}
				const perOrg: string[] = [];
				for (const { org } of me.orgs) {
					const tasks = await listTasks(org.name);
					const mine = tasks.filter((t) =>
						agentInvolved(t, me.orgs.find((o) => o.org.name === org.name)!.member.name),
					);
					perOrg.push(
						`### ${org.name}\n${mine.length ? mine.map(taskOneLine).join('\n') : '（无相关任务）'}`,
					);
				}
				await respond(`## 我的任务\n${perOrg.join('\n\n')}`);
				return;
			}
			case 'reconcile': {
				const { orgName } = await pickOrg(me, rest);
				const res = await reconcileOrg(orgName);
				const head = `## org「${orgName}」对账完成\n- 补投影：${res.projected} 条`;
				const body = res.issues.length
					? `\n\n需处理（${res.issues.length}）：\n${res.issues.map((i) => `- [${i.agent}] ${i.message}`).join('\n')}`
					: '';
				await respond(head + body);
				return;
			}
			case 'accept':
			case 'reject':
			case 'claim':
			case 'report':
			case 'approve':
			case 'return':
			case 'cancel':
			case 'consent-cancel':
			case 'reassign': {
				// 需显式任务编号，先在所属 org 里找到该任务（跨 org 查找）
				const taskId = rest[0];
				if (!taskId) {
					await respond(`[org] 用法见 /org help（命令 ${sub} 需任务编号）。`);
					return;
				}
				// 跨所属 org 找任务
				let found: { task: Task; orgName: string } | null = null;
				for (const { org } of me.orgs) {
					const t = await readTask(org.name, taskId);
					if (t) {
						found = { task: t, orgName: org.name };
						break;
					}
				}
				if (!found) {
					await respond(`[org] 任务 ${taskId} 不存在（或不在你所属的 org）。`);
					return;
				}
				const { task, orgName } = found;
				const memberName = me.orgs.find((o) => o.org.name === orgName)!.member.name;
				const msg = await handleTaskOp(sub, orgName, task, memberName, rest.slice(1));
				if (
					[
						'accept',
						'reject',
						'claim',
						'report',
						'approve',
						'return',
						'cancel',
						'consent-cancel',
						'reassign',
					].includes(sub)
				) {
					void projectTask(orgName, task.id).catch((e) =>
						log.warn('投影失败', { err: e, task: task.id }),
					);
				}
				// 惰性催办（ADR-0039 D）：每次 org 操作后重查未决握手（无则不打扰）
				void remindPendingHandshakes(orgName, memberName);
				await respond(msg);
				return;
			}
			default: {
				await respond(`[org] 未知子命令「${sub}」。\n${HELP}`);
			}
		}
	}

	// ── 任务操作（命令与工具共用）────────────────────────────────────────────
	async function handleTaskOp(
		op: string,
		orgName: string,
		task: Task,
		meName: string,
		rest: string[],
	): Promise<string> {
		switch (op) {
			case 'accept': {
				const subId = rest[0] ?? firstSubOf(task, meName);
				const sub = findSub(task, meName, subId);
				if (!sub) return `[org] 找不到你负责的子任务（任务 ${task.id}）。`;
				const assignee = sub.assignees.find((a) => a.agent === meName);
				if (!assignee) return `[org] 你不是该子任务的处理人。`;
				if (task.dispatcherRole === 'chief') {
					return `[org] 该任务由负责人单方派发，无需确认；直接 /org claim ${task.id} ${sub.id} 开工即可。`;
				}
				if (assignee.status !== 'invited') {
					return `[org] 该子任务已处理（${assignee.status}），不能重复确认。`;
				}
				// 一次只做一件（ADR-0055 `D1`）：执行槽被**别的任务**占着就拒绝接手，而不是并发两件
				// 先清掉"任务已被取消/叫停/改派"却仍占着的失效槽，否则该成员会被永久挡住（ADR-0055 `D2`）
				await releaseStaleSlotFor(orgName, meName);
				const slotRes = await claimSlot(orgName, meName, {
					taskId: task.id,
					subTaskId: sub.id,
				});
				if (!slotRes.ok) {
					return `[org] 你手上还有 ${slotRes.holder.taskId}${slotRes.holder.subTaskId ? `/${slotRes.holder.subTaskId}` : ''} 在执行（一次只做一件）。先交付或说明后再接手。`;
				}
				transitionAssignee(assignee, 'claimed', meName, { note: 'handshake accept' });
				task.history.push({ at: nowIso(), event: 'accepted', by: meName });
				refreshTaskStatus(task); // 聚合状态（in_progress）必须落盘，否则看板/简报显示 todo
				await saveTask(task);
				return `[org] 你已同意接手 ${task.id} 子任务 ${sub.id}，状态：进行中。完成后 /org report ${task.id} ${sub.id} <摘要>。`;
			}
			case 'reject': {
				// 启发式：rest[0] 仅当是该任务真实存在的子任务号时才消费；否则整段视为原因（缺省回退名下子任务）
				const explicitSub = rest[0]?.trim() || '';
				const hasSub =
					explicitSub !== '' && task.subTasks.some((s) => s.id === explicitSub);
				const subId = hasSub ? explicitSub : (firstSubOf(task, meName) ?? '');
				const reason = (hasSub ? rest.slice(1) : rest).join(' ').trim();
				if (!reason)
					return `[org] 拒绝必须带原因：/org reject ${task.id} ${subId} <原因>。`;
				const sub = findSub(task, meName, subId);
				const assignee = sub?.assignees.find((a) => a.agent === meName);
				if (!sub || !assignee) return '[org] 你不是该子任务的处理人。';
				if (task.dispatcherRole === 'chief') {
					return `[org] 负责人派发的任务不可拒接（组织规则）。如确有困难请向负责人说明。`;
				}
				transitionAssignee(assignee, 'rejected', meName, { note: reason });
				task.history.push({ at: nowIso(), event: 'rejected', by: meName, note: reason });
				refreshTaskStatus(task); // 拒接后可能已无人未决 → 聚合状态需回落
				await saveTask(task);
				await notifyDispatcher(
					orgName,
					task,
					`处理人 ${meName} 拒绝了子任务 ${sub.id}：${reason}`,
					meName,
				);
				return `[org] 你已拒绝 ${task.id} 子任务 ${sub.id}（原因已记录）。该子任务将交回派发人处理。`;
			}
			case 'claim': {
				const subId = rest[0] ?? firstSubOf(task, meName);
				const sub = findSub(task, meName, subId);
				const assignee = sub?.assignees.find((a) => a.agent === meName);
				if (!sub || !assignee) return '[org] 你不是该子任务的处理人。';
				if (assignee.status !== 'invited' && assignee.status !== 'returned') {
					return `[org] 当前状态（${assignee.status}）不能领取。`;
				}
				// 执行槽（ADR-0055 `D1`/`D2`）：同一时刻只做一件
				// 先清掉"任务已被取消/叫停/改派/已交付"却仍占着的失效槽：与 `accept` 同口径，
				// 否则领取要等巡检下一拍（≤4s）才放行，且槽的持有者若已换代就永久挡住（ADR-0055 `D2`）
				await releaseStaleSlotFor(orgName, meName);
				const slotRes = await claimSlot(orgName, meName, {
					taskId: task.id,
					subTaskId: sub.id,
				});
				if (!slotRes.ok) {
					return `[org] 你手上还有 ${slotRes.holder.taskId}${slotRes.holder.subTaskId ? `/${slotRes.holder.subTaskId}` : ''} 在执行（一次只做一件）。先交付或说明后再领取。`;
				}
				transitionAssignee(assignee, 'claimed', meName);
				task.history.push({ at: nowIso(), event: 'claimed', by: meName });
				refreshTaskStatus(task); // 领取即 in_progress（此前从未落盘 → 看板一直显示 todo）
				await saveTask(task);
				return `[org] 你已领取 ${task.id} 子任务 ${sub.id}，开始执行。`;
			}
			case 'report': {
				// 启发式同 reject：rest[0] 仅当是真实子任务号才消费；否则并入正文（摘要）
				const explicitSub = rest[0]?.trim() || '';
				const hasSub =
					explicitSub !== '' && task.subTasks.some((s) => s.id === explicitSub);
				const subId = hasSub ? explicitSub : (firstSubOf(task, meName) ?? '');
				const args = hasSub ? rest.slice(1) : rest;
				const fileFlags: string[] = [];
				const cleanArgs: string[] = [];
				for (let i = 0; i < args.length; i++) {
					if (args[i] === '--file') {
						fileFlags.push(args[i + 1] ?? '');
						i++;
					} else {
						cleanArgs.push(args[i]);
					}
				}
				const summary = cleanArgs.join(' ').trim();
				if (!summary) {
					return `[org] 交付需带结果摘要：/org report ${task.id} ${subId} <摘要> [--file 路径[:行]]`;
				}
				const sub = findSub(task, meName, subId);
				const assignee = sub?.assignees.find((a) => a.agent === meName);
				if (!sub || !assignee) return '[org] 你不是该子任务的处理人。';
				if (assignee.status === 'delivered' && assignee.deliveries.length > 0) {
					return `[org] 该子任务已交付过（幂等保护）。如需补充请等待派发人打回。`;
				}
				assignee.deliveries.push({
					at: nowIso(),
					by: meName,
					summary,
					files: fileFlags.map((f) => {
						const idx = f.lastIndexOf(':');
						if (idx > 0 && /^\d+(-?\d+)?$/.test(f.slice(idx + 1))) {
							return { path: f.slice(0, idx), lines: f.slice(idx + 1) };
						}
						return { path: f };
					}),
				});
				assignee.status = 'delivered';
				task.history.push({ at: nowIso(), event: 'delivered', by: meName, note: summary });
				refreshTaskStatus(task); // 全部交付齐 → waiting_accept（待验收）
				// 交付即释放执行槽（ADR-0055 `D2`）：否则后续任务会被"幽灵占用"挡住
				const slotNow = await readSlot(orgName, meName);
				if (slotNow && slotNow.taskId === task.id && slotNow.pid === process.pid) {
					await releaseSlot(orgName, meName, slotNow.token);
				}
				await saveTask(task);
				// 每次交付都通知派发人
				await notifyDispatcher(
					orgName,
					task,
					`处理人 ${meName} 已交付子任务 ${subId}：\n${summary}${fileFlags.length ? `\n产出：${fileFlags.join(', ')}` : ''}`,
					meName,
				);
				const allClear = !task.subTasks.some((s) =>
					s.assignees.some((a) => ['invited', 'claimed', 'returned'].includes(a.status)),
				);
				const extra = allClear ? '\n该任务全部子任务已交付，可整体验收。' : '';
				return `[org] 交付已记录（任务 ${task.id} 子任务 ${subId}）。${extra}`;
			}
			case 'approve': {
				if (task.dispatcher !== meName) {
					return `[org] 只有派发人 ${task.dispatcher} 能验收通过。`;
				}
				try {
					const note = rest.join(' ');
					// 情形 B 采纳：先叫停未交付参与者，再整体验收关闭（attest 要求 waiting_accept）
					const { stopped } = approveWithAdoption(task, meName, note || undefined);
					await saveTask(task);
					for (const agent of stopped) {
						await deliverMessage(
							orgName,
							agent,
							`[org] 任务 ${task.id} 已完成（采纳了更早的交付），你无需继续。感谢付出。`,
							{ sender: meName },
						);
					}
					return `[org] 任务 ${task.id} 验收通过并关闭（铁终态）。${stopped.length ? `已通知 ${stopped.length} 位未采纳参与者无需继续。` : ''}`;
				} catch (error) {
					return `[org] 验收失败：${error instanceof Error ? error.message : String(error)}`;
				}
			}
			case 'return': {
				if (task.dispatcher !== meName) {
					return `[org] 只有派发人 ${task.dispatcher} 能打回。`;
				}
				const note = rest.join(' ').trim();
				if (!note)
					return `[org] 打回需带原因（点明返工哪些点）：/org return ${task.id} <原因>`;
				try {
					await attestTask(task, meName, 'rejected', note);
					await saveTask(task);
					return `[org] 任务 ${task.id} 已打回（返工轮次 ${task.acceptance?.round ?? 1}）。对应处理人已回到返工状态。`;
				} catch (error) {
					return `[org] 打回失败：${error instanceof Error ? error.message : String(error)}`;
				}
			}
			case 'cancel': {
				if (task.dispatcher !== meName) {
					return `[org] 只有派发人 ${task.dispatcher} 能取消任务。`;
				}
				const note = rest.join(' ').trim();
				const res = await cancelTaskByDispatcher(
					orgName,
					task.id,
					meName,
					note || undefined,
				);
				if (!res.ok && res.needConsent) {
					return `[org] ${res.message} 可先与处理人沟通，处理人同意后 /org consent-cancel ${task.id}。`;
				}
				return `[org] ${res.message}`;
			}
			case 'consent-cancel': {
				const res = await consentCancel(orgName, task.id, meName);
				return `[org] ${res.message}`;
			}
			case 'reassign': {
				const subId = rest[0];
				const agent = rest[1];
				if (!subId || !agent) {
					return `[org] 用法：/org reassign <任务号> <子任务号> <agent> [--replace]`;
				}
				const replace = rest.includes('--replace');
				if (task.dispatcher !== meName) return '[org] 只有派发人能改派。';
				const res = await reassignSubTask(orgName, task.id, subId, meName, agent, {
					replace,
				});
				if (res.ok) {
					const subT = task.subTasks.find((s) => s.id === subId);
					if (subT) {
						void deliverMessage(
							orgName,
							agent,
							`[org:task] ${meName} 改派给你一个子任务：\n任务 ${task.id}：${task.title}\n你负责的子任务 ${subId}：${subT.description}`,
							{ sender: meName },
						).catch((e) => log.warn('reassign deliver fail', { err: e }));
					}
				}
				return `[org] ${res.message}`;
			}
			default:
				return `[org] 未知操作 ${op}`;
		}
	}

	function firstSubOf(task: Task, meName: string): string | undefined {
		const s = task.subTasks.find((x) => x.assignees.some((a) => a.agent === meName));
		return s?.id;
	}
	function findSub(task: Task, meName: string, subId?: string) {
		if (subId) return task.subTasks.find((s) => s.id === subId);
		return task.subTasks.find((s) => s.assignees.some((a) => a.agent === meName));
	}

	/** 交付/拒绝等事件通知派发人（在线优先，离线 inbox） */
	async function notifyDispatcher(
		orgName: string,
		task: Task,
		content: string,
		/** 报告人（成员名）—— 投递时作为发送者头，使派发人可归因（ADR-0044 D2） */
		sender?: string,
	): Promise<void> {
		const org = await readOrg(orgName);
		const dispatcher = org.members.find((m) => m.name === task.dispatcher);
		if (!dispatcher) return;
		void deliverMessage(
			orgName,
			dispatcher.name,
			`[org:report] 任务 ${task.id} 动态：\n${content}`,
			{ sender },
		).catch((e) => log.warn('notify dispatcher fail', { err: e }));
	}

	pi.registerCommand('org', {
		description:
			'agent 组织（目录绑定）：orgs/create/join/leave/delete、wake 显式唤醒、status/tasks/my-tasks 视图、accept/reject/claim/report 处理人操作、approve/return/cancel/reassign 派发人操作',
		handler: async (args: string, ctx) => {
			const argv = (args ?? '').trim().split(/\s+/).filter(Boolean);
			const sub = argv[0] ?? '';
			const rest = argv.slice(1);
			try {
				await handleOrgCommand(sub, rest, ctx);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				log.warn('/org 命令失败', { sub, error: msg });
				await respond(`[org] 命令失败：${msg}`);
			}
		},
	});

	// ── 工具（仅在岗注册；ADR-0041 D2）───────────────────────────────────────
	function registerOrgTools(): void {
		pi.registerTool({
			name: 'dispatch_task',
			label: '派发任务给子领域 agent（组织）',
			description:
				'向 org 成员派发任务（落官方任务记录，可指认）。你是该 org 负责人则单方生效（处理人不可拒）；否则走握手（处理人确认后才形成）。未在岗成员投递 inbox 不丢。可一次派给多个处理人（每人一个子任务）。',
			parameters: Type.Object({
				org: Type.String({ description: 'org 名（先 /org orgs 查看）' }),
				title: Type.String({ description: '任务标题' }),
				background: Type.String({ description: '概要背景（为什么做这件事）' }),
				items: Type.Array(Type.String({ description: '逐点任务清单' })),
				dueAt: Type.Optional(
					Type.String({ description: '任务级期望完成时间（ISO 时间，可空）' }),
				),
				targets: Type.Array(
					Type.Object({
						agent: Type.String({ description: '处理人 agent 名（org 成员）' }),
						description: Type.String({ description: '该处理人负责的子任务内容' }),
						dueAt: Type.Optional(
							Type.String({
								description: '子任务级期望完成时间（可空，继承任务级）',
							}),
						),
					}),
					{ description: '处理人列表（每人一个子任务）' },
				),
			}),
			async execute(
				_toolCallId,
				params: {
					org: string;
					title: string;
					background: string;
					items: string[];
					dueAt?: string;
					targets: { agent: string; description: string; dueAt?: string }[];
				},
			) {
				const me = await resolveSelf();
				if (me.orgs.length === 0) {
					return textResult('[org] 本目录未加入任何 org，不能派发。', {});
				}
				const member = me.orgs.find((o) => o.org.name === params.org)?.member;
				if (!member) {
					return textResult(`[org] 你在 org「${params.org}」中没有身份。`, {});
				}
				if (member.role !== 'chief') {
					const isMemberOfOrg = me.orgs.some((o) => o.org.name === params.org);
					if (!isMemberOfOrg)
						return textResult(`[org] org「${params.org}」不存在或你不是成员。`, {});
				}
				// 校验目标都是 org 成员
				const names = await memberNames(params.org);
				for (const t of params.targets) {
					if (!names.includes(t.agent)) {
						return textResult(
							`[org] 处理人「${t.agent}」不是 org「${params.org}」的成员（成员：${names.join('、')}）。`,
							{},
						);
					}
				}
				try {
					const res = await dispatchTask({
						org: params.org,
						dispatcher: member.name,
						dispatcherRole: member.role,
						title: params.title,
						background: params.background,
						items: params.items,
						dueAt: params.dueAt ?? null,
						targets: params.targets.map((t) => ({
							agent: t.agent,
							description: t.description,
							dueAt: t.dueAt ?? null,
						})),
					});
					const modeInfo = res.deliveries
						.map(
							(d) =>
								`${d.agent}:${
									d.mode === 'online'
										? '在岗送达'
										: d.mode === 'uncertain'
											? '送达存疑（未收到成员回报）'
											: d.mode === 'inbox'
												? '已入收件箱（未在岗）'
												: '未在岗'
								}`,
						)
						.join('，');
					return textResult(
						`[org] 任务 ${res.task.id} 已创建并投递（${modeInfo}）。\n` +
							`${member.role === 'chief' ? '你是负责人，任务单方生效。' : '你是普通成员派发，已发握手请求，处理人确认后生效。'}\n` +
							`进度查看：/org tasks ${params.org}`,
						{ taskId: res.task.id, deliveries: res.deliveries },
					);
				} catch (error) {
					return textResult(
						`[org] 派发失败：${error instanceof Error ? error.message : String(error)}`,
						{},
					);
				}
			},
		});

		async function meOrgNames(): Promise<string[]> {
			const me = await resolveSelf();
			return me.orgs.map((o) => o.org.name);
		}

		pi.registerTool({
			name: 'org_wake',
			label: '唤醒睡眠成员',
			description:
				'把一个睡眠成员叫起来（在其注册目录启动在岗进程）。幂等、不改组织数据、不产生任务——' +
				'与派活分离（只需叫醒、不必建任务时用它）。受「自动唤醒」门禁：该组织关闭时会被**明确拒绝**' +
				'并给出出路（不会静默跳过）。仅该 org 负责人可调用。',
			parameters: Type.Object({
				member: Type.String({ description: '要唤醒的成员名' }),
				org: Type.Optional(Type.String({ description: 'org 名（缺省你所属唯一 org）' })),
			}),
			async execute(_toolCallId, params: { member: string; org?: string }) {
				const orgs = await meOrgNames();
				const orgName = params.org ?? (orgs.length === 1 ? orgs[0] : null);
				if (!orgName) {
					return textResult(
						`[org] 请指定 org（你所属：${orgs.join('、') || '无'}）。`,
						{},
					);
				}
				return textResult(await wakeForCaller(orgName, params.member), { org: orgName });
			},
		});

		pi.registerTool({
			name: 'org_abort',
			label: '中断成员当前轮',
			description:
				'中断某个在岗成员**当前正在跑的这一轮**（相当于在它终端按 ESC）：进程、会话与记忆都保留，' +
				'随后可以继续派活、重试或换人。不唤醒、不杀进程、不改组织数据。' +
				'仅该 org 负责人可调用；成员不在岗、或它的控制通道不支持中断（进程版本旧）时会**据实拒绝**并说明原因，' +
				'绝不假装成功。',
			parameters: Type.Object({
				member: Type.String({ description: '要中断的成员名' }),
				org: Type.Optional(Type.String({ description: 'org 名（缺省你所属唯一 org）' })),
			}),
			async execute(_toolCallId, params: { member: string; org?: string }) {
				const orgs = await meOrgNames();
				const orgName = params.org ?? (orgs.length === 1 ? orgs[0] : null);
				if (!orgName) {
					return textResult(
						`[org] 请指定 org（你所属：${orgs.join('、') || '无'}）。`,
						{},
					);
				}
				return textResult(await interruptForCaller(orgName, params.member, 'agent'), {
					org: orgName,
				});
			},
		});

		pi.registerTool({
			name: 'org_urgent',
			label: '把紧急事项插给在岗成员',
			description:
				'在成员**正在干活**时把紧急事项推给它：默认只插话（`steer`：当前工具调用结束后、下一次模型调用前插入，' +
				'不打断它这一轮、不丢进度）；`hard: true` 先中断其当前轮再投递（仅当方向已错、继续跑就是浪费时用）。' +
				'仅该 org 负责人可调用；不在岗、或进程版本旧不支持中断时**据实回报**。',
			parameters: Type.Object({
				member: Type.String({ description: '目标成员名' }),
				message: Type.String({ description: '要插进去的话（也可只给任务号）' }),
				hard: Type.Optional(
					Type.Boolean({ description: 'true = 先中断其当前轮再投递（默认只插话）' }),
				),
				org: Type.Optional(Type.String({ description: 'org 名（缺省你所属唯一 org）' })),
			}),
			async execute(
				_t: never,
				p: { member: string; message: string; hard?: boolean; org?: string },
			) {
				const orgs = await meOrgNames();
				const orgName = p.org ?? (orgs.length === 1 ? orgs[0] : null);
				if (!orgName) {
					return textResult(
						`[org] 请指定 org（你所属：${orgs.join('、') || '无'}）。`,
						{},
					);
				}
				const me = await resolveSelf();
				const mine = me.orgs.find((o) => o.org.name === orgName);
				if (!mine) return textResult(`[org] 你不在 org「${orgName}」中。`, {});
				const file = await readOrg(orgName).catch(() => null);
				// fail-closed：读不到组织就无从证明调用者是负责人 → 拒绝（与 interruptForCaller 同口径）
				if (!file) {
					return textResult(
						`[org] 组织「${orgName}」不存在或读取失败，无法校验抢占权限。`,
						{},
					);
				}
				if (file.chiefName !== mine.member.name) {
					return textResult(
						`[org] 未抢占 ${p.member}：抢占权限限本 org 负责人（本组织负责人是 ${file.chiefName}）。`,
						{},
					);
				}
				const res = await preemptMember(orgName, p.member, p.message, {
					hard: p.hard === true,
					by: mine.member.name,
				});
				const extra = res.taskId
					? `（其当前任务：${res.taskId}${res.subTaskId ? `/${res.subTaskId}` : ''}）`
					: '';
				return textResult(`[org] ${res.message}${extra}`, { ...res });
			},
		});

		pi.registerTool({
			name: 'org_fleet',
			label: '查看组织成员与在岗状态',
			description:
				'列出指定 org（缺省你所属唯一 org）的成员、角色、在岗/忙闲状态，用于决定派发给谁。',
			parameters: Type.Object({
				org: Type.Optional(Type.String({ description: 'org 名（缺省你所属唯一 org）' })),
			}),
			async execute(_toolCallId, params: { org?: string }) {
				const orgs = await meOrgNames();
				const orgName = params.org ?? (orgs.length === 1 ? orgs[0] : null);
				if (!orgName) {
					return textResult(
						`[org] 请指定 org（你所属：${orgs.join('、') || '无'}）。`,
						{},
					);
				}
				try {
					return textResult(await fleetText(orgName), { org: orgName });
				} catch (error) {
					return textResult(
						`[org] ${error instanceof Error ? error.message : String(error)}`,
						{},
					);
				}
			},
		});

		pi.registerTool({
			name: 'org_my_tasks',
			label: '查看与我相关的任务',
			description:
				'列出我在各 org 作为处理人（待确认/进行中/待交付/返工）与作为派发人的任务。',
			parameters: Type.Object({}),
			async execute() {
				const me = await resolveSelf();
				if (me.orgs.length === 0) return textResult('[org] 本目录未加入任何 org。', {});
				const out: string[] = [];
				for (const { org, member } of me.orgs) {
					const tasks = await listTasks(org.name);
					const relevant = tasks.filter(
						(t) => t.status !== 'closed' && agentInvolved(t, member.name),
					);
					const lines = relevant.map(taskOneLine);
					out.push(
						`### org「${org.name}」\n${lines.length ? lines.join('\n') : '（无未关闭相关任务）'}`,
					);
				}
				return textResult(out.join('\n\n'), {});
			},
		});

		// 处理人侧快捷工具：把 /org op 参数转成 handleTaskOp 调用
		async function taskOpTool(
			op: string,
			taskId: string,
			rest: string[],
		): Promise<ReturnType<typeof textResult>> {
			const me = await resolveSelf();
			if (me.orgs.length === 0) return textResult('[org] 本目录未加入任何 org。', {});
			for (const { org, member } of me.orgs) {
				const task = await readTask(org.name, taskId);
				if (task) {
					const msg = await handleTaskOp(op, org.name, task, member.name, rest);
					// 惰性催办（ADR-0039 D）：工具面 org 操作后同样重查未决握手
					void remindPendingHandshakes(org.name, member.name);
					return textResult(msg, { taskId });
				}
			}
			return textResult(`[org] 任务 ${taskId} 不存在（不在你所属 org）。`, {});
		}

		pi.registerTool({
			name: 'org_accept',
			label: '同意接手派发的任务（握手）',
			description: '非负责人派发来的任务需你确认后才生效：同意接手一个子任务。',
			parameters: Type.Object({
				taskId: Type.String({ description: '任务编号' }),
				subTaskId: Type.Optional(
					Type.String({ description: '子任务编号（缺省你名下的那个）' }),
				),
			}),
			async execute(_t: never, p: { taskId: string; subTaskId?: string }) {
				return taskOpTool('accept', p.taskId, p.subTaskId ? [p.subTaskId] : []);
			},
		});
		pi.registerTool({
			name: 'org_reject',
			label: '拒绝派发的任务（握手，带原因）',
			description: '非负责人派发的任务可拒绝（负责人派发不可拒）。拒绝必须带原因。',
			parameters: Type.Object({
				taskId: Type.String({ description: '任务编号' }),
				subTaskId: Type.Optional(Type.String({ description: '子任务编号' })),
				reason: Type.String({ description: '拒绝原因' }),
			}),
			async execute(_t: never, p: { taskId: string; subTaskId?: string; reason: string }) {
				// subTaskId 缺省时保留空串占位 → rest[0] 为空 → handleTaskOp 内 fallback 到你名下的子任务
				// （若直接省略，reason 会落进 rest[0] 被当成子任务号，reason 必现为空）
				return taskOpTool('reject', p.taskId, [p.subTaskId ?? '', p.reason]);
			},
		});
		pi.registerTool({
			name: 'org_claim',
			label: '领取任务开始执行',
			description: '领取指派给你的子任务（负责人派发直接开工；握手任务需先 accept）。',
			parameters: Type.Object({
				taskId: Type.String({ description: '任务编号' }),
				subTaskId: Type.Optional(
					Type.String({ description: '子任务编号（缺省你名下的那个）' }),
				),
			}),
			async execute(_t: never, p: { taskId: string; subTaskId?: string }) {
				return taskOpTool('claim', p.taskId, p.subTaskId ? [p.subTaskId] : []);
			},
		});
		pi.registerTool({
			name: 'org_report',
			label: '交付任务（回传结果）',
			description:
				'完成子任务后回报交付：结果摘要 + 产出文件（可到具体行，--file 不支持则在描述里给路径）。',
			parameters: Type.Object({
				taskId: Type.String({ description: '任务编号' }),
				subTaskId: Type.Optional(
					Type.String({ description: '子任务编号（缺省你名下的那个）' }),
				),
				summary: Type.String({ description: '结果摘要（做了什么、结果如何）' }),
				files: Type.Optional(
					Type.Array(
						Type.String({ description: '产出文件路径（可带 :行号 说明具体位置）' }),
					),
				),
			}),
			async execute(
				_t: never,
				p: { taskId: string; subTaskId?: string; summary: string; files?: string[] },
			) {
				// subTaskId 缺省时保留空串占位（不能 filter 掉）：空 rest[0] 触发 handleTaskOp 内
				// fallback 到你名下的子任务；若省略则 summary 落进 rest[0] 被当成子任务号 → 摘要必现为空
				const rest: string[] = [p.subTaskId ?? '', p.summary];
				for (const f of p.files ?? []) rest.push('--file', f);
				return taskOpTool('report', p.taskId, rest);
			},
		});
		pi.registerTool({
			name: 'org_review',
			label: '验收 / 打回任务（派发人）',
			description:
				'派发人验收已交付任务：accepted 通过并关闭（铁终态）；rejected 打回返工（需说明原因）。',
			parameters: Type.Object({
				taskId: Type.String({ description: '任务编号' }),
				result: Type.Union([Type.Literal('accepted'), Type.Literal('rejected')], {
					description: 'accepted=验收通过并关闭；rejected=打回返工',
				}),
				note: Type.Optional(Type.String({ description: '验收说明 / 打回原因' })),
			}),
			async execute(
				_t: never,
				p: { taskId: string; result: 'accepted' | 'rejected'; note?: string },
			) {
				return taskOpTool(
					p.result === 'accepted' ? 'approve' : 'return',
					p.taskId,
					p.note ? [p.note] : [],
				);
			},
		});
	}
}
