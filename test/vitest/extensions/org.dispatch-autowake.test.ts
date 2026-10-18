// org 派活自动唤醒接线测试（审查 P1）
//
// 背景：`autoWake` 开关已写入 org.json、四份文档均已声明"负责人派活拉起睡眠成员"，
// 但 `dispatchTask` 从未调用 `ensureAwakeForDispatch` —— 开关打开与关闭行为一致。
// 这里用 vi.mock 替掉 lifecycle 模块（真实拉起 tmux 太重且不确定），只断言接线本身。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ensureAwakeForDispatch } = vi.hoisted(() => ({
	ensureAwakeForDispatch: vi.fn(async () => false),
}));
vi.mock('../../../extensions/auto/org/lifecycle.js', () => ({ ensureAwakeForDispatch }));

import { dispatchTask } from '../../../extensions/auto/org/dispatch.js';
import { createOrg, joinOrg, setAutoWake } from '../../../extensions/auto/org/orgstore.js';
import type { AgentManifest } from '../../../extensions/auto/org/types.js';

const ORG = 'dev-team';
let tmpRoot: string;
let chiefDir: string;
let workerDir: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), 'org-autowake-'));
	process.env.ORG_ROOT = tmpRoot;
	chiefDir = join(tmpRoot, 'chief');
	workerDir = join(tmpRoot, 'worker-a');
	for (const d of [chiefDir, workerDir]) mkdirSync(d, { recursive: true });
	ensureAwakeForDispatch.mockClear();
});

afterEach(() => {
	parkOrgRoot();
	rmSync(tmpRoot, { recursive: true, force: true });
});

const workerManifest: AgentManifest = { name: 'worker-a', role: 'member' };

async function setupOrg() {
	await createOrg(ORG, { name: 'chief', dir: chiefDir });
	await joinOrg(ORG, { manifest: workerManifest, dir: workerDir });
}

function dispatch() {
	return dispatchTask({
		org: ORG,
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		title: 'T',
		background: 'bg',
		items: ['i1'],
		targets: [{ agent: 'worker-a', description: 'd' }],
	});
}

describe('派活自动唤醒接线（P1 / ADR-0040 D3）', () => {
	it('autoWake 开：负责人派活前对每个目标调用 ensureAwakeForDispatch', async () => {
		await setupOrg();
		await setAutoWake(ORG, true);
		await dispatch();
		expect(ensureAwakeForDispatch).toHaveBeenCalledTimes(1);
		expect(ensureAwakeForDispatch).toHaveBeenCalledWith(ORG, 'worker-a', {
			selfDir: process.cwd(),
		});
	});

	it('autoWake 关（缺省）：不唤醒，仅投递', async () => {
		await setupOrg();
		await dispatch();
		expect(ensureAwakeForDispatch).not.toHaveBeenCalled();
	});
});
