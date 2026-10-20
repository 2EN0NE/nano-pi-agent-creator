/**
 * pi-worktree — Worktree 组声明（ADR-0062）
 *
 * 覆盖三条硬约束与候选集合计算：
 *   1. 用户级 groups → warn + 忽略（绝不静默生效）
 *   2. 分节读改写：写组不会把仓库级内容泄漏进用户级，也不会抹掉同文件的偏好节
 *   3. 候选 = 本次动作真正作用到的集合，不适用者保留为灰显上下文（不静默过滤）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_LIB = resolve(__dirname, '../../../extensions/meta/worktree/lib');

const ORIGINAL_HOME = process.env.HOME;

function createGitRepo(basedir: string, name: string): string {
	const repoDir = join(basedir, name);
	mkdirSync(repoDir, { recursive: true });
	execSync('git init --initial-branch main -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`);
	execSync('git add README.md && git commit -m init -q', { cwd: repoDir });
	return repoDir;
}

/** 在主仓库外（`<repo>-worktrees/<name>`）建一个受管 worktree，分支 wt/<name> */
function addManagedWorktree(repoRoot: string, name: string, base = 'main'): string {
	const wtDir = `${repoRoot}-worktrees/${name}`;
	mkdirSync(`${repoRoot}-worktrees`, { recursive: true });
	execSync(`git worktree add -b wt/${name} "${wtDir}" ${base} -q`, { cwd: repoRoot });
	return wtDir;
}

function readJson(path: string): any {
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}

describe('组声明：仓库级生效 + 用户级忽略 + 分节读写', () => {
	let baseDir: string;
	let repo: string;
	let homeDir: string;

	beforeEach(() => {
		baseDir = resolve(
			tmpdir(),
			'pi-wt-grp-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		repo = createGitRepo(baseDir, 'repo');
		homeDir = join(baseDir, 'home');
		mkdirSync(homeDir, { recursive: true });
		process.env.HOME = homeDir;
	});

	afterEach(() => {
		process.env.HOME = ORIGINAL_HOME;
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('仓库级声明可读到；缺字段按默认值解析（squash / copy）', async () => {
		mkdirSync(join(repo, '.pi/extensions-data/pi-worktree'), { recursive: true });
		writeFileSync(
			join(repo, '.pi/extensions-data/pi-worktree/config.json'),
			JSON.stringify({ groups: { fta: { baseRef: 'main', members: ['a', 'b'] } } }),
		);

		const { loadGroups, applyGroupDefaults } = await import(resolve(EXT_LIB, 'groups.ts'));
		const { groups, warnings } = loadGroups(repo);
		expect(Object.keys(groups)).toEqual(['fta']);
		expect(groups.fta.members).toEqual(['a', 'b']);
		expect(warnings).toEqual([]);

		const withDefaults = applyGroupDefaults(groups.fta);
		expect(withDefaults.mergeStrategy).toBe('squash');
		expect(withDefaults.env.nodeModules).toBe('copy');
	});

	it('用户级声明 groups → 忽略 + warn（绝不静默生效）', async () => {
		mkdirSync(join(homeDir, '.pi/agent/extensions-data/pi-worktree'), { recursive: true });
		writeFileSync(
			join(homeDir, '.pi/agent/extensions-data/pi-worktree/config.json'),
			JSON.stringify({ groups: { ghost: { members: ['x'] } } }),
		);

		const { loadGroups } = await import(resolve(EXT_LIB, 'groups.ts'));
		const { groups, warnings } = loadGroups(repo);
		expect(groups.ghost).toBeUndefined();
		expect(Object.keys(groups)).toEqual([]);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('用户级');
	});

	it('saveGroup 分节读改写：保留同文件偏好节，且不碰用户级文件', async () => {
		const projFile = join(repo, '.pi/extensions-data/pi-worktree/config.json');
		const userFile = join(homeDir, '.pi/agent/extensions-data/pi-worktree/config.json');
		mkdirSync(dirname(projFile), { recursive: true });
		mkdirSync(dirname(userFile), { recursive: true });
		writeFileSync(projFile, JSON.stringify({ lastNodeModulesStrategy: 'none' }));
		writeFileSync(userFile, JSON.stringify({ lastNodeModulesStrategy: 'symlink' }));

		const { saveGroup, loadGroups } = await import(resolve(EXT_LIB, 'groups.ts'));
		saveGroup(repo, 'fta', { baseRef: 'main', members: ['a'] });

		const proj = readJson(projFile);
		expect(proj.lastNodeModulesStrategy).toBe('none'); // 偏好节保留
		expect(proj.groups.fta.members).toEqual(['a']);
		// 用户级文件原样未动（不泄漏仓库级组）
		expect(readJson(userFile)).toEqual({ lastNodeModulesStrategy: 'symlink' });
		expect(loadGroups(repo).groups.fta).toBeDefined();
	});

	it('deleteGroup 只删目标组', async () => {
		const { saveGroup, deleteGroup, loadGroups } = await import(resolve(EXT_LIB, 'groups.ts'));
		saveGroup(repo, 'a', { members: ['m1'] });
		saveGroup(repo, 'b', { members: ['m2'] });
		expect(deleteGroup(repo, 'a')).toBe(true);
		expect(deleteGroup(repo, 'a')).toBe(false);
		expect(Object.keys(loadGroups(repo).groups)).toEqual(['b']);
	});

	it('无效声明被丢弃并给出原因（不静默）', async () => {
		mkdirSync(join(repo, '.pi/extensions-data/pi-worktree'), { recursive: true });
		writeFileSync(
			join(repo, '.pi/extensions-data/pi-worktree/config.json'),
			JSON.stringify({
				groups: {
					numeric: 42,
					empty: { members: [] },
					badMerge: { members: ['a'], mergeStrategy: 'frobnicate' },
				},
			}),
		);

		const { loadGroups } = await import(resolve(EXT_LIB, 'groups.ts'));
		const { groups, warnings } = loadGroups(repo);
		expect(Object.keys(groups)).toEqual(['badMerge']); // 无效 mergeStrategy 回退而非丢弃
		expect(warnings.some((w: string) => w.includes('numeric'))).toBe(true);
		expect(warnings.some((w: string) => w.includes('empty'))).toBe(true);
		expect(warnings.some((w: string) => w.includes('frobnicate'))).toBe(true);
	});
});

describe('候选集合计算（候选 = 本次动作真正作用到的集合）', () => {
	let baseDir: string;
	let repo: string;

	beforeEach(() => {
		baseDir = resolve(
			tmpdir(),
			'pi-wt-cand-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		repo = createGitRepo(baseDir, 'repo');
	});

	afterEach(() => {
		rmSync(`${repo}-worktrees`, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('create：尚无 worktree 的成员可选，已存在的灰显（exists）', async () => {
		addManagedWorktree(repo, 'has-wt');
		const { computeCandidates } = await import(resolve(EXT_LIB, 'groups.ts'));

		const c = computeCandidates(
			repo,
			'g',
			{ baseRef: 'main', members: ['has-wt', 'no-wt'] },
			'create',
		);
		const byName = Object.fromEntries(c.items.map((i: { name: string }) => [i.name, i]));
		expect(byName['has-wt'].locked).toBe(true);
		expect(byName['has-wt'].reason).toContain('已存在');
		expect(byName['no-wt'].locked).toBe(false);
		expect(c.selectable).toEqual(['no-wt']);
	});

	it('merge：脏成员与无提交成员灰显不可选，有提交且干净的可选（默认全选）', async () => {
		addManagedWorktree(repo, 'dirty-wt');
		addManagedWorktree(repo, 'empty-wt');
		addManagedWorktree(repo, 'ready-wt');
		// ready-wt 造一个提交
		writeFileSync(join(`${repo}-worktrees/ready-wt`, 'work.txt'), 'w\n');
		execSync('git add work.txt && git commit -m work -q', {
			cwd: `${repo}-worktrees/ready-wt`,
		});
		// dirty-wt 留未提交改动
		writeFileSync(join(`${repo}-worktrees/dirty-wt`, 'dirty.txt'), 'd\n');

		const { computeCandidates } = await import(resolve(EXT_LIB, 'groups.ts'));
		const c = computeCandidates(
			repo,
			'g',
			{ baseRef: 'main', members: ['dirty-wt', 'empty-wt', 'ready-wt', 'missing-wt'] },
			'merge',
		);
		const byName = Object.fromEntries(c.items.map((i: { name: string }) => [i.name, i]));

		expect(byName['dirty-wt'].locked).toBe(true);
		expect(byName['dirty-wt'].reason).toContain('未提交');
		expect(byName['empty-wt'].locked).toBe(true);
		expect(byName['empty-wt'].reason).toContain('无提交');
		expect(byName['missing-wt'].locked).toBe(true);
		expect(byName['missing-wt'].status).toBe('missing');
		expect(byName['ready-wt'].locked).toBe(false);
		expect(byName['ready-wt'].ahead).toBe(1);

		// 不适用的成员仍留在列表里作为上下文（不静默过滤）
		expect(c.items.length).toBe(4);
		expect(c.selectable).toEqual(['ready-wt']);
	});

	it('sync：不存在的成员灰显，脏成员灰显，干净成员可选', async () => {
		addManagedWorktree(repo, 'clean-wt');
		addManagedWorktree(repo, 'dirty-wt');
		writeFileSync(join(`${repo}-worktrees/dirty-wt`, 'dirty.txt'), 'd\n');

		const { computeCandidates } = await import(resolve(EXT_LIB, 'groups.ts'));
		const c = computeCandidates(
			repo,
			'g',
			{ baseRef: 'main', members: ['clean-wt', 'dirty-wt', 'gone-wt'] },
			'sync',
		);
		const byName = Object.fromEntries(c.items.map((i: { name: string }) => [i.name, i]));
		expect(byName['clean-wt'].locked).toBe(false);
		expect(byName['dirty-wt'].locked).toBe(true);
		expect(byName['gone-wt'].locked).toBe(true);
		expect(c.selectable).toEqual(['clean-wt']);
	});

	it('baseRef 缺失时走解析链（本地基准），候选里带回 base 来源', async () => {
		addManagedWorktree(repo, 'w1');
		const { computeCandidates } = await import(resolve(EXT_LIB, 'groups.ts'));
		const c = computeCandidates(repo, 'g', { members: ['w1'] }, 'merge');
		expect(c.base.branch).toBe('main');
		expect(c.base.isLocal).toBe(true);
	});

	it('告警去重：同一条只提示一次，重置后可再次提示（list 视图不受影响）', async () => {
		const { takeNewGroupWarnings, resetGroupWarningDedup } = await import(
			resolve(EXT_LIB, 'groups.ts')
		);
		resetGroupWarningDedup();
		const w = ['用户级配置里声明了 1 个组，已忽略'];
		expect(takeNewGroupWarnings(w)).toEqual(w);
		expect(takeNewGroupWarnings(w)).toEqual([]); // 第二次不再提示
		resetGroupWarningDedup();
		expect(takeNewGroupWarnings(w)).toEqual(w); // 重置（/reload 后新实例）可再次提示
		resetGroupWarningDedup();
	});
});
