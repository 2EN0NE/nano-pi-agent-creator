/**
 * pi-worktree — runGit 异步 git 执行原语单元测试
 *
 * 覆盖 ticket 08 的 runGit seam：
 *   1. 正常执行：status 0 + stdout 捕获
 *   2. 超时：kill 子进程并返回 status=null
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认 spawn 转发到真实实现；超时测试单独覆盖
vi.mock('node:child_process', async () => {
	const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
	return {
		...actual,
		spawn: vi.fn((cmd: string, args: string[], opts?: any) => actual.spawn(cmd, args, opts)),
	};
});

import { spawn } from 'node:child_process';
const mockSpawn = vi.mocked(spawn);

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_LIB = resolve(__dirname, '../../../extensions/meta/worktree/lib');

function makeFakeChild(): any {
	const child: any = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn(() => {
		// 模拟 SIGKILL 后子进程退出，触发 close 事件
		child.emit('close', null);
	});
	return child;
}

afterEach(() => {
	vi.useRealTimers();
	mockSpawn.mockClear();
});

describe('runGit — 正常执行', () => {
	it('返回 status 0 与 stdout', async () => {
		const dir = join(tmpdir(), 'rungit-' + Date.now());
		mkdirSync(dir, { recursive: true });
		execSync('git init --initial-branch main -q', { cwd: dir });

		const { runGit } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const r = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);

		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe('true');
		rmSync(dir, { recursive: true, force: true });
	});
});

describe('runGit — 超时', () => {
	it('超时后 kill 子进程并返回 status=null', async () => {
		vi.useFakeTimers();
		const fakeChild = makeFakeChild();
		mockSpawn.mockReturnValueOnce(fakeChild as any);

		const { runGit } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const p = runGit('/tmp', ['fetch', 'http://unreachable'], 1000);

		await vi.advanceTimersByTimeAsync(1000);
		const r = await p;

		expect(r.status).toBe(null);
		expect(r.timedOut).toBe(true);
		expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
	});
});

describe('runGit — spawn error', () => {
	it('spawn 失败（git ENOENT）返回 status=null 且 timedOut=false', async () => {
		const fakeChild = makeFakeChild();
		mockSpawn.mockReturnValueOnce(fakeChild as any);

		const { runGit } = await import(resolve(EXT_LIB, 'handlers.ts'));
		const p = runGit('/tmp', ['rev-parse'], 1000);

		// spawn 失败只触发 error 事件（不触发 close）
		fakeChild.emit('error', new Error('spawn git ENOENT'));
		const r = await p;

		expect(r.status).toBe(null);
		expect(r.timedOut).toBe(false);
		expect(r.stderr).toContain('ENOENT');
	});
});
