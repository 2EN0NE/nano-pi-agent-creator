/**
 * pi-worktree — 组批量动作的语义级保护（ADR-0062）
 *
 * 断言落在**持久化产物与 git 状态**上（提交数、SHA、成员基线），不是「无报错即通过」：
 *   - 组创建：只补建缺失成员、基点取本地目标分支、已存在者不动
 *   - 组合并：N 个成员 = 目标分支 N 个提交、按花名册顺序、即时对齐、fail-fast 可续跑
 *   - 守卫：目标分支 index 脏 → 硬拒绝且不产生提交；脏成员 → 执行层拒绝
 *   - 组同步：非破坏性（不丢未合入提交）
 *   - 本地优先：remote 指向不存在路径仍全部成功（证明不隐式 fetch）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_LIB = resolve(__dirname, '../../../extensions/meta/worktree/lib');

function createGitRepo(basedir: string, name: string): string {
	const repoDir = join(basedir, name);
	mkdirSync(repoDir, { recursive: true });
	execSync('git init --initial-branch main -q', { cwd: repoDir });
	writeFileSync(join(repoDir, 'README.md'), `# ${name}\n`);
	execSync('git add README.md && git commit -m init -q', { cwd: repoDir });
	return repoDir;
}

function sh(dir: string, cmd: string): string {
	return execSync(cmd, { cwd: dir, encoding: 'utf-8' }).trim();
}

function commitFile(dir: string, file: string, content: string, msg: string): void {
	writeFileSync(join(dir, file), content);
	execSync(`git add ${file} && git commit -m "${msg}" -q`, { cwd: dir });
}

function countCommits(repo: string, base: string, branch: string): number {
	return parseInt(sh(repo, `git rev-list --count ${base}..${branch}`) || '0', 10);
}

/**
 * 给测试仓库补上与真实仓库等价的 `.gitignore`。
 *
 * 必要性：组创建默认会 symlink `.pi`（`symlinkTargetIds` 默认含 `pi`）。
 *
 * ⚠️ 这里**故意**用带尾斜杠的 `.pi/`——它只匹配目录，而成员里的 `.pi` 是**符号链接**，
 * 所以 git 根本不认为它被忽略（`git status` 报 `?? .pi`）。这正是组功能曾经踩到的坑：
 * 成员被判为「脏」→ 候选层锁死 → 组合并/同步全做不了。
 * 修复是 `setup.ts` 在创建 symlink 后把路径登记进 `.git/info/exclude`（见
 * `worktree.operations.test.ts` 的「插件 symlink 的本地 exclude」套件）。
 * 这里保留 `.pi/` 写法，让组流程用例同时充当该修复的**回归保护**。
 */
function addGitignore(repo: string): void {
	writeFileSync(join(repo, '.gitignore'), '.pi/\nnode_modules/\n');
	execSync('git add .gitignore && git commit -m "chore: gitignore .pi/node_modules" -q', {
		cwd: repo,
	});
}

describe('组批量动作（execGroupCreate / execGroupMerge / execGroupSync / 守卫）', () => {
	let baseDir: string;
	let repo: string;
	let devSha: string;

	beforeEach(() => {
		baseDir = resolve(
			tmpdir(),
			'pi-wt-gops-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		repo = createGitRepo(baseDir, 'repo');
		// 本地集成分支 dev，领先其远端（origin 指向不存在路径 → 任何 fetch 都会失败）
		execSync('git checkout -b dev -q', { cwd: repo });
		commitFile(repo, 'integration.txt', 'integration\n', 'integration');
		execSync('git checkout main -q', { cwd: repo });
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repo });
		devSha = sh(repo, 'git rev-parse dev');
	});

	afterEach(() => {
		rmSync(`${repo}-worktrees`, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('组创建：只补建缺失成员；基点取本地 dev；已存在者一律不动', async () => {
		const { execGroupCreate } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const { createWorktree } = await import(resolve(EXT_LIB, 'worktree.ts'));
		// 先建一个成员（模拟已存在）
		const pre = createWorktree(repo, 'keep-me', 'none', undefined, { baseRef: 'dev' });
		expect(pre.ok).toBe(true);
		// 该成员上留一个未合入提交：组创建不应把它弄丢
		commitFile(`${repo}-worktrees/keep-me`, 'wip.txt', 'wip\n', 'wip');
		const keepSha = sh(`${repo}-worktrees/keep-me`, 'git rev-parse HEAD');
		expect(keepSha).not.toBe(devSha);

		const res = execGroupCreate(
			repo,
			'g',
			{ baseRef: 'dev', members: ['keep-me', 'fresh-a', 'fresh-b'] },
			['keep-me', 'fresh-a', 'fresh-b'],
		);
		expect(res.ok).toBe(true);
		// 已存在者未被动过（提交还在）
		expect(sh(`${repo}-worktrees/keep-me`, 'git rev-parse HEAD')).toBe(keepSha);
		// 补建成员的基点 == 本地 dev
		expect(sh(`${repo}-worktrees/fresh-a`, 'git rev-parse HEAD')).toBe(devSha);
		expect(sh(`${repo}-worktrees/fresh-b`, 'git rev-parse HEAD')).toBe(devSha);
		// 分支名沿用约定
		expect(sh(`${repo}-worktrees/fresh-a`, 'git rev-parse --abbrev-ref HEAD')).toBe(
			'wt/fresh-a',
		);
	});

	it('组合并：按花名册顺序，N 个成员 = 目标分支 N 个提交，且成员已即时对齐', async () => {
		const { execGroupCreate, execGroupMerge } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const group = {
			baseRef: 'dev',
			members: ['alpha', 'beta'],
			mergeStrategy: 'squash' as const,
		};
		expect(execGroupCreate(repo, 'g', group, group.members).ok).toBe(true);

		commitFile(`${repo}-worktrees/alpha`, 'alpha.txt', 'a\n', 'alpha work');
		commitFile(`${repo}-worktrees/beta`, 'beta.txt', 'b\n', 'beta work');
		const alphaTip = sh(`${repo}-worktrees/alpha`, 'git rev-parse HEAD');
		const betaTip = sh(`${repo}-worktrees/beta`, 'git rev-parse HEAD');

		const res = await execGroupMerge(repo, 'g', group, group.members);
		expect(res.ok).toBe(true);

		// 目标分支恰好新增 2 个提交
		expect(countCommits(repo, 'main', 'dev')).toBe(3); // integration + alpha + beta
		// 顺序：alpha 的提交在 beta 之前（squash 提交信息为 `Squash merge 'wt/<name>'`）
		const log = sh(repo, 'git log --format=%s dev');
		expect(log.indexOf('wt/alpha')).toBeGreaterThan(log.indexOf('wt/beta'));

		// 逐成员**即时**对齐的语义：每个成员相对最终 dev 都不再领先（下轮不会重放已合入的内容）
		// 注意：各成员对齐到的是「合入它时的 dev」，版本并不相同 —— 这正是需要阶段②统一对齐的原因
		expect(countCommits(repo, 'dev', 'wt/alpha')).toBe(0);
		expect(countCommits(repo, 'dev', 'wt/beta')).toBe(0);

		// 阶段②统一对齐：全部成员收敛到同一个最终 dev
		const { alignMember } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		expect(alignMember(repo, 'alpha', 'dev').ok).toBe(true);
		expect(sh(`${repo}-worktrees/alpha`, 'git rev-parse HEAD')).toBe(
			sh(repo, 'git rev-parse dev'),
		);
		// 旧 tip 被记录（可回溯）
		const oldTips = res.steps.map((s: { oldTip?: string }) => s.oldTip);
		expect(oldTips).toContain(alphaTip);
		expect(oldTips).toContain(betaTip);
	});

	it('组合并 fail-fast：冲突时停在冲突成员，前 i-1 个提交保留，可续跑', async () => {
		const { execGroupCreate, execGroupMerge } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const group = {
			baseRef: 'dev',
			members: ['first', 'second'],
			mergeStrategy: 'squash' as const,
		};
		expect(execGroupCreate(repo, 'g', group, group.members).ok).toBe(true);

		// 两个成员改同一文件同一行 → second 变基到（已含 first 提交的）dev 时冲突
		commitFile(`${repo}-worktrees/first`, 'shared.txt', 'from-first\n', 'first');
		commitFile(`${repo}-worktrees/second`, 'shared.txt', 'from-second\n', 'second');

		const res = await execGroupMerge(repo, 'g', group, group.members);
		expect(res.ok).toBe(false);
		expect(res.resumeFrom).toBe('second');
		// 只有 first 的提交进了 dev
		expect(countCommits(repo, 'main', 'dev')).toBe(2); // integration + first
		expect(sh(repo, 'git log --format=%s dev')).toContain('first');
		// second 停在 rebase 冲突态（便于解决后续跑）
		const status = spawnSync('git', ['status', '--porcelain'], {
			cwd: `${repo}-worktrees/second`,
			encoding: 'utf-8',
		});
		expect((status.stdout || '').length).toBeGreaterThan(0);
	});

	it('安全属性：主检出的已暂存改动**不会**被卷进 squash 提交，且合并后仍保持暂存', async () => {
		const { execGroupCreate, execGroupMerge } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const group = { baseRef: 'dev', members: ['s1'], mergeStrategy: 'squash' as const };
		expect(execGroupCreate(repo, 'g', group, group.members).ok).toBe(true);
		commitFile(`${repo}-worktrees/s1`, 'feature.txt', 'f\n', 'feature work');

		// 主检出制造「已暂存」在途改动，然后回到 main（模拟用户在别处工作）
		execSync('git checkout dev -q', { cwd: repo });
		writeFileSync(join(repo, 'staged-by-user.txt'), 'staged\n');
		execSync('git add staged-by-user.txt', { cwd: repo });
		execSync('git checkout main -q', { cwd: repo });

		const res = await execGroupMerge(repo, 'g', group, group.members);
		expect(res.ok).toBe(true);
		// squash 提交只含被合并成员的文件
		const merged = sh(repo, 'git show --name-only --format= dev');
		expect(merged).toContain('feature.txt');
		expect(merged).not.toContain('staged-by-user.txt');
		// 用户的在途暂存改动原样保留（execMerge 内部 stash push → … → stash pop）
		expect(sh(repo, 'git diff --cached --name-only')).toContain('staged-by-user.txt');
		expect(sh(repo, 'git stash list')).toBe('');
	});

	it('守卫：目标检出处于 merge 进行中 → 拒绝', async () => {
		const { execGroupMerge } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		// 真造一个冲突中的 merge：两侧各自新增同名文件（add/add 冲突）
		execSync('git checkout -b side -q', { cwd: repo });
		commitFile(repo, 'conflict.txt', 'from-side\n', 'side work');
		execSync('git checkout dev -q', { cwd: repo });
		commitFile(repo, 'conflict.txt', 'from-dev\n', 'dev work');
		spawnSync('git', ['merge', 'side'], { cwd: repo, encoding: 'utf-8' });
		expect(
			spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: repo })
				.status,
		).toBe(0);

		const before = sh(repo, 'git rev-parse dev');
		const res = await execGroupMerge(repo, 'g', { baseRef: 'dev', members: ['never-made'] }, [
			'never-made',
		]);
		expect(res.ok).toBe(false);
		expect(res.message).toContain('merge 进行中');
		expect(sh(repo, 'git rev-parse dev')).toBe(before);
	});

	it('未知子命令不执行任何变更动作（历史上会降级为 merge）', async () => {
		const { execGroupCreate, handleGroupCommand } = await import(
			resolve(EXT_LIB, 'group-ops.ts')
		);
		const group = { baseRef: 'dev', members: ['u1'], mergeStrategy: 'squash' as const };
		expect(execGroupCreate(repo, 'g', group, group.members).ok).toBe(true);
		commitFile(`${repo}-worktrees/u1`, 'u1.txt', 'u\n', 'u work');

		const before = sh(repo, 'git rev-parse dev');
		const notes: string[] = [];
		const ctx = {
			hasUI: false,
			cwd: repo,
			ui: { notify: (m: string, l?: string) => notes.push(`${l ?? 'info'}:${m}`) },
		} as any;

		await handleGroupCommand(repo, { _positional: 'mrege', _extraPositional: 'g' }, ctx);
		expect(notes.join('\n')).toContain('未知的组子命令');
		expect(sh(repo, 'git rev-parse dev')).toBe(before); // 没有发生任何合并
	});

	it('group delete 只删声明，不触发合并', async () => {
		const { handleGroupCommand } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const { saveGroup, loadGroups } = await import(resolve(EXT_LIB, 'groups.ts'));
		saveGroup(repo, 'g', { baseRef: 'dev', members: ['d1'], mergeStrategy: 'squash' });

		const before = sh(repo, 'git rev-parse dev');
		const notes: string[] = [];
		const ctx = {
			hasUI: false,
			cwd: repo,
			ui: { notify: (m: string, l?: string) => notes.push(`${l ?? 'info'}:${m}`) },
		} as any;

		await handleGroupCommand(repo, { _positional: 'delete', _extraPositional: 'g' }, ctx);
		expect(notes.join('\n')).toContain('已删除组声明');
		expect(loadGroups(repo).groups.g).toBeUndefined();
		expect(sh(repo, 'git rev-parse dev')).toBe(before);
	});

	it('守卫：脏成员在执行层被拒绝（面板不是唯一入口）', async () => {
		const { execGroupCreate, execGroupMerge } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const group = { baseRef: 'dev', members: ['dirty'], mergeStrategy: 'squash' as const };
		expect(execGroupCreate(repo, 'g', group, group.members).ok).toBe(true);
		commitFile(`${repo}-worktrees/dirty`, 'd.txt', 'd\n', 'd work');
		writeFileSync(join(`${repo}-worktrees/dirty`, 'uncommitted.txt'), 'wip\n');

		const before = sh(repo, 'git rev-parse dev');
		const res = await execGroupMerge(repo, 'g', group, group.members);
		expect(res.ok).toBe(false);
		expect(res.steps[0].message).toContain('未提交');
		expect(sh(repo, 'git rev-parse dev')).toBe(before);
	});

	it('组同步：非破坏性——成员的未合入提交仍在，且被重放到目标分支之上', async () => {
		const { execGroupCreate, execGroupSync } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const group = { baseRef: 'dev', members: ['w1'] };
		expect(execGroupCreate(repo, 'g', group, group.members).ok).toBe(true);
		commitFile(`${repo}-worktrees/w1`, 'w1.txt', 'w1\n', 'w1 work');

		// 目标分支前进
		execSync('git checkout dev -q', { cwd: repo });
		commitFile(repo, 'later.txt', 'later\n', 'later');
		const devTip = sh(repo, 'git rev-parse dev');
		execSync('git checkout main -q', { cwd: repo });

		const res = execGroupSync(repo, 'g', group, group.members);
		expect(res.ok).toBe(true);
		// 提交仍在（未被丢弃）
		const tip = sh(`${repo}-worktrees/w1`, 'git rev-parse HEAD');
		expect(sh(`${repo}-worktrees/w1`, `git log --format=%s -1 ${tip}`)).toBe('w1 work');
		// 且已重放到目标分支之上
		const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', devTip, 'HEAD'], {
			cwd: `${repo}-worktrees/w1`,
			encoding: 'utf-8',
		});
		expect(ancestry.status).toBe(0);
		// 领先 dev 1 个提交
		expect(countCommits(repo, 'dev', 'wt/w1')).toBe(1);
	});

	it('过程日志：逐成员 STEP_BEGIN / STEP_OK，失败侧 FAIL_MARKER（ADR-0062，可 grep）', async () => {
		// 用 mock bus 收集日志事件：logger 在总线存在时 emit 到总线（不写文件、不碰真实日志目录）
		const events: Array<{ message: string; level: string }> = [];
		const { initEventBus } = await import('../../../extensions/meta/pi-logger/api.js');
		initEventBus({
			emit: (_ch: string, e: { message: string; level: string }) => events.push(e),
		} as never);
		// 先让启动期缓冲的微任务 flush 走，再清空，确保只观察本用例产生的事件
		await new Promise((r) => setTimeout(r, 0));
		events.length = 0;

		const { saveGroup } = await import(resolve(EXT_LIB, 'groups.ts'));
		const { createWorktree } = await import(resolve(EXT_LIB, 'worktree.ts'));
		const { execGroupMerge } = await import(resolve(EXT_LIB, 'group-ops.ts'));

		const groupName = 'steplog-grp';
		const group = { baseRef: 'dev', members: ['w1', 'w2'], mergeStrategy: 'squash' as const };
		saveGroup(repo, groupName, group);
		for (const n of ['w1', 'w2']) {
			createWorktree(repo, n, 'none', undefined, { baseRef: 'dev' });
			commitFile(`${repo}-worktrees/${n}`, `${n}.txt`, `${n}\n`, n);
		}
		events.length = 0;

		const ok = await execGroupMerge(repo, groupName, group, ['w1', 'w2']);

		expect(ok.ok, ok.message).toBe(true);
		const msgs = events.map((e) => e.message);
		// 逐成员各一条 BEGIN / OK，且带成员名与目标分支（落 .pi/logs 后可直接 grep）
		expect(msgs.filter((m) => m.startsWith('STEP_BEGIN'))).toEqual([
			'STEP_BEGIN group=steplog-grp action=merge member=w1 base=dev',
			'STEP_BEGIN group=steplog-grp action=merge member=w2 base=dev',
		]);
		expect(msgs.filter((m) => m.startsWith('STEP_OK'))).toHaveLength(2);
		expect(msgs.filter((m) => m.includes('FAIL_MARKER'))).toHaveLength(0);

		// 失败侧：脏成员 → 恰好一条单行 FAIL_MARKER（error 级），停在 w3
		const group2 = { baseRef: 'dev', members: ['w3'], mergeStrategy: 'squash' as const };
		saveGroup(repo, 'steplog-grp2', group2);
		createWorktree(repo, 'w3', 'none', undefined, { baseRef: 'dev' });
		writeFileSync(join(`${repo}-worktrees/w3`, 'dirty.txt'), 'd\n');
		events.length = 0;

		const bad = await execGroupMerge(repo, 'steplog-grp2', group2, ['w3']);

		expect(bad.ok).toBe(false);
		expect(bad.resumeFrom).toBe('w3');
		const fail = events.filter((e) => e.message.includes('FAIL_MARKER'));
		expect(fail).toHaveLength(1);
		expect(fail[0].message).toContain('member=w3');
		expect(fail[0].message).not.toContain('\n');
		expect(fail[0].level).toBe('error');
	});
});

// ═══════════════════════════════════════════
// 可续跑：ADR-0062 验证要求 3 的**续跑半程**（此前无任何用例覆盖）
// ═══════════════════════════════════════════
//
// 语义（ADR-0062 决策 6 + 插件给用户的提示「解决后重跑本命令即可续完剩余成员」）：
// 冲突停下 → 用户解冲突 → 重跑同一命令 → 剩余成员续完。两条入口都必须成立：
//   ① 直接执行层 `execGroupMerge`（传全量花名册）→ 已合入成员必须**跳过**而非假失败
//   ② 命令面 `/worktree group merge <组>` → 候选锁定把已合入成员排除，只处理剩余成员
describe('组「fail-fast + 可续跑」的续跑半程', () => {
	let baseDir: string;
	let repo: string;

	/** first/second 两个成员改同一文件同一行 → 第二轮必冲突，停在 second */
	function conflictGroup(): {
		baseRef: string;
		members: string[];
		mergeStrategy: 'squash';
	} {
		return { baseRef: 'dev', members: ['first', 'second'], mergeStrategy: 'squash' };
	}

	/** 用户在 second 的 worktree 里解决 rebase 冲突（保留双方内容）并 rebase --continue */
	function resolveSecondConflict(): void {
		const dir = `${repo}-worktrees/second`;
		writeFileSync(join(dir, 'shared.txt'), 'from-first\nfrom-second\n');
		execSync('git add shared.txt', { cwd: dir });
		const cont = spawnSync('git', ['rebase', '--continue'], {
			cwd: dir,
			encoding: 'utf-8',
			env: { ...process.env, GIT_EDITOR: 'true' },
		});
		expect(cont.status, cont.stderr).toBe(0);
	}

	beforeEach(async () => {
		baseDir = resolve(
			tmpdir(),
			'pi-wt-resume-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		repo = createGitRepo(baseDir, 'repo');
		addGitignore(repo);
		execSync('git checkout -b dev -q', { cwd: repo });
		commitFile(repo, 'integration.txt', 'integration\n', 'integration');
		execSync('git checkout main -q', { cwd: repo });
		execSync('git remote add origin file:///nonexistent/repo.git', { cwd: repo });

		const { execGroupCreate } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const group = conflictGroup();
		expect(execGroupCreate(repo, 'g', group, group.members).ok).toBe(true);
		commitFile(`${repo}-worktrees/first`, 'shared.txt', 'from-first\n', 'first');
		commitFile(`${repo}-worktrees/second`, 'shared.txt', 'from-second\n', 'second');
	});

	afterEach(() => {
		rmSync(`${repo}-worktrees`, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('执行层：解冲突后重跑（全量花名册）→ 已合入成员跳过、剩余成员合完', async () => {
		const { execGroupMerge } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const group = conflictGroup();

		// 第一轮：停在 second；dev 已有 first 的提交
		const r1 = await execGroupMerge(repo, 'g', group, group.members);
		expect(r1.ok).toBe(false);
		expect(r1.resumeFrom).toBe('second');
		expect(countCommits(repo, 'main', 'dev')).toBe(2); // integration + first

		resolveSecondConflict();

		// 第二轮：按提示「重跑本命令」——成员列表不变（仍是全量花名册）
		const r2 = await execGroupMerge(repo, 'g', group, group.members);
		expect(r2.ok, r2.message).toBe(true);
		expect(
			r2.steps.find((s: { name: string; skipped?: boolean }) => s.name === 'first')?.skipped,
		).toBe(true);
		expect(
			r2.steps.find((s: { name: string; skipped?: boolean }) => s.name === 'second')?.skipped,
		).toBeFalsy();
		expect(countCommits(repo, 'main', 'dev')).toBe(3); // integration + first + second
		expect(sh(repo, 'git show dev:shared.txt')).toContain('from-second');

		// 第三轮：再重跑一次仍然成功且不新增提交（幂等）
		const r3 = await execGroupMerge(repo, 'g', group, group.members);
		expect(r3.ok, r3.message).toBe(true);
		expect(countCommits(repo, 'main', 'dev')).toBe(3);
	});

	it('命令面：解冲突后 /worktree group merge 重跑只处理剩余成员并合完', async () => {
		const { handleGroupCommand } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const { saveGroup } = await import(resolve(EXT_LIB, 'groups.ts'));
		const group = conflictGroup();
		saveGroup(repo, 'g', group);

		const notesOf = () => {
			const notes: string[] = [];
			return {
				notes,
				ctx: {
					hasUI: false,
					cwd: repo,
					ui: { notify: (m: string) => notes.push(m), confirm: async () => true },
				} as any,
			};
		};

		const r1 = notesOf();
		await handleGroupCommand(repo, { _positional: 'merge', _extraPositional: 'g' }, r1.ctx);
		expect(r1.notes.join('\n')).toContain("合并停在成员 'second'");
		expect(countCommits(repo, 'main', 'dev')).toBe(2);

		resolveSecondConflict();

		const r2 = notesOf();
		await handleGroupCommand(repo, { _positional: 'merge', _extraPositional: 'g' }, r2.ctx);
		const text2 = r2.notes.join('\n');
		expect(text2).toContain('合并完成');
		// 候选锁定：已合入的 first 不在本轮执行集里（只处理 second）
		expect(text2).toContain('OK   second');
		expect(text2).not.toContain('FAIL');
		expect(countCommits(repo, 'main', 'dev')).toBe(3);
		expect(sh(repo, 'git show dev:shared.txt')).toContain('from-second');
	});
});

// ═══════════════════════════════════════════
// 命令面：/worktree group sync 与 list（此前无端到端覆盖）
// ═══════════════════════════════════════════
describe('组命令面：sync / list', () => {
	let baseDir: string;
	let repo: string;

	function cmdCtx() {
		const notes: string[] = [];
		return {
			notes,
			ctx: {
				hasUI: false,
				cwd: repo,
				ui: { notify: (m: string) => notes.push(m), confirm: async () => true },
			} as any,
		};
	}

	beforeEach(async () => {
		baseDir = resolve(
			tmpdir(),
			'pi-wt-cmd-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		repo = createGitRepo(baseDir, 'repo');
		addGitignore(repo);
		execSync('git checkout -b dev -q', { cwd: repo });
		commitFile(repo, 'integration.txt', 'integration\n', 'integration');
		execSync('git checkout main -q', { cwd: repo });

		const { execGroupCreate } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const { saveGroup } = await import(resolve(EXT_LIB, 'groups.ts'));
		const group = { baseRef: 'dev', members: ['w1'], mergeStrategy: 'squash' as const };
		saveGroup(repo, 'g', group);
		expect(execGroupCreate(repo, 'g', group, group.members).ok).toBe(true);
	});

	afterEach(() => {
		rmSync(`${repo}-worktrees`, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('/worktree group sync：成员对齐到目标分支且未合入提交不丢', async () => {
		const { handleGroupCommand } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		commitFile(`${repo}-worktrees/w1`, 'w1.txt', 'w1\n', 'w1 work');

		// 目标分支前进（成员因此落后）
		execSync('git checkout dev -q', { cwd: repo });
		commitFile(repo, 'later.txt', 'later\n', 'later');
		const devTip = sh(repo, 'git rev-parse dev');
		execSync('git checkout main -q', { cwd: repo });

		const c = cmdCtx();
		await handleGroupCommand(repo, { _positional: 'sync', _extraPositional: 'g' }, c.ctx);

		expect(c.notes.join('\n')).toContain('同步完成');
		// 提交仍在，且已被重放到目标分支之上（非破坏性）
		expect(sh(`${repo}-worktrees/w1`, 'git log --format=%s -1 HEAD')).toBe('w1 work');
		const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', devTip, 'HEAD'], {
			cwd: `${repo}-worktrees/w1`,
			encoding: 'utf-8',
		});
		expect(ancestry.status, '成员应已重放到目标分支之上').toBe(0);
		expect(countCommits(repo, 'dev', 'wt/w1')).toBe(1);
	});

	it('/worktree group list：展示组名、目标分支与成员', async () => {
		const { handleGroupCommand } = await import(resolve(EXT_LIB, 'group-ops.ts'));
		const { getManagedWorktrees } = await import(resolve(EXT_LIB, 'paths.ts'));

		const c = cmdCtx();
		await handleGroupCommand(repo, { _positional: 'list' }, c.ctx);
		const text = c.notes.join('\n');
		expect(text).toContain('g');
		expect(text).toContain('dev');
		expect(text).toContain('w1');
		// 只读视图：不产生任何 git/worktree 副作用
		expect(getManagedWorktrees(repo).map((w: { name: string }) => w.name)).toEqual(['w1']);
	});
});
