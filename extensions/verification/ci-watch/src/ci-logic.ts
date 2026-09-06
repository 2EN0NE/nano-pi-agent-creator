/**
 * ci-watch 核心纯逻辑（无 Pi / execSync 依赖，便于单元测试）
 *
 * 本模块只包含：
 *   - 类型定义（CiCheckResult / PollConfig / PollResult / RunInfo）
 *   - 纯函数（分支名/SHA 提取、run 状态评估、PR checks 评估、轮询间隔计算）
 * 不包含任何 I/O（gh 命令、git 命令、日志、UI）。
 */

export interface CiCheckResult {
	status: 'pass' | 'fail' | 'pending' | 'error';
	/**
	 * 失败的检查/run 名称列表。
	 * - PR 模式：check 的 name（来自 `gh pr checks`）
	 * - 分支模式：workflow run 的 name（来自 `gh run list`）
	 */
	failedRuns: string[];
	logs: string;
	/**
	 * 分支模式专用：标记 pending 是因为目标 run 尚未出现
	 * （分支还没有 run，或 push 后新 run 尚未被 GitHub 创建/索引），
	 * 区别于 run 正在执行中的 pending。
	 */
	noRunsFound?: boolean;
}

export interface PollConfig {
	minMs: number;
	maxMs: number;
	stepMs: number;
}

export interface PollResult {
	outcome: 'pass' | 'fail' | 'error' | 'timeout' | 'cancelled';
	message: string;
	logs?: string;
	failedRuns?: string[];
}

export interface RunInfo {
	name: string;
	status: string;
	conclusion: string;
	databaseId: number;
	headSha: string;
}

export interface PrCheck {
	name: string;
	state: string;
	bucket: string;
}

/** 轮询间隔计算：按步长递增，超过最大值后重置为最小值 */
export function nextPollDelay(current: number, config: PollConfig): number {
	const next = current + config.stepMs;
	if (next > config.maxMs) return config.minMs;
	return next;
}

/** Validate that a branch name contains only safe characters for shell interpolation. */
export function isValidBranch(branch: string): boolean {
	return /^[a-zA-Z0-9_\-./]+$/.test(branch);
}

/** Check if input is a PR number (digits only) */
export function isPrRef(input: string): boolean {
	return /^\d+$/.test(input);
}

/**
 * 从 `git push` 输出提取推送信息。
 *
 * 支持以下输出形态：
 *   - 增量推送：`abc123..def456  main -> main`      → { branch: 'main', sha: 'def456' }
 *   - 强制推送：`+ abc123...def456  main -> main`   → { branch: 'main', sha: 'def456' }
 *   - 新分支：  `* [new branch]  dev -> dev`        → { branch: 'dev', sha: null }
 *   - set upstream 伴随新分支：`branch 'dev' set up to track ...` → { branch: 'dev', sha: null }
 *
 * 注意：
 *   - tag 推送（`* [new tag]`）不匹配任何分支形态，返回 { branch: null, sha: null }，
 *     调用方应明确跳过 tag push（避免误兜底成当前分支）。
 *   - 增量/强推提取的 sha 是短 SHA（GitHub 输出格式），调用方应补全为完整 SHA
 *     （`git rev-parse <sha>` 或 `git rev-parse refs/heads/<branch>`）。
 */
export function extractPushInfo(text: string): { branch: string | null; sha: string | null } {
	// 增量/强推：old..new 或 old...new（强推用三个点），后跟 本地分支 -> 远程分支
	// 例：`   0ed3326b..040c8427  main -> main`、`+ abc123...def456  main -> main (forced update)`
	const delta = text.match(/(?:^|\s)[+ ]?[0-9a-f]+\.{2,3}([0-9a-f]+)\s+([\w./-]+)\s*->\s*\S+/);
	if (delta) return { branch: delta[2], sha: delta[1] };

	// 新分支：`* [new branch]  dev -> dev`
	const newBranch = text.match(/\*\s+\[new branch\]\s+(\S+)\s*->\s*\S+/);
	if (newBranch) return { branch: newBranch[1], sha: null };

	// 首次推送带 upstream 提示：`branch 'dev' set up to track 'origin/dev'.`
	const track = text.match(/branch '([^']+)' set up to track/);
	if (track) return { branch: track[1], sha: null };

	return { branch: null, sha: null };
}

/**
 * 根据分支的 workflow runs 评估 CI 状态（纯函数）。
 *
 * @param runs        该分支的 runs（按 databaseId 降序，最新在前）
 * @param expectedSha 期望监控的 commit SHA（完整 40 位）。
 *                    - 提供时：只评估 headSha 匹配的 run（用于"push 后等待新 run 出现"，
 *                      避免读到上一次 push 的旧 run 状态而误报）
 *                    - 未提供：评估最新 run（runs[0]，用于手动监控分支）
 */
export function evaluateBranchRuns(runs: RunInfo[], expectedSha?: string | null): CiCheckResult {
	const target = expectedSha ? runs.find((r) => r.headSha === expectedSha) : runs[0];
	if (!target) {
		return { status: 'pending', failedRuns: [], logs: '', noRunsFound: true };
	}
	if (target.status !== 'completed') {
		return { status: 'pending', failedRuns: [], logs: '' };
	}
	if (target.conclusion === 'success' || target.conclusion === 'neutral') {
		return { status: 'pass', failedRuns: [], logs: '' };
	}
	return {
		status: 'fail',
		failedRuns: [target.name ?? `run#${target.databaseId}`],
		logs: '',
	};
}

export interface PollStepInput {
	status: CiCheckResult['status'];
	noRunsFound?: boolean;
	expectedSha?: string | null;
	consecutiveEmptyPolls: number;
	maxEmptyPolls: number;
	elapsed: number;
	maxWaitMs: number;
}

export type PollStepDecision =
	| { action: 'return'; outcome: 'error' | 'pass' | 'fail' | 'timeout' | 'no-runs' }
	| { action: 'continue'; consecutiveEmptyPolls: number };

/**
 * 轮询循环的单步决策（纯函数，不含任何 I/O）。
 *
 * 输入一次 CI 状态查询的结果与轮询上下文，输出：
 *   - return：终止轮询（error/pass/fail/no-runs/timeout）
 *   - continue：继续等待，返回更新后的 consecutiveEmptyPolls
 *
 * 时序语义（与 pollCiCompletion 原实现一一对应）：
 *   - pending 且目标 run 尚未出现（noRunsFound）：
 *     - expectedSha 模式（push 后等待新 run）：run 创建/索引有延迟，等待是正常行为，
 *       不做快速失败，交给 maxWaitMs 超时兜底（consecutiveEmptyPolls 不变）。
 *     - 非 expectedSha 模式（手动监控分支）：连续多次无 run → fast-fail 返回 no-runs
 *       （区别于 gh 命令出错的 error，调用方据此恢复可操作的 [STOP] 指引消息）。
 *   - elapsed 超过 maxWaitMs → timeout。
 */
export function decidePollStep(input: PollStepInput): PollStepDecision {
	if (input.status === 'error') return { action: 'return', outcome: 'error' };
	if (input.status === 'pass') return { action: 'return', outcome: 'pass' };
	if (input.status === 'fail') return { action: 'return', outcome: 'fail' };

	let consecutive = input.consecutiveEmptyPolls;
	if (input.noRunsFound) {
		if (!input.expectedSha) {
			consecutive++;
			if (consecutive >= input.maxEmptyPolls) {
				return { action: 'return', outcome: 'no-runs' };
			}
		}
	} else {
		consecutive = 0;
	}

	if (input.elapsed >= input.maxWaitMs) {
		return { action: 'return', outcome: 'timeout' };
	}

	return { action: 'continue', consecutiveEmptyPolls: consecutive };
}

/**
 * 根据 `gh pr checks` 的输出评估 PR 的 CI 状态（纯函数）。
 *
 * 空 checks（push 后 check run 尚未注册，或查询过早）视为 pending 而不是 pass，
 * 避免"push 刚结束、checks 还没建起来"时误报通过。
 */
export function evaluatePrChecks(checks: PrCheck[]): CiCheckResult {
	if (!checks.length) {
		return { status: 'pending', failedRuns: [], logs: '' };
	}
	const pending = checks.some((c) => c.bucket === 'pending');
	if (pending) return { status: 'pending', failedRuns: [], logs: '' };

	const failed = checks.filter((c) => c.bucket === 'fail');
	if (failed.length === 0) return { status: 'pass', failedRuns: [], logs: '' };

	return { status: 'fail', failedRuns: failed.map((f) => f.name), logs: '' };
}
