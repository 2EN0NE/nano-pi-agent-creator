/**
 * Code Review Extension (inspired by Codex's review feature)
 *
 * Provides a `/review` command that prompts the agent to review code changes.
 * Supports multiple review modes:
 * - Review a GitHub pull request (checks out the PR locally)
 * - Review against a base branch (PR style)
 * - Review uncommitted changes
 * - Review a specific commit
 * - Shared custom review instructions (applied to all review modes when configured)
 *
 * Usage:
 * - `/review` - show interactive selector
 * - `/review pr 123` - review PR #123 (checks out locally)
 * - `/review pr https://github.com/owner/repo/pull/123` - review PR from URL
 * - `/review staged` - review staged changes only
 * - `/review uncommitted` - review uncommitted changes directly
 * - `/review branch main` - review against main branch
 * - `/review commit abc123` - review specific commit
 * - `/review folder src docs` - review specific folders/files (snapshot, not diff)
 * - `/review` selector includes Add/Remove custom review instructions (applies to all modes)
 * - `/review --extra "focus on performance regressions"` - add extra review instruction (works with any mode)
 *
 * Project-specific review guidelines:
 * - If a REVIEW_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the review prompt.
 *
 * Note: PR review requires a clean working tree (no uncommitted changes to tracked files).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('review');
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

// State to track fresh session review (where we branched from).
// Module-level state means only one review can be active at a time.
// This is intentional - the UI and /end-review command assume a single active review.
let reviewOriginId: string | undefined = undefined;
let endReviewInProgress = false;
let reviewLoopFixingEnabled = false;
let reviewCustomInstructions: string | undefined = undefined;
let reviewLoopInProgress = false;

const REVIEW_STATE_TYPE = 'review-session';
const REVIEW_ANCHOR_TYPE = 'review-anchor';
const REVIEW_SETTINGS_TYPE = 'review-settings';
const REVIEW_LOOP_MAX_ITERATIONS = 10;
const REVIEW_LOOP_START_TIMEOUT_MS = 15000;
const REVIEW_LOOP_START_POLL_MS = 50;

type ReviewSessionState = {
	active: boolean;
	originId?: string;
};

type ReviewSettingsState = {
	loopFixingEnabled?: boolean;
	customInstructions?: string;
};

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget('review', undefined);
		return;
	}

	ctx.ui.setWidget('review', (_tui, theme) => {
		const message = reviewLoopInProgress
			? '审查会话进行中（循环修复运行中）'
			: reviewLoopFixingEnabled
				? '审查会话进行中（循环修复已启用）'
				: '审查会话进行中';
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

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
	let state: ReviewSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === 'custom' && entry.customType === REVIEW_STATE_TYPE) {
			state = entry.data as ReviewSessionState | undefined;
		}
	}

	return state;
}

function applyReviewState(ctx: ExtensionContext) {
	const state = getReviewState(ctx);

	if (state?.active && state.originId) {
		reviewOriginId = state.originId;
		setReviewWidget(ctx, true);
		return;
	}

	reviewOriginId = undefined;
	setReviewWidget(ctx, false);
}

function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
	let state: ReviewSettingsState | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === 'custom' && entry.customType === REVIEW_SETTINGS_TYPE) {
			state = entry.data as ReviewSettingsState | undefined;
		}
	}

	return {
		loopFixingEnabled: state?.loopFixingEnabled === true,
		customInstructions: state?.customInstructions?.trim() || undefined,
	};
}

function applyReviewSettings(ctx: ExtensionContext) {
	const state = getReviewSettings(ctx);
	reviewLoopFixingEnabled = state.loopFixingEnabled === true;
	reviewCustomInstructions = state.customInstructions?.trim() || undefined;
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
		if (heading && /^findings\b/i.test(heading.title)) {
			start = i + 1;
			findingsHeadingLevel = heading.level;
			break;
		}
		if (/^\s*findings\s*:?\s*$/i.test(line)) {
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
				/^(review scope|verdict|overall verdict|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
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
			/^\s*(review scope|verdict|overall verdict|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
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
		/^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+\[P[0-3]\]\s*-\s*(?:drop everything|urgent|normal|low|nice to have)\b/i.test(
			line,
		)
	) {
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
		const inlineMatch = line.match(/^\s*(?:[*-+]\s*)?(?:overall\s+)?verdict\s*:\s*(.+)$/i);
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
			if (!/^(?:overall\s+)?verdict\b/i.test(normalizedHeading)) {
				continue;
			}
			verdictLevel = heading.level;
		} else if (!/^\s*(?:overall\s+)?verdict\s*:?\s*$/i.test(line)) {
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
					/^(review scope|findings|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
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

			if (/\bcorrect\b/i.test(normalizeVerdictValue(trimmed))) {
				break;
			}
		}
	}

	return false;
}

function hasBlockingReviewFindings(messageText: string): boolean {
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

// Review target types (matching Codex's approach)
type ReviewTarget =
	| { type: 'staged' }
	| { type: 'uncommitted' }
	| { type: 'baseBranch'; branch: string }
	| { type: 'commit'; sha: string; title?: string }
	| { type: 'pullRequest'; prNumber: number; baseBranch: string; title: string }
	| { type: 'folder'; paths: string[] };

// Prompts (adapted from Codex)
const STAGED_PROMPT =
	'审查当前已暂存的代码变更（即执行 `git commit` 后会提交的内容）。仅使用 `git diff --staged` 和 `git diff --staged --stat` 来检查变更。不要包含未暂存或未跟踪的文件。提供按优先级排序、可操作的发现。';

const UNCOMMITTED_PROMPT =
	'审查当前所有代码变更（已暂存、未暂存及未跟踪的文件），并提供按优先级排序的发现。';

const LOCAL_CHANGES_REVIEW_INSTRUCTIONS =
	'同时包括本分支中的本地工作区变更（已暂存、未暂存及未跟踪的文件）。使用 `git status --porcelain`、`git diff`、`git diff --staged` 和 `git ls-files --others --exclude-standard` 命令，以便本地修复也纳入本次审查循环。';

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"审查基分支 '{baseBranch}' 的代码变更。本次比较的合并基提交是 {mergeBaseSha}。运行 `git diff {mergeBaseSha}` 以检查相对于 {baseBranch} 的变更。提供按优先级排序、可操作的发现。";

const BASE_BRANCH_PROMPT_FALLBACK =
	'审查基分支 \'{branch}\' 的代码变更。先找到当前分支与 {branch} 上游分支的合并差异（例如 `git merge-base HEAD "$(git rev-parse --abbrev-ref "{branch}@{upstream}")"`），然后针对该 SHA 运行 `git diff` 查看将合并到 {branch} 分支的变更。提供按优先级排序、可操作的发现。';

const COMMIT_PROMPT_WITH_TITLE =
	'审查提交 {sha}（"{title}"）引入的代码变更。提供按优先级排序、可操作的发现。';

const COMMIT_PROMPT = '审查提交 {sha} 引入的代码变更。提供按优先级排序、可操作的发现。';

const PULL_REQUEST_PROMPT =
	'审查针对基分支 \'{baseBranch}\' 的拉取请求 #{prNumber}（"{title}"）。本次比较的合并基提交是 {mergeBaseSha}。运行 `git diff {mergeBaseSha}` 以检查将合并的变更。提供按优先级排序、可操作的发现。';

const PULL_REQUEST_PROMPT_FALLBACK =
	'审查针对基分支 \'{baseBranch}\' 的拉取请求 #{prNumber}（"{title}"）。先找到当前分支与 {baseBranch} 之间的合并基（例如 `git merge-base HEAD {baseBranch}`），然后针对该 SHA 运行 `git diff` 查看将合并的变更。提供按优先级排序、可操作的发现。';

const FOLDER_REVIEW_PROMPT =
	'审查以下路径中的代码：{paths}。这是一个快照审查（而非差异对比），直接读取这些路径中的文件并提供按优先级排序、可操作的发现。';

// The detailed review rubric (adapted from Codex's review_prompt.md)
const REVIEW_RUBRIC = `# 审查指南

你是一名代码审查者，正在审查另一位工程师提交的代码变更。

以下是判断需要标记哪些问题的默认指南。这些并非最终定论——如果你在其他地方（开发者消息、用户消息、文件或下面附加的项目审查指南中）遇到更具体的指南，则以那些指南为准，覆盖这些通用说明。

## 判断需要标记的问题

标记满足以下条件的问题：
1. 对代码的准确性、性能、安全性或可维护性有实质影响。
2. 是具体的、可操作的问题（而非笼统的问题或多个问题的混合）。
3. 所要求的严谨程度与代码库其余部分一致。
4. 是在本次审查的变更中引入的（而非预先存在的缺陷）。
5. 作者如果知晓很可能愿意修复。
6. 不依赖于对代码库或作者意图的未声明的假设。
7. 对代码的其他部分有可证明的影响——不能仅凭推测某个变更可能破坏另一部分，你必须识别出可证明受影响的部分。
8. 明显不是作者的蓄意变更。
9. 对不受信任的用户输入要特别小心，遵循具体指南进行审查。
10. 将静默的局部错误恢复（尤其是解析/IO/网络回退）视为高信号审查候选，除非有明确的边界级理由。

## 不受信任的用户输入

1. 注意开放重定向，必须始终检查只跳转到受信任的域名（?next_page=...）
2. 始终标记未参数化的 SQL
3. 在用户提供 URL 输入的系统中，HTTP 请求始终需要防止访问本地资源（拦截 DNS 解析器！）
4. 如果有选择，使用转义而非清理（例如：HTML 转义）

## 评论指南

1. 明确说明为什么该问题是一个问题。
2. 恰当地传达严重程度——不要夸大。
3. 保持简洁——最多一段。
4. 代码片段控制在 3 行以内，使用行内代码或代码块包裹。
5. 仅在提供具体替换代码时使用 \`\`\`suggestion 块（最少行数；块内不含注释）。保持被替换行的前导空格不变。
6. 明确指出问题出现的场景/环境。
7. 使用实事求是、客观的语气——有帮助的 AI 助手，而非指责性的。
8. 文字让审查者无需仔细阅读即可快速理解。
9. 避免过度奉承或无帮助的措辞，如"做得好…"。

## 审查优先级

1. 在末尾呈现关键但不阻塞的人工标注项（迁移、依赖变更、认证/权限、兼容性、破坏性操作）。
2. 偏好简单直接的方案，而非没有明确价值的封装或抽象。
3. 将背压处理视为系统稳定性的关键。
4. 应用系统级思维；标记增加运维风险或值班唤醒的变更。
5. 确保错误始终依据错误码或稳定标识符进行检查，绝不依据错误消息。

## 快速失败的错误处理（严格）

审查新增或修改的错误处理时，默认采用快速失败行为。

1. 评估每个新增或修改的 \`try/catch\`：识别什么可能失败，以及为什么在该层进行局部处理是正确的。
2. 优先传播而非局部恢复。如果当前作用域无法在保持正确性的前提下完全恢复，应重新抛出（可选择附加上下文），而不是返回回退值。
3. 标记隐藏失败信号的 catch 块（例如返回 \`null\`/\`[]\`/\`false\`、吞掉 JSON 解析失败、记录日志后继续执行，或"尽力而为"的静默恢复）。
4. JSON 解析/解码默认应大声失败。静默回退解析仅在存在明确的兼容性需求和清晰测试过的行为时才可接受。
5. 边界处理器（HTTP 路由、CLI 入口点、监督者）可以转换错误，但绝不能假装成功或静默降级。
6. 如果 catch 块仅为了满足 lint/风格要求而没有实际处理，将其视为缺陷。
7. 不确定时，宁可快速崩溃也不要静默降级。

## 必需的人工标注项（非阻塞，放在最末尾）

在发现/结论之后，你必须附加以下最终章节：

## 人工审查者标注项（非阻塞）

仅包含适用的标注项（不要用是/否行）：

- **此变更添加了数据库迁移：** <文件/详情>
- **此变更引入了新的依赖：** <包/详情>
- **此变更更改了依赖（或锁定文件）：** <文件/包/详情>
- **此变更修改了认证/权限行为：** <变更内容及位置>
- **此变更引入了不向后兼容的公共 schema/API/契约变更：** <变更内容及位置>
- **此变更包含不可逆或破坏性操作：** <操作及范围>

本节的规则：
1. 这些是供人工审查者参考的信息性标注，不是修复项。
2. 除非存在独立的缺陷，否则不要将它们包含在发现中。
3. 仅凭这些标注不得改变结论。
4. 只包含适用于本次审查变更的标注项。
5. 保持每个标注项按原样加粗。
6. 如果都不适用，则写"- (无)"。

## 优先级级别

在标题中用优先级标签标记每个发现：
- [P0] - 放下一切立即修复。阻塞发布/运维。仅针对不依赖于输入假设的通用问题。
- [P1] - 紧急。应在下一个周期处理。
- [P2] - 普通。应最终修复。
- [P3] - 低优先级。锦上添花。

## 输出格式

以清晰、结构化的格式提供你的发现：
1. 列出每个发现及其优先级标签、文件位置和说明。
2. 发现必须引用与实际差异重叠的位置——不要标记预先存在的代码。
3. 保持行引用尽可能短（避免超过 5-10 行的范围；选择最合适的子范围）。
4. 提供总体结论："correct"（无阻塞问题）或"needs attention"（存在阻塞问题）。
5. 忽略琐碎的样式问题，除非它们模糊了含义或违反了文档化的标准。
6. 不要生成完整的 PR 修复——仅标记问题，可选地提供简短的 suggestion 块。
7. 以必需的"Human Reviewer Callouts (Non-Blocking)"章节和所有适用的加粗标注项结束（不用是/否）。

输出作者如果知晓会修复的所有发现。如果没有符合条件的发现，明确说明代码看起来没问题。不要只找到第一个发现就停止——列出每一个符合条件的问题。然后附加必需的 non-blocking callouts 章节。`;

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	log.debug('Searching for REVIEW_GUIDELINES.md from cwd=%s', cwd);
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, '.pi');
		const guidelinesPath = path.join(currentDir, 'REVIEW_GUIDELINES.md');

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (guidelineStats?.isFile()) {
				try {
					const content = await fs.readFile(guidelinesPath, 'utf8');
					const trimmed = content.trim();
					if (trimmed) {
						log.info(
							'Loaded REVIEW_GUIDELINES.md from %s (%d chars)',
							guidelinesPath,
							trimmed.length,
						);
					}
					return trimmed ? trimmed : null;
				} catch (err) {
					log.warn(
						'Failed to read REVIEW_GUIDELINES.md at %s: %s',
						guidelinesPath,
						err instanceof Error ? err.message : String(err),
					);
					return null;
				}
			}
			log.debug('No REVIEW_GUIDELINES.md found at %s', currentDir);
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
 * Build the review prompt based on target
 */
async function buildReviewPrompt(
	pi: ExtensionAPI,
	target: ReviewTarget,
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
				? `${basePrompt} ${LOCAL_CHANGES_REVIEW_INSTRUCTIONS}`
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
				? `${basePrompt} ${LOCAL_CHANGES_REVIEW_INSTRUCTIONS}`
				: basePrompt;
		}

		case 'folder':
			return FOLDER_REVIEW_PROMPT.replace('{paths}', target.paths.join(', '));
	}
}

/**
 * Get user-facing hint for the review target
 */
function getUserFacingHint(target: ReviewTarget): string {
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
	const deadline = Date.now() + REVIEW_LOOP_START_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const lastAssistantId = getLastAssistantSnapshot(ctx)?.id;
		if (
			!ctx.isIdle() ||
			ctx.hasPendingMessages() ||
			(lastAssistantId && lastAssistantId !== previousAssistantId)
		) {
			return true;
		}
		await sleep(REVIEW_LOOP_START_POLL_MS);
	}

	return false;
}

// Review preset options for the selector (keep this order stable)
const REVIEW_PRESETS = [
	{
		value: 'staged',
		label: '仅审查已暂存的变更',
		description: '(暂存区 vs 提交)',
	},
	{
		value: 'uncommitted',
		label: '审查所有未提交的变更',
		description: '',
	},
	{
		value: 'baseBranch',
		label: '对比基分支进行审查',
		description: '(本地)',
	},
	{ value: 'commit', label: '审查某个提交', description: '' },
	{
		value: 'pullRequest',
		label: '审查拉取请求',
		description: '(GitHub PR)',
	},
	{
		value: 'folder',
		label: '审查文件夹/文件',
		description: '(快照模式，非差异对比)',
	},
] as const;

const TOGGLE_LOOP_FIXING_VALUE = 'toggleLoopFixing' as const;
const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = 'toggleCustomInstructions' as const;
type ReviewPresetValue =
	| (typeof REVIEW_PRESETS)[number]['value']
	| typeof TOGGLE_LOOP_FIXING_VALUE
	| typeof TOGGLE_CUSTOM_INSTRUCTIONS_VALUE;

export default function reviewExtension(pi: ExtensionAPI) {
	function persistReviewSettings() {
		pi.appendEntry(REVIEW_SETTINGS_TYPE, {
			loopFixingEnabled: reviewLoopFixingEnabled,
			customInstructions: reviewCustomInstructions,
		});
	}

	function setReviewLoopFixingEnabled(enabled: boolean) {
		reviewLoopFixingEnabled = enabled;
		persistReviewSettings();
	}

	function setReviewCustomInstructions(instructions: string | undefined) {
		reviewCustomInstructions = instructions?.trim() || undefined;
		persistReviewSettings();
	}

	function applyAllReviewState(ctx: ExtensionContext) {
		applyReviewSettings(ctx);
		applyReviewState(ctx);
	}

	pi.on('session_start', (_event, ctx) => {
		applyAllReviewState(ctx);
	});

	pi.on('session_tree', (_event, ctx) => {
		applyAllReviewState(ctx);
	});

	/**
	 * Determine the smart default review type based on git state
	 */
	async function getSmartDefault(): Promise<'uncommitted' | 'baseBranch' | 'commit'> {
		// Priority 1: If there are uncommitted changes, default to reviewing them
		if (await hasUncommittedChanges(pi)) {
			return 'uncommitted';
		}

		// Priority 2: If on a feature branch (not the default branch), default to PR-style review
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		if (currentBranch && currentBranch !== defaultBranch) {
			return 'baseBranch';
		}

		// Priority 3: Default to reviewing a specific commit
		return 'commit';
	}

	/**
	 * Show the review preset selector
	 */
	async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// Determine smart default (but keep the list order stable)
		const smartDefault = await getSmartDefault();
		const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
			value: preset.value,
			label: preset.label,
			description: preset.description,
		}));
		const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

		while (true) {
			const customInstructionsLabel = reviewCustomInstructions
				? '移除自定义审查指令'
				: '添加自定义审查指令';
			const customInstructionsDescription = reviewCustomInstructions
				? '(当前已设置)'
				: '(适用于所有审查模式)';
			const loopToggleLabel = reviewLoopFixingEnabled ? '禁用循环修复' : '启用循环修复';
			const loopToggleDescription = reviewLoopFixingEnabled ? '(当前已启用)' : '(当前已禁用)';
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

			const result = await ctx.ui.custom<ReviewPresetValue | null>(
				(tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
					container.addChild(new Text(theme.fg('accent', theme.bold('选择审查预设'))));

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

					selectList.onSelect = (item) => done(item.value as ReviewPresetValue);
					selectList.onCancel = () => done(null);

					container.addChild(selectList);
					container.addChild(new Text(theme.fg('dim', '按回车确认，按 ESC 返回')));
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
				const nextEnabled = !reviewLoopFixingEnabled;
				setReviewLoopFixingEnabled(nextEnabled);
				ctx.ui.notify(nextEnabled ? '循环修复已启用' : '循环修复已禁用', 'info');
				continue;
			}

			if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
				if (reviewCustomInstructions) {
					setReviewCustomInstructions(undefined);
					ctx.ui.notify('自定义审查指令已移除', 'info');
					continue;
				}

				const customInstructions = await ctx.ui.editor(
					'输入自定义审查指令（适用于所有审查模式）：',
					'',
				);

				if (!customInstructions?.trim()) {
					ctx.ui.notify('自定义审查指令未更改', 'info');
					continue;
				}

				setReviewCustomInstructions(customInstructions);
				ctx.ui.notify('自定义审查指令已保存', 'info');
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
					if (reviewLoopFixingEnabled) {
						ctx.ui.notify('循环模式不适用于提交审查', 'error');
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
	 * Show branch selector for base branch review
	 */
	async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const branches = await getLocalBranches(pi);
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);

		// Never offer the current branch as a base branch (reviewing against itself is meaningless).
		const candidateBranches = currentBranch
			? branches.filter((b) => b !== currentBranch)
			: branches;

		if (candidateBranches.length === 0) {
			ctx.ui.notify(
				currentBranch ? `未找到其他分支（当前分支：${currentBranch}）` : '未找到分支',
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
			container.addChild(new Text(theme.fg('accent', theme.bold('选择基分支'))));

			const searchInput = new Input();
			container.addChild(searchInput);
			container.addChild(new Spacer(1));

			const listContainer = new Container();
			container.addChild(listContainer);
			container.addChild(new Text(theme.fg('dim', '输入筛选 • 回车选中 • ESC 取消')));
			container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

			let filteredItems = items;
			let selectList: SelectList | null = null;

			const updateList = () => {
				listContainer.clear();
				if (filteredItems.length === 0) {
					listContainer.addChild(new Text(theme.fg('warning', '  没有匹配的分支')));
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
	async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const commits = await getRecentCommits(pi, 20);

		if (commits.length === 0) {
			ctx.ui.notify('未找到提交', 'error');
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
				container.addChild(new Text(theme.fg('accent', theme.bold('选择要审查的提交'))));

				const searchInput = new Input();
				container.addChild(searchInput);
				container.addChild(new Spacer(1));

				const listContainer = new Container();
				container.addChild(listContainer);
				container.addChild(new Text(theme.fg('dim', '输入筛选 • 回车选中 • ESC 取消')));
				container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

				let filteredItems = items;
				let selectList: SelectList | null = null;

				const updateList = () => {
					listContainer.clear();
					if (filteredItems.length === 0) {
						listContainer.addChild(new Text(theme.fg('warning', '  没有匹配的提交')));
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

	function parseReviewPaths(value: string): string[] {
		return value
			.split(/\s+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	/**
	 * Show folder input
	 */
	async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const result = await ctx.ui.editor('输入要审查的文件夹/文件（空格分隔或每行一个）：', '.');

		if (!result?.trim()) return null;
		const paths = parseReviewPaths(result);
		if (paths.length === 0) return null;

		return { type: 'folder', paths };
	}

	/**
	 * Show PR input and handle checkout
	 */
	async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// First check for pending changes that would prevent branch switching
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify('无法检出 PR：你有未提交的变更，请先提交或暂存', 'error');
			return null;
		}

		// Get PR reference from user
		const prRef = await ctx.ui.editor(
			'输入 PR 编号或 URL（如 123 或 https://github.com/owner/repo/pull/123）：',
			'',
		);

		if (!prRef?.trim()) return null;

		const prNumber = parsePrReference(prRef);
		if (!prNumber) {
			ctx.ui.notify('无效的 PR 引用，请输入编号或 GitHub PR URL', 'error');
			return null;
		}

		// Get PR info from GitHub
		ctx.ui.notify(`正在获取 PR #${prNumber} 信息...`, 'info');
		const prInfo = await getPrInfo(pi, prNumber);

		if (!prInfo) {
			ctx.ui.notify(`未找到 PR #${prNumber}，请确认 gh 已认证且 PR 存在`, 'error');
			return null;
		}

		// Check again for pending changes (in case something changed)
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify('无法检出 PR：你有未提交的变更，请先提交或暂存', 'error');
			return null;
		}

		// Checkout the PR
		ctx.ui.notify(`正在检出 PR #${prNumber}...`, 'info');
		const checkoutResult = await checkoutPr(pi, prNumber);

		if (!checkoutResult.success) {
			ctx.ui.notify(`检出 PR 失败：${checkoutResult.error}`, 'error');
			return null;
		}

		ctx.ui.notify(`已检出 PR #${prNumber}（${prInfo.headBranch}）`, 'info');

		return {
			type: 'pullRequest',
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	/**
	 * Execute the review
	 */
	async function executeReview(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
		useFreshSession: boolean,
		options?: { includeLocalChanges?: boolean; extraInstruction?: string },
	): Promise<boolean> {
		// Check if we're already in a review
		if (reviewOriginId) {
			log.warn('executeReview blocked: review already in progress');
			ctx.ui.notify('已在审查中，请先使用 /end-review 结束', 'warning');
			return false;
		}

		log.info(
			'Starting review: target=%s, freshSession=%s, options=%j',
			target.type,
			useFreshSession,
			options,
		);
		log.debug('Review target details: %j', target);

		// Handle fresh session mode
		if (useFreshSession) {
			// Store current position (where we'll return to).
			// In an empty session there is no leaf yet, so create a lightweight anchor first.
			let originId = ctx.sessionManager.getLeafId() ?? undefined;
			if (!originId) {
				pi.appendEntry(REVIEW_ANCHOR_TYPE, {
					createdAt: new Date().toISOString(),
				});
				originId = ctx.sessionManager.getLeafId() ?? undefined;
			}
			if (!originId) {
				ctx.ui.notify('失败：无法确定审查起点', 'error');
				return false;
			}
			reviewOriginId = originId;

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
				// Label it as "code-review" so it's visible in the tree
				try {
					const result = await ctx.navigateTree(firstUserMessage.id, {
						summarize: false,
						label: 'code-review',
					});
					if (result.cancelled) {
						reviewOriginId = undefined;
						return false;
					}
				} catch (error) {
					// Clean up state if navigation fails
					reviewOriginId = undefined;
					ctx.ui.notify(
						`Failed to start review: ${error instanceof Error ? error.message : String(error)}`,
						'error',
					);
					return false;
				}

				// Clear the editor (navigating to user message fills it with the message text)
				ctx.ui.setEditorText('');
			}

			// Restore origin after navigation events (session_tree can reset it)
			reviewOriginId = lockedOriginId;

			// Show widget and persist state only when branch was actually created
			setReviewWidget(ctx, true);
			pi.appendEntry(REVIEW_STATE_TYPE, {
				active: true,
				originId: lockedOriginId,
			});
		} else {
			// No user messages in session — no branch created, clear review state
			reviewOriginId = undefined;
		}

		const prompt = await buildReviewPrompt(pi, target, {
			includeLocalChanges: options?.includeLocalChanges === true,
		});
		const hint = getUserFacingHint(target);
		const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

		// Combine the review rubric with the specific prompt
		let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

		if (reviewCustomInstructions) {
			fullPrompt += `\n\nShared custom review instructions (applies to all reviews):\n\n${reviewCustomInstructions}`;
		}

		if (options?.extraInstruction?.trim()) {
			fullPrompt += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`;
		}

		if (projectGuidelines) {
			fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
		}

		const modeHint = useFreshSession ? ' (fresh session)' : '';
		ctx.ui.notify(`开始审查：${hint}${modeHint}`, 'info');
		log.info(
			'Review prompt sent: hint=%s, prompt_len=%d, guidelines=%s',
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
	type ParsedReviewArgs = {
		target: ReviewTarget | { type: 'pr'; ref: string } | null;
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

	function parseArgs(args: string | undefined): ParsedReviewArgs {
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
				const paths = parseReviewPaths(parts.slice(1).join(' '));
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
	 * Handle PR checkout and return a ReviewTarget (or null on failure)
	 */
	async function handlePrCheckout(
		ctx: ExtensionContext,
		ref: string,
	): Promise<ReviewTarget | null> {
		// First check for pending changes
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify('无法检出 PR：你有未提交的变更，请先提交或暂存', 'error');
			return null;
		}

		const prNumber = parsePrReference(ref);
		if (!prNumber) {
			ctx.ui.notify('无效的 PR 引用，请输入编号或 GitHub PR URL', 'error');
			return null;
		}

		// Get PR info
		ctx.ui.notify(`正在获取 PR #${prNumber} 信息...`, 'info');
		const prInfo = await getPrInfo(pi, prNumber);

		if (!prInfo) {
			ctx.ui.notify(`未找到 PR #${prNumber}，请确认 gh 已认证且 PR 存在`, 'error');
			return null;
		}

		// Checkout the PR
		ctx.ui.notify(`正在检出 PR #${prNumber}...`, 'info');
		const checkoutResult = await checkoutPr(pi, prNumber);

		if (!checkoutResult.success) {
			ctx.ui.notify(`检出 PR 失败：${checkoutResult.error}`, 'error');
			return null;
		}

		ctx.ui.notify(`已检出 PR #${prNumber}（${prInfo.headBranch}）`, 'info');

		return {
			type: 'pullRequest',
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	function isLoopCompatibleTarget(target: ReviewTarget): boolean {
		if (target.type !== 'commit') {
			return true;
		}

		return false;
	}

	async function runLoopFixingReview(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
		extraInstruction?: string,
	): Promise<void> {
		if (reviewLoopInProgress) {
			log.warn('runLoopFixingReview blocked: already running');
			ctx.ui.notify('循环修复正在进行中', 'warning');
			return;
		}

		log.info(
			'Starting loop-fixing review: target=%s, max_iterations=%d',
			target.type,
			REVIEW_LOOP_MAX_ITERATIONS,
		);
		if (extraInstruction) {
			log.debug('Extra instruction: %s', extraInstruction);
		}

		reviewLoopInProgress = true;
		setReviewWidget(ctx, Boolean(reviewOriginId));
		try {
			ctx.ui.notify('循环修复已启用：使用新分支模式循环审查，直至无阻塞发现项。', 'info');

			for (let pass = 1; pass <= REVIEW_LOOP_MAX_ITERATIONS; pass++) {
				const reviewBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
				const started = await executeReview(ctx, target, true, {
					includeLocalChanges: true,
					extraInstruction,
				});
				if (!started) {
					ctx.ui.notify(
						'Loop fixing stopped before starting the review pass.',
						'warning',
					);
					return;
				}

				const reviewTurnStarted = await waitForLoopTurnToStart(
					ctx,
					reviewBaselineAssistantId,
				);
				if (!reviewTurnStarted) {
					ctx.ui.notify(
						'Loop fixing stopped: review pass did not start in time.',
						'error',
					);
					return;
				}

				await ctx.waitForIdle();

				const reviewSnapshot = getLastAssistantSnapshot(ctx);
				if (!reviewSnapshot || reviewSnapshot.id === reviewBaselineAssistantId) {
					ctx.ui.notify(
						'Loop fixing stopped: could not read the review result.',
						'warning',
					);
					return;
				}

				if (reviewSnapshot.stopReason === 'aborted') {
					ctx.ui.notify('Loop fixing stopped: review was aborted.', 'warning');
					return;
				}

				if (reviewSnapshot.stopReason === 'error') {
					ctx.ui.notify('Loop fixing stopped: review failed with an error.', 'error');
					return;
				}

				if (reviewSnapshot.stopReason === 'length') {
					ctx.ui.notify(
						'Loop fixing stopped: review output was truncated (stopReason=length).',
						'warning',
					);
					return;
				}

				if (!hasBlockingReviewFindings(reviewSnapshot.text)) {
					const finalized = await executeEndReviewAction(ctx, 'returnAndSummarize', {
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
					ctx.ui.notify('Loop fixing complete: no blocking findings remain.', 'info');
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
				const sentFixPrompt = await executeEndReviewAction(ctx, 'returnAndFix', {
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
				REVIEW_LOOP_MAX_ITERATIONS,
			);
			ctx.ui.notify(
				`Loop fixing stopped after ${REVIEW_LOOP_MAX_ITERATIONS} passes (safety limit reached).`,
				'warning',
			);
		} finally {
			log.info('Loop fixing review ended: target=%s', target.type);
			reviewLoopInProgress = false;
			setReviewWidget(ctx, Boolean(reviewOriginId));
		}
	}

	// Register the /review command
	pi.registerCommand('review', {
		description: 'Review code changes (PR, uncommitted, branch, commit, or folder)',
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify('审查需要交互模式', 'error');
				return;
			}

			if (reviewLoopInProgress) {
				ctx.ui.notify('循环修复正在进行中', 'warning');
				return;
			}

			// Check if we're already in a review
			if (reviewOriginId) {
				ctx.ui.notify('已在审查中，请先使用 /end-review 结束', 'warning');
				return;
			}

			// Check if we're in a git repository
			const { code } = await pi.exec('git', ['rev-parse', '--git-dir']);
			if (code !== 0) {
				ctx.ui.notify('不是 git 仓库', 'error');
				return;
			}

			// Try to parse direct arguments
			let target: ReviewTarget | null = null;
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
						ctx.ui.notify('PR 审查失败，返回审查菜单', 'warning');
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
					target = await showReviewSelector(ctx);
				}

				if (!target) {
					ctx.ui.notify('已取消审查', 'info');
					return;
				}

				if (reviewLoopFixingEnabled && !isLoopCompatibleTarget(target)) {
					ctx.ui.notify('循环模式不适用于提交审查', 'error');
					if (fromSelector) {
						target = null;
						continue;
					}
					return;
				}

				if (reviewLoopFixingEnabled) {
					await runLoopFixingReview(ctx, target, extraInstruction);
					return;
				}

				// Determine if we should use fresh session mode
				// Check if this is a new session (no messages yet)
				const entries = ctx.sessionManager.getEntries();
				const messageCount = entries.filter((e) => e.type === 'message').length;

				// In an empty session, default to fresh review mode so /end-review works consistently.
				let useFreshSession = messageCount === 0;

				if (messageCount > 0) {
					// Existing session - ask user which mode they want
					const choice = await ctx.ui.select('选择审查模式：', ['新分支', '当前会话']);

					if (choice === undefined) {
						if (fromSelector) {
							target = null;
							continue;
						}
						ctx.ui.notify('Review cancelled', 'info');
						return;
					}

					useFreshSession = choice === '新分支';
				}

				await executeReview(ctx, target, useFreshSession, { extraInstruction });
				return;
			}
		},
	});

	// Custom prompt for review summaries - focuses on preserving actionable findings
	const REVIEW_SUMMARY_PROMPT = `我们即将离开代码审查分支，返回主编码分支。
创建一个结构化的交接信息，用于立即实施修复。

你必须总结在此分支中进行的所有审查内容，以便能够针对发现项采取行动。
不要遗漏任何发现：包括每一个已识别的可操作问题。

必需的章节（按顺序）：

## 审查范围
- 审查了哪些内容（文件/路径、变更和范围）

## 结论
- "correct"（正确）或"needs attention"（需要注意）

## 发现项
对每个发现项，包括：
- 优先级标签 ([P0]..[P3]) 和简短标题
- 文件位置（\`path/to/file.ext:line\`）
- 为什么重要（简要）
- 应该怎样修改（简要、可操作）

## 修复队列
1. 有序的实施检查清单（最高优先级优先）

## 约束与偏好
- 审查中提到的任何约束或偏好
- 或"(无)"

## 人工审查者标注项（非阻塞）
仅包含适用的标注项（不要用是/否行）：
- **此变更添加了数据库迁移：** <文件/详情>
- **此变更引入了新的依赖：** <包/详情>
- **此变更更改了依赖（或锁定文件）：** <文件/包/详情>
- **此变更修改了认证/权限行为：** <变更内容及位置>
- **此变更引入了不向后兼容的公共 schema/API/契约变更：** <变更内容及位置>
- **此变更包含不可逆或破坏性操作：** <操作及范围>

如果不适用，则写"- (无)"。

这些是供人工参考的信息性标注，它们本身不是修复项。

尽可能保留精确的文件路径、函数名和错误消息。`;

	const REVIEW_FIX_FINDINGS_PROMPT = `使用本次会话中最新的审查总结，立即实施审查发现项。

说明：
1. 将总结中的发现项/修复队列视为检查清单。
2. 按优先级顺序修复：P0、P1，然后 P2（如果快速且安全则包括 P3）。
3. 如果某个发现项无效/已修复/当前无法处理，简要说明原因后继续。
4. 将"Human Reviewer Callouts (Non-Blocking)"仅视为信息性内容；不要将其转换为修复任务，除非存在独立的明确发现项。
5. 遵循快速失败的错误处理：不要添加局部 catch/回退恢复，除非当前作用域是能够安全转换错误的明确边界。
6. 如果你添加或保留 \`try/catch\`，说明预期的失败模式，并要么带上上下文重新抛出，要么返回一个边界安全的错误响应。
7. JSON 解析/解码默认应大声失败；避免静默回退解析。
8. 对受影响的代码运行相关测试/检查（在可行的情况下）。
9. 以以下内容结尾：已修复项、已推迟/跳过的项（附原因）以及验证结果。`;

	type EndReviewAction = 'returnOnly' | 'returnAndFix' | 'returnAndSummarize';
	type EndReviewActionResult = 'ok' | 'cancelled' | 'error';
	type EndReviewActionOptions = {
		showSummaryLoader?: boolean;
		notifySuccess?: boolean;
	};

	function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
		if (reviewOriginId) {
			return reviewOriginId;
		}

		const state = getReviewState(ctx);
		if (state?.active && state.originId) {
			reviewOriginId = state.originId;
			return reviewOriginId;
		}

		if (state?.active) {
			setReviewWidget(ctx, false);
			pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
			ctx.ui.notify(
				'Review state was missing origin info; cleared review status.',
				'warning',
			);
		}

		return undefined;
	}

	function clearReviewState(ctx: ExtensionContext) {
		setReviewWidget(ctx, false);
		reviewOriginId = undefined;
		pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
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
						'Returning and summarizing review branch...',
					);
					loader.onAbort = () => done(null);

					ctx.navigateTree(originId, {
						summarize: true,
						customInstructions: REVIEW_SUMMARY_PROMPT,
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
				customInstructions: REVIEW_SUMMARY_PROMPT,
				replaceInstructions: true,
			});
		} catch (error) {
			return {
				cancelled: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async function executeEndReviewAction(
		ctx: ExtensionCommandContext,
		action: EndReviewAction,
		options: EndReviewActionOptions = {},
	): Promise<EndReviewActionResult> {
		const originId = getActiveReviewOrigin(ctx);
		if (!originId) {
			if (!getReviewState(ctx)?.active) {
				ctx.ui.notify('不在审查分支中（未使用新分支，或审查在当前会话中进行）', 'info');
			}
			return 'error';
		}

		const notifySuccess = options.notifySuccess ?? true;

		if (action === 'returnOnly') {
			try {
				const result = await ctx.navigateTree(originId, { summarize: false });
				if (result.cancelled) {
					ctx.ui.notify('导航已取消，如需重试请再次输入 /end-review', 'info');
					return 'cancelled';
				}
			} catch (error) {
				ctx.ui.notify(
					`返回失败：${error instanceof Error ? error.message : String(error)}`,
					'error',
				);
				return 'error';
			}

			clearReviewState(ctx);
			if (notifySuccess) {
				ctx.ui.notify('审查完成！已返回原位置。', 'info');
			}
			return 'ok';
		}

		const summaryResult = await navigateWithSummary(
			ctx,
			originId,
			options.showSummaryLoader ?? false,
		);
		if (summaryResult === null) {
			ctx.ui.notify('总结已取消，如需重试请再次输入 /end-review', 'info');
			return 'cancelled';
		}

		if (summaryResult.error) {
			ctx.ui.notify(`总结失败：${summaryResult.error}`, 'error');
			return 'error';
		}

		if (summaryResult.cancelled) {
			ctx.ui.notify('导航已取消，如需重试请再次输入 /end-review', 'info');
			return 'cancelled';
		}

		clearReviewState(ctx);

		if (action === 'returnAndSummarize') {
			if (!ctx.ui.getEditorText().trim()) {
				ctx.ui.setEditorText('根据审查发现项执行修复');
			}
			if (notifySuccess) {
				ctx.ui.notify('审查完成！已返回并总结。', 'info');
			}
			return 'ok';
		}

		pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: 'followUp' });
		if (notifySuccess) {
			ctx.ui.notify('审查完成！已返回并安排了后续修复任务。', 'info');
		}
		return 'ok';
	}

	async function runEndReview(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify('/end-review 需要交互模式', 'error');
			return;
		}

		if (reviewLoopInProgress) {
			ctx.ui.notify('循环修复正在运行，请等待完成', 'info');
			return;
		}

		if (endReviewInProgress) {
			ctx.ui.notify('/end-review 正在运行中', 'info');
			return;
		}

		// If no active review origin, just silently return (no branch to end)
		if (!getActiveReviewOrigin(ctx)) {
			ctx.ui.notify('当前没有活跃的审查会话，无需执行 /end-review', 'info');
			return;
		}

		endReviewInProgress = true;
		try {
			const choice = await ctx.ui.select('完成审查：', [
				'仅返回',
				'返回并修复发现项',
				'返回并总结',
			]);

			if (choice === undefined) {
				ctx.ui.notify('已取消。如需重试请再次输入 /end-review', 'info');
				return;
			}

			const action: EndReviewAction =
				choice === '返回并修复发现项'
					? 'returnAndFix'
					: choice === '返回并总结'
						? 'returnAndSummarize'
						: 'returnOnly';

			await executeEndReviewAction(ctx, action, {
				showSummaryLoader: true,
				notifySuccess: true,
			});
		} finally {
			endReviewInProgress = false;
		}
	}

	// Register the /end-review command
	pi.registerCommand('end-review', {
		description: 'Complete review and return to original position',
		handler: async (_args, ctx) => {
			await runEndReview(ctx);
		},
	});
}
