/**
 * ADR-0051 审查票 11 —— 花名册写锁。
 *
 * 背景：`readOrg → 改动 → writeOrg` 是 last-write-wins，人类在面板改某成员的启动参数、
 * 与成员在岗期间回写自己的简档，会互相抹掉。这里验证锁的机制（互斥 + 可重入）与
 * 两条写路径同时进行时**两边改动都保住**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	createOrg,
	joinOrg,
	readOrg,
	refreshMemberManifest,
	setMemberLaunchArgs,
	withOrgLock,
} from '../../../extensions/auto/org/orgstore.js';

let root = '';
let chiefDir = '';
let workerDir = '';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'org-write-lock-'));
	process.env.ORG_ROOT = join(root, 'orgdata');
	chiefDir = join(root, 'chief');
	workerDir = join(root, 'worker-a');
	for (const d of [chiefDir, workerDir]) mkdirSync(d, { recursive: true });
	await createOrg('dev-team', { name: 'chief', dir: chiefDir });
	await joinOrg('dev-team', {
		manifest: { name: 'worker-a', role: 'member' },
		dir: workerDir,
	});
});

afterEach(() => {
	delete process.env.ORG_ROOT;
	rmSync(root, { recursive: true, force: true });
});

describe('per-org 花名册写锁（票 11）', () => {
	it('互斥：后来者必须等前者释放（不交错进入临界区）', async () => {
		const order: string[] = [];
		const first = withOrgLock('dev-team', async () => {
			order.push('a-in');
			await sleep(30);
			order.push('a-out');
		});
		await sleep(5); // 让 first 先拿到锁
		const second = withOrgLock('dev-team', async () => {
			order.push('b-in');
		});
		await Promise.all([first, second]);
		expect(order).toEqual(['a-in', 'a-out', 'b-in']);
	});

	it('可重入：同进程嵌套取同一把锁不会自锁（joinOrg 内部会再取锁）', async () => {
		const value = await withOrgLock('dev-team', async () =>
			withOrgLock('dev-team', async () => 'ok'),
		);
		expect(value).toBe('ok');
	});

	it('并发写：改启动参数 与 在岗回写简档 两边的改动都保住', async () => {
		const [member, refreshed] = await Promise.all([
			setMemberLaunchArgs('dev-team', 'worker-a', '--no-permission-gate'),
			refreshMemberManifest('dev-team', workerDir, {
				label: 'Worker A',
				description: '在岗回写',
			}),
		]);
		expect(member.launchArgs).toBe('--no-permission-gate');
		expect(refreshed).toBe(true);

		const m = (await readOrg('dev-team')).members.find((x) => x.name === 'worker-a');
		expect(m?.launchArgs).toBe('--no-permission-gate'); // 不被简档回写抹掉
		expect(m?.manifest?.label).toBe('Worker A'); // 不被参数修改抹掉
		expect(m?.launchArgsUpdatedAt).toBeTruthy();
	});
});
