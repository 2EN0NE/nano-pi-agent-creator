import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { createConfigStore, type ConfigStore } from '@zenone/pi-config';

/**
 * custom-rename 配置 schema。
 *
 * 双层路径（@zenone/pi-config 统一管理，defaults → user → project 深合并 + 原子写）：
 *   用户级：~/.pi/agent/extensions-data/custom-rename/config.json
 *   项目级：<cwd>/.pi/extensions-data/custom-rename/config.json
 */

// ──────────────────────── 类型 ────────────────────────

/** 模型选择器：仅 ref 精确指定 provider/modelId。 */
export type ModelSelector = { type: 'ref'; ref: string };

export interface RenameSessionConfig {
	/** 自动重命名开关（默认 false）。 */
	enabled: boolean;
	/** 标题生成用的模型 selector（仅支持 ref 精确指定；未配置时默认为空 ref，解析不到模型则跳过）。 */
	model: ModelSelector;
	/** 标题最大长度（Unicode 码点数）。 */
	maxTitleLength: number;
	/** 标题生成 LLM 的 thinking 级别（默认 "off"）。 */
	thinkingLevel: ModelThinkingLevel;
}

/** 合法 thinking 级别清单（与 pi-ai ModelThinkingLevel 一致；normalize 校验用）。 */
const THINKING_LEVELS: ReadonlySet<string> = new Set([
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
]);

// ──────────────────────── 环境变量覆盖 ────────────────────────

/** 环境变量前缀（避免与其他配置冲突）。 */
const ENV_PREFIX = 'PI_RENAME_';

/**
 * "provider/modelId" ref → 拆分。用 indexOf 而非 split：modelId 理论上可含 /，
 * 只取首个 / 作分隔（"a/b/c" → provider:"a", modelId:"b/c"）。
 * 无 /、/ 在首尾（provider 或 modelId 为空）→ null。
 * 是 env 覆盖校验与 config 文件 ref 解析的唯一实现（两路口径一致）。
 */
export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
	const idx = ref.indexOf('/');
	if (idx <= 0 || idx >= ref.length - 1) return null;
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/**
 * 从环境变量读取配置覆盖值（live 读取，每次调用查 process.env）。
 *
 * 支持的环境变量：
 * - `PI_RENAME_ENABLED`: 自动重命名开关（"true"/"false"）
 * - `PI_RENAME_MODEL`: 模型引用（"provider/model" 格式，映射为 {type:"ref", ref:"provider/model"}）
 * - `PI_RENAME_MAX_TITLE_LENGTH`: 标题最大长度（正整数）
 * - `PI_RENAME_THINKING_LEVEL`: thinking 级别（枚举值）
 *
 * 返回 Partial<RenameSessionConfig>，仅包含有效覆盖值。无效值静默忽略（不阻断加载）。
 */
function getEnvOverrides(): Partial<RenameSessionConfig> {
	const overrides: Partial<RenameSessionConfig> = {};

	const enabledEnv = process.env[`${ENV_PREFIX}ENABLED`];
	if (enabledEnv !== undefined) {
		if (enabledEnv === 'true') overrides.enabled = true;
		else if (enabledEnv === 'false') overrides.enabled = false;
		// 其他值静默忽略（让 config 文件接管）
	}

	const modelEnv = process.env[`${ENV_PREFIX}MODEL`];
	if (modelEnv !== undefined && typeof modelEnv === 'string') {
		if (parseModelRef(modelEnv) !== null) {
			overrides.model = { type: 'ref', ref: modelEnv };
		}
		// 非法格式静默忽略（与 config 文件 ref 同一解析口径：parseModelRef）
	}

	const maxLengthEnv = process.env[`${ENV_PREFIX}MAX_TITLE_LENGTH`];
	if (maxLengthEnv !== undefined) {
		const parsed = Number(maxLengthEnv);
		if (Number.isInteger(parsed) && parsed > 0) {
			overrides.maxTitleLength = parsed;
		}
		// 非正整数静默忽略
	}

	const thinkingLevelEnv = process.env[`${ENV_PREFIX}THINKING_LEVEL`];
	if (thinkingLevelEnv !== undefined && isThinkingLevel(thinkingLevelEnv)) {
		overrides.thinkingLevel = thinkingLevelEnv;
		// 非法值静默忽略
	}

	return overrides;
}

/**
 * 类型谓词：unknown 是否为合法 thinking 级别（normalizeRenameConfig 校验用，单点断言）。
 */
function isThinkingLevel(raw: unknown): raw is ModelThinkingLevel {
	return typeof raw === 'string' && THINKING_LEVELS.has(raw);
}

/** 默认配置：关闭、空 ref（未精确指定模型，解析不到则跳过）、标题上限 50、不启用 thinking。 */
export const DEFAULT_RENAME_CONFIG: RenameSessionConfig = {
	enabled: false,
	model: { type: 'ref', ref: '' },
	maxTitleLength: 50,
	thinkingLevel: 'off',
};

// ──────────────────────── 归一化 ────────────────────────

/**
 * 把磁盘/内存中的 unknown JSON 归一化成 RenameSessionConfig。
 *
 * 容错策略（逐字段校验 + 默认值回填）：坏字段不影响其他字段（粒度容错），
 * 整体坏（非对象 / null / 数组）返回全默认。宁可静默回默认，不抛错阻断 rename。
 */
export function normalizeRenameConfig(raw: unknown): RenameSessionConfig {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ...DEFAULT_RENAME_CONFIG };
	}
	const obj = raw as Record<string, unknown>;

	const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_RENAME_CONFIG.enabled;

	const maxTitleLength =
		typeof obj.maxTitleLength === 'number' &&
		Number.isInteger(obj.maxTitleLength) &&
		obj.maxTitleLength > 0
			? obj.maxTitleLength
			: DEFAULT_RENAME_CONFIG.maxTitleLength;

	const model = normalizeModelSelector(obj.model) ?? DEFAULT_RENAME_CONFIG.model;

	const thinkingLevel = isThinkingLevel(obj.thinkingLevel)
		? obj.thinkingLevel
		: DEFAULT_RENAME_CONFIG.thinkingLevel;

	return { enabled, model, maxTitleLength, thinkingLevel };
}

/** 校验 ModelSelector：只支持 ref 精确指定，其余形式非法返回 null。 */
function normalizeModelSelector(raw: unknown): ModelSelector | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (obj.type === 'ref' && typeof obj.ref === 'string') {
		return { type: 'ref', ref: obj.ref };
	}
	return null;
}

// ──────────────────────── 配置读写（pi-config 双层 + 缓存） ────────────────────────

/** 创建可注入 cwd/homeDir 的 store（测试用临时目录隔离）。 */
export function createRenameStore(opts?: {
	cwd?: string;
	homeDir?: string;
}): ConfigStore<RenameSessionConfig> {
	return createConfigStore({
		pluginName: 'custom-rename',
		defaults: DEFAULT_RENAME_CONFIG,
		cwd: opts?.cwd,
		homeDir: opts?.homeDir,
	});
}

let store: ConfigStore<RenameSessionConfig> = createRenameStore();

/** 仅供 vitest 注入隔离 store；生产代码不要调用。 */
export function __setStoreForTest(s: ConfigStore<RenameSessionConfig>): void {
	store = s;
}

/**
 * 加载文件层配置（defaults → 用户级 → 项目级深合并 + 归一化），不含环境变量覆盖。
 *
 * 读时刷新：每次调用 store.reload() 强制重读磁盘，保证「改文件后下一个 turn_end 生效」的热重载契约。
 * 用途：① loadRenameConfig 的文件层基座；② 配置面板保存的合并基准——若用运行时配置（含 env
 * 覆盖）当基准落盘，会把 PI_RENAME_* 环境变量的临时值固化进用户级 config.json（env 撤销后漂移残留）。
 */
export function loadFileRenameConfig(): RenameSessionConfig {
	store.reload();
	return normalizeRenameConfig(store.get());
}

/**
 * 加载配置（defaults → user → project 深合并，再归一化 + 环境变量覆盖）。
 * 环境变量覆盖优先级最高（live 读取），覆盖配置文件。
 */
export function loadRenameConfig(): RenameSessionConfig {
	return { ...loadFileRenameConfig(), ...getEnvOverrides() };
}

/**
 * 保存配置到用户级（原子写）。返回 {success, error?}。
 */
export function saveRenameConfig(config: RenameSessionConfig): {
	success: boolean;
	error?: string;
} {
	const ok = store.save(config, 'user');
	return ok ? { success: true } : { success: false, error: 'save failed' };
}

// ──────────────────────── 首 turn 判定 ────────────────────────

/** entry 的宽松类型（structural typing，兼容 pi 的 SessionEntry[] 但不依赖 pi 类型）。 */
interface EntryLike {
	type: string;
	message?: { role?: string; stopReason?: string };
}

/**
 * 数 session 中 assistant 回复数（兼容保留，触发判定用 countSuccessfulAssistantReplies）。
 */
export function countAssistantReplies(entries: ReadonlyArray<EntryLike>): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === 'message' && entry.message?.role === 'assistant') {
			count++;
		}
	}
	return count;
}

/**
 * 数 session 中「成功完成」的 assistant 回复数（stopReason === "stop"）。
 * 触发语义（v2）：未命名会话中该计数 ≥ 1 即满足触发条件（首个可触发的成功 turn 发起），
 * 命名成功后 getSessionName 非空 → 后续自动 skip（见 src/index.ts）。
 *
 * 只数 stop 的理由：pi 的 turn_end 每个 iteration 发一次，中间 iteration 的 stopReason 是 toolUse；
 * error/aborted 轮的错误上下文不该用来命名（延迟到下一个成功轮）；length（输出被截断）质量无保证，
 * 与 error 同等对待。无 stopReason 字段的宽松数据不计（只认显式 stop，防误触发）。
 */
export function countSuccessfulAssistantReplies(entries: ReadonlyArray<EntryLike>): number {
	let count = 0;
	for (const entry of entries) {
		if (
			entry.type === 'message' &&
			entry.message?.role === 'assistant' &&
			entry.message.stopReason === 'stop'
		) {
			count++;
		}
	}
	return count;
}

// ──────────────────────── 标题清洗 ────────────────────────

/**
 * rename 专属后处理：去首尾成对引号（单/双/中文）+ markdown 强调标记（* ** ` _）+ 尾部标点，按 Unicode 码点截断。
 *
 * 输入是 completeSimple 已 extractText+trim 的 string。本函数只做 rename 特有的包装清理。
 */
export function cleanTitle(content: string, maxLength: number): string {
	const trimmed = content.trim();
	if (!trimmed) return '';

	// 归一化内部空白——把所有连续空白（含 \n / \r / \t）压成单空格，
	// 避免 LLM 返回多行标题原样落库破坏 UI 标题/列表渲染
	const normalized = trimmed.replace(/\s+/g, ' ');

	// 去首部引号/markdown 标记 + 尾部引号/markdown/标点。
	// 只清首尾——中间标点保留（如 version 号 'v1.2.3' 中间的点）。
	const cleaned = normalized.replace(/^["“”'`*_]+|["“”'`*_。．.，,、;；!！?？：:]+$/g, '').trim();
	if (!cleaned) return '';

	// 按 Unicode 码点截断（避免截断多字节字符）
	const chars = Array.from(cleaned);
	if (chars.length <= maxLength) return cleaned;
	return chars.slice(0, maxLength).join('');
}
