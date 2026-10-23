/**
 * plannotator-tui / git — 「候选集」的唯一数据来源。
 *
 * 四种入口（全部文件 / 文件夹 / 未提交变更 / 某次提交）最终都收敛成同一个
 * `FileCandidate[]`，选择器只认这一种形状，这样「变更」就只是候选集的一层过滤，
 * 而不是另一种打开方式。
 *
 * 有意**不复用** `extensions/tui/files/` 的 git 层：本插件要保持可独立安装，
 * 不把别的插件的内部实现变成自己的公共 API（见 ADR-0064）。解析函数保持纯函数，
 * 便于单测覆盖 `-z` 输出的边界（带空格路径、重命名、已删除）。
 */

import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface FileCandidate {
	/** 绝对路径，原样交给 `plannotator-tui herdr open` */
	path: string;
	/** 相对仓库根的显示路径；目录以 `/` 结尾 */
	display: string;
	isDirectory: boolean;
	/** git status 徽标（M / A / R …），只有变更候选集带 */
	status?: string;
}

export interface CommitEntry {
	sha: string;
	title: string;
}

/** `git status --porcelain=1 -z` 的一行。重命名的第二个 NUL 段是旧路径，调用方需跳过。 */
export interface PorcelainEntry {
	status: string;
	path: string;
	/** 重命名/复制的旧路径；没有则为 undefined */
	from?: string;
}

/**
 * 解析 `git status --porcelain=1 -z`。条目形如 `XY <path>`，重命名时**紧随其后**
 * 是旧路径（`-z` 下顺序为 `to\0from\0`）。
 */
export function parsePorcelain(stdout: string): PorcelainEntry[] {
	const parts = stdout.split('\0');
	const entries: PorcelainEntry[] = [];
	for (let i = 0; i < parts.length; i += 1) {
		const raw = parts[i];
		if (!raw || raw.length < 4) continue;
		const code = raw.slice(0, 2);
		const status = code.replace(/\s/g, '') || code.trim();
		const filePath = raw.slice(3);
		if (!filePath) continue;
		const renamed = code.startsWith('R') || code.startsWith('C');
		const from = renamed ? parts[i + 1] : undefined;
		if (renamed && from !== undefined) i += 1;
		entries.push({ status, path: filePath, from: from || undefined });
	}
	return entries;
}

/** 解析 `git show --name-only --format= -z` / `git ls-files -z`（NUL 分隔的路径清单）。 */
export function parsePathList(stdout: string): string[] {
	return stdout.split('\0').filter((item) => item.length > 0);
}

/** 解析 `git log --format=%H%x09%s`，一行一条提交。 */
export function parseCommitLog(stdout: string): CommitEntry[] {
	return stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const tab = line.indexOf('\t');
			if (tab < 0) return { sha: line, title: '' };
			return { sha: line.slice(0, tab), title: line.slice(tab + 1) };
		});
}

/** 一行的短 sha（7 位），对齐 /review 的提交列表显示。 */
export function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

const normalize = (value: string): string => value.split(path.sep).join('/');

/** 把仓库内的相对路径变成一个文件候选。 */
function toCandidate(root: string, relativePath: string, status?: string): FileCandidate {
	const normalized = normalize(relativePath);
	return {
		path: path.resolve(root, relativePath),
		display: normalized,
		isDirectory: false,
		...(status ? { status } : {}),
	};
}

/**
 * 从文件清单推导目录候选（去重、不含仓库根本身、按字典序）。
 * 目录是打开 plannotator-tui 文件夹模式（原生多文件评审）的入口。
 */
export function collectDirectories(root: string, files: FileCandidate[]): FileCandidate[] {
	const seen = new Set<string>();
	for (const file of files) {
		const segments = file.display.split('/');
		segments.pop();
		while (segments.length > 0) {
			seen.add(`${segments.join('/')}/`);
			segments.pop();
		}
	}
	return [...seen]
		.sort((a, b) => a.localeCompare(b))
		.map((display) => ({
			path: path.resolve(root, display),
			display,
			isDirectory: true,
		}));
}
export interface RepoRoot {
	root: string;
	/** 是否真的在 git 仓库里；false 时 root 退回会话 cwd，调用方据此给提示 */
	isRepo: boolean;
}

/** 仓库根；不在 git 仓库里时退回会话 cwd 并标记 `isRepo: false`。 */
export async function repoRoot(pi: ExtensionAPI, cwd: string): Promise<RepoRoot> {
	const result = await pi.exec('git', ['rev-parse', '--show-toplevel'], { cwd });
	const top = result.code === 0 ? result.stdout.trim() : '';
	return top ? { root: top, isRepo: true } : { root: cwd, isRepo: false };
}

/** 一次候选集查询的结果：失败与「查询成功但为空」必须可区分——两者的提示完全不同。 */
export interface CandidateSet {
	items: FileCandidate[];
	/** git 查询失败时的可读原因；成功但结果为空时为 undefined */
	error?: string;
}

/** 提交清单查询结果，语义同 {@link CandidateSet}。 */
export interface CommitSet {
	items: CommitEntry[];
	error?: string;
}

/** 把 git 的失败收敛成一行可读原因（只取 stderr 首行，避免把整屏报错塞进通知）。 */
function failureOf(result: { stderr: string }, command: string): string {
	const detail = result.stderr.trim().split('\n')[0] ?? '';
	return detail ? `${command} 失败：${detail}` : `${command} 失败`;
}

/** 仓库内全部已跟踪 + 未忽略的未跟踪文件。 */
export async function listRepositoryFiles(pi: ExtensionAPI, root: string): Promise<CandidateSet> {
	const tracked = await pi.exec('git', ['ls-files', '-z'], { cwd: root });
	const untracked = await pi.exec('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
		cwd: root,
	});
	const paths = new Set<string>();
	for (const item of parsePathList(tracked.stdout)) paths.add(item);
	for (const item of parsePathList(untracked.stdout)) paths.add(item);
	const items = [...paths]
		.sort((a, b) => a.localeCompare(b))
		.map((item) => toCandidate(root, item));
	const failed = [tracked, untracked].find((result) => result.code !== 0);
	return failed ? { items, error: failureOf(failed, 'git ls-files') } : { items };
}

/** 未提交的变更（含暂存）。已删除的文件打不开，直接剔除。 */
export async function listChangedFiles(pi: ExtensionAPI, root: string): Promise<CandidateSet> {
	const result = await pi.exec('git', ['status', '--porcelain=1', '-z'], { cwd: root });
	if (result.code !== 0) return { items: [], error: failureOf(result, 'git status') };
	const items = parsePorcelain(result.stdout)
		.filter((entry) => !entry.status.includes('D'))
		.map((entry) => toCandidate(root, entry.path, entry.status));
	return { items };
}

/** 最近 N 条提交（新→旧）。 */
export async function listRecentCommits(
	pi: ExtensionAPI,
	root: string,
	limit = 20,
): Promise<CommitSet> {
	const result = await pi.exec('git', ['log', `-n${limit}`, '--format=%H%x09%s'], { cwd: root });
	if (result.code !== 0) return { items: [], error: failureOf(result, 'git log') };
	return { items: parseCommitLog(result.stdout) };
}

/** 某个提交触碰的文件（新增/修改/重命名都算，已删除的剔除——与 `listChangedFiles` 一致）。 */
export async function listCommitFiles(
	pi: ExtensionAPI,
	root: string,
	sha: string,
): Promise<CandidateSet> {
	const result = await pi.exec(
		'git',
		['show', '--name-only', '--format=', '-z', '--diff-filter=d', sha],
		{
			cwd: root,
		},
	);
	if (result.code !== 0) return { items: [], error: failureOf(result, 'git show') };
	const items = [...new Set(parsePathList(result.stdout))]
		.sort((a, b) => a.localeCompare(b))
		.map((item) => toCandidate(root, item));
	return { items };
}
