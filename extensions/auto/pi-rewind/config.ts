/**
 * pi-rewind 用户配置（扁平 schema，经 @zenone/pi-config 双层读写）。
 *
 * 层级：defaults → 用户级 `~/.pi/agent/extensions-data/pi-rewind/config.json`
 *       → 项目级 `<cwd>/.pi/extensions-data/pi-rewind/config.json`（覆盖用户级）。
 * 不开 session 级（无会话专属配置需求）。
 */

import { loadLayeredConfig } from '@zenone/pi-config';
import type { CheckpointConfig } from './engine';
import { resolveExcludePatterns } from './engine';
import { getBooleanField, getNumberField, isRecord, isString, isStringArray } from './util';

export type TreeRestoreMode = 'never' | 'ask' | 'always';
export type CheckpointTrigger = 'message' | 'event' | 'off';

export interface RewindConfig {
	/** 扩展总开关（false = 不注册命令、事件处理器全跳过）。 */
	enabled: boolean;
	/**
	 * checkpoint 创建策略：
	 * - `message`：每条用户消息打一个 checkpoint（before=消息前，after=loop 后）。
	 * - `event`：仅在 fork/clone/tree 等事件前打当前状态快照（before=after=快照点）。
	 * - `off`：完全不打。
	 * `batch`（每 N 条）已挂起，未进 schema。
	 */
	checkpointTrigger: CheckpointTrigger;
	/** `/tree` 导航时的文件回滚策略。 */
	restoreOnTree: TreeRestoreMode;
	/** `/fork` 时的文件回滚策略。 */
	restoreOnFork: TreeRestoreMode;
	/** fork 的 "at" 位（clone）文件回滚策略。 */
	restoreOnClone: TreeRestoreMode;
	/** 打开旧会话（resume / 启动选中）时是否回滚文件。 */
	restoreOnResume: boolean;
	/** checkpoint 存储保留天数（0 = 永不清理）。 */
	retentionDays: number;
	/** 单文件上限 MB（0 = 不设限）。 */
	maxFileMB: number | undefined;
	/** 跳过二进制文件。 */
	skipBinary: boolean;
	/** 是否纳入 untracked 文件。 */
	includeUntracked: boolean;
	/** 追加排除路径。 */
	exclude: string[];
	/** 重新包含路径。 */
	include: string[];
}

export const DEFAULT_REWIND_CONFIG: RewindConfig = {
	enabled: true,
	checkpointTrigger: 'message',
	restoreOnTree: 'ask',
	restoreOnFork: 'ask',
	restoreOnClone: 'never',
	restoreOnResume: false,
	retentionDays: 30,
	maxFileMB: 25,
	skipBinary: true,
	includeUntracked: true,
	exclude: [],
	include: [],
};

const TREE_MODES: readonly string[] = ['never', 'ask', 'always'];
const TRIGGERS: readonly string[] = ['message', 'event', 'off'];

function pickTreeMode(value: unknown): TreeRestoreMode | undefined {
	return isString(value) && TREE_MODES.includes(value) ? (value as TreeRestoreMode) : undefined;
}

function pickTrigger(value: unknown): CheckpointTrigger | undefined {
	return isString(value) && TRIGGERS.includes(value) ? (value as CheckpointTrigger) : undefined;
}

/** 校验单层读出的原始配置，只保留合法字段（非法值丢弃 → 走 defaults）。 */
export function validateRewindConfig(raw: unknown): Partial<RewindConfig> | null {
	if (!isRecord(raw)) return null;
	const out: Partial<RewindConfig> = {};

	const enabled = getBooleanField(raw, 'enabled');
	if (enabled !== undefined) out.enabled = enabled;

	const trigger = pickTrigger(raw.checkpointTrigger);
	if (trigger) out.checkpointTrigger = trigger;

	const tree = pickTreeMode(raw.restoreOnTree);
	if (tree) out.restoreOnTree = tree;

	const fork = pickTreeMode(raw.restoreOnFork);
	if (fork) out.restoreOnFork = fork;

	const clone = pickTreeMode(raw.restoreOnClone);
	if (clone) out.restoreOnClone = clone;

	const resume = getBooleanField(raw, 'restoreOnResume');
	if (resume !== undefined) out.restoreOnResume = resume;

	const retention = getNumberField(raw, 'retentionDays');
	if (retention !== undefined && retention >= 0) out.retentionDays = retention;

	const maxMb = getNumberField(raw, 'maxFileMB');
	if (maxMb !== undefined && maxMb >= 0) out.maxFileMB = maxMb === 0 ? undefined : maxMb;

	const skipBinary = getBooleanField(raw, 'skipBinary');
	if (skipBinary !== undefined) out.skipBinary = skipBinary;

	const includeUntracked = getBooleanField(raw, 'includeUntracked');
	if (includeUntracked !== undefined) out.includeUntracked = includeUntracked;

	if (isStringArray(raw.exclude)) out.exclude = [...raw.exclude];
	if (isStringArray(raw.include)) out.include = [...raw.include];

	return out;
}

/** 按会话 cwd 一次性读双层配置（无缓存，session_start 调用）。 */
export function loadRewindConfig(cwd: string): RewindConfig {
	const { config } = loadLayeredConfig<RewindConfig>({
		pluginName: 'pi-rewind',
		defaults: DEFAULT_REWIND_CONFIG,
		cwd,
		validate: validateRewindConfig,
	});
	return config;
}

/** 把用户配置映射成引擎侧 CheckpointConfig（含内置排除合并）。 */
export function toCheckpointConfig(config: RewindConfig): CheckpointConfig {
	return {
		exclude: resolveExcludePatterns(config.exclude, config.include),
		include: config.include,
		maxFileMB: config.maxFileMB,
		skipBinary: config.skipBinary,
		includeUntracked: config.includeUntracked,
	};
}
