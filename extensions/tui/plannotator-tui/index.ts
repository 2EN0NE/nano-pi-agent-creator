/**
 * plannotator-tui: 在 Herdr 面板里评审文档 / 文件夹 / 变更文件 / agent 回复 / 终端输出。
 *
 * 与 @plannotator/pi-extension 注册的 /plannotator-* 命令互不影响：那些固定走浏览器
 * （网页侧有 diff / PR / 代码评审），tui 用不了那些形态。
 *
 * 一屏目标选择（对齐 /review 的交互）：
 *   变更类（未提交 / 某次提交）只是**候选集的一层过滤**，选中后打开源文件本身；
 *   全部文件 / 文件夹走同一台可搜索选择器，差别只在候选集；
 *   agent 回复 / 终端输出直接转交 plannotator-tui 自己的 picker。
 *
 * 不经过模型。终端批注（send / paste）已移除——herdr 自带键位覆盖同一场景，
 * 本插件只负责「打开评审面板」。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { selectPanel } from '../../../src/tui/select-panel.js';
import {
	collectDirectories,
	listChangedFiles,
	listCommitFiles,
	listRecentCommits,
	listRepositoryFiles,
	repoRoot,
	shortSha,
	type CandidateSet,
} from './git.js';
import { herdrSession, openReview, type HerdrSession, type ReviewKind } from './herdr.js';
import { pickCandidate } from './picker.js';

const log = createLogger('plannotator-tui');

type MenuValue = 'changed' | 'commit' | 'files' | 'folders' | 'last' | 'newest' | 'terminal';

const MENU: { label: string; value: MenuValue }[] = [
	{ label: '未提交的变更…', value: 'changed' },
	{ label: '某个提交的变更…', value: 'commit' },
	{ label: '全部文件…', value: 'files' },
	{ label: '文件夹…', value: 'folders' },
	{ label: 'agent 最近回复（可挑选）', value: 'last' },
	{ label: 'agent 最新回复', value: 'newest' },
	{ label: '本 pane 最近终端输出', value: 'terminal' },
];

const MENU_TITLE = 'Plannotator';
const COMMIT_LIMIT = 20;

/** 已移除能力的历史参数名；保留识别只为给出可读提示，不再有任何行为。 */
const REMOVED_ARGUMENTS = new Set(['send', 'send-archive', 'paste', 'paste-archive']);
const REVIEW_ALIASES = new Set<ReviewKind>(['last', 'newest', 'terminal']);

export type Invocation =
	| { kind: 'review'; reviewKind: ReviewKind; target: string }
	| { kind: 'removed'; argument: string }
	| { kind: 'unknown'; argument: string };

/**
 * 解析命令参数。纯函数（`exists` 注入）以便单测覆盖各分支。
 * 行为对齐改造前：别名优先，其次把参数当路径，路径不存在则报未知。
 */
export function resolveArgument(
	argument: string,
	cwd: string,
	exists: (path: string) => boolean,
): Invocation {
	if (REMOVED_ARGUMENTS.has(argument)) return { kind: 'removed', argument };
	if (REVIEW_ALIASES.has(argument as ReviewKind)) {
		return { kind: 'review', reviewKind: argument as ReviewKind, target: '' };
	}
	if (argument === 'open') return { kind: 'review', reviewKind: 'file', target: cwd };

	const target = resolve(cwd, argument);
	if (!exists(target)) return { kind: 'unknown', argument };
	return { kind: 'review', reviewKind: 'file', target };
}

/** 候选集查询的失败与「查询成功但为空」是两件事，提示必须分开。 */
function reportCandidates(
	ctx: ExtensionCommandContext,
	title: string,
	set: CandidateSet,
	emptyHint: string,
): set is CandidateSet & { items: never } {
	if (set.error) {
		log.warn(`${title}：${set.error}`);
		ctx.ui.notify(`无法读取${title}：${set.error}`, 'error');
		return true;
	}
	if (set.items.length === 0) {
		log.warn(`${title}：候选集为空`);
		ctx.ui.notify(emptyHint, 'warning');
		return true;
	}
	return false;
}

/** 打开候选集里选中的那一项。 */
async function pickAndOpen(
	ctx: ExtensionCommandContext,
	session: HerdrSession,
	title: string,
	set: CandidateSet,
	emptyHint: string,
): Promise<void> {
	if (reportCandidates(ctx, title, set, emptyHint)) return;
	const picked = await pickCandidate(ctx, title, set.items);
	if (!picked) return;
	await openReview(ctx, session, 'file', picked.path);
}

/** 仓库根；不在 git 仓库里时给一条可读提示并返回 null。 */
async function requireRepo(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: HerdrSession,
	action: string,
): Promise<string | null> {
	const { root, isRepo } = await repoRoot(pi, session.cwd);
	if (isRepo) return root;
	log.warn(`不在 git 仓库里，无法${action}：${session.cwd}`);
	ctx.ui.notify(`当前目录不在 git 仓库里，无法${action}`, 'warning');
	return null;
}

async function chooseCommit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: HerdrSession,
): Promise<void> {
	const root = await requireRepo(pi, ctx, session, '读取提交记录');
	if (!root) return;

	const commits = await listRecentCommits(pi, root, COMMIT_LIMIT);
	if (commits.error) {
		log.warn(`读取提交记录：${commits.error}`);
		ctx.ui.notify(`无法读取提交记录：${commits.error}`, 'error');
		return;
	}
	if (commits.items.length === 0) {
		log.warn('读取提交记录：没有可用的提交');
		ctx.ui.notify('没有可用的提交记录', 'warning');
		return;
	}

	const labels = commits.items.map((commit) => `${shortSha(commit.sha)} ${commit.title}`);
	const choice = await selectPanel(ctx, '提交', labels);
	if (!choice) return;
	const commit = commits.items.find(
		(entry) => `${shortSha(entry.sha)} ${entry.title}` === choice,
	);
	if (!commit) return;

	const files = await listCommitFiles(pi, root, commit.sha);
	await pickAndOpen(
		ctx,
		session,
		'提交的文件',
		files,
		`提交 ${shortSha(commit.sha)} 没有可打开的文件`,
	);
}

async function chooseRepositoryFiles(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: HerdrSession,
	directoriesOnly: boolean,
): Promise<void> {
	const root = await requireRepo(pi, ctx, session, '列出仓库文件');
	if (!root) return;

	const files = await listRepositoryFiles(pi, root);
	if (files.error) {
		log.warn(`列出仓库文件：${files.error}`);
		ctx.ui.notify(`无法列出仓库文件：${files.error}`, 'error');
		return;
	}
	const candidates: CandidateSet = directoriesOnly
		? { items: collectDirectories(root, files.items) }
		: files;
	await pickAndOpen(
		ctx,
		session,
		directoriesOnly ? '文件夹' : '全部文件',
		candidates,
		directoriesOnly ? '仓库里没有可打开的文件夹' : '仓库里没有可打开的文件',
	);
}

async function chooseChanged(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	session: HerdrSession,
): Promise<void> {
	const root = await requireRepo(pi, ctx, session, '列出变更');
	if (!root) return;

	const changed = await listChangedFiles(pi, root);
	await pickAndOpen(ctx, session, '未提交的变更', changed, '没有未提交的变更');
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand('plannotator-tui', {
		description:
			'在 Herdr 面板里评审文档 / 文件夹 / 变更文件 / agent 回复 / 终端输出（不会走网页）',
		handler: async (args, ctx) => {
			const session = herdrSession(ctx.cwd);
			if (!session) {
				log.warn('当前不在 Herdr 会话里（HERDR_ENV != 1），无法打开面板');
				ctx.ui.notify('当前不在 Herdr 会话里（HERDR_ENV != 1），无法打开面板', 'warning');
				return;
			}

			const argument = args.trim();
			if (argument) {
				const invocation = resolveArgument(argument, session.cwd, existsSync);
				switch (invocation.kind) {
					case 'review':
						await openReview(ctx, session, invocation.reviewKind, invocation.target);
						return;
					case 'removed':
						log.warn(`终端批注能力已移除，忽略参数：${invocation.argument}`);
						ctx.ui.notify(
							`终端批注能力已移除：${invocation.argument}\n可用：open | last | newest | terminal，或文件/文件夹路径`,
							'warning',
						);
						return;
					case 'unknown':
						log.warn(`无法识别的参数：${invocation.argument}`);
						ctx.ui.notify(
							`无法识别的参数：${invocation.argument}\n可用：open | last | newest | terminal，或文件/文件夹路径`,
							'warning',
						);
						return;
				}
			}

			const choice = await selectPanel(
				ctx,
				MENU_TITLE,
				MENU.map((item) => item.label),
			);
			if (!choice) return;
			const target = MENU.find((item) => item.label === choice);
			if (!target) return;

			switch (target.value) {
				case 'changed':
					await chooseChanged(pi, ctx, session);
					return;
				case 'commit':
					await chooseCommit(pi, ctx, session);
					return;
				case 'files':
					await chooseRepositoryFiles(pi, ctx, session, false);
					return;
				case 'folders':
					await chooseRepositoryFiles(pi, ctx, session, true);
					return;
				default:
					await openReview(ctx, session, target.value, '');
			}
		},
	});
}
