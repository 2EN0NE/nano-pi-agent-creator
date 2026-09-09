// org — 目录绑定 agent 框架扩展（装配入口）
// 职责：org 实体（create/join/leave/删除）、多 org 在岗注册、派发（chief 单方 / 非 chief 握手）、
//       任务/子任务/参与者状态机、交付回传与验收（approve/return）、待办投影（07 基础）、inbox 兜底。
// 依赖 control（成员侧需 --session-control 收消息）；org 数据全局 ~/.pi/org/<org名>/。
import { Type } from 'typebox';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AgentManifest, OrgFile, OrgMember, Task } from './types.js';
import { ensureDir, nowIso, readJson, writeJsonAtomic } from './util.js';
import { loadManifest } from './manifest.js';
import {
	createOrg,
	findMemberByDir,
	findOrgsForDir,
	joinOrg,
	leaveOrg,
	listOrgNames,
	orgExists,
	readOrg,
	removeOrg,
	runtimeDir,
	runtimeFile,
} from './orgstore.js';
import {
	approveWithAdoption,
	attestTask,
	findMemberOpenWork,
	listTasks,
	readTask,
	saveTask,
	transitionAssignee,
} from './task.js';
import {
	cancelTaskByDispatcher,
	consentCancel,
	deliverMessage,
	dispatchTask,
	reassignSubTask,
	takeInbox,
} from './dispatch.js';
import { isSocketAlive } from './util.js';
import { projectTask, reconcileOrg } from './todoproj.js';
import { OrgBoard } from './board.js';

const log = createLogger('org');

function sessionDir(): string {
	return path.join(os.homedir(), '.pi', 'session-control');
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
		const socketPath = path.join(sessionDir(), `${sessionId}.sock`);
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

	// ── 生命周期事件 ─────────────────────────────────────────────────────────
	pi.on('session_start', async (_event, ctx) => {
		const me = await resolveSelf();
		if (me.orgs.length === 0) return; // 本目录未加入任何 org
		const sessionId = ctx.sessionManager.getSessionId();
		await registerRuntime(me, sessionId ?? '', false);

		// 离线期间积累的 inbox 消息补投（任务不丢）
		for (const { org, member } of me.orgs) {
			const queued = await takeInbox(org.name, member.name);
			if (queued.length > 0) {
				pi.sendMessage(
					{
						customType: 'org-inbox',
						content: `[org] 你离线期间收到 ${queued.length} 条任务消息：\n${queued.join('\n---\n')}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
		}
		log.info('在岗注册', {
			orgs: me.orgs.map((o) => `${o.org.name}:${o.member.name}:${o.member.role}`),
			pid: process.pid,
			sessionId,
		});
	});

	pi.on('turn_start', () => {
		void resolveSelf().then((me) => setBusyAll(me, true));
	});
	pi.on('turn_end', () => {
		void resolveSelf().then((me) => setBusyAll(me, false));
	});
	pi.on('session_shutdown', async () => {
		const me = await resolveSelf();
		if (me.orgs.length > 0) await clearRuntime(me);
	});

	// ── 文本视图 ─────────────────────────────────────────────────────────────
	function stateLabel(online: boolean, busy: boolean, receivable: boolean): string {
		if (!online) return '离线';
		if (!receivable) return '进程在·收不了消息（未开 --session-control）';
		return busy ? '忙碌' : '空闲';
	}

	async function fleetText(orgName: string): Promise<string> {
		const org = await readOrg(orgName);
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
			return `- [${flag}] ${meName(m)}（${m.name}）【${stateLabel(online, rt?.busy ?? false, receivable)}】 ${m.dir}`;
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
			'提示：派发给离线成员会进 inbox 排队不丢；收任务需成员以 --session-control 启动。',
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
- \`/org orgs\` 列出本机全部组织及我所属
- \`/org create <org名>\` 创建组织（登记本目录为负责人）
- \`/org join <org名> [--inherit|--fresh|--exit]\` 加入（历史同名回归需三选一）
- \`/org leave <org名> [--confirm]\` 退出（盘点未结子任务后确认）
- \`/org delete <org名>\` 删除组织（先归档，人类操作）
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
				});
				await respond(
					`[org] 组织「${orgName}」已创建，你（${name}）是负责人。员工请 cd 到自己目录后 /org join ${orgName}。`,
				);
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
					const res = await joinOrg(orgName, { manifest, dir: me.dir, disposition });
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
							(role === '成员' ? '收任务请以 --session-control 启动本进程。' : ''),
					);
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
				transitionAssignee(assignee, 'claimed', meName, { note: 'handshake accept' });
				task.history.push({ at: nowIso(), event: 'accepted', by: meName });
				await saveTask(task);
				return `[org] 你已同意接手 ${task.id} 子任务 ${sub.id}，状态：进行中。完成后 /org report ${task.id} ${sub.id} <摘要>。`;
			}
			case 'reject': {
				const subId = (rest[0]?.trim() || firstSubOf(task, meName)) ?? '';
				const reason = rest.slice(1).join(' ').trim();
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
				await saveTask(task);
				await notifyDispatcher(
					orgName,
					task,
					`处理人 ${meName} 拒绝了子任务 ${sub.id}：${reason}`,
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
				transitionAssignee(assignee, 'claimed', meName);
				task.history.push({ at: nowIso(), event: 'claimed', by: meName });
				await saveTask(task);
				return `[org] 你已领取 ${task.id} 子任务 ${sub.id}，开始执行。`;
			}
			case 'report': {
				const subId = (rest[0]?.trim() || firstSubOf(task, meName)) ?? '';
				const args = rest.slice(1);
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
				await saveTask(task);
				// 每次交付都通知派发人
				await notifyDispatcher(
					orgName,
					task,
					`处理人 ${meName} 已交付子任务 ${subId}：\n${summary}${fileFlags.length ? `\n产出：${fileFlags.join(', ')}` : ''}`,
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
	async function notifyDispatcher(orgName: string, task: Task, content: string): Promise<void> {
		const org = await readOrg(orgName);
		const dispatcher = org.members.find((m) => m.name === task.dispatcher);
		if (!dispatcher) return;
		void deliverMessage(
			orgName,
			dispatcher.name,
			`[org:report] 任务 ${task.id} 动态：\n${content}`,
		).catch((e) => log.warn('notify dispatcher fail', { err: e }));
	}

	pi.registerCommand('org', {
		description:
			'agent 组织（目录绑定）：orgs/create/join/leave/delete、status/tasks/my-tasks 视图、accept/reject/claim/report 处理人操作、approve/return/cancel/reassign 派发人操作',
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

	// ── 工具 ─────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: 'dispatch_task',
		label: '派发任务给子领域 agent（组织）',
		description:
			'向 org 成员派发任务（落官方任务记录，可指认）。你是该 org 负责人则单方生效（处理人不可拒）；否则走握手（处理人确认后才形成）。离线成员投递 inbox 不丢。可一次派给多个处理人（每人一个子任务）。',
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
						Type.String({ description: '子任务级期望完成时间（可空，继承任务级）' }),
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
							`${d.agent}:${d.mode === 'online' ? '在线送达' : d.mode === 'inbox' ? '已入收件箱(离线)' : '离线'}`,
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
				return textResult(`[org] 请指定 org（你所属：${orgs.join('、') || '无'}）。`, {});
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
		description: '列出我在各 org 作为处理人（待确认/进行中/待交付/返工）与作为派发人的任务。',
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
				Type.Array(Type.String({ description: '产出文件路径（可带 :行号 说明具体位置）' })),
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

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
