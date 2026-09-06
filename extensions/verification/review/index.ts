/**
 * Review Extension — profile 驱动的代码审查 / 测试覆盖分析（ADR-0025）
 *
 * 合并原 review.ts 与 test-analysis.ts：两者主流程一致，仅提示词与
 * "判定结束条件"不同。差异抽成 **审查方案（profile）**，每个 profile 绑定：
 *   - prompt.md    — 提示词（rubric + 各 target prompt + summary/fix），按 `## <section>` 分节
 *   - verdict.json — 判定结束条件（结论词 / 发现章节标题 / 发现行识别规则）
 *
 * `config.json` 是轻量 profile 注册表（id + label + verb + guidelinesFile）。
 * 资源文件用 `import.meta.url` 定位（随插件目录分发，pi-logger 同款模式）。
 *
 * 命令：
 *   - `/review`       — 先选审查方案，再选目标（staged/uncommitted/branch/commit/PR/folder）
 *   - `/review staged` / `/review branch main` / ... — 直接带目标（用最近一次方案）
 *   - `/end-review`   — 完成审查并返回原位置（summary/fix 提示词随当前方案走）
 *
 * 项目级审查指南：<cwd>/.pi 同级目录下的 REVIEW_GUIDELINES.md（code-review）
 * 或 TEST_ANALYSIS_GUIDELINES.md（test-analysis），内容追加到审查提示词。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { DynamicBorder, BorderedLoader } from '@earendil-works/pi-coding-agent';
import { TitleBar } from '../../../src/tui/helpers.js';
import { selectPanel } from '../../../src/tui/select-panel.js';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const log = createLogger('review');

// ═══════════════════════════════════════════════════════════════════════════
// Profile 加载（资源文件随插件目录分发）
// ═══════════════════════════════════════════════════════════════════════════

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

interface VerdictRule {
	safeValues: string[];
	blockingValues: string[];
	headings: string[];
	stopHeadings: string[];
}

interface FindingsRule {
	headings: string[];
	boundaryHeadings: string[];
}

interface FindingLineRule {
	priorityTag: string;
	excludeDefinitionPatterns: string[];
	excludePlaceholderPatterns: string[];
}

interface ProfileConfig {
	id: string;
	label: string;
	verb: string;
	object: string;
	guidelinesFile: string;
}

interface ReviewProfile {
	id: string;
	label: string;
	verb: string;
	object: string;
	guidelinesFile: string;
	prompts: Map<string, string>;
	verdict: VerdictRule;
	findings: FindingsRule;
	findingLine: FindingLineRule;
}

/** prompt.md 的 section 白名单（`## <section>` 分节，正文内 `## ` 标题不属于分节符） */
const PROMPT_SECTIONS = [
	'rubric',
	'staged',
	'uncommitted',
	'localChanges',
	'baseBranch',
	'baseBranchFallback',
	'commit',
	'commitWithTitle',
	'pullRequest',
	'pullRequestFallback',
	'folder',
	'summary',
	'fix',
] as const;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 profile 词表里的一个词转成正则片段。
 * - 空格 → \s*（宽容连续/零空格）
 * - 以英文字母开头的词 → 追加 \b（避免 "protected" 误匹配 "unprotected" 等）
 */
function wordToRegexFragment(word: string): string {
	const frag = escapeRegExp(word).replace(/ /g, '\\s*');
	return /^[A-Za-z]/.test(word) ? frag + '\\b' : frag;
}

/** 把词表拼成一个带 `^` 锚定的 alternation 正则（i 标志） */
function wordsToRegex(words: string[], anchor = '^'): RegExp {
	const body = words.map(wordToRegexFragment).join('|');
	return new RegExp(`${anchor}(?:${body})`, 'i');
}

/** 词是否命中（英文词用 \b 边界，词内空格转 \s+） */
function wordMatches(text: string, word: string): boolean {
	const escaped = escapeRegExp(word).replace(/ /g, '\\s+');
	const hasAscii = /[A-Za-z]/.test(word);
	const boundary = hasAscii ? '\\b' : '';
	return new RegExp(`${boundary}${escaped}${boundary}`, 'i').test(text);
}

/** 是否 "not <word>" 的否定形式 */
function isNegated(text: string, word: string): boolean {
	const escaped = escapeRegExp(word).replace(/ /g, '\\s+');
	return new RegExp(`\\bnot\\s+${escaped}\\b`, 'i').test(text);
}

/** 解析 prompt.md：按 `## <section>` 分节，section 名需在 PROMPT_SECTIONS 白名单内 */
function parsePromptSections(md: string): Map<string, string> {
	const sections = new Map<string, string>();
	const lines = md.split('\n');
	let current: string | null = null;
	let buf: string[] = [];

	for (const line of lines) {
		const m = line.match(/^##\s+(.+?)\s*$/);
		const name = m ? m[1].trim() : null;
		if (m && name && (PROMPT_SECTIONS as readonly string[]).includes(name)) {
			if (current) sections.set(current, buf.join('\n').trim());
			current = name;
			buf = [];
		} else if (current) {
			buf.push(line);
		}
	}
	if (current) sections.set(current, buf.join('\n').trim());
	return sections;
}

/** 加载单个 profile 的全部资源 */
function loadProfile(config: ProfileConfig): ReviewProfile {
	const dir = join(PLUGIN_DIR, 'profiles', config.id);
	const promptMd = readFileSync(join(dir, 'prompt.md'), 'utf-8');
	const verdictRaw = readFileSync(join(dir, 'verdict.json'), 'utf-8');
	let verdict: { verdict?: VerdictRule; findings?: FindingsRule; findingLine?: FindingLineRule };
	try {
		verdict = JSON.parse(verdictRaw) as {
			verdict?: VerdictRule;
			findings?: FindingsRule;
			findingLine?: FindingLineRule;
		};
	} catch (error) {
		throw new Error(
			`profile "${config.id}" 的 verdict.json 解析失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const prompts = parsePromptSections(promptMd);
	for (const sec of PROMPT_SECTIONS) {
		if (!prompts.has(sec)) {
			throw new Error(`profile "${config.id}" 缺少 prompt section: ${sec}`);
		}
	}

	return {
		id: config.id,
		label: config.label,
		verb: config.verb,
		object: config.object,
		guidelinesFile: config.guidelinesFile,
		prompts,
		verdict: verdict.verdict as VerdictRule,
		findings: verdict.findings as FindingsRule,
		findingLine: verdict.findingLine as FindingLineRule,
	};
}

/** 加载全部 profile（config.json 注册表顺序即选择器顺序） */
function loadProfiles(): ReviewProfile[] {
	const configRaw = readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf-8');
	let config: { profiles: ProfileConfig[] };
	try {
		config = JSON.parse(configRaw) as { profiles: ProfileConfig[] };
	} catch (error) {
		throw new Error(
			`config.json 解析失败: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return config.profiles.map(loadProfile);
}

const PROFILES = loadProfiles();
const DEFAULT_PROFILE = PROFILES[0];
if (!DEFAULT_PROFILE) throw new Error('review: config.json 未声明任何 profile');

function getProfile(id: string | undefined): ReviewProfile {
	if (!id) return DEFAULT_PROFILE;
	return PROFILES.find((p) => p.id === id) ?? DEFAULT_PROFILE;
}

// ═══════════════════════════════════════════════════════════════════════════
// 状态（模块级：一次只允许一个活跃审查会话；设置按 profile 隔离）
// ═══════════════════════════════════════════════════════════════════════════

let reviewOriginId: string | undefined = undefined;
let endReviewInProgress = false;
let reviewLoopInProgress = false;
let activeProfileId: string | undefined = undefined;
/** 最近一次使用的 profile id（直接带 target 的 /review 调用时复用） */
let lastProfileId: string = DEFAULT_PROFILE.id;
/** 按 profile 隔离的设置 */
const profileSettings = new Map<
	string,
	{ loopFixingEnabled: boolean; customInstructions?: string }
>();

function getProfileSettings(profileId: string): {
	loopFixingEnabled: boolean;
	customInstructions?: string;
} {
	return (
		profileSettings.get(profileId) ?? {
			loopFixingEnabled: false,
			customInstructions: undefined,
		}
	);
}

/** 上次已持久化的设置快照（JSON），用于跳过无变化的重复写入 */
let lastPersistedSettingsJson: string | undefined;

function buildSettingsPayload(): {
	lastProfileId: string;
	profiles: Record<string, { loopFixingEnabled?: boolean; customInstructions?: string }>;
} {
	const profiles: Record<string, { loopFixingEnabled?: boolean; customInstructions?: string }> =
		{};
	for (const [id, s] of profileSettings.entries()) {
		profiles[id] = {
			loopFixingEnabled: s.loopFixingEnabled,
			customInstructions: s.customInstructions,
		};
	}
	return { lastProfileId, profiles };
}

function persistReviewSettings(pi: ExtensionAPI) {
	const payload = buildSettingsPayload();
	const json = JSON.stringify(payload);
	if (json === lastPersistedSettingsJson) return;
	lastPersistedSettingsJson = json;
	pi.appendEntry(REVIEW_SETTINGS_TYPE, payload);
}

function setProfileLoopFixing(pi: ExtensionAPI, profileId: string, enabled: boolean) {
	const cur = getProfileSettings(profileId);
	profileSettings.set(profileId, { ...cur, loopFixingEnabled: enabled });
	persistReviewSettings(pi);
}

function setProfileCustomInstructions(
	pi: ExtensionAPI,
	profileId: string,
	instructions: string | undefined,
) {
	const cur = getProfileSettings(profileId);
	profileSettings.set(profileId, {
		...cur,
		customInstructions: instructions?.trim() || undefined,
	});
	persistReviewSettings(pi);
}

const REVIEW_STATE_TYPE = 'review-session';
const REVIEW_ANCHOR_TYPE = 'review-anchor';
const REVIEW_SETTINGS_TYPE = 'review-settings';

// 合并前 test-analysis 扩展遗留的状态类型（ADR-0025）。仅用于识别并引导迁移，
// 不再新写入：新状态一律用 REVIEW_STATE_TYPE / REVIEW_SETTINGS_TYPE。
const LEGACY_ANALYSIS_STATE_TYPE = 'test-analysis-session';
const LEGACY_ANALYSIS_SETTINGS_TYPE = 'test-analysis-settings';
const REVIEW_LOOP_MAX_ITERATIONS = 10;
const REVIEW_LOOP_START_TIMEOUT_MS = 15000;
const REVIEW_LOOP_START_POLL_MS = 50;

type ReviewSessionState = {
	active: boolean;
	originId?: string;
	profileId?: string;
};

type ReviewSettingsState = {
	lastProfileId?: string;
	profiles?: Record<string, { loopFixingEnabled?: boolean; customInstructions?: string }>;
};

function setReviewWidget(ctx: ExtensionContext, active: boolean, profile: ReviewProfile) {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget('review', undefined);
		return;
	}

	const verb = profile.verb;
	ctx.ui.setWidget('review', (_tui, theme) => {
		const message = reviewLoopInProgress
			? `${verb}会话进行中（循环修复运行中）`
			: getProfileSettings(profile.id).loopFixingEnabled
				? `${verb}会话进行中（循环修复已启用）`
				: `${verb}会话进行中`;
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
	if (state) return state;

	// 迁移引导：合并前 test-analysis 的活跃会话（无 profileId），映射为 test-analysis 方案。
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === 'custom' && entry.customType === LEGACY_ANALYSIS_STATE_TYPE) {
			const legacy = entry.data as { active?: boolean; originId?: string } | undefined;
			if (legacy?.active && legacy.originId) {
				log.warn(
					'Detected legacy test-analysis-session state, migrating to test-analysis profile',
				);
				return { active: true, originId: legacy.originId, profileId: 'test-analysis' };
			}
		}
	}
	return undefined;
}

function applyReviewState(ctx: ExtensionContext) {
	const state = getReviewState(ctx);

	if (state?.active && state.originId) {
		reviewOriginId = state.originId;
		if (state.profileId) {
			activeProfileId = state.profileId;
			lastProfileId = state.profileId;
		}
		setReviewWidget(ctx, true, getProfile(state.profileId));
		return;
	}

	reviewOriginId = undefined;
	activeProfileId = undefined;
	setReviewWidget(ctx, false, DEFAULT_PROFILE);
}

/** 反向遍历取最新的 review-settings 条目（与 session-manager 的 getSessionName 同款先例） */
export function getLatestReviewSettings(
	entries: readonly SessionEntry[],
): ReviewSettingsState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === 'custom' && entry.customType === REVIEW_SETTINGS_TYPE) {
			return entry.data as ReviewSettingsState | undefined;
		}
	}
	return undefined;
}

function getReviewSettingsState(ctx: ExtensionContext): ReviewSettingsState | undefined {
	return getLatestReviewSettings(ctx.sessionManager.getEntries());
}

function applyReviewSettings(ctx: ExtensionContext) {
	profileSettings.clear();
	const state = getReviewSettingsState(ctx);
	if (state?.lastProfileId) {
		lastProfileId = state.lastProfileId;
	}
	if (state?.profiles) {
		for (const [id, s] of Object.entries(state.profiles)) {
			profileSettings.set(id, {
				loopFixingEnabled: s.loopFixingEnabled === true,
				customInstructions: s.customInstructions?.trim() || undefined,
			});
		}
		lastPersistedSettingsJson = JSON.stringify(buildSettingsPayload());
		return;
	}

	// 迁移引导：合并前 test-analysis 的顶层设置（非 profiles 结构），映射到 test-analysis 方案下。
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === 'custom' && entry.customType === LEGACY_ANALYSIS_SETTINGS_TYPE) {
			const legacy = entry.data as
				{ loopFixingEnabled?: boolean; customInstructions?: string } | undefined;
			if (legacy) {
				log.warn(
					'Detected legacy test-analysis-settings state, migrating to test-analysis profile',
				);
				profileSettings.set('test-analysis', {
					loopFixingEnabled: legacy.loopFixingEnabled === true,
					customInstructions: legacy.customInstructions?.trim() || undefined,
				});
			}
			lastPersistedSettingsJson = JSON.stringify(buildSettingsPayload());
			return;
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// 判定结束条件（参数化——骨架统一，词表来自 profile.verdict / findings / findingLine）
// ═══════════════════════════════════════════════════════════════════════════

function parseMarkdownHeading(line: string): { level: number; title: string } | null {
	const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
	if (!headingMatch) return null;
	const rawTitle = headingMatch[2].replace(/\s+#+\s*$/, '').trim();
	return { level: headingMatch[1].length, title: rawTitle };
}

function getFindingsSectionBounds(
	lines: string[],
	findingsRule: FindingsRule,
): { start: number; end: number } | null {
	const headingTitleRe = wordsToRegex(findingsRule.headings, '^');
	const boundaryRe = wordsToRegex(findingsRule.boundaryHeadings, '^');

	let start = -1;
	let findingsHeadingLevel: number | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);
		if (heading && headingTitleRe.test(heading.title)) {
			start = i + 1;
			findingsHeadingLevel = heading.level;
			break;
		}
		// 纯文本行匹配："findings" 或 "发现列表" 单独成行（可带冒号）
		const trimmed = line.trim();
		if (
			findingsRule.headings.some((h) =>
				new RegExp(`^${escapeRegExp(h)}\\s*[:：]?\\s*$`, 'i').test(trimmed),
			)
		) {
			start = i + 1;
			break;
		}
	}

	if (start < 0) return null;

	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);
		if (heading) {
			const normalizedTitle = heading.title.replace(/[*_`]/g, '').trim();
			if (boundaryRe.test(normalizedTitle)) {
				end = i;
				break;
			}
			if (/\[P[0-3]\]/i.test(heading.title)) continue;
			if (findingsHeadingLevel !== null && heading.level <= findingsHeadingLevel) {
				end = i;
				break;
			}
		}
		if (boundaryRe.test(line.trim())) {
			end = i;
			break;
		}
	}

	return { start, end };
}

function isLikelyFindingLine(line: string, findingLineRule: FindingLineRule): boolean {
	const tag = findingLineRule.priorityTag;
	if (!new RegExp(tag, 'i').test(line)) {
		return false;
	}

	// 排除 "priority tag" 说明行（rubric 里的元说明，非真发现）
	if (/^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+priority\s+tag\b/i.test(line)) {
		return false;
	}

	// 排除"优先级定义行"（rubric 里解释 P0/P1/P2/P3 含义的那几行）
	const defWords = findingLineRule.excludeDefinitionPatterns;
	if (defWords.length > 0) {
		const defRe = new RegExp(
			`^\\s*(?:[-*+]|(?:\\d+)[.)]|#{1,6})\\s+(?:\\*\\*|__)?${tag}(?:\\*\\*|__)?\\s*-\\s*(?:${defWords
				.map(escapeRegExp)
				.join('|')})`,
			'i',
		);
		if (defRe.test(line)) return false;
	}

	// 排除"rubric 示例回显"占位符
	if (findingLineRule.excludePlaceholderPatterns.length > 0) {
		const phRe = new RegExp(findingLineRule.excludePlaceholderPatterns.join('|'));
		if (phRe.test(line)) return false;
	}

	const allPriorityTags = line.match(/\[P[0-3]\]/gi) ?? [];
	if (allPriorityTags.length > 1) return false;

	if (/^\s*(?:[-*+]|(?:\d+)[.)])\s+/.test(line)) return true;
	if (/^\s*#{1,6}\s+/.test(line)) return true;
	if (/^\s*(?:\*\*|__)?\[P[0-3]\](?:\*\*|__)?(?=\s|:|-)/i.test(line)) return true;

	return false;
}

function normalizeVerdictValue(value: string): string {
	return value
		.trim()
		.replace(/^[-*+]\s*/, '')
		.replace(/^['"`]+|['"`]+$/g, '')
		.toLowerCase();
}

/** 行是否像"多选回显"（含枚举分隔符：or / 或 / 斜杠 / 顿号） */
function hasEnumerationMarker(text: string): boolean {
	return /\bor\b|或|\/|、/.test(text);
}

/**
 * 判定单个结论值是否"阻塞"（需要继续循环修复）。
 * 统一算法覆盖二态（correct/needs attention）与三态（protected/gaps found/unprotected）：
 *   1. 枚举拒绝：safe + blocking 词命中数 > 1 且行含枚举分隔符 → 是 rubric 的多选回显，拒绝
 *      （仅拒绝枚举回显，避免 "needs attention — 结构整体 correct" 这类
 *        附带解释的结论被误判为非阻塞）
 *   2. blocking 词命中（且非 "not X"）→ 阻塞
 *   3. 否则非阻塞
 */
function isBlockingVerdictValue(value: string, verdictRule: VerdictRule): boolean {
	const normalized = normalizeVerdictValue(value);
	const allValues = [...verdictRule.safeValues, ...verdictRule.blockingValues];
	const hits = allValues.filter((w) => wordMatches(normalized, w));
	if (hits.length > 1 && hasEnumerationMarker(normalized)) return false;

	for (const w of verdictRule.blockingValues) {
		if (wordMatches(normalized, w) && !isNegated(normalized, w)) return true;
	}
	return false;
}

function hasBlockingVerdict(messageText: string, verdictRule: VerdictRule): boolean {
	const lines = messageText.split(/\r?\n/);
	const headingTitleRe = wordsToRegex(verdictRule.headings, '^');
	const stopRe = wordsToRegex(verdictRule.stopHeadings, '^');
	const inlineRe = new RegExp(
		`^\\s*(?:[*-+]\\s*)?(?:${verdictRule.headings.map(wordToRegexFragment).join('|')})\\s*[:：]\\s*(.+)$`,
		'i',
	);

	for (const line of lines) {
		const inlineMatch = line.match(inlineRe);
		if (inlineMatch && isBlockingVerdictValue(inlineMatch[1], verdictRule)) {
			return true;
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);

		let verdictLevel: number | null = null;
		if (heading) {
			const normalizedHeading = heading.title.replace(/[*_`]/g, '').trim();
			if (!headingTitleRe.test(normalizedHeading)) continue;
			verdictLevel = heading.level;
		} else if (
			!verdictRule.headings.some((h) =>
				new RegExp(`^\\s*${escapeRegExp(h)}\\s*[:：]?\\s*$`, 'i').test(line),
			)
		) {
			continue;
		}

		for (let j = i + 1; j < lines.length; j++) {
			const verdictLine = lines[j];
			const nextHeading = parseMarkdownHeading(verdictLine);
			if (nextHeading) {
				const normalizedNextHeading = nextHeading.title.replace(/[*_`]/g, '').trim();
				if (verdictLevel === null || nextHeading.level <= verdictLevel) break;
				if (stopRe.test(normalizedNextHeading)) break;
			}

			const trimmed = verdictLine.trim();
			if (!trimmed) continue;

			if (isBlockingVerdictValue(trimmed, verdictRule)) return true;

			if (
				verdictRule.safeValues.some((s) => wordMatches(normalizeVerdictValue(trimmed), s))
			) {
				break;
			}
		}
	}

	return false;
}

function hasBlockingFindings(messageText: string, profile: ReviewProfile): boolean {
	const lines = messageText.split(/\r?\n/);
	const bounds = getFindingsSectionBounds(lines, profile.findings);
	const candidateLines = bounds ? lines.slice(bounds.start, bounds.end) : lines;

	let inCodeFence = false;
	let foundTaggedFinding = false;
	for (const line of candidateLines) {
		if (/^\s*```/.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) continue;
		if (!isLikelyFindingLine(line, profile.findingLine)) continue;

		foundTaggedFinding = true;
		if (/\[(P0|P1|P2)\]/i.test(line)) return true;
	}

	if (foundTaggedFinding) return false;
	return hasBlockingVerdict(messageText, profile.verdict);
}

// ═══════════════════════════════════════════════════════════════════════════
// 审查目标类型（与合并前一致）
// ═══════════════════════════════════════════════════════════════════════════

type ReviewTarget =
	| { type: 'staged' }
	| { type: 'uncommitted' }
	| { type: 'baseBranch'; branch: string }
	| { type: 'commit'; sha: string; title?: string }
	| { type: 'pullRequest'; prNumber: number; baseBranch: string; title: string }
	| { type: 'folder'; paths: string[] };

async function loadProjectReviewGuidelines(
	cwd: string,
	guidelinesFile: string,
): Promise<string | null> {
	log.debug('Searching for %s from cwd=%s', guidelinesFile, cwd);
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, '.pi');
		const guidelinesPath = path.join(currentDir, guidelinesFile);

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (guidelineStats?.isFile()) {
				try {
					const content = await fs.readFile(guidelinesPath, 'utf8');
					const trimmed = content.trim();
					if (trimmed) {
						log.info(
							'Loaded %s from %s (%d chars)',
							guidelinesFile,
							guidelinesPath,
							trimmed.length,
						);
					}
					return trimmed ? trimmed : null;
				} catch (err) {
					log.warn(
						'Failed to read %s at %s: %s',
						guidelinesFile,
						guidelinesPath,
						err instanceof Error ? err.message : String(err),
					);
					return null;
				}
			}
			log.debug('No %s found at %s', guidelinesFile, currentDir);
			return null;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// git 辅助（与合并前完全一致）
// ═══════════════════════════════════════════════════════════════════════════

async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
	try {
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
			if (code === 0 && mergeBase.trim()) return mergeBase.trim();
		}
		const { stdout: mergeBase, code } = await pi.exec('git', ['merge-base', 'HEAD', branch]);
		if (code === 0 && mergeBase.trim()) return mergeBase.trim();
		return null;
	} catch {
		return null;
	}
}

async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec('git', ['branch', '--format=%(refname:short)']);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split('\n')
		.filter((b) => b.trim());
}

async function getRecentCommits(
	pi: ExtensionAPI,
	limit: number = 10,
): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec('git', ['log', '--oneline', '-n', `${limit}`]);
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

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec('git', ['status', '--porcelain']);
	return code === 0 && stdout.trim().length > 0;
}

async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec('git', ['status', '--porcelain']);
	if (code !== 0) return false;
	const lines = stdout
		.trim()
		.split('\n')
		.filter((line) => line.trim());
	const trackedChanges = lines.filter((line) => !line.startsWith('??'));
	return trackedChanges.length > 0;
}

function parsePrReference(ref: string): number | null {
	const trimmed = ref.trim();
	const num = parseInt(trimmed, 10);
	if (!isNaN(num) && num > 0) return num;
	const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
	if (urlMatch) return parseInt(urlMatch[1], 10);
	return null;
}

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
		return { baseBranch: data.baseRefName, title: data.title, headBranch: data.headRefName };
	} catch {
		return null;
	}
}

async function checkoutPr(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<{ success: boolean; error?: string }> {
	log.info('Checking out PR #%d', prNumber);
	const { stdout, stderr, code } = await pi.exec('gh', ['pr', 'checkout', String(prNumber)]);
	if (code !== 0) {
		log.warn('PR checkout failed: #%d — %s', prNumber, (stderr || stdout).trim());
		return { success: false, error: stderr || stdout || 'Failed to checkout PR' };
	}
	log.info('PR #%d checked out successfully', prNumber);
	return { success: true };
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec('git', ['branch', '--show-current']);
	if (code === 0 && stdout.trim()) return stdout.trim();
	return null;
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const { stdout, code } = await pi.exec('git', [
		'symbolic-ref',
		'refs/remotes/origin/HEAD',
		'--short',
	]);
	if (code === 0 && stdout.trim()) return stdout.trim().replace('origin/', '');
	const branches = await getLocalBranches(pi);
	if (branches.includes('main')) return 'main';
	if (branches.includes('master')) return 'master';
	return 'main';
}

// ═══════════════════════════════════════════════════════════════════════════
// 提示词构建（模板变量来自 profile.prompts，运行时替换）
// ═══════════════════════════════════════════════════════════════════════════

function fillTemplate(text: string, vars: Record<string, string>): string {
	let out = text;
	for (const [k, v] of Object.entries(vars)) {
		out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
	}
	return out;
}

async function buildReviewPrompt(
	pi: ExtensionAPI,
	profile: ReviewProfile,
	target: ReviewTarget,
	options?: { includeLocalChanges?: boolean },
): Promise<string> {
	const p = profile.prompts;
	const includeLocalChanges = options?.includeLocalChanges === true;

	switch (target.type) {
		case 'staged':
			return p.get('staged')!;

		case 'uncommitted':
			return p.get('uncommitted')!;

		case 'baseBranch': {
			const mergeBase = await getMergeBase(pi, target.branch);
			const basePrompt = mergeBase
				? fillTemplate(p.get('baseBranch')!, {
						baseBranch: target.branch,
						mergeBaseSha: mergeBase,
					})
				: fillTemplate(p.get('baseBranchFallback')!, { branch: target.branch });
			return includeLocalChanges ? `${basePrompt} ${p.get('localChanges')!}` : basePrompt;
		}

		case 'commit':
			if (target.title) {
				return fillTemplate(p.get('commitWithTitle')!, {
					sha: target.sha,
					title: target.title,
				});
			}
			return fillTemplate(p.get('commit')!, { sha: target.sha });

		case 'pullRequest': {
			const mergeBase = await getMergeBase(pi, target.baseBranch);
			const vars = {
				prNumber: String(target.prNumber),
				title: target.title,
				baseBranch: target.baseBranch,
			};
			const basePrompt = mergeBase
				? fillTemplate(p.get('pullRequest')!, { ...vars, mergeBaseSha: mergeBase })
				: fillTemplate(p.get('pullRequestFallback')!, vars);
			return includeLocalChanges ? `${basePrompt} ${p.get('localChanges')!}` : basePrompt;
		}

		case 'folder':
			return fillTemplate(p.get('folder')!, { paths: target.paths.join(', ') });
	}
}

function getUserFacingHint(_profile: ReviewProfile, target: ReviewTarget): string {
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
	if (typeof content === 'string') return content.trim();
	if (!Array.isArray(content)) return '';
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
		if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
		const assistantMessage = entry.message as { content?: unknown; stopReason?: string };
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

// ═══════════════════════════════════════════════════════════════════════════
// 选择器
// ═══════════════════════════════════════════════════════════════════════════

const TARGET_VALUES = [
	'staged',
	'uncommitted',
	'baseBranch',
	'commit',
	'pullRequest',
	'folder',
] as const;
const TOGGLE_LOOP_FIXING_VALUE = 'toggleLoopFixing' as const;
const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = 'toggleCustomInstructions' as const;
type TargetPresetValue =
	| (typeof TARGET_VALUES)[number]
	| typeof TOGGLE_LOOP_FIXING_VALUE
	| typeof TOGGLE_CUSTOM_INSTRUCTIONS_VALUE;

function targetPresetItems(profile: ReviewProfile): SelectItem[] {
	const { verb, object } = profile;
	return [
		{ value: 'staged', label: `仅${verb}已暂存的${object}`, description: '(暂存区 vs 提交)' },
		{ value: 'uncommitted', label: `${verb}所有未提交的${object}`, description: '' },
		{ value: 'baseBranch', label: `对比基分支${verb}${object}`, description: '(本地)' },
		{ value: 'commit', label: `${verb}某个提交的${object}`, description: '' },
		{ value: 'pullRequest', label: `${verb} PR 的${object}`, description: '(GitHub PR)' },
		{
			value: 'folder',
			label: `${verb}文件夹/文件的${object}`,
			description: '(快照模式，非差异对比)',
		},
	];
}

async function showProfileSelector(ctx: ExtensionContext): Promise<ReviewProfile | null> {
	const items: SelectItem[] = PROFILES.map((p) => ({
		value: p.id,
		label: p.label,
		description: '',
	}));

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new TitleBar('审查方案', (str) => theme.fg('accent', theme.bold(str))));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg('accent', text),
			selectedText: (text) => theme.fg('accent', text),
			description: (text) => theme.fg('muted', text),
			scrollInfo: (text) => theme.fg('dim', text),
			noMatch: (text) => theme.fg('warning', text),
		});

		selectList.onSelect = (item) => done(item.value);
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
	});

	if (!result) return null;
	return PROFILES.find((p) => p.id === result) ?? null;
}

async function showTargetSelector(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	profile: ReviewProfile,
): Promise<ReviewTarget | null> {
	const smartDefault = await getSmartDefault(pi, profile);
	const presetItems = targetPresetItems(profile);
	const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

	while (true) {
		const settings = getProfileSettings(profile.id);
		const customInstructionsLabel = settings.customInstructions
			? '移除自定义审查指令'
			: '添加自定义审查指令';
		const customInstructionsDescription = settings.customInstructions
			? '(当前已设置)'
			: '(适用于所有审查模式)';
		const loopToggleLabel = settings.loopFixingEnabled ? '禁用循环修复' : '启用循环修复';
		const loopToggleDescription = settings.loopFixingEnabled ? '(当前已启用)' : '(当前已禁用)';

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

		const result = await ctx.ui.custom<TargetPresetValue | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(
				new TitleBar(`${profile.verb}目标`, (str) => theme.fg('accent', theme.bold(str))),
			);

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg('accent', text),
				selectedText: (text) => theme.fg('accent', text),
				description: (text) => theme.fg('muted', text),
				scrollInfo: (text) => theme.fg('dim', text),
				noMatch: (text) => theme.fg('warning', text),
			});

			if (smartDefaultIndex >= 0) selectList.setSelectedIndex(smartDefaultIndex);

			selectList.onSelect = (item) => done(item.value as TargetPresetValue);
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
		});

		if (!result) return null;

		if (result === TOGGLE_LOOP_FIXING_VALUE) {
			const next = !settings.loopFixingEnabled;
			setProfileLoopFixing(pi, profile.id, next);
			ctx.ui.notify(next ? '循环修复已启用' : '循环修复已禁用', 'info');
			continue;
		}

		if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
			if (settings.customInstructions) {
				setProfileCustomInstructions(pi, profile.id, undefined);
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
			setProfileCustomInstructions(pi, profile.id, customInstructions);
			ctx.ui.notify('自定义审查指令已保存', 'info');
			continue;
		}

		switch (result) {
			case 'staged':
				return { type: 'staged' };
			case 'uncommitted':
				return { type: 'uncommitted' };
			case 'baseBranch': {
				const target = await showBranchSelector(pi, ctx);
				if (target) return target;
				break;
			}
			case 'commit': {
				if (settings.loopFixingEnabled) {
					ctx.ui.notify('循环模式不适用于提交审查', 'error');
					break;
				}
				const target = await showCommitSelector(pi, ctx);
				if (target) return target;
				break;
			}
			case 'folder': {
				const target = await showFolderInput(pi, ctx);
				if (target) return target;
				break;
			}
			case 'pullRequest': {
				const target = await showPrInput(pi, ctx);
				if (target) return target;
				break;
			}
			default:
				return null;
		}
	}
}

async function getSmartDefault(
	pi: ExtensionAPI,
	_profile: ReviewProfile,
): Promise<'uncommitted' | 'baseBranch' | 'commit'> {
	if (await hasUncommittedChanges(pi)) return 'uncommitted';
	const currentBranch = await getCurrentBranch(pi);
	const defaultBranch = await getDefaultBranch(pi);
	if (currentBranch && currentBranch !== defaultBranch) return 'baseBranch';
	return 'commit';
}

async function showBranchSelector(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
	const branches = await getLocalBranches(pi);
	const currentBranch = await getCurrentBranch(pi);
	const defaultBranch = await getDefaultBranch(pi);

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
		container.addChild(
			new TitleBar('Base Branch', (str) => theme.fg('accent', theme.bold(str))),
		);

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

async function showCommitSelector(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
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
			container.addChild(
				new TitleBar('Commits to Review', (str) => theme.fg('accent', theme.bold(str))),
			);

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
					done(commit ?? null);
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

async function showFolderInput(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<ReviewTarget | null> {
	const result = await ctx.ui.editor('输入要审查的文件夹/文件（空格分隔或每行一个）：', '.');
	if (!result?.trim()) return null;
	const paths = parseReviewPaths(result);
	if (paths.length === 0) return null;
	return { type: 'folder', paths };
}

async function showPrInput(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ReviewTarget | null> {
	if (await hasPendingChanges(pi)) {
		ctx.ui.notify('无法检出 PR：你有未提交的变更，请先提交或暂存', 'error');
		return null;
	}

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

	ctx.ui.notify(`正在获取 PR #${prNumber} 信息...`, 'info');
	const prInfo = await getPrInfo(pi, prNumber);
	if (!prInfo) {
		ctx.ui.notify(`未找到 PR #${prNumber}，请确认 gh 已认证且 PR 存在`, 'error');
		return null;
	}

	if (await hasPendingChanges(pi)) {
		ctx.ui.notify('无法检出 PR：你有未提交的变更，请先提交或暂存', 'error');
		return null;
	}

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

// ═══════════════════════════════════════════════════════════════════════════
// 扩展入口
// ═══════════════════════════════════════════════════════════════════════════

export default function reviewExtension(pi: ExtensionAPI) {
	function applyAllState(ctx: ExtensionContext) {
		applyReviewSettings(ctx);
		applyReviewState(ctx);
	}

	pi.on('session_start', (_event, ctx) => applyAllState(ctx));
	pi.on('session_tree', (_event, ctx) => applyAllState(ctx));

	async function executeReview(
		ctx: ExtensionCommandContext,
		profile: ReviewProfile,
		target: ReviewTarget,
		useFreshSession: boolean,
		options?: { includeLocalChanges?: boolean; extraInstruction?: string },
	): Promise<boolean> {
		if (reviewOriginId) {
			log.warn('executeReview blocked: review already in progress');
			ctx.ui.notify('已在审查中，请先使用 /end-review 结束', 'warning');
			return false;
		}

		log.info(
			'Starting review: profile=%s, target=%s, freshSession=%s, options=%j',
			profile.id,
			target.type,
			useFreshSession,
			options,
		);
		log.debug('Review target details: %j', target);

		if (useFreshSession) {
			let originId = ctx.sessionManager.getLeafId() ?? undefined;
			if (!originId) {
				pi.appendEntry(REVIEW_ANCHOR_TYPE, { createdAt: new Date().toISOString() });
				originId = ctx.sessionManager.getLeafId() ?? undefined;
			}
			if (!originId) {
				ctx.ui.notify('失败：无法确定审查起点', 'error');
				return false;
			}
			reviewOriginId = originId;
			activeProfileId = profile.id;

			const lockedOriginId = originId;

			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find(
				(e) => e.type === 'message' && e.message.role === 'user',
			);

			if (firstUserMessage) {
				try {
					const result = await ctx.navigateTree(firstUserMessage.id, {
						summarize: false,
						label: profile.id === 'code-review' ? 'code-review' : 'test-analysis',
					});
					if (result.cancelled) {
						reviewOriginId = undefined;
						return false;
					}
				} catch (error) {
					reviewOriginId = undefined;
					ctx.ui.notify(
						`Failed to start review: ${error instanceof Error ? error.message : String(error)}`,
						'error',
					);
					return false;
				}
				ctx.ui.setEditorText('');
			}

			reviewOriginId = lockedOriginId;
			setReviewWidget(ctx, true, profile);
			pi.appendEntry(REVIEW_STATE_TYPE, {
				active: true,
				originId: lockedOriginId,
				profileId: profile.id,
			});
		} else {
			reviewOriginId = undefined;
			activeProfileId = undefined;
		}

		const prompt = await buildReviewPrompt(pi, profile, target, {
			includeLocalChanges: options?.includeLocalChanges === true,
		});
		const hint = getUserFacingHint(profile, target);
		const projectGuidelines = await loadProjectReviewGuidelines(
			ctx.cwd,
			profile.guidelinesFile,
		);

		let fullPrompt = `${profile.prompts.get('rubric')}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

		const settings = getProfileSettings(profile.id);
		if (settings.customInstructions) {
			fullPrompt += `\n\nShared custom review instructions (applies to all reviews):\n\n${settings.customInstructions}`;
		}

		if (options?.extraInstruction?.trim()) {
			fullPrompt += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`;
		}

		if (projectGuidelines) {
			fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
		}

		const modeHint = useFreshSession ? ' (fresh session)' : '';
		ctx.ui.notify(`开始${profile.verb}：${hint}${modeHint}`, 'info');
		log.info(
			'Review prompt sent: profile=%s, hint=%s, prompt_len=%d, guidelines=%s',
			profile.id,
			hint,
			fullPrompt.length,
			projectGuidelines ? 'yes' : 'no',
		);

		pi.sendUserMessage(fullPrompt);
		return true;
	}

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
		if (current.length > 0) tokens.push(current);
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
				if (!next) return { target: null, error: 'Missing value for --extra' };
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

		if (parts.length === 0) return { target: null, extraInstruction };

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

	async function handlePrCheckout(
		ctx: ExtensionContext,
		ref: string,
	): Promise<ReviewTarget | null> {
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify('无法检出 PR：你有未提交的变更，请先提交或暂存', 'error');
			return null;
		}
		const prNumber = parsePrReference(ref);
		if (!prNumber) {
			ctx.ui.notify('无效的 PR 引用，请输入编号或 GitHub PR URL', 'error');
			return null;
		}
		ctx.ui.notify(`正在获取 PR #${prNumber} 信息...`, 'info');
		const prInfo = await getPrInfo(pi, prNumber);
		if (!prInfo) {
			ctx.ui.notify(`未找到 PR #${prNumber}，请确认 gh 已认证且 PR 存在`, 'error');
			return null;
		}
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
		return target.type !== 'commit';
	}

	async function runLoopFixingReview(
		ctx: ExtensionCommandContext,
		profile: ReviewProfile,
		target: ReviewTarget,
		extraInstruction?: string,
	): Promise<void> {
		if (reviewLoopInProgress) {
			log.warn('runLoopFixingReview blocked: already running');
			ctx.ui.notify('循环修复正在进行中', 'warning');
			return;
		}

		log.info(
			'Starting loop-fixing review: profile=%s, target=%s, max_iterations=%d',
			profile.id,
			target.type,
			REVIEW_LOOP_MAX_ITERATIONS,
		);
		if (extraInstruction) log.debug('Extra instruction: %s', extraInstruction);

		reviewLoopInProgress = true;
		setReviewWidget(ctx, Boolean(reviewOriginId), profile);
		try {
			ctx.ui.notify(
				`循环${profile.verb}已启用：使用新分支模式循环${profile.verb}，直至无阻塞发现项。`,
				'info',
			);

			for (let pass = 1; pass <= REVIEW_LOOP_MAX_ITERATIONS; pass++) {
				const reviewBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
				const started = await executeReview(ctx, profile, target, true, {
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

				if (!hasBlockingFindings(reviewSnapshot.text, profile)) {
					const finalized = await executeEndReviewAction(ctx, 'returnAndSummarize', {
						showSummaryLoader: true,
						notifySuccess: false,
					});
					if (finalized !== 'ok') return;

					log.info(
						'Loop fixing complete: no blocking findings remain after %d passes',
						pass,
					);
					ctx.ui.notify('循环修复完成：无阻塞问题。', 'info');
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
				if (sentFixPrompt !== 'ok') return;

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
			log.info('Loop fixing review ended: profile=%s, target=%s', profile.id, target.type);
			reviewLoopInProgress = false;
			setReviewWidget(ctx, Boolean(reviewOriginId), profile);
		}
	}

	type EndReviewAction = 'returnOnly' | 'returnAndFix' | 'returnAndSummarize';
	type EndReviewActionResult = 'ok' | 'cancelled' | 'error';
	type EndReviewActionOptions = {
		showSummaryLoader?: boolean;
		notifySuccess?: boolean;
	};

	function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
		if (reviewOriginId) return reviewOriginId;

		const state = getReviewState(ctx);
		if (state?.active && state.originId) {
			reviewOriginId = state.originId;
			if (state.profileId) activeProfileId = state.profileId;
			return reviewOriginId;
		}

		if (state?.active) {
			setReviewWidget(ctx, false, DEFAULT_PROFILE);
			pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
			ctx.ui.notify(
				'Review state was missing origin info; cleared review status.',
				'warning',
			);
		}

		return undefined;
	}

	function clearReviewState(ctx: ExtensionContext) {
		setReviewWidget(ctx, false, DEFAULT_PROFILE);
		reviewOriginId = undefined;
		activeProfileId = undefined;
		pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
	}

	function currentProfile(): ReviewProfile {
		return getProfile(activeProfileId ?? lastProfileId);
	}

	async function navigateWithSummary(
		ctx: ExtensionCommandContext,
		profile: ReviewProfile,
		originId: string,
		showLoader: boolean,
	): Promise<{ cancelled: boolean; error?: string } | null> {
		if (showLoader && ctx.hasUI) {
			return ctx.ui.custom<{ cancelled: boolean; error?: string } | null>(
				(tui, theme, _kb, done) => {
					const loader = new BorderedLoader(
						tui,
						theme,
						`Returning and summarizing ${profile.label} branch...`,
					);
					loader.onAbort = () => done(null);

					ctx.navigateTree(originId, {
						summarize: true,
						customInstructions: profile.prompts.get('summary')!,
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
				customInstructions: profile.prompts.get('summary')!,
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

		const profile = currentProfile();
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
				ctx.ui.notify(`${profile.verb}完成！已返回原位置。`, 'info');
			}
			return 'ok';
		}

		const summaryResult = await navigateWithSummary(
			ctx,
			profile,
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
				ctx.ui.setEditorText(`根据${profile.verb}发现项执行修复`);
			}
			if (notifySuccess) {
				ctx.ui.notify(`${profile.verb}完成！已返回并总结。`, 'info');
			}
			return 'ok';
		}

		pi.sendUserMessage(profile.prompts.get('fix')!, { deliverAs: 'followUp' });
		if (notifySuccess) {
			ctx.ui.notify(`${profile.verb}完成！已返回并安排了后续修复任务。`, 'info');
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
		if (!getActiveReviewOrigin(ctx)) {
			ctx.ui.notify('当前没有活跃的审查会话，无需执行 /end-review', 'info');
			return;
		}

		endReviewInProgress = true;
		try {
			const choice = await selectPanel(ctx, 'Finish Review:', [
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

	// Register /review
	pi.registerCommand('review', {
		description: '审查代码变更 / 分析测试覆盖（PR、未提交、分支、提交或文件夹）',
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify('审查需要交互模式', 'error');
				return;
			}
			if (reviewLoopInProgress) {
				ctx.ui.notify('循环修复正在进行中', 'warning');
				return;
			}
			if (reviewOriginId) {
				ctx.ui.notify('已在审查中，请先使用 /end-review 结束', 'warning');
				return;
			}

			const { code } = await pi.exec('git', ['rev-parse', '--git-dir']);
			if (code !== 0) {
				ctx.ui.notify('不是 git 仓库', 'error');
				return;
			}

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
					target = await handlePrCheckout(ctx, parsed.target.ref);
					if (!target) ctx.ui.notify('PR 审查失败，返回审查菜单', 'warning');
				} else {
					target = parsed.target;
				}
			}

			if (!target) fromSelector = true;

			// 确定方案：直接带 target 用最近一次；无 target 先选方案
			let profile: ReviewProfile = getProfile(lastProfileId);
			if (fromSelector) {
				const chosen = await showProfileSelector(ctx);
				if (!chosen) {
					ctx.ui.notify('已取消审查', 'info');
					return;
				}
				profile = chosen;
			}
			lastProfileId = profile.id;
			persistReviewSettings(pi);

			while (true) {
				if (!target && fromSelector) {
					target = await showTargetSelector(pi, ctx, profile);
				}

				if (!target) {
					ctx.ui.notify(`已取消${profile.verb}`, 'info');
					return;
				}

				const settings = getProfileSettings(profile.id);
				if (settings.loopFixingEnabled && !isLoopCompatibleTarget(target)) {
					ctx.ui.notify('循环模式不适用于提交审查', 'error');
					if (fromSelector) {
						target = null;
						continue;
					}
					return;
				}

				if (settings.loopFixingEnabled) {
					await runLoopFixingReview(ctx, profile, target, extraInstruction);
					return;
				}

				const entries = ctx.sessionManager.getEntries();
				const messageCount = entries.filter((e) => e.type === 'message').length;

				let useFreshSession = messageCount === 0;
				if (messageCount > 0) {
					const choice = await selectPanel(ctx, 'Review Mode:', ['新分支', '当前会话']);
					if (choice === undefined) {
						if (fromSelector) {
							target = null;
							continue;
						}
						ctx.ui.notify(`已取消${profile.verb}`, 'info');
						return;
					}
					useFreshSession = choice === '新分支';
				}

				await executeReview(ctx, profile, target, useFreshSession, { extraInstruction });
				return;
			}
		},
	});

	// Register /end-review
	pi.registerCommand('end-review', {
		description: '完成审查并返回原位置',
		handler: async (_args, ctx) => {
			await runEndReview(ctx);
		},
	});
}
