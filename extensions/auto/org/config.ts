// org 插件配置（**用户级**）—— @zenone/pi-config（AGENTS.md「扩展的配置文件设计」）。
//
// 这里承载**插件级**的两类内容（ADR-0051：本文件从"只看板界面偏好"扩展为"org 插件级默认"）：
// ① 看板界面偏好（排序方向、行尾标注）——单机全局的界面选择；
// ② 成员/公司相关的行为默认（如成员启动参数的初值）。
//
// 为什么只用用户级、不启用项目级/会话级：
// 这两类都是**单机全局**的选择——换项目不改变人对看板的口味，也不改变他给成员起进程的习惯；
// 提供项目级覆盖只会多一条"同一个人在两处配置不一致"的困惑来源。
//
// 反例（**不**迁移）：`autoWake`、`background` 是**按组织**的领域数据；成员启动参数一旦在
// join 时写入成员记录就是**按成员**的领域数据——两者都存在 `org.json`（`~/.pi/org/<org>/`）。
// pi-config 是"每插件一份"，表达不了"每组织/每成员一份"，迁移会破坏领域模型：
// 本文件里的 `memberLaunchArgs` 只是**加入时的初值**，成员记录才是唯一真值（ADR-0051 D1/D2）。

import { createConfigStore } from '@zenone/pi-config';
import type { ConfigStore } from '@zenone/pi-config';

/** 看板界面偏好（用户级，单机全局） */
export interface BoardPrefs {
	sortNewFirst: boolean;
	annotate: boolean;
}

/** 成员/公司相关的行为默认（用户级，单机全局） */
export interface OrgBehaviorDefaults {
	/** 新成员加入时的启动参数初值（改后只影响此后加入的成员；ADR-0051 D2） */
	memberLaunchArgs: string;
	/**
	 * 每个成员的**排队上限**（ADR-0055 `D4`）：名下「待领取」待办达到此数时，派活**明确拒绝**
	 * 而不是无限堆积。`0` = 不限制；实测后再调。
	 */
	memberQueueCap: number;
	/**
	 * 执行槽（ADR-0055 `D2`）的僵尸回收阈值（毫秒）。
	 * 仅在"无 pid / 无法判定存活"时生效；**有死亡实证时不受此阈值保护**。
	 * `false` = 禁用自动回收；数值钳位 5min–24h（默认 20min）。
	 */
	abandonedSlotReleaseAfterMs: number | false;
}

/** org 插件配置（界面偏好 + 行为默认） */
export type OrgPluginConfig = BoardPrefs & OrgBehaviorDefaults;

/** 内置默认（新装用户的第一印象） */
export const DEFAULT_BOARD_PREFS: BoardPrefs = { sortNewFirst: true, annotate: true };

/**
 * 成员启动参数初值（ADR-0051）：成员进程默认**不带权限门**——它由代码在 tmux 里拉起、
 * 人类不在场，一旦被门禁的确认弹层拦住就是"既没执行也没失败"的无限挂起（事故记录见 ADR-0051）。
 */
export const DEFAULT_MEMBER_LAUNCH_ARGS = '--no-permission-gate';

/** 排队上限默认值（ADR-0055 `D4`）：先给一个小值，靠实测再调；`0` = 不限制 */
export const DEFAULT_MEMBER_QUEUE_CAP = 3;

/** 执行槽僵尸回收阈值默认值（ADR-0055 `D2`，口径与参考实现一致） */
export const DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS = 20 * 60 * 1000;

export const DEFAULT_ORG_PLUGIN_CONFIG: OrgPluginConfig = {
	...DEFAULT_BOARD_PREFS,
	memberLaunchArgs: DEFAULT_MEMBER_LAUNCH_ARGS,
	memberQueueCap: DEFAULT_MEMBER_QUEUE_CAP,
	abandonedSlotReleaseAfterMs: DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS,
};

/**
 * org 插件配置 store（用户级路径：`~/.pi/agent/extensions-data/org/config.json`）。
 * 项目级/会话级覆盖**有意未启用**（见文件头注释）。
 */
export const orgConfigStore: ConfigStore<OrgPluginConfig> = createConfigStore<OrgPluginConfig>({
	pluginName: 'org',
	defaults: DEFAULT_ORG_PLUGIN_CONFIG,
});

/** 加入组织时给新成员的启动参数初值（读插件配置当前值；成员记录一经写入即以其为准） */
export function defaultMemberLaunchArgs(): string {
	// trim 后再回：配置里写成纯空白与「不设」等价，否则会往成员记录里写一个空白字段
	// （而清空语义是删除该字段，见 ADR-0051 D2/D3）
	return (orgConfigStore.get().memberLaunchArgs ?? '').trim();
}

/**
 * 解析排队上限配置：`0`/非法值 → `undefined`（不限制）；其余取整且至少 1。
 * 口径与参考实现 `resolveMaxActiveAsyncRunsPerSession` 一致（`0` 即"不限"）。
 */
export function resolveMemberQueueCap(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
	return value;
}

/**
 * 手工启动在岗成员的**标准命令**（供命令提示共用；README 改不了代码，故那边只注明来源）。
 *
 * 为何要单一来源：这条命令散落在技能/README/两个命令回复里，改一处漏一处必然导致
 * 「同一个组织两种起法」——ADR-0051 D5 要消灭的正是这个形态。固定核在 launch-args 模块，
 * 追加的默认值在插件配置，这里把两者拼成一句给人看的命令。
 */
export function manualStartHint(): string {
	const extra = defaultMemberLaunchArgs();
	return `pi -a --session-control${extra ? ` ${extra}` : ''}`;
}
