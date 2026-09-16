/**
 * pi-worktree — 检出分支的 shell 注入防线（CWE-78 回归）
 *
 * 背景：`handleUse` 的「检出分支」策略原先用 `execSync(`git checkout ${branch}`)` 拼接字符串。
 * 目标分支名可能来自 `origin/HEAD`（**由被 clone 的远端决定**），而 git ref 名允许 `$()`、
 * 反引号、`${IFS}` 等字符——实测字符串形式下 `evil$(touch${IFS}/path/marker)` 会真的落文件
 * （本用例的 marker 断言在旧实现下必红）。现行实现走 argv，必须始终按字面处理。
 */
import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

describe('检出分支按字面处理（shell 注入防线）', () => {
	it('分支名含 $()/IFS 时：检出成功、不执行注入命令', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-refsafety-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		const marker = join(baseDir, 'INJECTED');
		// git ref 名允许 $ ( ) { }；空格非法，故用 ${IFS} 充当分隔符构造注入
		const evil = `evil$(touch\${IFS}${marker})`;
		const created = spawnSync('git', ['branch', evil], { cwd: repo, encoding: 'utf-8' });
		expect(created.status, created.stderr).toBe(0);

		const { execCheckoutBranch, getCurrentBranch } = await import(resolve(EXT_LIB, 'git.ts'));
		const res = execCheckoutBranch(repo, evil);

		expect(res.ok, res.message).toBe(true);
		expect(getCurrentBranch(repo)).toBe(evil);
		// 关键断言：字符串拼接实现下这里会真被注入出文件
		expect(existsSync(marker)).toBe(false);

		rmSync(baseDir, { recursive: true, force: true });
	});

	it('分支不存在时：返回 ok=false 并带 git 错误信息（不抛异常）', async () => {
		const baseDir = resolve(tmpdir(), 'pi-wt-refsafety2-' + Date.now());
		const repo = createGitRepo(baseDir, 'repo');
		const { execCheckoutBranch } = await import(resolve(EXT_LIB, 'git.ts'));

		const res = execCheckoutBranch(repo, 'no-such-branch');

		expect(res.ok).toBe(false);
		expect(res.message.length).toBeGreaterThan(0);

		rmSync(baseDir, { recursive: true, force: true });
	});
});
