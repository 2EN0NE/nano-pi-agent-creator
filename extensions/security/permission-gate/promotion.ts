/**
 * permission-gate — 提升候选的现场检测（Ticket 05 / ADR-0058 补充）
 *
 * **触发条件**：本会话对同一模式的「人工放行」次数已达阈值，而「自动放行」次数为 0。
 * 这才是「机制记不住、该提升了」的**现场证据**（例：目标在信任范围外，或目标是变量
 * 因而不匹配任何计数键）。
 *
 * 为什么不是「≥2 个目录 + ≥3 个会话」：那是给「事后扫历史」设计的门槛，
 * 搬到现场会问得太晚、太抽象（对当场的人没有意义）。跨目录/跨会话统计
 * **降级为证据与置信度**，不再是硬门槛。
 *
 * 事件驱动，**不使用定时器**（AGENTS.md 坑 #13：扩展运行时 setInterval/setTimeout 不执行）。
 */

import { makeCommandKey, makeFolderKey, makeToolKey, type DangerTier } from './config.js';
import { classifyDeny, isDenyDecision, type AuditEntry } from './audit-log.js';

/** 触发维度（与动态策略的三个计数维度一致） */
export type PromotionDimension = 'sameFolder' | 'sameTool' | 'sameCommand';

/**
 * 该危险等级是否有资格进入提升候选 / 被采纳（ADR-0058 两条硬约束）。
 *
 * - **critical 不可提升**：提权（permission-related）、凭证（credential）、
 *   不可逆破坏（destructive）、系统目录写（system-dir-write）一律 critical（见 tiering.ts）。
 *   ADR-0025 规定 critical 的放行规则只能沉淀在**会话层**；而提升会把计数迁到**用户层**
 *   （跨项目永久生效），直接绕过「危险等级越高信任越不持久」——因此 critical 既不产候选也不迁层。
 * - **warning / info 可提升**：局部可逆类别（如临时区根写、只读操作），且必须经人类在卡片上逐条确认。
 *
 * 注意：tiering.ts 把 permission-related / credential 硬编码为 critical，故 tier 检查
 * 等价于「提权与凭证类永不进入候选」。`null`（不应出现在危险子命令上）按失败即拒绝处理。
 */
export function isPromotableTier(tier: DangerTier | null): tier is 'warning' | 'info' {
	return tier === 'warning' || tier === 'info';
}

/** 候选证据（展示给用户，用于判断"值不值得提升"） */
export interface PromotionEvidence {
	/** 本会话对同一键的人工放行次数 */
	sessionManual: number;
	/** 本会话对同一键的自动放行次数（>0 则不会产生候选） */
	sessionAuto: number;
	/** 历史（审计日志）涉及的目录数 */
	historyDirectories: number;
	/** 历史涉及的会话数 */
	historySessions: number;
	/** 历史里真实的用户拒绝次数（不含无界面拦截与迁移条目） */
	userDenials: number;
}

export interface PromotionCandidate {
	dimension: PromotionDimension;
	/** 该维度对应的计数键（cmd:… / tool:… / dir:…） */
	key: string;
	tool: string;
	command: string;
	/** 目标目录（判定时的目标所在目录） */
	dir: string;
	/** 触发候选的危险等级（critical 不产候选，见 isPromotableTier） */
	tier: DangerTier;
	evidence: PromotionEvidence;
}

export interface DetectInput {
	tool: string;
	command: string;
	dir: string;
	/** 该子命令的危险等级（assessTier 的结果；决定是否有提升资格） */
	tier: DangerTier | null;
	thresholds: { sameCommand: number; sameTool: number; sameFolder: number };
}

export class PromotionTracker {
	/** 本会话人工放行计数（按计数键） */
	private readonly manual = new Map<string, number>();
	/** 本会话自动放行计数（按计数键） */
	private readonly auto = new Map<string, number>();
	/** 已产出候选的键（同一模式一次会话内只产一次） */
	private readonly emitted = new Set<string>();
	/** 已产出候选的「情境」（工具+目标目录）：同一情境不重复打扰用户 */
	private readonly emittedSituations = new Set<string>();
	/** 用户忽略过的键（不再重复提示） */
	private readonly ignored = new Set<string>();
	/** 待用户查看的候选（Ticket 06 的提示从这里读） */
	private readonly pending: PromotionCandidate[] = [];

	/** 历史证据（从审计日志播种，全场统计） */
	private history = {
		directories: new Set<string>(),
		sessions: new Set<string>(),
		userDenials: 0,
	};

	/**
	 * 从审计日志播种：历史证据 + 本会话的**命令级**计数。
	 *
	 * 局限（已知）：工具级/目录级计数只能靠会话内的实时调用累积，
	 * `/reload` 后会从 0 开始（命令级可由审计回放恢复）。触发是"刚批完就问"，
	 * 该局限只在"reload 后立刻期望触发"时可见。
	 */
	seed(entries: AuditEntry[], sessionId: string | undefined): void {
		for (const e of entries) {
			if (!isDenyDecision(e.decision)) {
				if (e.projectPath) this.history.directories.add(e.projectPath);
				if (e.sessionId) this.history.sessions.add(e.sessionId);
			}
			if (classifyDeny(e) === 'user') this.history.userDenials++;

			if (!sessionId || e.sessionId !== sessionId) continue;
			const cmd = e.originalCommand;
			if (!cmd) continue;
			const key = makeCommandKey(cmd.trim().split('\n').pop() ?? cmd);
			if (e.decision === 'ask') this.bump(this.manual, key);
			else if (e.decision === 'auto') this.bump(this.auto, key);
		}
	}

	private bump(map: Map<string, number>, key: string): void {
		map.set(key, (map.get(key) ?? 0) + 1);
	}

	/** 记录一次决策（人工放行 / 自动放行） */
	noteDecision(decision: 'manual' | 'auto', keys: string[]): void {
		for (const key of keys) {
			this.bump(decision === 'manual' ? this.manual : this.auto, key);
		}
	}

	/** 用户忽略某候选 → 本会话不再提示 */
	markIgnored(key: string): void {
		this.ignored.add(key);
	}

	isIgnored(key: string): boolean {
		return this.ignored.has(key);
	}

	/** 取走待查看的候选（Ticket 06 用） */
	takePending(): PromotionCandidate[] {
		return this.pending.splice(0, this.pending.length);
	}

	/** 从待处理列表移除一条候选（采纳 / 忽略后调用） */
	resolvePending(key: string): void {
		const i = this.pending.findIndex((c) => c.key === key);
		if (i >= 0) this.pending.splice(i, 1);
	}

	peekPending(): readonly PromotionCandidate[] {
		return this.pending;
	}

	/**
	 * 判定当前模式是否够格成为提升候选。
	 *
	 * 维度顺序：目录级 → 工具级 → 命令级（越靠前越宽，越值得提升）。
	 * 阈值为 0 的维度直接跳过——它表示"该维度永不自动放行"（用户在配置里关掉了）。
	 */
	detect(input: DetectInput): PromotionCandidate | null {
		// 危险等级门禁（ADR-0058 硬约束）：提权/凭证/不可逆的 critical 永不产候选。
		// 这里再挡一道，确保任何直接调用方都不会绕过 index.ts 的计数门禁。
		if (!isPromotableTier(input.tier)) return null;

		// 同一情境（工具 + 目标目录）不重复打扰：否则同一次重复会在
		// 目录级/工具级/命令级各弹一次
		const situation = `${input.tool}::${input.dir}`;
		if (this.emittedSituations.has(situation)) return null;

		const dims: Array<[PromotionDimension, string, number]> = [
			['sameFolder', makeFolderKey(input.dir), input.thresholds.sameFolder],
			['sameTool', makeToolKey(input.tool), input.thresholds.sameTool],
			['sameCommand', makeCommandKey(input.command), input.thresholds.sameCommand],
		];

		for (const [dimension, key, threshold] of dims) {
			if (threshold <= 0) continue;
			if (this.emitted.has(key) || this.ignored.has(key)) continue;
			// 已经能自动放行 → 没有提升的必要
			if ((this.auto.get(key) ?? 0) > 0) continue;
			if ((this.manual.get(key) ?? 0) < threshold) continue;

			const candidate: PromotionCandidate = {
				dimension,
				key,
				tool: input.tool,
				command: input.command,
				dir: input.dir,
				tier: input.tier,
				evidence: {
					sessionManual: this.manual.get(key) ?? 0,
					sessionAuto: this.auto.get(key) ?? 0,
					historyDirectories: this.history.directories.size,
					historySessions: this.history.sessions.size,
					userDenials: this.history.userDenials,
				},
			};
			this.emitted.add(key);
			this.emittedSituations.add(situation);
			this.pending.push(candidate);
			return candidate;
		}
		return null;
	}
}

let tracker = new PromotionTracker();

export function getPromotionTracker(): PromotionTracker {
	return tracker;
}

export function resetPromotionTracker(): void {
	tracker = new PromotionTracker();
}
