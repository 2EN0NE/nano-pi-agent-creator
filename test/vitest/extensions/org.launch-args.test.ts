/**
 * 成员启动参数（ADR-0051）— 取值/拼装语义 + 成员记录写入。
 *
 * 覆盖：D2（join 写初值 / 记录无字段 ⇒ 无参数，不回填不兜底）、D3（纯追加、空白切分、
 * 成对引号、引号不成对拒绝、空串=不带参数）、D4（唯一写入口 + 留修改时间）。
 * 这里不碰 tmux（真拉起在 org.wake-trace.test.ts 用伪造 tmux 断言实际命令行）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FIXED_WAKE_ARGS,
	buildWakeArgs,
	splitLaunchArgs,
} from '../../../extensions/auto/org/launch-args.js';
import {
	createOrg,
	joinOrg,
	readOrg,
	setMemberLaunchArgs,
} from '../../../extensions/auto/org/orgstore.js';

const ORG = 'dev-team';
let root = '';
let chiefDir = '';
let memberDir = '';

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'org-launch-args-'));
	process.env.ORG_ROOT = join(root, 'orgdata');
	chiefDir = join(root, 'chief');
	memberDir = join(root, 'worker-a');
	mkdirSync(chiefDir, { recursive: true });
	mkdirSync(memberDir, { recursive: true });
	await createOrg(ORG, { name: 'chief', dir: chiefDir, launchArgs: '--no-permission-gate' });
	await joinOrg(ORG, {
		manifest: { name: 'worker-a', role: 'member' },
		dir: memberDir,
		launchArgs: '--no-permission-gate',
	});
});

afterEach(() => {
	parkOrgRoot();
	rmSync(root, { recursive: true, force: true });
});

describe('splitLaunchArgs（D3：空白切分 + 成对引号）', () => {
	it('空串 / 全空白 ⇒ 无参数', () => {
		expect(splitLaunchArgs('')).toEqual({ ok: true, args: [] });
		expect(splitLaunchArgs('  \t ')).toEqual({ ok: true, args: [] });
	});

	it('按空白切分，首尾与连续空白不产生空 token', () => {
		expect(splitLaunchArgs(' --no-permission-gate   --model x ')).toEqual({
			ok: true,
			args: ['--no-permission-gate', '--model', 'x'],
		});
	});

	it('成对引号：保留内部空格、剔除引号（单/双引号均可）', () => {
		expect(splitLaunchArgs('-e "/a b/c.ts"')).toEqual({ ok: true, args: ['-e', '/a b/c.ts'] });
		expect(splitLaunchArgs("-e '/a b/c.ts'")).toEqual({ ok: true, args: ['-e', '/a b/c.ts'] });
	});

	it('引号不成对 ⇒ 报错（不猜、不截断）', () => {
		const r = splitLaunchArgs('-e "/a b/c.ts');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('引号不成对');
	});

	it('空引号不产生空参数（`""` 与「空串 = 不带参数」同源）', () => {
		expect(splitLaunchArgs('--model ""')).toEqual({ ok: true, args: ['--model'] });
		expect(splitLaunchArgs('""')).toEqual({ ok: true, args: [] });
		// 非平凡 token 不受影响：引号内的内容照旧保留
		expect(splitLaunchArgs('--name "a b"')).toEqual({ ok: true, args: ['--name', 'a b'] });
	});
});

describe('buildWakeArgs（D3：固定核 + 纯追加）', () => {
	it('拼装顺序：prefixArgs → 固定核 → session-id → 追加参数', () => {
		const r = buildWakeArgs({
			prefixArgs: ['node', 'pi.js'],
			sessionId: 'abc-123',
			launchArgs: '--no-permission-gate',
		});
		expect(r.args).toEqual([
			'node',
			'pi.js',
			...FIXED_WAKE_ARGS,
			'--session-id',
			'abc-123',
			'--no-permission-gate',
		]);
		expect(r.droppedReason).toBeUndefined();
	});

	it('追加项永远在最后：写重复的固定项也只在尾部（org 不替用户判错）', () => {
		const r = buildWakeArgs({ launchArgs: '-a --session-control' });
		expect(r.args.slice(0, 2)).toEqual(['-a', '--session-control']);
		expect(r.args.slice(2)).toEqual(['-a', '--session-control']);
	});

	it('无字段 / 空串 / 全空白 ⇒ 不追加任何参数（D2「没有的就没有」）', () => {
		for (const v of [undefined, '', '   ']) {
			expect(buildWakeArgs({ launchArgs: v }).args).toEqual([...FIXED_WAKE_ARGS]);
		}
	});

	it('无上次会话 ⇒ 不带 --session-id', () => {
		expect(buildWakeArgs({ launchArgs: '--x' }).args).toEqual([...FIXED_WAKE_ARGS, '--x']);
	});

	it('坏参数不阻断唤醒：忽略追加项并回传原因（固定核才是命脉）', () => {
		const r = buildWakeArgs({ launchArgs: '-e "/a b' });
		expect(r.args).toEqual([...FIXED_WAKE_ARGS]);
		expect(String(r.droppedReason)).toContain('引号不成对');
	});
});

describe('成员记录里的启动参数（D1/D2/D4）', () => {
	it('初值为纯空白时**不写字段**（与「清空 = 删除」同一口径）', async () => {
		const blankDir = join(root, 'blank-args');
		mkdirSync(blankDir, { recursive: true });
		await joinOrg(ORG, {
			manifest: { name: 'blank-args', role: 'member' },
			dir: blankDir,
			launchArgs: '   ',
		});
		const m = (await readOrg(ORG)).members.find((x) => x.name === 'blank-args');
		expect(m?.launchArgs).toBeUndefined();
	});

	it('join / create 写入初值；未传则该字段不存在（没有的就没有）', async () => {
		const org = await readOrg(ORG);
		expect(org.members.find((m) => m.name === 'chief')?.launchArgs).toBe(
			'--no-permission-gate',
		);
		expect(org.members.find((m) => m.name === 'worker-a')?.launchArgs).toBe(
			'--no-permission-gate',
		);

		await createOrg('bare-org', { name: 'chief', dir: chiefDir });
		const bare = await readOrg('bare-org');
		expect(Object.hasOwn(bare.members[0], 'launchArgs')).toBe(false);
	});

	it('改值：写回成员记录 + 留修改时间', async () => {
		const before = await readOrg(ORG);
		expect(
			before.members.find((m) => m.name === 'worker-a')?.launchArgsUpdatedAt,
		).toBeUndefined();

		const updated = await setMemberLaunchArgs(ORG, 'worker-a', '--model claude-sonnet-5');
		expect(updated.launchArgs).toBe('--model claude-sonnet-5');
		expect(updated.launchArgsUpdatedAt).toBeTruthy();

		const after = await readOrg(ORG);
		expect(after.members.find((m) => m.name === 'worker-a')?.launchArgs).toBe(
			'--model claude-sonnet-5',
		);
	});

	it('清空（空白）= 删除该字段，且此后唤醒不再追加（跨唤醒持久化回归）', async () => {
		await setMemberLaunchArgs(ORG, 'worker-a', '  ');
		const org = await readOrg(ORG);
		const m = org.members.find((x) => x.name === 'worker-a');
		expect(m?.launchArgs).toBeUndefined();
		expect(m?.launchArgsUpdatedAt).toBeTruthy(); // 清空同样是一次修改
		expect(buildWakeArgs({ launchArgs: m?.launchArgs }).args).toEqual([...FIXED_WAKE_ARGS]);
	});

	it('非成员 ⇒ 报错（不静默写入）', async () => {
		await expect(setMemberLaunchArgs(ORG, 'nobody', '--x')).rejects.toThrow('不在组织');
	});
});
