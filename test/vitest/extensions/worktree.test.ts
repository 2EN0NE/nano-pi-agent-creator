/**
 * pi-worktree — paths.ts 单元测试
 *
 * 测试纯函数路径推导逻辑，mock child_process.execSync 模拟 git 输出。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';

// 在 import 前 mock execSync
vi.mock('node:child_process', () => {
	const actual = vi.importActual('node:child_process');
	return {
		...actual,
		execSync: vi.fn(),
	};
});

// 现在 import 被测试模块（执行时 execSync 已被 mock）
import {
	getRepoRoot,
	getWorktreesDir,
	getWorktreePath,
	isWorktreeCwd,
	getNameFromCwd,
	isMainCwd,
	getManagedWorktrees,
	parseWorktreeList,
	assertPathInWorktrees,
} from '../../../extensions/meta/worktree/lib/paths';

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
	vi.clearAllMocks();
});

// ── 路径常量 ──

const MAIN_REPO = '/home/user/projects/my-app';
const WORKTREES_DIR = '/home/user/projects/my-app-worktrees';

// ── getRepoRoot ──

describe('getRepoRoot', () => {
	it('returns repo root when git common dir is resolved', () => {
		// git rev-parse --path-format=absolute --git-common-dir returns .git parent path
		mockExecSync.mockReturnValueOnce(`${MAIN_REPO}/.git\n`);
		const result = getRepoRoot(MAIN_REPO);
		expect(result).toBe(MAIN_REPO);
		expect(mockExecSync).toHaveBeenCalledWith(
			expect.stringContaining('git rev-parse'),
			expect.objectContaining({ cwd: MAIN_REPO }),
		);
	});

	it('returns null when execSync throws', () => {
		mockExecSync.mockImplementationOnce(() => {
			throw new Error('not a git repo');
		});
		const result = getRepoRoot('/tmp/non-repo');
		expect(result).toBeNull();
	});

	it('returns null when --git-common-dir returns empty', () => {
		mockExecSync.mockReturnValueOnce('\n');
		const result = getRepoRoot(MAIN_REPO);
		expect(result).toBeNull();
	});
});

// ── getWorktreesDir ──

describe('getWorktreesDir', () => {
	it('appends -worktrees suffix', () => {
		expect(getWorktreesDir(MAIN_REPO)).toBe(WORKTREES_DIR);
	});

	it('works for paths with trailing slash', () => {
		expect(getWorktreesDir('/app/')).toBe('/app-worktrees');
	});
});

// ── getWorktreePath ──

describe('getWorktreePath', () => {
	it('joins worktrees dir with name', () => {
		expect(getWorktreePath(MAIN_REPO, 'Aries-Hamal')).toBe(`${WORKTREES_DIR}/Aries-Hamal`);
	});
});

// ── isWorktreeCwd ──

describe('isWorktreeCwd', () => {
	it('returns true when cwd is inside a worktree', () => {
		expect(isWorktreeCwd(`${WORKTREES_DIR}/Aries-Hamal`, MAIN_REPO)).toBe(true);
	});

	it('returns true when cwd is deep inside a worktree', () => {
		expect(isWorktreeCwd(`${WORKTREES_DIR}/Aries-Hamal/src/app.ts`, MAIN_REPO)).toBe(true);
	});

	it('returns false when cwd is the main repo root', () => {
		expect(isWorktreeCwd(MAIN_REPO, MAIN_REPO)).toBe(false);
	});

	it('returns false when cwd is a subdir of main repo', () => {
		expect(isWorktreeCwd(`${MAIN_REPO}/src`, MAIN_REPO)).toBe(false);
	});

	it('returns false when cwd is unrelated path', () => {
		expect(isWorktreeCwd('/tmp', MAIN_REPO)).toBe(false);
	});
});

// ── getNameFromCwd ──

describe('getNameFromCwd', () => {
	it('extracts name from worktree root', () => {
		expect(getNameFromCwd(`${WORKTREES_DIR}/Aries-Hamal`, MAIN_REPO)).toBe('Aries-Hamal');
	});

	it('extracts name from deep path inside worktree', () => {
		expect(getNameFromCwd(`${WORKTREES_DIR}/Aries-Hamal/lib/utils.ts`, MAIN_REPO)).toBe(
			'Aries-Hamal',
		);
	});

	it('returns null for main repo', () => {
		expect(getNameFromCwd(MAIN_REPO, MAIN_REPO)).toBeNull();
	});

	it('returns null for unrelated path', () => {
		expect(getNameFromCwd('/tmp', MAIN_REPO)).toBeNull();
	});
});

// ── isMainCwd ──

describe('isMainCwd', () => {
	it('returns true for exact repo root', () => {
		expect(isMainCwd(MAIN_REPO, MAIN_REPO)).toBe(true);
	});

	it('returns true for subdirectory of repo root', () => {
		expect(isMainCwd(`${MAIN_REPO}/src`, MAIN_REPO)).toBe(true);
	});

	it('returns false for worktree directory', () => {
		expect(isMainCwd(`${WORKTREES_DIR}/Aries-Hamal`, MAIN_REPO)).toBe(false);
	});
});

// ── parseWorktreeList ──

describe('parseWorktreeList', () => {
	const porcelain = [
		`worktree ${MAIN_REPO}`,
		'HEAD abc123...',
		'branch refs/heads/main',
		'',
		`worktree ${WORKTREES_DIR}/Aries-Hamal`,
		'HEAD def456...',
		'branch refs/heads/wt/Aries-Hamal',
		'',
		`worktree ${WORKTREES_DIR}/Leo-Denebola`,
		'HEAD ghi789...',
		'detached',
	].join('\n');

	it('parses worktrees and filters out main', () => {
		const result = parseWorktreeList(porcelain, WORKTREES_DIR);
		expect(result).toHaveLength(2);
		expect(result[0].name).toBe('Aries-Hamal');
		expect(result[0].branch).toBe('wt/Aries-Hamal');
		expect(result[0].path).toBe(`${WORKTREES_DIR}/Aries-Hamal`);
		expect(result[1].name).toBe('Leo-Denebola');
		expect(result[1].branch).toBe('detached');
	});

	it('returns empty for empty input', () => {
		expect(parseWorktreeList('', WORKTREES_DIR)).toEqual([]);
	});

	it('ignores worktrees outside managed dir', () => {
		const output = [
			`worktree ${MAIN_REPO}`,
			'HEAD abc...',
			'branch refs/heads/main',
			'',
			'worktree /some/other/path/Aries-Hamal',
			'HEAD def...',
			'branch refs/heads/wt/Aries-Hamal',
		].join('\n');
		const result = parseWorktreeList(output, WORKTREES_DIR);
		expect(result).toHaveLength(0);
	});
});

// ── getManagedWorktrees ──

describe('getManagedWorktrees', () => {
	it('reads git worktree list and returns managed ones', () => {
		const porcelain = [
			`worktree ${MAIN_REPO}`,
			'HEAD abc...',
			'branch refs/heads/main',
			'',
			`worktree ${WORKTREES_DIR}/Aries-Hamal`,
			'HEAD def...',
			'branch refs/heads/wt/Aries-Hamal',
		].join('\n');
		mockExecSync.mockReturnValueOnce(porcelain + '\n');
		const result = getManagedWorktrees(MAIN_REPO);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('Aries-Hamal');
	});

	it('returns empty on git error', () => {
		mockExecSync.mockImplementationOnce(() => {
			throw new Error('error');
		});
		expect(getManagedWorktrees(MAIN_REPO)).toEqual([]);
	});
});

// ── assertPathInWorktrees ──

describe('assertPathInWorktrees', () => {
	it('passes for path inside worktrees dir', () => {
		expect(() =>
			assertPathInWorktrees(WORKTREES_DIR, `${WORKTREES_DIR}/Aries-Hamal`),
		).not.toThrow();
	});

	it('passes for deep path inside worktree', () => {
		expect(() =>
			assertPathInWorktrees(WORKTREES_DIR, `${WORKTREES_DIR}/Aries-Hamal/src/app.ts`),
		).not.toThrow();
	});

	it('throws for worktree root itself', () => {
		expect(() => assertPathInWorktrees(WORKTREES_DIR, WORKTREES_DIR)).toThrow(
			/worktree 根目录本身/,
		);
	});

	it('throws for main repo root', () => {
		expect(() => assertPathInWorktrees(WORKTREES_DIR, MAIN_REPO)).toThrow(/不在 worktree 目录/);
	});
});
