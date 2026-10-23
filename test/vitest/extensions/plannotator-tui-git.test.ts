/**
 * plannotator-tui 的候选集解析 — 纯函数单测。
 *
 * 覆盖 `-z` 输出的边界：带空格路径、重命名（`R` 时第二个 NUL 段是旧路径）、
 * 已删除（候选集里要剔除）、提交日志的标题含制表符。
 */
import { describe, expect, it } from 'vitest';
import {
	collectDirectories,
	listChangedFiles,
	listCommitFiles,
	listRecentCommits,
	listRepositoryFiles,
	parseCommitLog,
	parsePathList,
	parsePorcelain,
	shortSha,
	type FileCandidate,
} from '../../../extensions/tui/plannotator-tui/git.js';

/** 假 pi：按 `git <args...>` 回放预置输出，驱动候选集函数而不真的跑 git。 */
function fakePi(replies: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
	const calls: string[] = [];
	const pi = {
		exec: async (command: string, args: string[]) => {
			const key = [command, ...args].join(' ');
			calls.push(key);
			const reply = replies[key];
			if (!reply) {
				return { code: 1, stdout: '', stderr: `unexpected: ${key}`, killed: false };
			}
			return {
				code: reply.code ?? 0,
				stdout: reply.stdout ?? '',
				stderr: reply.stderr ?? '',
				killed: false,
			};
		},
	};
	return { pi: pi as never, calls };
}
const NUL = '\0';

describe('parsePorcelain', () => {
	it('解析普通状态并归一化徽标', () => {
		const entries = parsePorcelain(` M keep.txt${NUL}?? new file.txt${NUL}`);
		expect(entries).toEqual([
			{ status: 'M', path: 'keep.txt', from: undefined },
			{ status: '??', path: 'new file.txt', from: undefined },
		]);
	});

	it('重命名保留新路径，旧路径单独给出', () => {
		const entries = parsePorcelain(`R  new name.txt${NUL}old name.txt${NUL}`);
		expect(entries).toEqual([{ status: 'R', path: 'new name.txt', from: 'old name.txt' }]);
	});

	it('空输出返回空数组', () => {
		expect(parsePorcelain('')).toEqual([]);
	});
});

describe('parsePathList', () => {
	it('NUL 分隔、忽略空段', () => {
		expect(parsePathList(`a.md${NUL}dir/b.ts${NUL}`)).toEqual(['a.md', 'dir/b.ts']);
	});
});

describe('parseCommitLog', () => {
	it('拆出 sha 与标题，标题里的制表符之前的都算 sha', () => {
		expect(parseCommitLog('abc123\tfix: 甲\n	def456\tfeat: 乙\n')).toEqual([
			{ sha: 'abc123', title: 'fix: 甲' },
			{ sha: 'def456', title: 'feat: 乙' },
		]);
	});

	it('没有制表符时标题留空', () => {
		expect(parseCommitLog('abc123')).toEqual([{ sha: 'abc123', title: '' }]);
	});
});

describe('shortSha', () => {
	it('取前 7 位', () => {
		expect(shortSha('0123456789abcdef')).toBe('0123456');
	});
});

describe('collectDirectories', () => {
	const candidate = (display: string): FileCandidate => ({
		path: `/repo/${display}`,
		display,
		isDirectory: false,
	});

	it('去重所有父目录，以 / 结尾并排序，不含仓库根', () => {
		const result = collectDirectories('/repo', [
			candidate('extensions/tui/files/types.ts'),
			candidate('extensions/tui/files/ui.ts'),
			candidate('AGENTS.md'),
		]);
		expect(result.map((item) => item.display)).toEqual([
			'extensions/',
			'extensions/tui/',
			'extensions/tui/files/',
		]);
	});

	it('目录候选是绝对路径且标记为目录', () => {
		const [first] = collectDirectories('/repo', [candidate('docs/adr/0001-x.md')]);
		expect(first).toEqual({
			path: '/repo/docs',
			display: 'docs/',
			isDirectory: true,
		});
	});

	it('顶层文件不产生目录候选', () => {
		expect(collectDirectories('/repo', [candidate('README.md')])).toEqual([]);
	});
});

describe('listChangedFiles', () => {
	it('剔除已删除（D）项，保留其余状态徽标', async () => {
		const { pi, calls } = fakePi({
			'git status --porcelain=1 -z': {
				stdout: ` M keep.txt${NUL} D gone.txt${NUL}R  new name.txt${NUL}old name.txt${NUL}`,
			},
		});

		const set = await listChangedFiles(pi, '/repo');

		expect(calls).toEqual(['git status --porcelain=1 -z']);
		expect(set.error).toBeUndefined();
		expect(set.items).toEqual([
			{ path: '/repo/keep.txt', display: 'keep.txt', isDirectory: false, status: 'M' },
			{
				path: '/repo/new name.txt',
				display: 'new name.txt',
				isDirectory: false,
				status: 'R',
			},
		]);
	});

	it('git 失败时报 error，而不是伪装成「没有变更」', async () => {
		const { pi } = fakePi({
			'git status --porcelain=1 -z': {
				code: 128,
				stderr: 'fatal: not a git repository (or any parent)\nmore lines',
			},
		});

		const set = await listChangedFiles(pi, '/repo');

		expect(set.items).toEqual([]);
		expect(set.error).toBe('git status 失败：fatal: not a git repository (or any parent)');
	});

	it('查询成功但真的没有变更时 error 为空', async () => {
		const { pi } = fakePi({ 'git status --porcelain=1 -z': { stdout: '' } });
		expect(await listChangedFiles(pi, '/repo')).toEqual({ items: [] });
	});
});

describe('listRepositoryFiles', () => {
	it('合并已跟踪与未跟踪并去重排序', async () => {
		const { pi } = fakePi({
			'git ls-files -z': { stdout: `b.ts${NUL}a.ts${NUL}` },
			'git ls-files -z --others --exclude-standard': { stdout: `a.ts${NUL}c.md${NUL}` },
		});

		const set = await listRepositoryFiles(pi, '/repo');

		expect(set.error).toBeUndefined();
		expect(set.items.map((item) => item.display)).toEqual(['a.ts', 'b.ts', 'c.md']);
		expect(set.items[0]).toEqual({
			path: '/repo/a.ts',
			display: 'a.ts',
			isDirectory: false,
		});
	});

	it('任一命令失败时报 error，但仍保留已取到的条目', async () => {
		const { pi } = fakePi({
			'git ls-files -z': { stdout: `a.ts${NUL}` },
			'git ls-files -z --others --exclude-standard': { code: 1, stderr: 'boom' },
		});

		const set = await listRepositoryFiles(pi, '/repo');

		expect(set.items.map((item) => item.display)).toEqual(['a.ts']);
		expect(set.error).toBe('git ls-files 失败：boom');
	});
});

describe('listRecentCommits / listCommitFiles', () => {
	it('提交清单解析为 sha + 标题', async () => {
		const { pi } = fakePi({
			'git log -n20 --format=%H%x09%s': { stdout: 'abc123\tfix: 甲\ndef456\tfeat: 乙\n' },
		});

		const set = await listRecentCommits(pi, '/repo', 20);

		expect(set.error).toBeUndefined();
		expect(set.items).toEqual([
			{ sha: 'abc123', title: 'fix: 甲' },
			{ sha: 'def456', title: 'feat: 乙' },
		]);
	});

	it('git log 失败时报 error', async () => {
		const { pi } = fakePi({
			'git log -n20 --format=%H%x09%s': { code: 128, stderr: 'no commits' },
		});
		expect(await listRecentCommits(pi, '/repo', 20)).toEqual({
			items: [],
			error: 'git log 失败：no commits',
		});
	});

	it('提交文件清单去重排序，并剔除已删除的文件', async () => {
		const { pi, calls } = fakePi({
			'git show --name-only --format= -z --diff-filter=d abc123': {
				stdout: `b.ts${NUL}a.ts${NUL}b.ts${NUL}`,
			},
		});

		const set = await listCommitFiles(pi, '/repo', 'abc123');

		// 删除的文件打不开（选中只会得到「找不到路径」），由 git 侧 --diff-filter=d 剔除
		expect(calls).toEqual(['git show --name-only --format= -z --diff-filter=d abc123']);
		expect(set.items.map((item) => item.display)).toEqual(['a.ts', 'b.ts']);
	});

	it('git show 失败时报 error', async () => {
		const { pi } = fakePi({
			'git show --name-only --format= -z --diff-filter=d bad': {
				code: 128,
				stderr: 'unknown revision',
			},
		});
		expect(await listCommitFiles(pi, '/repo', 'bad')).toEqual({
			items: [],
			error: 'git show 失败：unknown revision',
		});
	});
});
