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

async function writeOrg(org: OrgFile): Promise<void> {
	org.updatedAt = nowIso();
	await writeJsonAtomic(orgFile(org.name), org);
}

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
	opts: { name: string; dir: string; label?: string; description?: string },
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
	opts: { manifest: AgentManifest; dir: string; disposition?: JoinDisposition },
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
