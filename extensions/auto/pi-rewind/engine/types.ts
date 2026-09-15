/**
 * Checkpoint 引擎的配置与类型（纯类型/纯函数，零 Pi 依赖）。
 *
 * 配置的读取与校验由扩展层经 `@zenone/pi-config` 完成，引擎只接收普通对象。
 */

/** 引擎侧配置（扩展层把用户配置映射成这个子集再传入）。 */
export interface CheckpointConfig {
	/** 最终写入 `info/exclude` 的完整排除（内置高置信排除 + 用户 exclude + include 重包含）。 */
	readonly exclude: readonly string[];
	/** 用户 include 原始值（`resolveExcludePatterns` 已处理重包含）。 */
	readonly include: readonly string[];
	/** 跳过超过该 MB 的变更文件；undefined = 不设限。 */
	readonly maxFileMB: number | undefined;
	/** 跳过二进制文件（读前 8KB 探测 NUL 字节）。 */
	readonly skipBinary: boolean;
	/** 是否纳入 untracked 文件；false = 只 stage 已 track 的文件。 */
	readonly includeUntracked: boolean;
}

/** 单个文件变更的统计。 */
export interface FileChange {
	/** 相对路径。 */
	readonly path: string;
	/** 新增行数。 */
	readonly added: number;
	/** 删除行数。 */
	readonly removed: number;
}

/** 每个 checkpoint 的元数据（历史遗留，保留类型导出）。 */
export interface CheckpointMeta {
	readonly entryId: string;
	readonly commitHash: string;
	readonly timestamp: number;
	readonly prompt: string;
	readonly fileCount: number;
	readonly fileChanges: readonly FileChange[];
}
