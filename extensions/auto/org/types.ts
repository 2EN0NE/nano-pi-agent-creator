// org — 共享类型定义（目录绑定 agent 框架）
// 术语见 CONTEXT.md「多 agent 框架」节；决策见 ADR-0038。

// ── Agent manifest ───────────────────────────────────────────────────────────

export type AgentRole = 'chief' | 'member';

/** agent 目录根的 pi.agent.json 内容（轻量元数据入口，正文仍用 AGENTS.md） */
export interface AgentManifest {
	/** 唯一名（org 内 registry key）；缺省 = 目录 basename */
	name?: string;
	/** 显示名（中文名等）；缺省 = name */
	label?: string;
	/** 角色：chief = 负责人（org 唯一通才），member = 子领域 agent；缺省 member */
	role?: AgentRole;
	/** 一句话职责描述（派发人据此决策派给谁） */
	description?: string;
	/** 工具白名单（声明性；实际强制由 sandbox 负责） */
	tools?: string[];
	/** 沙箱 scope 预留 */
	sandbox?: Record<string, unknown>;
	/** 记忆载体路径预留（D4 暂缓） */
	memory?: string;
	/** 对 member 可选：本 agent 的负责人名 */
	chief?: string;
}

// ── org 实体（具名多组织）────────────────────────────────────────────────────

/** org 成员（active） */
export interface OrgMember {
	/** agent 名（org 内唯一；曾同名回归走历史三选一） */
	name: string;
	/** agent 目录绝对路径 */
	dir: string;
	/** 角色：chief = 该 org 负责人（org.json.chiefName 也指向） */
	role: AgentRole;
	/** manifest 摘要快照 */
	manifest: { label?: string; description?: string; tools?: string[] };
	/** 登记时间 */
	joinedAt: string;
	/**
	 * 唤醒时追加到固定启动项之后的参数（ADR-0051 D1/D2）。
	 * join 时写入插件配置里的初值；**字段缺失 ⇒ 不带任何额外参数**（不做兜底、不回填）。
	 */
	launchArgs?: string;
	/** 启动参数最后修改时间（人类操作台留下的留痕；ADR-0051 D4） */
	launchArgsUpdatedAt?: string;
}

/** org 静态登记文件 ~/.pi/org/<org>/org.json */
export interface OrgFile {
	schemaVersion: 1;
	/** org 名（= 目录名） */
	name: string;
	/** 负责人 agent 名（有且只有一个 chief） */
	chiefName?: string;
	/** 负责人目录（登记时 realDir） */
	chiefDir?: string;
	createdAt: string;
	updatedAt: string;
	members: OrgMember[];
	/** org 级设置（按组织存储，见 ADR-0040 D8） */
	settings?: OrgSettings;
	/** org 背景（使命/业务与协作约定）；在岗简报的静态块会带上它 — 见 ADR-0042 D5 */
	background?: string;
}

/** org 级设置（作用域 = 该组织；区别于插件配置里的界面偏好）— 见 ADR-0040 D8 */
export interface OrgSettings {
	/** 负责人派活时是否允许唤醒睡眠成员（缺省 = 关，即维持现状：落 inbox 兜底） */
	autoWake?: boolean;
}

/** 离开档案 ~/.pi/org/<org>/history/<name>.json：离开的成员记录不删除（可指认 + 回归继承依据） */
export interface OrgHistoryRecord {
	schemaVersion: 1;
	org: string;
	/** agent 名（join 时若同名记录存在 → 人类三选一） */
	name: string;
	dir: string;
	/** 历次加入/离开时间线 */
	events: { at: string; type: 'joined' | 'left'; note?: string }[];
	/** 该成员在此 org 期间参与的未结任务编号快照（可选留痕） */
	openTaskIds?: string[];
	leftAt: string;
}

/** join 回归时人类三选一 */
export type JoinDisposition = 'inherit' | 'fresh' | 'exit';

// ── runtime 在岗状态（按 org 各一份）────────────────────────────────────────

export interface RuntimeState {
	schemaVersion: 1;
	/** agent 名 */
	name: string;
	/** agent 目录 */
	dir: string;
	/** 本 pi 进程 pid */
	pid: number;
	/** control socket 路径 */
	socketPath: string;
	/** pi 会话 id */
	sessionId: string;
	/** busy = 正在处理 turn */
	busy: boolean;
	startedAt: string;
	updatedAt: string;
}

// ── 任务（task）—— 任务 → 子任务[] → 参与者[] ──────────────────────────────

export const TASK_STATUSES = ['todo', 'in_progress', 'waiting_accept', 'closed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 参与者（assignee）在子任务上的状态机：
 * invited(待确认/待领取) → claimed(领取=进行中) → delivered(交付)
 * → (打回) returned(返工，重新可领) → claimed … → delivered …
 * 非负责人派发（握手）：invited 需 accept/reject 才生效；reject = 拒绝剔除（带原因）。
 * chief 单方派发：invited 不可拒，处理人自行 claim 开干。
 */
export const ASSIGNEE_STATUSES = [
	'invited',
	'claimed',
	'delivered',
	'returned',
	'rejected',
	'cancelled',
] as const;
export type AssigneeStatus = (typeof ASSIGNEE_STATUSES)[number];

/** 一次交付：参与者把完成结果交回（结果摘要 + 产出文件可指到具体行） */
export interface Delivery {
	at: string;
	by: string;
	/** 结果摘要 */
	summary: string;
	/** 产出文件（路径 + 可选具体行说明） */
	files: { path: string; lines?: string }[];
	/** 备注/补充说明 */
	note?: string;
}

export interface Assignee {
	/** agent 名 */
	agent: string;
	/** agent 目录（join 时快照） */
	dir?: string;
	status: AssigneeStatus;
	/** 拒绝原因（status=rejected 时必须带，数据格式） */
	rejectedReason?: string;
	/** 返工轮次（打回一次 +1） */
	round: number;
	/** 交付记录（可能多轮；采纳标记在任务验收记录里） */
	deliveries: Delivery[];
	/** 该参与者视角是否被告知"无需继续"（情形 B 叫停） */
	stopped?: boolean;
}

/** 子任务：一个工作单元，可指派 1 或多个参与者（多人=同一份内容，情形 B 知情隔离） */
export interface SubTask {
	id: string;
	/** 子任务描述（参与者看到的具体内容；多人同做同一份时可相同） */
	description: string;
	/** 期望完成时间：子任务级可设，未设继承任务级 */
	dueAt?: string | null;
	/** 参与人（多人负责同一子任务时多个） */
	assignees: Assignee[];
}

/** 验收记录（任务级：派发人整体验收；打回可点明返工哪些子任务） */
export interface Acceptance {
	by: string;
	result: 'accepted' | 'rejected';
	at: string;
	/** 验收说明 / 打回原因（点明返工哪些点） */
	note?: string;
	/** 任务级返工计数（打回一次 +1；子任务级轮次在 Assignee.round） */
	round: number;
}

export interface TaskHistoryEntry {
	at: string;
	event: string;
	by: string;
	note?: string;
}

/** org 官方任务记录（~/.pi/org/<org>/tasks/<id>.json） */
export interface Task {
	schemaVersion: 1;
	/** 随机字母数字编号（org 内唯一、删除不复用） */
	id: string;
	org: string;
	/** 标题 */
	title: string;
	/** 概要背景（派发参照 handoff 结构） */
	background: string;
	/** 逐点任务清单 */
	items: string[];
	/** 派发人（只有派发人能验收与关闭任务） */
	dispatcher: string;
	/** 派发人角色（派发时判定：chief 单方 / member 握手） */
	dispatcherRole: AgentRole;
	/** 任务级期望完成时间（可空；子任务未设继承此值） */
	dueAt?: string | null;
	createdAt: string;
	updatedAt: string;
	/**
	 * 乐观写保护的单调修订号（saveTask 每次写入 +1）。缺省视为 0（兼容旧账本）。
	 * 相比毫秒精度的 `updatedAt`，能发现「同一毫秒内的先后写」这一盲区。
	 */
	revision?: number;
	/** 任务聚合状态 */
	status: TaskStatus;
	/** 子任务数组 */
	subTasks: SubTask[];
	/** 验收记录（closed 时必有 accepted） */
	acceptance?: Acceptance;
	/** 是否曾未在岗投递（inbox） */
	inboxed?: boolean;
	/** 状态机历史（可指认） */
	history: TaskHistoryEntry[];
	/** 新任务引用旧任务（关闭即终态，重开只能新任务并引用） */
	reopensRef?: string;
	/** 被本任务关闭引用的旧任务记录该 id（反向指针，可选） */
	reopenedBy?: string;
}

/** 员工工作台 任务↔待办 映射（org 侧持有，不写进待办文件） */
export interface TodoMapEntry {
	taskId: string;
	org: string;
	/** 子任务 id（一个任务每个子任务/参与者可各自映射到其待办） */
	subTaskId: string;
	/** agent（工作台主人） */
	agent: string;
	/** 待办文件 id（裸 hex8；todos 插件文件名 = `<hex8>.md`，TODO- 为展示前缀） */
	todoId: string;
	/** 方向：in = 收到（处理人），out = 派出（派发人自己待办） */
	direction: 'in' | 'out';
}

// ── socket RPC（control 协议子集）───────────────────────────────────────

export interface RpcCommand {
	/**
	 * 我们**会发出**的命令子集（control 协议）：
	 * - `send` / `ping`：既有；
	 * - `get_message`：取最后一条 assistant 文本；
	 * - `get_history`：取最近若干条事件（只读观测，ADR-0052）；
	 * - `abort`：中断当前轮次（ADR-0053）。
	 */
	type: 'send' | 'ping' | 'get_message' | 'get_history' | 'abort';
	id?: string;
	message?: string;
	mode?: 'steer' | 'follow_up';
	/** `get_history` 专用：要几条（control 侧会夹到 1..50） */
	limit?: number;
}

export interface RpcResponse {
	type: 'response';
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
	id?: string;
}

export interface RpcEvent {
	type: 'event';
	event: string;
	data?: unknown;
}

/** 待办文件正文里的交付节标记（员工把结果写在此节后标 done = 交付声明） */
export const DELIVERY_SECTION = '## 交付';
