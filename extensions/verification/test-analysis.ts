/**
 * Test Analysis Extension (adapted from review extension)
 *
 * Provides a `/test-analysis` command that prompts the agent to analyze
 * automated test coverage and quality for code changes.
 * Supports multiple analysis modes:
 * - Analyze test coverage for staged changes
 * - Analyze test coverage for uncommitted changes
 * - Analyze test coverage against a base branch (PR style)
 * - Analyze test coverage for a specific commit
 * - Analyze test coverage for a folder (snapshot mode)
 *
 * Analysis flow (per the embedded rubric):
 *   1. Test infrastructure inventory (framework, e2e base, test data, determinism)
 *   2. CI gating inventory (local hooks, remote CI, branch protection)
 *   3. Existing coverage inventory
 *   4. Risk map vs gap analysis
 *   5. Prioritized findings by category: infrastructure / CI / coverage gap
 *
 * Usage:
 * - `/test-analysis` - show interactive selector
 * - `/test-analysis staged` - analyze tests for staged changes only
 * - `/test-analysis uncommitted` - analyze tests for uncommitted changes
 * - `/test-analysis branch main` - analyze tests against main branch
 * - `/test-analysis commit abc123` - analyze tests for a specific commit
 * - `/test-analysis folder src docs` - analyze tests for specific folders/files (snapshot)
 * - `/test-analysis` selector includes custom instructions (applies to all modes)
 * - `/test-analysis --extra "focus on E2E coverage"` - add extra instruction
 *
 * Project-specific analysis guidelines:
 * - If a TEST_ANALYSIS_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the analysis prompt.
 *
 * Note: PR analysis requires a clean working tree (no uncommitted changes to tracked files).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('test_analysis');
import { DynamicBorder, BorderedLoader } from '@earendil-works/pi-coding-agent';
import {
	Container,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from '@earendil-works/pi-tui';
import path from 'node:path';
import { promises as fs } from 'node:fs';

// State to track fresh session analysis (where we branched from).
// Module-level state means only one analysis can be active at a time.
// This is intentional - the UI and /end-analysis command assume a single active analysis.
let analysisOriginId: string | undefined = undefined;
let endAnalysisInProgress = false;
let analysisLoopFixingEnabled = false;
let analysisCustomInstructions: string | undefined = undefined;
let analysisLoopInProgress = false;

const ANALYSIS_STATE_TYPE = 'test-analysis-session';
const ANALYSIS_ANCHOR_TYPE = 'test-analysis-anchor';
const ANALYSIS_SETTINGS_TYPE = 'test-analysis-settings';
const ANALYSIS_LOOP_MAX_ITERATIONS = 10;
const ANALYSIS_LOOP_START_TIMEOUT_MS = 15000;
const ANALYSIS_LOOP_START_POLL_MS = 50;

type AnalysisSessionState = {
	active: boolean;
	originId?: string;
};

type AnalysisSettingsState = {
	loopFixingEnabled?: boolean;
	customInstructions?: string;
};

function setAnalysisWidget(ctx: ExtensionContext, active: boolean) {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget('test_analysis', undefined);
		return;
	}

	ctx.ui.setWidget('test_analysis', (_tui, theme) => {
		const message = analysisLoopInProgress
			? 'Analysis session active (loop running)'
			: analysisLoopFixingEnabled
				? 'Analysis session active (loop enabled), return with /end-analysis'
				: 'Analysis session active, return with /end-analysis';
		const text = new Text(theme.fg('warning', message), 0, 0);
		return {
			render(width: number) {
				return text.render(width);
			},
			invalidate() {
				text.invalidate();
			},
		};
	});
}

function getAnalysisState(ctx: ExtensionContext): AnalysisSessionState | undefined {
	let state: AnalysisSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === 'custom' && entry.customType === ANALYSIS_STATE_TYPE) {
			state = entry.data as AnalysisSessionState | undefined;
		}
	}

	return state;
}

function applyAnalysisState(ctx: ExtensionContext) {
	const state = getAnalysisState(ctx);

	if (state?.active && state.originId) {
		analysisOriginId = state.originId;
		setAnalysisWidget(ctx, true);
		return;
	}

	analysisOriginId = undefined;
	setAnalysisWidget(ctx, false);
}

function getAnalysisSettings(ctx: ExtensionContext): AnalysisSettingsState {
	let state: AnalysisSettingsState | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === 'custom' && entry.customType === ANALYSIS_SETTINGS_TYPE) {
			state = entry.data as AnalysisSettingsState | undefined;
		}
	}

	return {
		loopFixingEnabled: state?.loopFixingEnabled === true,
		customInstructions: state?.customInstructions?.trim() || undefined,
	};
}

function applyAnalysisSettings(ctx: ExtensionContext) {
	const state = getAnalysisSettings(ctx);
	analysisLoopFixingEnabled = state.loopFixingEnabled === true;
	analysisCustomInstructions = state.customInstructions?.trim() || undefined;
}

function parseMarkdownHeading(line: string): { level: number; title: string } | null {
	const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
	if (!headingMatch) {
		return null;
	}

	const rawTitle = headingMatch[2].replace(/\s+#+\s*$/, '').trim();
	return {
		level: headingMatch[1].length,
		title: rawTitle,
	};
}

function getFindingsSectionBounds(lines: string[]): { start: number; end: number } | null {
	let start = -1;
	let findingsHeadingLevel: number | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);
		if (heading && /^(findings\b|发现列表)/i.test(heading.title)) {
			start = i + 1;
			findingsHeadingLevel = heading.level;
			break;
		}
		if (/^\s*(findings|发现列表)\s*[:：]?\s*$/i.test(line)) {
			start = i + 1;
			break;
		}
	}

	if (start < 0) {
		return null;
	}

	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);
		if (heading) {
			const normalizedTitle = heading.title.replace(/[*_`]/g, '').trim();
			if (
				/^(review scope\b|verdict\b|overall verdict\b|fix queue\b|constraints(?:\s*&\s*preferences)?\b|分析范围|总体结论|结论|改进队列|人工审查者标注项)/i.test(
					normalizedTitle,
				)
			) {
				end = i;
				break;
			}

			if (/\[P[0-3]\]/i.test(heading.title)) {
				continue;
			}

			if (findingsHeadingLevel !== null && heading.level <= findingsHeadingLevel) {
				end = i;
				break;
			}
		}

		if (
			/^\s*(review scope\b|verdict\b|overall verdict\b|fix queue\b|constraints(?:\s*&\s*preferences)?\b|分析范围|总体结论|结论|改进队列|人工审查者标注项)\s*[:：]?/i.test(
				line,
			)
		) {
			end = i;
			break;
		}
	}

	return { start, end };
}

function isLikelyFindingLine(line: string): boolean {
	if (!/\[P[0-3]\]/i.test(line)) {
		return false;
	}

	if (/^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+priority\s+tag\b/i.test(line)) {
		return false;
	}

	if (
		/^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+(?:\*\*|__)?\[P[0-3]\](?:\*\*|__)?\s*-\s*(?:drop everything|urgent|normal|low|nice to have|立即处理|下一个迭代|应最终处理|锦上添花)/i.test(
			line,
		)
	) {
		return false;
	}

	// Filter out format-example placeholders echoed from the rubric.
	if (/类别:标题|path\/to\/file/.test(line)) {
		return false;
	}

	const allPriorityTags = line.match(/\[P[0-3]\]/gi) ?? [];
	if (allPriorityTags.length > 1) {
		return false;
	}

	if (/^\s*(?:[-*+]|(?:\d+)[.)])\s+/.test(line)) {
		return true;
	}

	if (/^\s*#{1,6}\s+/.test(line)) {
		return true;
	}

	if (/^\s*(?:\*\*|__)?\[P[0-3]\](?:\*\*|__)?(?=\s|:|-)/i.test(line)) {
		return true;
	}

	return false;
}

function normalizeVerdictValue(value: string): string {
	return value
		.trim()
		.replace(/^[-*+]\s*/, '')
		.replace(/^['"`]+|['"`]+$/g, '')
		.toLowerCase();
}

function isNeedsAttentionVerdictValue(value: string): boolean {
	const normalized = normalizeVerdictValue(value);

	const hasProtected = /\bprotected\b/.test(normalized);
	const hasGapsFound = /gaps\s+found/.test(normalized);
	const hasUnprotected = /\bunprotected\b/.test(normalized);

	// Reject rubric/choice phrasing that enumerates multiple options
	// (e.g. "protected / gaps found / unprotected").
	const optionCount = [hasProtected, hasGapsFound, hasUnprotected].filter(Boolean).length;
	if (optionCount > 1) {
		return false;
	}

	if (hasGapsFound || hasUnprotected) {
		return true;
	}

	if (hasProtected) {
		return false;
	}

	// Legacy review-style verdicts.
	if (!normalized.includes('needs attention')) {
		return false;
	}

	if (/\bnot\s+needs\s+attention\b/.test(normalized)) {
		return false;
	}

	// Reject rubric/choice phrasing like "correct or needs attention", but
	// keep legitimate verdict text that may contain unrelated "or".
	if (/\bcorrect\b/.test(normalized) && /\bor\b/.test(normalized)) {
		return false;
	}

	return true;
}

function hasNeedsAttentionVerdict(messageText: string): boolean {
	const lines = messageText.split(/\r?\n/);

	for (const line of lines) {
		const inlineMatch = line.match(
			/^\s*(?:[*-+]\s*)?(?:overall\s+)?(?:verdict|总体结论|结论)\s*[:：]\s*(.+)$/i,
		);
		if (inlineMatch && isNeedsAttentionVerdictValue(inlineMatch[1])) {
			return true;
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);

		let verdictLevel: number | null = null;
		if (heading) {
			const normalizedHeading = heading.title.replace(/[*_`]/g, '').trim();
			if (!/^(?:overall\s+)?(?:verdict\b|总体结论|结论)/i.test(normalizedHeading)) {
				continue;
			}
			verdictLevel = heading.level;
		} else if (!/^\s*(?:overall\s+)?(?:verdict|总体结论|结论)\s*[:：]?\s*$/i.test(line)) {
			continue;
		}

		for (let j = i + 1; j < lines.length; j++) {
			const verdictLine = lines[j];
			const nextHeading = parseMarkdownHeading(verdictLine);
			if (nextHeading) {
				const normalizedNextHeading = nextHeading.title.replace(/[*_`]/g, '').trim();
				if (verdictLevel === null || nextHeading.level <= verdictLevel) {
					break;
				}
				if (
					/^(review scope\b|findings\b|fix queue\b|constraints(?:\s*&\s*preferences)?\b|分析范围|发现列表|改进队列|人工审查者标注项|基础设施评估|CI 门禁评估|覆盖度盘点)/i.test(
						normalizedNextHeading,
					)
				) {
					break;
				}
			}

			const trimmed = verdictLine.trim();
			if (!trimmed) {
				continue;
			}

			if (isNeedsAttentionVerdictValue(trimmed)) {
				return true;
			}

			if (/\b(correct|protected)\b/i.test(normalizeVerdictValue(trimmed))) {
				break;
			}
		}
	}

	return false;
}

function hasBlockingAnalysisFindings(messageText: string): boolean {
	const lines = messageText.split(/\r?\n/);
	const bounds = getFindingsSectionBounds(lines);
	const candidateLines = bounds ? lines.slice(bounds.start, bounds.end) : lines;

	let inCodeFence = false;
	let foundTaggedFinding = false;
	for (const line of candidateLines) {
		if (/^\s*```/.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) {
			continue;
		}

		if (!isLikelyFindingLine(line)) {
			continue;
		}

		foundTaggedFinding = true;
		if (/\[(P0|P1|P2)\]/i.test(line)) {
			return true;
		}
	}

	if (foundTaggedFinding) {
		return false;
	}

	return hasNeedsAttentionVerdict(messageText);
}

// Analysis target types
type AnalysisTarget =
	| { type: 'staged' }
	| { type: 'uncommitted' }
	| { type: 'baseBranch'; branch: string }
	| { type: 'commit'; sha: string; title?: string }
	| { type: 'pullRequest'; prNumber: number; baseBranch: string; title: string }
	| { type: 'folder'; paths: string[] };

// Prompts (adapted from Codex)
const STAGED_PROMPT =
	'分析当前已暂存的代码变更所对应的测试覆盖（即执行 `git commit` 后会提交的内容）。使用 `git diff --staged` 和 `git diff --staged --stat` 来检查变更，然后识别受影响的模块并评估测试覆盖是否完备。提供按优先级排序的发现。';

const UNCOMMITTED_PROMPT =
	'分析当前所有代码变更的测试保障情况（已暂存、未暂存及未跟踪的文件），按测试分析流程依次检查基座、CI、覆盖缺口，并提供按优先级排序的发现。';

const LOCAL_CHANGES_ANALYSIS_INSTRUCTIONS =
	'同时包括本分支中的本地工作区变更（已暂存、未暂存及未跟踪的文件）。使用 `git status --porcelain`、`git diff`、`git diff --staged` 和 `git ls-files --others --exclude-standard` 命令，以便本地的测试覆盖缺口也纳入本次分析循环。';

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"分析基分支 '{baseBranch}' 的代码变更对应的测试覆盖。本次比较的合并基提交是 {mergeBaseSha}。运行 `git diff {mergeBaseSha}` 以检查相对于 {baseBranch} 的变更。按测试分析流程依次检查基座、CI、覆盖缺口。";

const BASE_BRANCH_PROMPT_FALLBACK =
	'分析基分支 \'{branch}\' 的代码变更对应的测试覆盖。先找到当前分支与 {branch} 上游分支的合并差异（例如 `git merge-base HEAD "$(git rev-parse --abbrev-ref "{branch}@{upstream}")"`），然后针对该 SHA 运行 `git diff` 查看将合并到 {branch} 分支的变更。按测试分析流程检查基座、CI、覆盖缺口。';

const COMMIT_PROMPT_WITH_TITLE =
	'分析提交 {sha}（"{title}"）引入的代码变更对应的测试覆盖。按测试分析流程检查基座、CI、覆盖缺口。';

const COMMIT_PROMPT =
	'分析提交 {sha} 引入的代码变更对应的测试覆盖。按测试分析流程检查基座、CI、覆盖缺口。';

const PULL_REQUEST_PROMPT =
	'分析针对基分支 \'{baseBranch}\' 的拉取请求 #{prNumber}（"{title}"）对应的测试覆盖。本次比较的合并基提交是 {mergeBaseSha}。运行 `git diff {mergeBaseSha}` 以检查将合并的变更。按测试分析流程检查基座、CI、覆盖缺口。';

const PULL_REQUEST_PROMPT_FALLBACK =
	'分析针对基分支 \'{baseBranch}\' 的拉取请求 #{prNumber}（"{title}"）对应的测试覆盖。先找到当前分支与 {baseBranch} 之间的合并基（例如 `git merge-base HEAD {baseBranch}`），然后针对该 SHA 运行 `git diff` 查看将合并的变更。按测试分析流程检查基座、CI、覆盖缺口。';

const FOLDER_ANALYSIS_PROMPT =
	'分析以下路径中的代码对应的测试覆盖：{paths}。这是一个快照分析（而非差异对比），直接读取这些路径中的文件。按测试分析流程检查基座、CI、覆盖缺口。';

// The detailed analysis rubric (adapted from code review extension)
const REVIEW_RUBRIC = `# 自动化测试审查指南

你是一名资深测试架构师，正在分析一个系统的自动化测试保障体系，目标是给出**真正能落地的保护方案**：基础设施能否支撑测试、CI 能否守住门禁、用例是否覆盖了关键链路。

以下是判断需要标记哪些问题的默认指南。如果你在其他地方（开发者消息、用户消息、文件或附加的项目测试规范中）遇到更具体的指南，则以那些指南为准，覆盖这些通用说明。

## 分析流程（必须按顺序执行，前一步不过关要在结论中明确阻塞）

0. **测试基础设施盘点**：检查测试基座是否完备（见"基础设施与可测性检查"章）。如果基座缺失，后续用例建议全部标注"依赖基座先行落地"。
1. **CI 门禁盘点**：检查本地与远程 CI 是否真正起到门禁作用（见"CI 门禁检查"章）。
2. **现有覆盖盘点**：扫描全部测试，建立"已有测试清单"，按业务模块归纳覆盖的场景。
3. **风险地图**：梳理核心业务链路、状态机、外部依赖、数据流，识别每个环节"出错会怎样"。
4. **缺口比对与分层建议**：风险地图 vs 已有清单，标记无覆盖/覆盖不足的缺口，按下方层级观建议层级。

## 大模型时代的测试层级观（本提示词的核心立场）

- **业务链路测试（e2e）是第一公民，也是默认建议层级**：模拟真实用户从入口操作到感知结果的完整旅程（触发点=用户操作，观察点=用户感知到的结果+系统终态）。大模型各自写对的模块，拼起来字段对不上、状态流转断、失败时用户白屏——只有链路测试能抓住。
- **集成测试是链路的局部放大器**：仅用于覆盖链路上**在 UI/终端层难以稳定构造**的场景——下游超时、错误码、部分失败、并发竞争、消息乱序。触发点=API/消息，观察点=服务返回+中间数据。
- **单元测试严格限定适用范围**：只守护**纯逻辑密集点**——金额计算（舍入/溢出）、状态机转移、规则引擎、复杂解析。大模型写实现时能顺手生成单元测试且"都通过"，不代表业务正确，不要把单元覆盖率当作保障证据。
- **覆盖率数字不构成结论**：必须逐场景比对，"有测试"不等于"测住了"。

## 基础设施与可测性检查（前置，严格）

逐项检查，每项明确回答"已具备 / 缺失 / 不适用"，缺失项进入发现列表（通常为 P0/P1，因为会阻塞一切用例落地）：

### 1. 测试运行基座
- 是否存在测试框架与**一条命令可跑通**的入口（如 \`npm test\` / \`pytest\` / \`make test\`）？新成员能否不看文档跑起来？
- 测试是否与源码同仓库、随代码评审一起变更？测试代码是否有 lint/类型检查？

### 2. 按交付形态的链路测试能力（关键——没有对应基座，e2e 就是空中楼阁）
- **CLI 工具**：是否有**模拟终端的 e2e 基座**——伪终端（pty）驱动（如 pexpect/expect、Node 的 node-pty、Go 的 creack/pty 或 vim 式终端录制）、stdout/stderr 捕获与断言、**exit code 断言**、交互式提示的自动应答、输出快照测试（snapshot）、临时工作目录隔离、环境变量注入。
- **Web 应用**：是否有浏览器自动化基座（Playwright/Cypress 等）、确定性等待机制、trace/录像/截图的失败取证、测试账号体系。
- **后端服务**：是否有可本地启动的依赖替身（testcontainers / docker compose / mock server）、API 层链路测试入口、数据库迁移在测试环境自动执行。
- **异步/消息系统**：是否有嵌入式或容器化的消息中间件测试实例、事件等待/轮询断言工具。

### 3. 测试数据基础设施
- 是否有数据工厂/夹具（fixture），用例可自带数据、可重复构造，而非依赖环境"碰巧存在"的数据？
- 是否有用例间隔离机制（独立 schema/临时目录/事务回滚/独立账号）？
- 清理失败是否有兜底，避免脏数据导致后续用例 flaky？

### 4. 确定性保障
- 时钟可冻结/注入，随机数有固定种子，测试不依赖真实外部网络。
- 已有用例中标记 flakiness 反模式：固定 sleep、依赖执行顺序、断言时机过早、共享可变状态。

### 5. 断言与观测能力
- 能否断言**系统终态**（数据库、消息、文件产物），而非仅断言表层提示？
- 失败时能否快速定位：日志捕获、快照对比、trace？

## CI 门禁检查（前置，严格）

**原则：测试存在但没进 CI 门禁 = 不存在；CI 存在但不阻断合并 = 装饰。**

### 1. 本地门禁
- 是否有 pre-commit / pre-push 钩子运行快速层检查（lint、类型、受影响范围的快测）？
- 本地跑测试的命令与 CI **是否完全一致**（同一脚本/同一容器），避免"本地过、CI 挂"？
- 快速层是否足够快（分钟级），快到开发者不会绕过（\`--no-verify\` 滥用是信号）？

### 2. 远程 CI（GitHub Actions 等）
- PR 是否自动触发测试？**失败是否阻断合并**（分支保护 + required status check），管理员能否绕过？
- 是否分层执行：PR 跑快速层（单元+关键链路），合并后/定时跑全量（完整链路矩阵+慢速场景）？全量失败是否有值班响应？
- 主分支是否受保护：禁止直推、要求最新代码通过测试（require branches up to date）？
- CI 环境是否可重复：依赖锁定（lockfile）、固定 runner/镜像版本、无外网不确定依赖？
- 测试报告是否可见：失败用例、截图/trace 是否作为构件（artifact）留存？
- CI 时长是否有预算与监控？超长导致团队跳过测试是门禁失效的前兆。

## 业务链路测试专项（第一公民，逐维度检查）

当场景**必须跨模块/跨服务联动**验证时建议链路级用例。每个维度明确回答"已覆盖 / 缺失 / 不适用"：

### 1. 核心业务旅程
- 端到端主流程（从入口到终态）至少一条全链路用例。
- 每一步断言**持久层终态**（数据库、下游收到的消息、产物文件），而非仅断言表面提示。

### 2. 业务规则与边界
- 金额/额度/数量阈值：恰好边界、边界 ±1、超限。
- 状态机：每个合法转移各一条用例；非法转移被拒绝且无副作用。
- 时间敏感规则：截止前后、跨账期、时区。
- 枚举值全覆盖。

### 3. 异常与失败路径（链路测试价值最高的部分）
- 下游超时/错误码/畸形报文时用户看到什么、系统补偿动作。
- 部分失败：第 N 步失败，已完成步骤回滚或可续跑。
- 中断恢复：提交中断网/进程被杀，恢复后重试不产生重复记录（幂等）。
- 第三方回调失败/延迟/重复推送的对账兜底。

### 4. 并发与时序
- 双击提交、多标签页/多终端同时操作同一资源、两人同时审批。
- 消息乱序、任务重入、定时任务与用户操作竞争。

### 5. 异步与最终一致性
- 异步任务中间态可观测可断言；杜绝"提交后立即断言结果"的隐性时序假设（轮询或等待事件）。
- 对账/补偿任务触发后的终态验证。

### 6. 会话与状态持久化
- 登录态/Token 过期、凭证刷新中途失效。
- 刷新、后退、深链接直达中间页（Web）；中断后续跑、重复执行同一命令（CLI）。
- 多角色/多账号数据隔离。

### 7. 权限矩阵
- 角色 × 关键操作的允许/拒绝，覆盖越权直达 URL/直接调接口/命令行参数绕过。

### 8. 契约一致性
- 链路中 mock/录制数据与真实下游契约是否一致，契约变更时 mock 是否漂移失效。
- 前后端/上下游对同一字段校验规则不一致的场景（前端通过、后端拒绝）。

### 9. 兼容矩阵
- 按真实用户分布定矩阵（浏览器/操作系统/shell/终端类型），关键旅程在矩阵上跑。

### 10. 安全冒烟
- 未认证访问受保护资源、越权访问他人数据、敏感信息泄露在输出/日志/源码中。

### 11. 可观测性断言
- 关键动作触发应有埋点/日志/告警；失败场景产生告警而非静默。

### 12. 发布与开关路径
- 特性开关 on/off、灰度切换、新旧版本共存兼容；安装/升级/降级路径（CLI 尤其重要：升级后旧数据/旧配置是否兼容）。

### 13. 回归用例
- 历史线上事故是否都有防回归用例（关联事故单号）。

## 集成测试检查清单（链路的局部放大器）

- 数据库事务回滚、唯一约束冲突、缓存失效。
- 下游 API 全错误码映射、超时与重试策略的实际行为。
- 消息生产/消费、死信处理。
- 契约层：provider 覆盖 consumer 实际使用的字段与错误码；破坏性 schema 变更被契约测试拦截。

## 单元测试检查清单（严格限定范围）

仅对以下场景建议补单元测试，其余不标记：
- 金额/数值计算：舍入、精度、溢出、币种换算。
- 状态机与规则引擎：转移表全覆盖、规则优先级冲突。
- 复杂解析/序列化：畸形输入、边界长度、编码。
- 已有单元测试若只测 trivial getter/包装层，标记为"低价值占位"，不视为保障证据。

## 判断需要标记的问题

标记满足以下条件的问题（基础设施/CI/用例缺口均适用）：

1. 对系统的质量保障能力有实质影响。
2. 具体、可落地（有明确的建设/修复动作），而非笼统的"建议加强测试"。
3. 严谨程度与项目现有体系一致。
4. 作者如果知晓很可能愿意修复。
5. 不依赖未声明的假设——行为不确定时标记"需确认后再补"，不臆造预期。
6. 能回答"缺了它会造成什么可证明的后果"——答不上来的不标记。
7. 引用具体文件/配置/用例位置证明现状，不笼统描述。
8. 区分三类问题分别报告：**基础设施缺失**、**CI 门禁缺失**、**用例缺口**（含已有用例质量缺陷）。

## 描述指南

1. 基础设施/CI 项：**问题 / 现状证据（引用文件与配置）/ 影响 / 建议方案（含具体工具或配置示例，最少行数）**。
2. 用例缺口：**场景名称 / 建议层级 / 前置条件 / 操作步骤 / 预期结果 / 缺失后果 / 建议断言**。
3. 明确指出触发条件与环境；恰当传达严重程度，不夸大。
4. 保持简洁可扫读；不生成完整测试实现，只给最小骨架或配置片段。
5. 客观语气，有帮助的质量顾问，不指责；避免"已经很好了"之类的奉承。

## 优先级级别

- **[P0]** - 立即处理。基座缺失导致链路测试无法落地；CI 无门禁（失败不阻断合并）；资金/安全/数据正确性链路核心场景无覆盖。
- **[P1]** - 下一个迭代处理。主流程关键分支、常见失败路径无覆盖；flaky 治理缺失导致红 CI 被忽视；本地与 CI 命令不一致。
- **[P2]** - 应最终处理。边界场景、兼容矩阵缺口、CI 时长超标。
- **[P3]** - 锦上添花。防御性场景、报告可读性优化。

## 必需的人工标注项（非阻塞，放在最末尾）

在发现/结论之后，必须附加：

## 人工审查者标注项（非阻塞）

仅包含适用的标注项（不要用是/否行）：

- **建议引入新的测试框架/工具/服务：** <工具/用途/学习成本>
- **建议新增 CI 流水线或调整分支保护策略：** <变更/需要谁审批>
- **建议的用例需要新的测试环境/数据准备：** <环境/数据详情>
- **建议会显著增加 CI 执行时长：** <估算/分层执行建议>
- **建议依赖真实第三方凭证或沙箱账号：** <第三方/风险>
- **建议需要改造现有用例（可能引入不稳定性）：** <用例/范围>
- **建议涉及生产数据脱敏或合规要求：** <数据/要求>

本节规则：
1. 信息性标注，不是修复项；除非存在独立缺陷，不混入发现列表。
2. 仅凭标注不得改变结论；只包含适用项；保持加粗原样；都不适用则写"- (无)"。

## 输出格式（严格遵守——自动化流程按此结构解析结果，标题文字不得改动）

按以下章节顺序输出，标题原样使用：

## 基础设施评估
逐项给出：ready / missing / 不适用，附一行证据（引用具体文件与配置）。

## CI 门禁评估
本地/远程/flaky 治理三块分别给出：enforced / decorative / missing，附一行证据。

## 覆盖度盘点摘要
按模块列出现有用例覆盖（简表）。

## 发现列表
每条发现独占一个列表项，格式严格为：
- [P0] 类别:标题 — \`path/to/file:line\` — 问题与建议
规则：
1. 优先级标签 ∈ [P0]/[P1]/[P2]/[P3]，是行内第一个标记，且每行只允许出现一个标签；发现按 P0→P3 排序。
2. 类别 ∈ 基础设施 / CI / 用例缺口 / 用例质量。
3. 不要把多条发现合并进一行，不要在发现行内复述优先级定义。
4. 没有符合条件的发现时写"- (无)"，不要省略本章节。

## 总体结论
单独一行给出结论词，三选一（protected / gaps found / unprotected）。含义：protected=基座 ready 且 CI enforced 且无 P0/P1 缺口；gaps found=基座与 CI 可用但存在 P0/P1 用例缺口；unprotected=基座或 CI 门禁缺失、须先落地 P0 基础设施项。结论词必须与发现列表一致：存在 P0/P1 发现时不允许给出 protected。

## 人工审查者标注项（非阻塞）
按前文规则输出加粗标注项；都不适用则写"- (无)"。

补充要求：忽略琐碎风格问题；不要找到第一个问题就停——按各章清单逐项检查完再收尾。
`;

async function loadProjectAnalysisGuidelines(cwd: string): Promise<string | null> {
	log.debug('Searching for TEST_ANALYSIS_GUIDELINES.md from cwd=%s', cwd);
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, '.pi');
		const guidelinesPath = path.join(currentDir, 'TEST_ANALYSIS_GUIDELINES.md');

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (guidelineStats?.isFile()) {
				try {
					const content = await fs.readFile(guidelinesPath, 'utf8');
					const trimmed = content.trim();
					if (trimmed) {
						log.info(
							'Loaded TEST_ANALYSIS_GUIDELINES.md from %s (%d chars)',
							guidelinesPath,
							trimmed.length,
						);
					}
					return trimmed ? trimmed : null;
				} catch (err) {
					log.warn(
						'Failed to read TEST_ANALYSIS_GUIDELINES.md at %s: %s',
						guidelinesPath,
						err instanceof Error ? err.message : String(err),
					);
					return null;
				}
			}
			log.debug('No TEST_ANALYSIS_GUIDELINES.md found at %s', currentDir);
			return null;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

/**
 * Get the merge base between HEAD and a branch
 */
async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	try {
		// First try to get the upstream tracking branch
		const { stdout: upstream, code: upstreamCode } = await pi.exec('git', [
			'rev-parse',
			'--abbrev-ref',
			`${branch}@{upstream}`,
		]);

		if (upstreamCode === 0 && upstream.trim()) {
			const { stdout: mergeBase, code } = await pi.exec('git', [
				'merge-base',
				'HEAD',
				upstream.trim(),
			]);
			if (code === 0 && mergeBase.trim()) {
				return mergeBase.trim();
			}
		}

		// Fall back to using the branch directly
		const { stdout: mergeBase, code } = await pi.exec('git', ['merge-base', 'HEAD', branch]);
		if (code === 0 && mergeBase.trim()) {
			return mergeBase.trim();
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Get list of local branches
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec('git', ['branch', '--format=%(refname:short)']);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split('\n')
		.filter((b) => b.trim());
}

/**
 * Get list of recent commits
 */
async function getRecentCommits(
	pi: ExtensionAPI,
	limit: number = 10,
): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec('git', ['log', `--oneline`, `-n`, `${limit}`]);
	if (code !== 0) return [];

	return stdout
		.trim()
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => {
			const [sha, ...rest] = line.trim().split(' ');
			return { sha, title: rest.join(' ') };
		});
}

/**
 * Check if there are uncommitted changes (staged, unstaged, or untracked)
 */
async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec('git', ['status', '--porcelain']);
	return code === 0 && stdout.trim().length > 0;
}

/**
 * Check if there are changes that would prevent switching branches
 * (staged or unstaged changes to tracked files - untracked files are fine)
 */
async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
	// Check for staged or unstaged changes to tracked files
	const { stdout, code } = await pi.exec('git', ['status', '--porcelain']);
	if (code !== 0) return false;

	// Filter out untracked files (lines starting with ??)
	const lines = stdout
		.trim()
		.split('\n')
		.filter((line) => line.trim());
	const trackedChanges = lines.filter((line) => !line.startsWith('??'));
	return trackedChanges.length > 0;
}

/**
 * Parse a PR reference (URL or number) and return the PR number
 */
function parsePrReference(ref: string): number | null {
	const trimmed = ref.trim();

	// Try as a number first
	const num = parseInt(trimmed, 10);
	if (!isNaN(num) && num > 0) {
		return num;
	}

	// Try to extract from GitHub URL
	// Formats: https://github.com/owner/repo/pull/123
	//          github.com/owner/repo/pull/123
	const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
	if (urlMatch) {
		return parseInt(urlMatch[1], 10);
	}

	return null;
}

/**
 * Get PR information from GitHub CLI
 */
async function getPrInfo(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
	const { stdout, code } = await pi.exec('gh', [
		'pr',
		'view',
		String(prNumber),
		'--json',
		'baseRefName,title,headRefName',
	]);

	if (code !== 0) return null;

	try {
		const data = JSON.parse(stdout);
		return {
			baseBranch: data.baseRefName,
			title: data.title,
			headBranch: data.headRefName,
		};
	} catch {
		return null;
	}
}

/**
 * Checkout a PR using GitHub CLI
 */
async function checkoutPr(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<{ success: boolean; error?: string }> {
	log.info('Checking out PR #%d', prNumber);
	const { stdout, stderr, code } = await pi.exec('gh', ['pr', 'checkout', String(prNumber)]);

	if (code !== 0) {
		log.warn('PR checkout failed: #%d — %s', prNumber, (stderr || stdout).trim());
		return {
			success: false,
			error: stderr || stdout || 'Failed to checkout PR',
		};
	}

	log.info('PR #%d checked out successfully', prNumber);
	return { success: true };
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec('git', ['branch', '--show-current']);
	if (code === 0 && stdout.trim()) {
		return stdout.trim();
	}
	return null;
}

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	// Try to get from remote HEAD
	const { stdout, code } = await pi.exec('git', [
		'symbolic-ref',
		'refs/remotes/origin/HEAD',
		'--short',
	]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace('origin/', '');
	}

	// Fall back to checking if main or master exists
	const branches = await getLocalBranches(pi);
	if (branches.includes('main')) return 'main';
	if (branches.includes('master')) return 'master';

	return 'main'; // Default fallback
}

/**
 * Build the analysis prompt based on target
 */
async function buildAnalysisPrompt(
	pi: ExtensionAPI,
	target: AnalysisTarget,
	options?: { includeLocalChanges?: boolean },
): Promise<string> {
	const includeLocalChanges = options?.includeLocalChanges === true;

	switch (target.type) {
		case 'staged':
			return STAGED_PROMPT;

		case 'uncommitted':
			return UNCOMMITTED_PROMPT;

		case 'baseBranch': {
			const mergeBase = await getMergeBase(pi, target.branch);
			const basePrompt = mergeBase
				? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(
						/{baseBranch}/g,
						target.branch,
					).replace(/{mergeBaseSha}/g, mergeBase)
				: BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
			return includeLocalChanges
				? `${basePrompt} ${LOCAL_CHANGES_ANALYSIS_INSTRUCTIONS}`
				: basePrompt;
		}

		case 'commit':
			if (target.title) {
				return COMMIT_PROMPT_WITH_TITLE.replace('{sha}', target.sha).replace(
					'{title}',
					target.title,
				);
			}
			return COMMIT_PROMPT.replace('{sha}', target.sha);

		case 'pullRequest': {
			const mergeBase = await getMergeBase(pi, target.baseBranch);
			const basePrompt = mergeBase
				? PULL_REQUEST_PROMPT.replace(/{prNumber}/g, String(target.prNumber))
						.replace(/{title}/g, target.title)
						.replace(/{baseBranch}/g, target.baseBranch)
						.replace(/{mergeBaseSha}/g, mergeBase)
				: PULL_REQUEST_PROMPT_FALLBACK.replace(/{prNumber}/g, String(target.prNumber))
						.replace(/{title}/g, target.title)
						.replace(/{baseBranch}/g, target.baseBranch);
			return includeLocalChanges
				? `${basePrompt} ${LOCAL_CHANGES_ANALYSIS_INSTRUCTIONS}`
				: basePrompt;
		}

		case 'folder':
			return FOLDER_ANALYSIS_PROMPT.replace('{paths}', target.paths.join(', '));
	}
}

/**
 * Get user-facing hint for the analysis target
 */
function getUserFacingHint(target: AnalysisTarget): string {
	switch (target.type) {
		case 'staged':
			return 'staged changes';

		case 'uncommitted':
			return 'current changes';
		case 'baseBranch':
			return `changes against '${target.branch}'`;
		case 'commit': {
			const shortSha = target.sha.slice(0, 7);
			return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
		}

		case 'pullRequest': {
			const shortTitle =
				target.title.length > 30 ? target.title.slice(0, 27) + '...' : target.title;
			return `PR #${target.prNumber}: ${shortTitle}`;
		}

		case 'folder': {
			const joined = target.paths.join(', ');
			return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`;
		}
	}
}

type AssistantSnapshot = {
	id: string;
	text: string;
	stopReason?: string;
};

function extractAssistantTextContent(content: unknown): string {
	if (typeof content === 'string') {
		return content.trim();
	}

	if (!Array.isArray(content)) {
		return '';
	}

	const textParts = content
		.filter((part): part is { type: 'text'; text: string } =>
			Boolean(
				part &&
				typeof part === 'object' &&
				'type' in part &&
				part.type === 'text' &&
				'text' in part,
			),
		)
		.map((part) => part.text);
	return textParts.join('\n').trim();
}

function getLastAssistantSnapshot(ctx: ExtensionContext): AssistantSnapshot | null {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== 'message' || entry.message.role !== 'assistant') {
			continue;
		}

		const assistantMessage = entry.message as {
			content?: unknown;
			stopReason?: string;
		};
		return {
			id: entry.id,
			text: extractAssistantTextContent(assistantMessage.content),
			stopReason: assistantMessage.stopReason,
		};
	}

	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoopTurnToStart(
	ctx: ExtensionContext,
	previousAssistantId?: string,
): Promise<boolean> {
	const deadline = Date.now() + ANALYSIS_LOOP_START_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const lastAssistantId = getLastAssistantSnapshot(ctx)?.id;
		if (
			!ctx.isIdle() ||
			ctx.hasPendingMessages() ||
			(lastAssistantId && lastAssistantId !== previousAssistantId)
		) {
			return true;
		}
		await sleep(ANALYSIS_LOOP_START_POLL_MS);
	}

	return false;
}

// Analysis preset options for the selector (keep this order stable)
const ANALYSIS_PRESETS = [
	{
		value: 'staged',
		label: 'Analyze tests for staged changes only',
		description: '(index vs commit)',
	},
	{
		value: 'uncommitted',
		label: 'Analyze tests for uncommitted changes',
		description: '',
	},
	{
		value: 'baseBranch',
		label: 'Analyze tests against a base branch',
		description: '(local)',
	},
	{ value: 'commit', label: 'Analyze tests for a commit', description: '' },
	{
		value: 'pullRequest',
		label: 'Analyze tests for a PR',
		description: '(GitHub PR)',
	},
	{
		value: 'folder',
		label: 'Analyze tests for a folder (or more)',
		description: '(snapshot, not diff)',
	},
] as const;

const TOGGLE_LOOP_FIXING_VALUE = 'toggleLoopFixing' as const;
const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = 'toggleCustomInstructions' as const;
type AnalysisPresetValue =
	| (typeof ANALYSIS_PRESETS)[number]['value']
	| typeof TOGGLE_LOOP_FIXING_VALUE
	| typeof TOGGLE_CUSTOM_INSTRUCTIONS_VALUE;

export default function testAnalysisExtension(pi: ExtensionAPI) {
	function persistAnalysisSettings() {
		pi.appendEntry(ANALYSIS_SETTINGS_TYPE, {
			loopFixingEnabled: analysisLoopFixingEnabled,
			customInstructions: analysisCustomInstructions,
		});
	}

	function setAnalysisLoopFixingEnabled(enabled: boolean) {
		analysisLoopFixingEnabled = enabled;
		persistAnalysisSettings();
	}

	function setAnalysisCustomInstructions(instructions: string | undefined) {
		analysisCustomInstructions = instructions?.trim() || undefined;
		persistAnalysisSettings();
	}

	function applyAllAnalysisState(ctx: ExtensionContext) {
		applyAnalysisSettings(ctx);
		applyAnalysisState(ctx);
	}

	pi.on('session_start', (_event, ctx) => {
		applyAllAnalysisState(ctx);
	});

	pi.on('session_tree', (_event, ctx) => {
		applyAllAnalysisState(ctx);
	});

	/**
	 * Determine the smart default analysis type based on git state
	 */
	async function getSmartDefault(): Promise<'uncommitted' | 'baseBranch' | 'commit'> {
		// Priority 1: If there are uncommitted changes, default to analyzing them
		if (await hasUncommittedChanges(pi)) {
			return 'uncommitted';
		}

		// Priority 2: If on a feature branch (not the default branch), default to PR-style analysis
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		if (currentBranch && currentBranch !== defaultBranch) {
			return 'baseBranch';
		}

		// Priority 3: Default to analyzing a specific commit
		return 'commit';
	}

	/**
	 * Show the analysis target selector
	 */
	async function showAnalysisSelector(ctx: ExtensionContext): Promise<AnalysisTarget | null> {
		// Determine smart default (but keep the list order stable)
		const smartDefault = await getSmartDefault();
		const presetItems: SelectItem[] = ANALYSIS_PRESETS.map((preset) => ({
			value: preset.value,
			label: preset.label,
			description: preset.description,
		}));
		const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

		while (true) {
			const customInstructionsLabel = analysisCustomInstructions
				? 'Remove custom analysis instructions'
				: 'Add custom analysis instructions';
			const customInstructionsDescription = analysisCustomInstructions
				? '(currently set)'
				: '(applies to all analysis modes)';
			const loopToggleLabel = analysisLoopFixingEnabled
				? 'Disable Loop Fixing'
				: 'Enable Loop Fixing';
			const loopToggleDescription = analysisLoopFixingEnabled
				? '(currently on)'
				: '(currently off)';
			const items: SelectItem[] = [
				...presetItems,
				{
					value: TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
					label: customInstructionsLabel,
					description: customInstructionsDescription,
				},
				{
					value: TOGGLE_LOOP_FIXING_VALUE,
					label: loopToggleLabel,
					description: loopToggleDescription,
				},
			];

			const result = await ctx.ui.custom<AnalysisPresetValue | null>(
				(tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
					container.addChild(
						new Text(theme.fg('accent', theme.bold('Select an analysis target'))),
					);

					const selectList = new SelectList(items, Math.min(items.length, 10), {
						selectedPrefix: (text) => theme.fg('accent', text),
						selectedText: (text) => theme.fg('accent', text),
						description: (text) => theme.fg('muted', text),
						scrollInfo: (text) => theme.fg('dim', text),
						noMatch: (text) => theme.fg('warning', text),
					});

					// Preselect the smart default without reordering the list
					if (smartDefaultIndex >= 0) {
						selectList.setSelectedIndex(smartDefaultIndex);
					}

					selectList.onSelect = (item) => done(item.value as AnalysisPresetValue);
					selectList.onCancel = () => done(null);

					container.addChild(selectList);
					container.addChild(
						new Text(theme.fg('dim', 'Press enter to confirm or esc to go back')),
					);
					container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

					return {
						render(width: number) {
							return container.render(width);
						},
						invalidate() {
							container.invalidate();
						},
						handleInput(data: string) {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				},
			);

			if (!result) return null;

			if (result === TOGGLE_LOOP_FIXING_VALUE) {
				const nextEnabled = !analysisLoopFixingEnabled;
				setAnalysisLoopFixingEnabled(nextEnabled);
				ctx.ui.notify(nextEnabled ? 'Loop fixing enabled' : 'Loop fixing disabled', 'info');
				continue;
			}

			if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
				if (analysisCustomInstructions) {
					setAnalysisCustomInstructions(undefined);
					ctx.ui.notify('Custom analysis instructions removed', 'info');
					continue;
				}

				const customInstructions = await ctx.ui.editor(
					'Enter custom analysis instructions (applies to all modes):',
					'',
				);

				if (!customInstructions?.trim()) {
					ctx.ui.notify('Custom analysis instructions not changed', 'info');
					continue;
				}

				setAnalysisCustomInstructions(customInstructions);
				ctx.ui.notify('Custom analysis instructions saved', 'info');
				continue;
			}

			// Handle each preset type
			switch (result) {
				case 'staged':
					return { type: 'staged' };

				case 'uncommitted':
					return { type: 'uncommitted' };

				case 'baseBranch': {
					const target = await showBranchSelector(ctx);
					if (target) return target;
					break;
				}

				case 'commit': {
					if (analysisLoopFixingEnabled) {
						ctx.ui.notify('Loop mode is not available for commit analysis.', 'error');
						break;
					}
					const target = await showCommitSelector(ctx);
					if (target) return target;
					break;
				}

				case 'folder': {
					const target = await showFolderInput(ctx);
					if (target) return target;
					break;
				}

				case 'pullRequest': {
					const target = await showPrInput(ctx);
					if (target) return target;
					break;
				}

				default:
					return null;
			}
		}
	}

	/**
	 * Show branch selector for base branch analysis
	 */
	async function showBranchSelector(ctx: ExtensionContext): Promise<AnalysisTarget | null> {
		const branches = await getLocalBranches(pi);
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);

		// Never offer the current branch as a base branch (analyzing against itself is meaningless).
		const candidateBranches = currentBranch
			? branches.filter((b) => b !== currentBranch)
			: branches;

		if (candidateBranches.length === 0) {
			ctx.ui.notify(
				currentBranch
					? `No other branches found (current branch: ${currentBranch})`
					: 'No branches found',
				'error',
			);
			return null;
		}

		// Sort branches with default branch first
		const sortedBranches = candidateBranches.sort((a, b) => {
			if (a === defaultBranch) return -1;
			if (b === defaultBranch) return 1;
			return a.localeCompare(b);
		});

		const items: SelectItem[] = sortedBranches.map((branch) => ({
			value: branch,
			label: branch,
			description: branch === defaultBranch ? '(default)' : '',
		}));

		const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
			container.addChild(new Text(theme.fg('accent', theme.bold('Select base branch'))));

			const searchInput = new Input();
			container.addChild(searchInput);
			container.addChild(new Spacer(1));

			const listContainer = new Container();
			container.addChild(listContainer);
			container.addChild(
				new Text(theme.fg('dim', 'Type to filter • enter to select • esc to cancel')),
			);
			container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

			let filteredItems = items;
			let selectList: SelectList | null = null;

			const updateList = () => {
				listContainer.clear();
				if (filteredItems.length === 0) {
					listContainer.addChild(new Text(theme.fg('warning', '  No matching branches')));
					selectList = null;
					return;
				}

				selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
					selectedPrefix: (text) => theme.fg('accent', text),
					selectedText: (text) => theme.fg('accent', text),
					description: (text) => theme.fg('muted', text),
					scrollInfo: (text) => theme.fg('dim', text),
					noMatch: (text) => theme.fg('warning', text),
				});

				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				listContainer.addChild(selectList);
			};

			const applyFilter = () => {
				const query = searchInput.getValue();
				filteredItems = query
					? fuzzyFilter(
							items,
							query,
							(item) => `${item.label} ${item.value} ${item.description ?? ''}`,
						)
					: items;
				updateList();
			};

			applyFilter();

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (
						keybindings.matches(data, 'tui.select.up') ||
						keybindings.matches(data, 'tui.select.down') ||
						keybindings.matches(data, 'tui.select.confirm') ||
						keybindings.matches(data, 'tui.select.cancel')
					) {
						if (selectList) {
							selectList.handleInput(data);
						} else if (keybindings.matches(data, 'tui.select.cancel')) {
							done(null);
						}
						tui.requestRender();
						return;
					}

					searchInput.handleInput(data);
					applyFilter();
					tui.requestRender();
				},
			};
		});

		if (!result) return null;
		return { type: 'baseBranch', branch: result };
	}

	/**
	 * Show commit selector
	 */
	async function showCommitSelector(ctx: ExtensionContext): Promise<AnalysisTarget | null> {
		const commits = await getRecentCommits(pi, 20);

		if (commits.length === 0) {
			ctx.ui.notify('No commits found', 'error');
			return null;
		}

		const items: SelectItem[] = commits.map((commit) => ({
			value: commit.sha,
			label: `${commit.sha.slice(0, 7)} ${commit.title}`,
			description: '',
		}));

		const result = await ctx.ui.custom<{ sha: string; title: string } | null>(
			(tui, theme, keybindings, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
				container.addChild(
					new Text(theme.fg('accent', theme.bold('Select commit to analyze'))),
				);

				const searchInput = new Input();
				container.addChild(searchInput);
				container.addChild(new Spacer(1));

				const listContainer = new Container();
				container.addChild(listContainer);
				container.addChild(
					new Text(theme.fg('dim', 'Type to filter • enter to select • esc to cancel')),
				);
				container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

				let filteredItems = items;
				let selectList: SelectList | null = null;

				const updateList = () => {
					listContainer.clear();
					if (filteredItems.length === 0) {
						listContainer.addChild(
							new Text(theme.fg('warning', '  No matching commits')),
						);
						selectList = null;
						return;
					}

					selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
						selectedPrefix: (text) => theme.fg('accent', text),
						selectedText: (text) => theme.fg('accent', text),
						description: (text) => theme.fg('muted', text),
						scrollInfo: (text) => theme.fg('dim', text),
						noMatch: (text) => theme.fg('warning', text),
					});

					selectList.onSelect = (item) => {
						const commit = commits.find((c) => c.sha === item.value);
						if (commit) {
							done(commit);
						} else {
							done(null);
						}
					};
					selectList.onCancel = () => done(null);
					listContainer.addChild(selectList);
				};

				const applyFilter = () => {
					const query = searchInput.getValue();
					filteredItems = query
						? fuzzyFilter(
								items,
								query,
								(item) => `${item.label} ${item.value} ${item.description ?? ''}`,
							)
						: items;
					updateList();
				};

				applyFilter();

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						if (
							keybindings.matches(data, 'tui.select.up') ||
							keybindings.matches(data, 'tui.select.down') ||
							keybindings.matches(data, 'tui.select.confirm') ||
							keybindings.matches(data, 'tui.select.cancel')
						) {
							if (selectList) {
								selectList.handleInput(data);
							} else if (keybindings.matches(data, 'tui.select.cancel')) {
								done(null);
							}
							tui.requestRender();
							return;
						}

						searchInput.handleInput(data);
						applyFilter();
						tui.requestRender();
					},
				};
			},
		);

		if (!result) return null;
		return { type: 'commit', sha: result.sha, title: result.title };
	}

	function parseAnalysisPaths(value: string): string[] {
		return value
			.split(/\s+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	/**
	 * Show folder input for analysis
	 */
	async function showFolderInput(ctx: ExtensionContext): Promise<AnalysisTarget | null> {
		const result = await ctx.ui.editor(
			'Enter folders/files to analyze (space-separated or one per line):',
			'.',
		);

		if (!result?.trim()) return null;
		const paths = parseAnalysisPaths(result);
		if (paths.length === 0) return null;

		return { type: 'folder', paths };
	}

	/**
	 * Show PR input and handle checkout for analysis
	 */
	async function showPrInput(ctx: ExtensionContext): Promise<AnalysisTarget | null> {
		// First check for pending changes that would prevent branch switching
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify(
				'Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.',
				'error',
			);
			return null;
		}

		// Get PR reference from user
		const prRef = await ctx.ui.editor(
			'Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):',
			'',
		);

		if (!prRef?.trim()) return null;

		const prNumber = parsePrReference(prRef);
		if (!prNumber) {
			ctx.ui.notify('Invalid PR reference. Enter a number or GitHub PR URL.', 'error');
			return null;
		}

		// Get PR info from GitHub
		ctx.ui.notify(`Fetching PR #${prNumber} info...`, 'info');
		const prInfo = await getPrInfo(pi, prNumber);

		if (!prInfo) {
			ctx.ui.notify(
				`Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`,
				'error',
			);
			return null;
		}

		// Check again for pending changes (in case something changed)
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify(
				'Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.',
				'error',
			);
			return null;
		}

		// Checkout the PR
		ctx.ui.notify(`Checking out PR #${prNumber}...`, 'info');
		const checkoutResult = await checkoutPr(pi, prNumber);

		if (!checkoutResult.success) {
			ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, 'error');
			return null;
		}

		ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, 'info');

		return {
			type: 'pullRequest',
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	/**
	 * Execute the analysis
	 */
	async function executeAnalysis(
		ctx: ExtensionCommandContext,
		target: AnalysisTarget,
		useFreshSession: boolean,
		options?: { includeLocalChanges?: boolean; extraInstruction?: string },
	): Promise<boolean> {
		// Check if we're already in an analysis
		if (analysisOriginId) {
			log.warn('executeAnalysis blocked: analysis already in progress');
			ctx.ui.notify('Already in an analysis. Use /end-analysis to finish first.', 'warning');
			return false;
		}

		log.info(
			'Starting analysis: target=%s, freshSession=%s, options=%j',
			target.type,
			useFreshSession,
			options,
		);
		log.debug('Analysis target details: %j', target);

		// Handle fresh session mode
		if (useFreshSession) {
			// Store current position (where we'll return to).
			// In an empty session there is no leaf yet, so create a lightweight anchor first.
			let originId = ctx.sessionManager.getLeafId() ?? undefined;
			if (!originId) {
				pi.appendEntry(ANALYSIS_ANCHOR_TYPE, {
					createdAt: new Date().toISOString(),
				});
				originId = ctx.sessionManager.getLeafId() ?? undefined;
			}
			if (!originId) {
				ctx.ui.notify('Failed to determine analysis origin.', 'error');
				return false;
			}
			analysisOriginId = originId;

			// Keep a local copy so session_tree events during navigation don't wipe it
			const lockedOriginId = originId;

			// Find the first user message in the session.
			// If none exists (e.g. brand-new session), we'll stay on the current leaf.
			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find(
				(e) => e.type === 'message' && e.message.role === 'user',
			);

			if (firstUserMessage) {
				// Navigate to first user message to create a new branch from that point
				// Label it as "test-analysis" so it's visible in the tree
				try {
					const result = await ctx.navigateTree(firstUserMessage.id, {
						summarize: false,
						label: 'test-analysis',
					});
					if (result.cancelled) {
						analysisOriginId = undefined;
						return false;
					}
				} catch (error) {
					// Clean up state if navigation fails
					analysisOriginId = undefined;
					ctx.ui.notify(
						`Failed to start analysis: ${error instanceof Error ? error.message : String(error)}`,
						'error',
					);
					return false;
				}

				// Clear the editor (navigating to user message fills it with the message text)
				ctx.ui.setEditorText('');
			}

			// Restore origin after navigation events (session_tree can reset it)
			analysisOriginId = lockedOriginId;

			// Show widget indicating analysis is active
			setAnalysisWidget(ctx, true);

			// Persist analysis state so tree navigation can restore/reset it
			pi.appendEntry(ANALYSIS_STATE_TYPE, {
				active: true,
				originId: lockedOriginId,
			});
		}

		const prompt = await buildAnalysisPrompt(pi, target, {
			includeLocalChanges: options?.includeLocalChanges === true,
		});
		const hint = getUserFacingHint(target);
		const projectGuidelines = await loadProjectAnalysisGuidelines(ctx.cwd);

		// Combine the analysis rubric with the specific prompt
		let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

		if (analysisCustomInstructions) {
			fullPrompt += `\n\nShared custom analysis instructions (applies to all analyses):\n\n${analysisCustomInstructions}`;
		}

		if (options?.extraInstruction?.trim()) {
			fullPrompt += `\n\nAdditional user-provided analysis instruction:\n\n${options.extraInstruction.trim()}`;
		}

		if (projectGuidelines) {
			fullPrompt += `\n\nThis project has additional instructions for test analysis:\n\n${projectGuidelines}`;
		}

		const modeHint = useFreshSession ? ' (fresh session)' : '';
		ctx.ui.notify(`Starting analysis: ${hint}${modeHint}`, 'info');
		log.info(
			'Analysis prompt sent: hint=%s, prompt_len=%d, guidelines=%s',
			hint,
			fullPrompt.length,
			projectGuidelines ? 'yes' : 'no',
		);

		// Send as a user message that triggers a turn
		pi.sendUserMessage(fullPrompt);
		return true;
	}

	/**
	 * Parse command arguments for direct invocation
	 * Returns the target or a special marker for PR that needs async handling
	 */
	type ParsedAnalysisArgs = {
		target: AnalysisTarget | { type: 'pr'; ref: string } | null;
		extraInstruction?: string;
		error?: string;
	};

	function tokenizeArgs(value: string): string[] {
		const tokens: string[] = [];
		let current = '';
		let quote: '"' | "'" | null = null;

		for (let i = 0; i < value.length; i++) {
			const char = value[i];

			if (quote) {
				if (char === '\\' && i + 1 < value.length) {
					current += value[i + 1];
					i += 1;
					continue;
				}
				if (char === quote) {
					quote = null;
					continue;
				}
				current += char;
				continue;
			}

			if (char === '"' || char === "'") {
				quote = char;
				continue;
			}

			if (/\s/.test(char)) {
				if (current.length > 0) {
					tokens.push(current);
					current = '';
				}
				continue;
			}

			current += char;
		}

		if (current.length > 0) {
			tokens.push(current);
		}

		return tokens;
	}

	function parseArgs(args: string | undefined): ParsedAnalysisArgs {
		if (!args?.trim()) return { target: null };

		const rawParts = tokenizeArgs(args.trim());
		const parts: string[] = [];
		let extraInstruction: string | undefined;

		for (let i = 0; i < rawParts.length; i++) {
			const part = rawParts[i];
			if (part === '--extra') {
				const next = rawParts[i + 1];
				if (!next) {
					return { target: null, error: 'Missing value for --extra' };
				}
				extraInstruction = next;
				i += 1;
				continue;
			}

			if (part.startsWith('--extra=')) {
				extraInstruction = part.slice('--extra='.length);
				continue;
			}

			parts.push(part);
		}

		if (parts.length === 0) {
			return { target: null, extraInstruction };
		}

		const subcommand = parts[0]?.toLowerCase();

		switch (subcommand) {
			case 'staged':
				return { target: { type: 'staged' }, extraInstruction };

			case 'uncommitted':
				return { target: { type: 'uncommitted' }, extraInstruction };

			case 'branch': {
				const branch = parts[1];
				if (!branch) return { target: null, extraInstruction };
				return { target: { type: 'baseBranch', branch }, extraInstruction };
			}

			case 'commit': {
				const sha = parts[1];
				if (!sha) return { target: null, extraInstruction };
				const title = parts.slice(2).join(' ') || undefined;
				return { target: { type: 'commit', sha, title }, extraInstruction };
			}

			case 'folder': {
				const paths = parseAnalysisPaths(parts.slice(1).join(' '));
				if (paths.length === 0) return { target: null, extraInstruction };
				return { target: { type: 'folder', paths }, extraInstruction };
			}

			case 'pr': {
				const ref = parts[1];
				if (!ref) return { target: null, extraInstruction };
				return { target: { type: 'pr', ref }, extraInstruction };
			}

			default:
				return { target: null, extraInstruction };
		}
	}

	/**
	 * Handle PR checkout and return a AnalysisTarget (or null on failure)
	 */
	async function handlePrCheckout(
		ctx: ExtensionContext,
		ref: string,
	): Promise<AnalysisTarget | null> {
		// First check for pending changes
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify(
				'Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.',
				'error',
			);
			return null;
		}

		const prNumber = parsePrReference(ref);
		if (!prNumber) {
			ctx.ui.notify('Invalid PR reference. Enter a number or GitHub PR URL.', 'error');
			return null;
		}

		// Get PR info
		ctx.ui.notify(`Fetching PR #${prNumber} info...`, 'info');
		const prInfo = await getPrInfo(pi, prNumber);

		if (!prInfo) {
			ctx.ui.notify(
				`Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`,
				'error',
			);
			return null;
		}

		// Checkout the PR
		ctx.ui.notify(`Checking out PR #${prNumber}...`, 'info');
		const checkoutResult = await checkoutPr(pi, prNumber);

		if (!checkoutResult.success) {
			ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, 'error');
			return null;
		}

		ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, 'info');

		return {
			type: 'pullRequest',
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	function isLoopCompatibleTarget(target: AnalysisTarget): boolean {
		if (target.type !== 'commit') {
			return true;
		}

		return false;
	}

	async function runLoopFixingAnalysis(
		ctx: ExtensionCommandContext,
		target: AnalysisTarget,
		extraInstruction?: string,
	): Promise<void> {
		if (analysisLoopInProgress) {
			log.warn('runLoopFixingAnalysis blocked: already running');
			ctx.ui.notify('Loop analysis is already running.', 'warning');
			return;
		}

		log.info(
			'Starting loop-fixing analysis: target=%s, max_iterations=%d',
			target.type,
			ANALYSIS_LOOP_MAX_ITERATIONS,
		);
		if (extraInstruction) {
			log.debug('Extra instruction: %s', extraInstruction);
		}

		analysisLoopInProgress = true;
		setAnalysisWidget(ctx, Boolean(analysisOriginId));
		try {
			ctx.ui.notify(
				'Loop fixing enabled: cycling analysis until no blocking findings remain.',
				'info',
			);

			for (let pass = 1; pass <= ANALYSIS_LOOP_MAX_ITERATIONS; pass++) {
				const analysisBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
				const started = await executeAnalysis(ctx, target, true, {
					includeLocalChanges: true,
					extraInstruction,
				});
				if (!started) {
					ctx.ui.notify(
						'Loop fixing stopped before starting the analysis pass.',
						'warning',
					);
					return;
				}

				const analysisTurnStarted = await waitForLoopTurnToStart(
					ctx,
					analysisBaselineAssistantId,
				);
				if (!analysisTurnStarted) {
					ctx.ui.notify(
						'Loop fixing stopped: analysis pass did not start in time.',
						'error',
					);
					return;
				}

				await ctx.waitForIdle();

				const analysisSnapshot = getLastAssistantSnapshot(ctx);
				if (!analysisSnapshot || analysisSnapshot.id === analysisBaselineAssistantId) {
					ctx.ui.notify(
						'Loop fixing stopped: could not read the analysis result.',
						'warning',
					);
					return;
				}

				if (analysisSnapshot.stopReason === 'aborted') {
					ctx.ui.notify('Loop fixing stopped: analysis was aborted.', 'warning');
					return;
				}

				if (analysisSnapshot.stopReason === 'error') {
					ctx.ui.notify('Loop fixing stopped: analysis failed with an error.', 'error');
					return;
				}

				if (analysisSnapshot.stopReason === 'length') {
					ctx.ui.notify(
						'Loop fixing stopped: analysis output was truncated (stopReason=length).',
						'warning',
					);
					return;
				}

				if (!hasBlockingAnalysisFindings(analysisSnapshot.text)) {
					const finalized = await executeEndAnalysisAction(ctx, 'returnAndSummarize', {
						showSummaryLoader: true,
						notifySuccess: false,
					});
					if (finalized !== 'ok') {
						return;
					}

					log.info(
						'Loop fixing complete: no blocking findings remain after %d passes',
						pass,
					);
					ctx.ui.notify('Loop analysis complete: no blocking findings remain.', 'info');
					return;
				}

				log.info(
					'Loop fixing pass %d: blocking findings found, fix iteration starting',
					pass,
				);
				ctx.ui.notify(
					`Loop fixing pass ${pass}: found blocking findings, returning to fix them...`,
					'info',
				);

				const fixBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
				const sentFixPrompt = await executeEndAnalysisAction(ctx, 'returnAndFix', {
					showSummaryLoader: true,
					notifySuccess: false,
				});
				if (sentFixPrompt !== 'ok') {
					return;
				}

				const fixTurnStarted = await waitForLoopTurnToStart(ctx, fixBaselineAssistantId);
				if (!fixTurnStarted) {
					ctx.ui.notify('Loop fixing stopped: fix pass did not start in time.', 'error');
					return;
				}

				await ctx.waitForIdle();

				const fixSnapshot = getLastAssistantSnapshot(ctx);
				if (!fixSnapshot || fixSnapshot.id === fixBaselineAssistantId) {
					ctx.ui.notify(
						'Loop fixing stopped: could not read the fix pass result.',
						'warning',
					);
					return;
				}
				if (fixSnapshot.stopReason === 'aborted') {
					ctx.ui.notify('Loop fixing stopped: fix pass was aborted.', 'warning');
					return;
				}
				if (fixSnapshot.stopReason === 'error') {
					ctx.ui.notify('Loop fixing stopped: fix pass failed with an error.', 'error');
					return;
				}
				if (fixSnapshot.stopReason === 'length') {
					ctx.ui.notify(
						'Loop fixing stopped: fix pass output was truncated (stopReason=length).',
						'warning',
					);
					return;
				}
			}

			log.warn(
				'Loop fixing hit safety limit: %d passes exceeded',
				ANALYSIS_LOOP_MAX_ITERATIONS,
			);
			ctx.ui.notify(
				`Loop fixing stopped after ${ANALYSIS_LOOP_MAX_ITERATIONS} passes (safety limit reached).`,
				'warning',
			);
		} finally {
			log.info('Loop fixing analysis ended: target=%s', target.type);
			analysisLoopInProgress = false;
			setAnalysisWidget(ctx, Boolean(analysisOriginId));
		}
	}

	// Register the /test-analysis command
	pi.registerCommand('test-analysis', {
		description:
			'Analyze test coverage and quality (staged, uncommitted, branch, commit, or folder)',
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify('Test analysis requires interactive mode', 'error');
				return;
			}

			if (analysisLoopInProgress) {
				ctx.ui.notify('Loop analysis is already running.', 'warning');
				return;
			}

			// Check if we're already in an analysis
			if (analysisOriginId) {
				ctx.ui.notify(
					'Already in an analysis. Use /end-analysis to finish first.',
					'warning',
				);
				return;
			}

			// Check if we're in a git repository
			const { code } = await pi.exec('git', ['rev-parse', '--git-dir']);
			if (code !== 0) {
				ctx.ui.notify('Not a git repository', 'error');
				return;
			}

			// Try to parse direct arguments
			let target: AnalysisTarget | null = null;
			let fromSelector = false;
			let extraInstruction: string | undefined;
			const parsed = parseArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, 'error');
				return;
			}
			extraInstruction = parsed.extraInstruction?.trim() || undefined;

			if (parsed.target) {
				if (parsed.target.type === 'pr') {
					// Handle PR checkout (async operation)
					target = await handlePrCheckout(ctx, parsed.target.ref);
					if (!target) {
						ctx.ui.notify('PR analysis failed. Returning to analysis menu.', 'warning');
					}
				} else {
					target = parsed.target;
				}
			}

			// If no args or invalid args, show selector
			if (!target) {
				fromSelector = true;
			}

			while (true) {
				if (!target && fromSelector) {
					target = await showAnalysisSelector(ctx);
				}

				if (!target) {
					ctx.ui.notify('Analysis cancelled', 'info');
					return;
				}

				if (analysisLoopFixingEnabled && !isLoopCompatibleTarget(target)) {
					ctx.ui.notify('Loop mode is not available for commit analysis.', 'error');
					if (fromSelector) {
						target = null;
						continue;
					}
					return;
				}

				if (analysisLoopFixingEnabled) {
					await runLoopFixingAnalysis(ctx, target, extraInstruction);
					return;
				}

				// Determine if we should use fresh session mode
				// Check if this is a new session (no messages yet)
				const entries = ctx.sessionManager.getEntries();
				const messageCount = entries.filter((e) => e.type === 'message').length;

				// In an empty session, default to fresh analysis mode so /end-analysis works consistently.
				let useFreshSession = messageCount === 0;

				if (messageCount > 0) {
					// Existing session - ask user which mode they want
					const choice = await ctx.ui.select('Start analysis in:', [
						'Empty branch',
						'Current session',
					]);

					if (choice === undefined) {
						if (fromSelector) {
							target = null;
							continue;
						}
						ctx.ui.notify('Analysis cancelled', 'info');
						return;
					}

					useFreshSession = choice === 'Empty branch';
				}

				await executeAnalysis(ctx, target, useFreshSession, { extraInstruction });
				return;
			}
		},
	});

	// Custom prompt for analysis summaries - focuses on preserving actionable findings
	const ANALYSIS_SUMMARY_PROMPT = `我们即将离开测试分析分支，返回主编码分支。
创建一个结构化的交接信息，用于立即实施改进。

你必须总结在此分支中进行的全部测试分析结果，以便能够针对发现项采取行动。
不要遗漏任何发现：包括每一个已识别的可操作问题。

必需的章节（按顺序）：

## 分析范围
- 分析了哪些内容（文件/路径、变更和范围）

## 结论
- "protected"（受保护）、"gaps found"（存在缺口）或"unprotected"（无保护）

## 发现项
对每个发现项，包括：
- 类别（基础设施/CI/用例缺口/用例质量）和优先级标签 ([P0]..[P3])
- 文件位置（\`path/to/file.ext:line\`）
- 为什么重要（简要）
- 应该怎样修改（简要、可操作）

## 改进队列
1. 有序的实施检查清单（最高优先级优先）

## 约束与偏好
- 分析中提到的任何约束或偏好
- 或"(无)"

## 人工审查者标注项（非阻塞）
仅包含适用的标注项（不要用是/否行）：
- **建议引入新的测试框架/工具/服务：** <工具/学习成本>
- **建议新增 CI 流水线或调整分支保护策略：** <变更/需要谁审批>
- **建议会显著增加 CI 执行时长：** <估算/分层执行建议>
- **建议需要改造现有用例（可能引入不稳定性）：** <用例/范围>

如果不适用，则写"- (无)"。

这些是供人工参考的信息性标注，它们本身不是修复项。

尽可能保留精确的文件路径、函数名和配置位置。`;

	const ANALYSIS_FIX_FINDINGS_PROMPT = `使用本次会话中最新的测试分析总结，立即实施发现项。

说明：
1. 将总结中的发现项/改进队列视为检查清单。
2. 按优先级顺序实施：P0、P1，然后 P2（如果快速且安全则包括 P3）。
3. 如果某个发现项无效/已修复/当前无法处理，简要说明原因后继续。
4. 将"Human Reviewer Callouts (Non-Blocking)" section 仅视为信息性内容。
5. 准确识别测试文件位置，避免在错误位置添加测试。
6. 在实施过程中遵守现有项目的测试约定（命名、目录结构、框架选择）。
7. 实施后运行相关测试以验证不破坏已有功能。
8. 以以下内容结尾：已实施项、已推迟/跳过的项（附原因）以及验证结果。`;

	type EndAnalysisAction = 'returnOnly' | 'returnAndFix' | 'returnAndSummarize';
	type EndAnalysisActionResult = 'ok' | 'cancelled' | 'error';
	type EndAnalysisActionOptions = {
		showSummaryLoader?: boolean;
		notifySuccess?: boolean;
	};

	function getActiveAnalysisOrigin(ctx: ExtensionContext): string | undefined {
		if (analysisOriginId) {
			return analysisOriginId;
		}

		const state = getAnalysisState(ctx);
		if (state?.active && state.originId) {
			analysisOriginId = state.originId;
			return analysisOriginId;
		}

		if (state?.active) {
			setAnalysisWidget(ctx, false);
			pi.appendEntry(ANALYSIS_STATE_TYPE, { active: false });
			ctx.ui.notify(
				'Analysis state was missing origin info; cleared analysis status.',
				'warning',
			);
		}

		return undefined;
	}

	function clearAnalysisState(ctx: ExtensionContext) {
		setAnalysisWidget(ctx, false);
		analysisOriginId = undefined;
		pi.appendEntry(ANALYSIS_STATE_TYPE, { active: false });
	}

	async function navigateWithSummary(
		ctx: ExtensionCommandContext,
		originId: string,
		showLoader: boolean,
	): Promise<{ cancelled: boolean; error?: string } | null> {
		if (showLoader && ctx.hasUI) {
			return ctx.ui.custom<{ cancelled: boolean; error?: string } | null>(
				(tui, theme, _kb, done) => {
					const loader = new BorderedLoader(
						tui,
						theme,
						'Returning and summarizing analysis branch...',
					);
					loader.onAbort = () => done(null);

					ctx.navigateTree(originId, {
						summarize: true,
						customInstructions: ANALYSIS_SUMMARY_PROMPT,
						replaceInstructions: true,
					})
						.then(done)
						.catch((err) =>
							done({
								cancelled: false,
								error: err instanceof Error ? err.message : String(err),
							}),
						);

					return loader;
				},
			);
		}

		try {
			return await ctx.navigateTree(originId, {
				summarize: true,
				customInstructions: ANALYSIS_SUMMARY_PROMPT,
				replaceInstructions: true,
			});
		} catch (error) {
			return {
				cancelled: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async function executeEndAnalysisAction(
		ctx: ExtensionCommandContext,
		action: EndAnalysisAction,
		options: EndAnalysisActionOptions = {},
	): Promise<EndAnalysisActionResult> {
		const originId = getActiveAnalysisOrigin(ctx);
		if (!originId) {
			if (!getAnalysisState(ctx)?.active) {
				ctx.ui.notify('Not in an analysis branch (use /test-analysis first)', 'info');
			}
			return 'error';
		}

		const notifySuccess = options.notifySuccess ?? true;

		if (action === 'returnOnly') {
			try {
				const result = await ctx.navigateTree(originId, { summarize: false });
				if (result.cancelled) {
					ctx.ui.notify('Navigation cancelled. Use /end-analysis to try again.', 'info');
					return 'cancelled';
				}
			} catch (error) {
				ctx.ui.notify(
					`Failed to return: ${error instanceof Error ? error.message : String(error)}`,
					'error',
				);
				return 'error';
			}

			clearAnalysisState(ctx);
			if (notifySuccess) {
				ctx.ui.notify('Analysis complete! Returned to original position.', 'info');
			}
			return 'ok';
		}

		const summaryResult = await navigateWithSummary(
			ctx,
			originId,
			options.showSummaryLoader ?? false,
		);
		if (summaryResult === null) {
			ctx.ui.notify('Summarization cancelled. Use /end-analysis to try again.', 'info');
			return 'cancelled';
		}

		if (summaryResult.error) {
			ctx.ui.notify(`Summarization failed: ${summaryResult.error}`, 'error');
			return 'error';
		}

		if (summaryResult.cancelled) {
			ctx.ui.notify('Navigation cancelled. Use /end-analysis to try again.', 'info');
			return 'cancelled';
		}

		clearAnalysisState(ctx);

		if (action === 'returnAndSummarize') {
			if (!ctx.ui.getEditorText().trim()) {
				ctx.ui.setEditorText('Act on the analysis findings');
			}
			if (notifySuccess) {
				ctx.ui.notify('Analysis complete! Returned and summarized.', 'info');
			}
			return 'ok';
		}

		pi.sendUserMessage(ANALYSIS_FIX_FINDINGS_PROMPT, { deliverAs: 'followUp' });
		if (notifySuccess) {
			ctx.ui.notify('Analysis complete! Returned and queued a follow-up.', 'info');
		}
		return 'ok';
	}

	async function runEndAnalysis(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify('/end-analysis requires interactive mode', 'error');
			return;
		}

		if (analysisLoopInProgress) {
			ctx.ui.notify('Loop analysis is running. Wait for it to finish.', 'info');
			return;
		}

		if (endAnalysisInProgress) {
			ctx.ui.notify('/end-analysis is already running', 'info');
			return;
		}

		endAnalysisInProgress = true;
		try {
			const choice = await ctx.ui.select('Finish analysis:', [
				'Return only',
				'Return and fix findings',
				'Return and summarize',
			]);

			if (choice === undefined) {
				ctx.ui.notify('Cancelled. Use /end-analysis to try again.', 'info');
				return;
			}

			const action: EndAnalysisAction =
				choice === 'Return and fix findings'
					? 'returnAndFix'
					: choice === 'Return and summarize'
						? 'returnAndSummarize'
						: 'returnOnly';

			await executeEndAnalysisAction(ctx, action, {
				showSummaryLoader: true,
				notifySuccess: true,
			});
		} finally {
			endAnalysisInProgress = false;
		}
	}

	// Register the /end-analysis command
	pi.registerCommand('end-analysis', {
		description: 'Complete test analysis and return to original position',
		handler: async (_args, ctx) => {
			await runEndAnalysis(ctx);
		},
	});
}
