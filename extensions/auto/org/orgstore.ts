// org — org 实体存储（具名多组织：create/join/leave/回归三选一/删除归档）
// 数据布局：~/.pi/org/<org名>/
//   org.json          静态登记（名称/负责人/成员）
//   history/<name>.json  离开档案（记录保留不删 → 回归继承依据）
//   runtime/<name>.json  在岗状态（每进程写自己的，按 org 一份）
//   tasks/<id>.json    org 官方任务记录
//   inbox/<agent>/<id>.json  离线派发暂存
//   todo-map.json      任务↔待办映射（org 侧持有）
// 删除 org = 整个目录挪到 ~/.pi/org/.trash/<org>-<ts>（归档可恢复，不物理抹掉）
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '@zenone/pi-logger';
import type {
	AgentManifest,
	AgentRole,
	JoinDisposition,
	OrgFile,
	OrgHistoryRecord,
	OrgMember,
} from './types.js';
import {
	assertSafeName,
	ensureDir,
	nowIso,
	orgRoot,
	readJson,
	realDir,
	writeJsonAtomic,
} from './util.js';
import { loadManifest } from './manifest.js';

const log = createLogger('org');

// ── 路径 helpers ─────────────────────────────────────────────────────────────

export function orgDir(org: string): string {
	return path.join(orgRoot(), assertSafeName(org));
}
export function orgFile(org: string): string {
	return path.join(orgDir(org), 'org.json');
}
export function historyDir(org: string): string {
	return path.join(orgDir(org), 'history');
}
export function historyFile(org: string, name: string): string {
	return path.join(historyDir(org), `${assertSafeName(name)}.json`);
}
export function taskDir(org: string): string {
	return path.join(orgDir(org), 'tasks');
}
export function taskFile(org: string, taskId: string): string {
	return path.join(taskDir(org), `${taskId}.json`);
}
export function runtimeDir(org: string): string {
	return path.join(orgDir(org), 'runtime');
}
export function runtimeFile(org: string, name: string): string {
	return path.join(runtimeDir(org), `${assertSafeName(name)}.json`);
}
export function inboxDir(org: string, name: string): string {
	return path.join(orgDir(org), 'inbox', assertSafeName(name));
}
/** 投递簿记（已注入 / 已见过的消息 id）——与 inbox 同构，一成员一文件（ADR-0054 `D7`/`D10`） */
export function inboxStateDir(org: string): string {
	return path.join(orgDir(org), 'inbox-state');
}
export function inboxStateFile(org: string, name: string): string {
	return path.join(inboxStateDir(org), `${assertSafeName(name)}.json`);
}
/** 执行槽（成员此刻在跑哪个任务；租约制，ADR-0055 `D2`） */
export function slotDir(org: string): string {
	return path.join(orgDir(org), 'slots');
}
export function slotFile(org: string, name: string): string {
	return path.join(slotDir(org), `${assertSafeName(name)}.json`);
}
export function todoMapFile(org: string): string {
	return path.join(orgDir(org), 'todo-map.json');
}
export function trashDir(): string {
	return path.join(orgRoot(), '.trash');
}

/** 列出全部 org 名（排除 .trash 等非 org 目录） */
export async function listOrgNames(): Promise<string[]> {
	const root = orgRoot();
	let entries: string[] = [];
	try {
		entries = await fs.readdir(root);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		if (e.startsWith('.')) continue;
		const p = path.join(root, e);
		try {
			const st = await fs.stat(p);
			if (st.isDirectory() && (await readJson<OrgFile>(path.join(p, 'org.json'))))
				out.push(e);
		} catch {
			// 非 org 目录（无 org.json 或损坏）跳过
			log.debug('skip non-org dir', { entry: e });
		}
	}
	return out.sort((a, b) => a.localeCompare(b));
}

export async function readOrg(org: string): Promise<OrgFile> {
	const file = orgFile(org);
	const raw = await readJson<OrgFile>(file);
	if (!raw) {
		throw new Error(`org「${org}」不存在或无法读取：${file}。先让负责人 /org create。`);
	}
	return raw;
}

export async function orgExists(org: string): Promise<boolean> {
	try {
		await readOrg(org);
		return true;
	} catch {
		return false;
	}
}

/**
 * 写花名册。
 *
 * ⚠️ 无并发守卫（与任务账本 `saveTask` 的乐观锁不同）：`readOrg → 改动 → writeOrg` 的调用方
 * 之间是 last-write-wins，多进程同时改 org.json（如两个成员同时在岗注册回写简档、
 * 或人类改 autoWake 时恰好有成员在岗注册）可能丢更新。已知边界，见 ADR-0040 D11 注。
 */
async function writeOrg(org: OrgFile): Promise<void> {
	org.updatedAt = nowIso();
	await writeJsonAtomic(orgFile(org.name), org);
}

// ── per-org 写锁（ADR-0051 审查 11；亦用于巡检的逾期扫描串行化）───────────────
//
// 为何不放在 writeOrg 里：要防的是 `readOrg → 改动 → writeOrg` **整段**被打断（两个进程
// 各读到旧版、各自写回 ⇒ 后写者抹掉前者的改动），锁必须罩住读与写两端。巡检的
// `listTasks → markOverdue → saveTask → 通知` 也是同一类「读-改-写 + 副作用」序列，复用此锁。
// 为何是锁文件：参与者可能不是一个进程（人类看板 + 成员在岗回写），进程内的互斥栈无效。
// 可重入：joinOrg 等路径内部会再调 refresh*，同一 async 链路重入直接放行，避免自锁。
// **必须用 async 上下文判断**：用进程级集合/计数会把「同进程的两个并发调用者」误判成
// 「重入」而双双跳过锁（首版就是这么错的）。

const lockContext = new AsyncLocalStorage<Set<string>>();
const LOCK_WAIT_MS = 2000;
/** 超过这个年龄的锁视为进程崩溃残留，可抢占（正常持有是毫秒级） */
const LOCK_STALE_MS = 10_000;

/** 在 per-org 写锁内执行 fn（改花名册用）。导出仅供测试直接验证互斥与可重入。 */
export async function withOrgLock<T>(orgName: string, fn: () => Promise<T>): Promise<T> {
	const held = lockContext.getStore();
	// 真·重入：当前 async 链路已持有这把锁（不是同进程的另一个并发调用者）
	if (held?.has(orgName)) return fn();
	const lockFile = path.join(orgDir(orgName), '.write.lock');
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
		try {
			handle = await fs.open(lockFile, 'wx'); // O_EXCL：同一时刻只有一个持有者
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST') throw e;
			const st = await fs.stat(lockFile).catch(() => null);
			if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
				await fs.unlink(lockFile).catch(() => {});
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`org「${orgName}」花名册写入锁超时（${LOCK_WAIT_MS}ms）——另一个写者未释放，请重试`,
				);
			}
			await sleep(25);
			continue;
		}
		try {
			const store = held ?? new Set<string>();
			return await lockContext.run(store, async () => {
				store.add(orgName);
				try {
					return await fn();
				} finally {
					store.delete(orgName);
				}
			});
		} finally {
			await handle.close().catch(() => {});
			await fs.unlink(lockFile).catch(() => {});
		}
	}
}

/** 与 lifecycle.ts 同形的极简 sleep（等锁用，毫秒级） */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 当前目录所属的全部 org（active member.dir == realDir(cwd)） */
export async function findOrgsForDir(dir: string): Promise<OrgFile[]> {
	const norm = realDir(dir);
	const names = await listOrgNames();
	const out: OrgFile[] = [];
	for (const name of names) {
		try {
			const org = await readOrg(name);
			if (org.members.some((m) => realDir(m.dir) === norm)) out.push(org);
		} catch {
			// 跳过损坏 org
		}
	}
	return out;
}

/** 在指定 org 内按目录找 active 成员 */
export async function findMemberByDir(org: OrgFile, dir: string): Promise<OrgMember | null> {
	const norm = realDir(dir);
	return org.members.find((m) => realDir(m.dir) === norm) ?? null;
}

/** 在指定 org 内按名找 active 成员 */
export function findMemberByName(org: OrgFile, name: string): OrgMember | null {
	return org.members.find((m) => m.name === name) ?? null;
}

export async function readHistory(org: string, name: string): Promise<OrgHistoryRecord | null> {
	return readJson<OrgHistoryRecord>(historyFile(org, name));
}

// ── create / join / leave ────────────────────────────────────────────────────

/** 创建 org：在负责人目录执行，登记当前目录为该 org 负责人（一步完成「创建公司 + 指定负责人」） */
export async function createOrg(
	orgName: string,
	opts: { name: string; dir: string; label?: string; description?: string; launchArgs?: string },
): Promise<OrgFile> {
	const name = assertSafeName(orgName);
	if (await orgExists(name)) {
		throw new Error(`org「${name}」已存在。要加入请 /org join ${name}。`);
	}
	const dir = realDir(opts.dir);
	const member: OrgMember = {
		name: opts.name,
		dir,
		role: 'chief',
		manifest: { label: opts.label, description: opts.description },
		joinedAt: nowIso(),
	};
	// 初值只在**非空白**时落盘（与「清空 = 删除该字段」同一口径，ADR-0051 D2/D3）
	if (opts.launchArgs?.trim()) member.launchArgs = opts.launchArgs.trim();
	const org: OrgFile = {
		schemaVersion: 1,
		name,
		chiefName: opts.name,
		chiefDir: dir,
		createdAt: nowIso(),
		updatedAt: nowIso(),
		members: [member],
	};
	await ensureDir(orgDir(name));
	await writeJsonAtomic(orgFile(name), org);
	log.info('org 创建', { org: name, chief: opts.name, dir });
	return org;
}

/** 成员名缺省 = 目录 basename */
export function defaultAgentName(dir: string): string {
	const base = path.basename(dir);
	return assertSafeName(base);
}

export function memberFromManifest(
	manifest: AgentManifest,
	dir: string,
): { name: string; role: AgentRole; label?: string; description?: string } {
	const name = manifest.name ? assertSafeName(manifest.name) : defaultAgentName(dir);
	const role: AgentRole = manifest.role === 'chief' ? 'chief' : 'member';
	return { name, role, label: manifest.label, description: manifest.description };
}

export interface JoinResult {
	org: OrgFile;
	member: OrgMember;
	/** true = 需要人类三选一（历史同名回归） */
	dispositionRequired: boolean;
	history?: OrgHistoryRecord | null;
	/** 已存在同名同目录（幂等 join） */
	already?: boolean;
}

/**
 * 加入指定 org。加入方携 manifest（名字/角色）+ 目录。
 * - org 不存在 → 抛错（先让负责人 create）
 * - 该 ID（name）在该 org 历史上存在过（history 档案）→ 返回 dispositionRequired，
 *   由人类三选一（inherit 继承 / fresh 清空重来 / exit 退出改 ID 再加入）
 * - 已是 active 成员同目录 → 幂等（already）
 * - 同名不同目录 active → 冲突抛错
 * - role=chief 且 org 已有 chief → 拒绝（一个 org 一个负责人）
 */
export async function joinOrg(
	orgName: string,
	opts: {
		manifest: AgentManifest;
		dir: string;
		disposition?: JoinDisposition;
		/** 启动参数初值（由调用方从插件配置读取；ADR-0051 D2）；缺省则成员记录不带该字段 */
		launchArgs?: string;
	},
): Promise<JoinResult> {
	const org = await readOrg(orgName);
	const { name, role, label, description } = memberFromManifest(opts.manifest, opts.dir);
	const dir = realDir(opts.dir);

	// 幂等：同目录同名同角色的 active 成员（角色不同 = 成员想升/降负责人，不走幂等）
	const sameDir = await findMemberByDir(org, dir);
	if (sameDir && sameDir.name === name && sameDir.role === role) {
		return { org, member: sameDir, dispositionRequired: false, already: true };
	}
	// 同名不同目录 active → 冲突（同目录视为角色变更/重登记，不冲突）
	const sameName = findMemberByName(org, name);
	if (sameName && realDir(sameName.dir) !== dir) {
		throw new Error(`org「${orgName}」已有名为「${name}」的成员（目录 ${sameName.dir}）。`);
	}

	// 历史同名回归 → 需人类三选一
	const history = await readHistory(orgName, name);
	if (history && opts.disposition === undefined) {
		return { org, member: emptyMember(), dispositionRequired: true, history };
	}
	if (history && opts.disposition === 'fresh') {
		await fs.unlink(historyFile(orgName, name)).catch(() => {
			log.debug('history file already gone', { org: orgName, name });
		});
	}
	if (history && opts.disposition === 'exit') {
		throw new Error(
			`已按你的选择退出加入；请修改 agent 名（pi.agent.json name 或目录名）后重新加入。`,
		);
	}

	// chief 唯一
	if (role === 'chief' && org.chiefName) {
		throw new Error(`org「${orgName}」已有负责人 ${org.chiefName}。一个 org 只有一个负责人。`);
	}

	const member: OrgMember = {
		name,
		dir,
		role,
		manifest: { label, description },
		joinedAt: nowIso(),
	};
	// 初值只在**非空白**时落盘（与「清空 = 删除该字段」同一口径，ADR-0051 D2/D3）
	if (opts.launchArgs?.trim()) member.launchArgs = opts.launchArgs.trim();
	org.members = org.members.filter((m) => m.name !== name || realDir(m.dir) !== dir);
	org.members.push(member);
	if (role === 'chief') {
		org.chiefName = name;
		org.chiefDir = dir;
	}
	await writeOrg(org);

	// 继承路径：给既有 history 档案追加 joined 事件
	if (history && opts.disposition === 'inherit') {
		history.events.push({ at: nowIso(), type: 'joined' });
		history.dir = dir;
		await writeJsonAtomic(historyFile(orgName, name), history);
	} else {
		// 记录离开档案由 leave 写；首次 join 不建档案，leave 时才建
	}
	log.info('join', { org: orgName, name, role, dir });
	return { org, member, dispositionRequired: false };
}

function emptyMember(): OrgMember {
	return {
		name: '',
		dir: '',
		role: 'member',
		manifest: {},
		joinedAt: nowIso(),
	};
}

/**
 * 从指定 org 移除当前目录（仅人类用户在其目录下执行）。
 * 返回 leave 的成员；orgstore 侧完成「active → history 档案」，
 * 未结子任务盘点由调用方（index 命令层）在执行前查询并确认。
 */
export async function leaveOrg(
	orgName: string,
	dir: string,
	note?: string,
): Promise<{ left: boolean; member?: OrgMember; history?: OrgHistoryRecord }> {
	const org = await readOrg(orgName);
	const norm = realDir(dir);
	const idx = org.members.findIndex((m) => realDir(m.dir) === norm);
	if (idx === -1) {
		return { left: false };
	}
	const [member] = org.members.splice(idx, 1);
	// 负责人离开后 org 无负责人：新负责人日后以 chief 角色加入（先清理再写盘）
	if (org.chiefName === member.name) {
		org.chiefName = undefined;
		org.chiefDir = undefined;
	}
	await writeOrg(org);

	// 成员记录保留（不删）：active → history 档案，供回归继承判断
	const hist = await readHistory(orgName, member.name);
	const events = hist?.events ?? [];
	events.push({ at: nowIso(), type: 'left', note });
	const record: OrgHistoryRecord = {
		schemaVersion: 1,
		org: orgName,
		name: member.name,
		dir: member.dir,
		events,
		leftAt: nowIso(),
	};
	await ensureDir(historyDir(orgName));
	await writeJsonAtomic(historyFile(orgName, member.name), record);
	return { left: true, member, history: record };
}

/** 删除整个 org：先归档到 ~/.pi/org/.trash/<org>-<ts>（可恢复，不物理抹掉） */
export async function removeOrg(
	orgName: string,
): Promise<{ removed: boolean; archivedTo?: string }> {
	if (!(await orgExists(orgName))) {
		return { removed: false };
	}
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const target = path.join(trashDir(), `${orgName}-${ts}`);
	await ensureDir(trashDir());
	await fs.rename(orgDir(orgName), target);
	log.warn('org 删除（已归档）', { org: orgName, archivedTo: target });
	return { removed: true, archivedTo: target };
}

/**
 * 公司改名（人类操作）：公司名只存在于自己这棵数据树里，改名 = 换目录名 + 同步树内名字字段。
 * 迁移点（全部在 ~/.pi/org/<名>/ 内，成员工作目录不受影响）：
 *   1) 目录 rename（原子）
 *   2) org.json.name
 *   3) tasks/*.json 的 .org 字段（saveTask 以 task.org 定位目录，硬引用）
 *   4) todo-map.json 每条 entry.org
 * 注意：成员侧存量 todo 文件的 `org:<旧名>` tag 属派生展示，不自动刷新，投影重建时自然更新；
 * 改名期间若有成员进程在线，其 runtime/inbox 写入可能落到旧路径——建议成员睡眠时改名。
 */
export async function renameOrg(
	oldName: string,
	newName: string,
): Promise<{ renamed: boolean; from: string; to: string }> {
	const from = assertSafeName(oldName);
	const to = assertSafeName(newName);
	if (from === to) throw new Error('新旧公司名相同。');
	if (!(await orgExists(from))) throw new Error(`公司「${from}」不存在。`);
	if (await orgExists(to)) throw new Error(`公司「${to}」已存在，请换一个名字。`);

	// 1) 整棵树换名（同文件系统原子 rename）
	await fs.rename(orgDir(from), orgDir(to));

	// 2) org.json.name
	const org = await readOrg(to);
	org.name = to;
	await writeOrg(org);

	// 3) 任务账本的 .org 字段
	const dir = taskDir(to);
	// 只吞「无 tasks 目录」（ENOENT）；其它错误必须冒泡——否则会静默中止剩余迁移，
	// 未迁移的任务保留旧 .org，其后 saveTask 会经 ensureDir 重建旧公司目录（孤儿数据）。
	let taskFiles: string[];
	try {
		taskFiles = await fs.readdir(dir);
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
		taskFiles = [];
	}
	for (const f of taskFiles) {
		if (!f.endsWith('.json')) continue;
		const p = path.join(dir, f);
		const t = await readJson<{ org?: string }>(p);
		if (t && t.org === from) {
			t.org = to;
			await writeJsonAtomic(p, t);
		}
	}

	// 4) todo 投影映射的 entry.org
	const mapFile = todoMapFile(to);
	const map = await readJson<{ entries: { org?: string }[] }>(mapFile);
	if (map?.entries) {
		let changed = false;
		for (const e of map.entries) {
			if (e.org === from) {
				e.org = to;
				changed = true;
			}
		}
		if (changed) await writeJsonAtomic(mapFile, map);
	}

	log.info('公司改名完成', { from, to });
	return { renamed: true, from, to };
}

/**
 * 负责人转移（人类操作）：被指成员升 chief，原 chief 自动降为普通成员（仍留在成员列表）。
 * 只写 org.json（两人 role + chiefName/chiefDir）；成员工作目录与任务账本不受影响。
 */
export async function transferChief(orgName: string, newChiefName: string): Promise<void> {
	const org = await readOrg(orgName);
	const next = org.members.find((m) => m.name === newChiefName);
	if (!next) throw new Error(`成员「${newChiefName}」不在公司「${orgName}」中。`);
	if (org.chiefName === newChiefName) throw new Error(`「${newChiefName}」已经是负责人。`);
	const prev = org.members.find((m) => m.name === org.chiefName);
	if (prev) prev.role = 'member';
	next.role = 'chief';
	org.chiefName = next.name;
	org.chiefDir = next.dir;
	await writeOrg(org);
	log.info('负责人转移', { org: orgName, from: prev?.name, to: next.name });
}

/** 该 org 是否开启「负责人派活时自动唤醒睡眠成员」（缺省关，ADR-0040 D8） */
export function autoWakeEnabled(org: OrgFile): boolean {
	return org.settings?.autoWake === true;
}

/**
 * 快照口径：`label` 与 agent 名相同 ⇒ 视为「未声明显示名」（与 `meName()` 一致）。
 *
 * 必须做这个归一，否则 `loadManifest` 会把未声明的 label 默认成 agent 名，
 * 与快照里的 `undefined` 永远不等 ⇒ 每次刷新都误判为"有变化"并重写 org.json。
 */
function profileOf(input: { name?: string; label?: string; description?: string }): {
	label?: string;
	description?: string;
} {
	const label = input.label && input.label !== input.name ? input.label : undefined;
	return { label, description: input.description };
}

/**
 * 用目录当前的 manifest 刷新 org.json 里的**成员简档快照**（ticket 06 路径①）。
 *
 * 由在岗注册时调用——这是**成员自己的启动动作**，不是感知循环，故不违反
 * ADR-0040 D4「感知与动作分离」。无变化则不写盘。返回是否发生了变更。
 */
export async function refreshMemberManifest(
	orgName: string,
	dir: string,
	manifest: { label?: string; description?: string },
): Promise<boolean> {
	// 11：与「人类改启动参数」等写路径共用同一个 per-org 锁（读→改→写整段）
	return withOrgLock(orgName, async () => {
		const org = await readOrg(orgName);
		const member = await findMemberByDir(org, dir);
		if (!member) return false;
		const next = profileOf({
			name: member.name,
			label: manifest.label,
			description: manifest.description,
		});
		if (
			member.manifest?.label === next.label &&
			member.manifest?.description === next.description
		) {
			return false;
		}
		member.manifest = next;
		await writeOrg(org);
		log.info('成员简档刷新', { org: orgName, member: member.name });
		return true;
	});
}

/**
 * 重读本 org **全体成员目录**的 `pi.agent.json` 并对齐快照（ticket 06 路径②）。
 *
 * 由看板 `r`（**人类显式动作**）调用——不放进巡检（ADR-0040 D4 红线）。
 * 目录不存在 / 无 manifest 的成员跳过（保留原快照，不破坏）。返回变更人数。
 */
export async function refreshAllMemberManifests(orgName: string): Promise<number> {
	// 11：同上——批量刷新也可能与单点写入相撞
	return withOrgLock(orgName, async () => {
		const org = await readOrg(orgName);
		let changed = 0;
		for (const member of org.members) {
			// loadManifest 自身容错（目录不存在 / JSON 非法 → null）——保留原快照
			const fresh = await loadManifest(member.dir);
			if (!fresh) continue;
			const next = profileOf(fresh);
			if (
				member.manifest?.label === next.label &&
				member.manifest?.description === next.description
			) {
				continue;
			}
			member.manifest = next;
			changed++;
		}
		if (changed > 0) {
			await writeOrg(org);
			log.info('成员简档批量刷新', { org: orgName, changed });
		}
		return changed;
	});
}

/** 设置 org 背景（空串/空白 = 清除该字段）— 见 ADR-0042 D5 */
export async function setBackground(orgName: string, background: string): Promise<void> {
	const org = await readOrg(orgName);
	const trimmed = background.trim();
	if (trimmed) org.background = trimmed;
	else delete org.background;
	await writeOrg(org);
	log.info('组织背景变更', { org: orgName, len: trimmed.length });
}

/** 写入「自动唤醒」开关（读-改-写；与 transferChief 同路径 writeOrg 持久化） */
export async function setAutoWake(orgName: string, enabled: boolean): Promise<void> {
	const org = await readOrg(orgName);
	org.settings = { ...org.settings, autoWake: enabled };
	await writeOrg(org);
	log.info('自动唤醒开关变更', { org: orgName, autoWake: enabled });
}

/**
 * 设置某成员的启动参数（ADR-0051 D1/D3/D4）——看板人类操作台的唯一写入口。
 * 空串/空白 = 清除该字段（此后唤醒不带任何额外参数）；每次都留修改时间。
 */
export async function setMemberLaunchArgs(
	orgName: string,
	memberName: string,
	launchArgs: string,
): Promise<OrgMember> {
	// 11：人类改参数与成员在岗回写简档会撞同一份 org.json——这次改动必须在锁内读→改→写
	return withOrgLock(orgName, async () => {
		const org = await readOrg(orgName);
		const member = findMemberByName(org, memberName);
		if (!member) throw new Error(`成员 ${memberName} 不在组织「${orgName}」中。`);
		const trimmed = launchArgs.trim();
		if (trimmed) member.launchArgs = trimmed;
		else delete member.launchArgs;
		member.launchArgsUpdatedAt = nowIso();
		await writeOrg(org);
		log.info('成员启动参数变更', { org: orgName, member: memberName, launchArgs: trimmed });
		return member;
	});
}
