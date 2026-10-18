/**
 * org 显式唤醒的**授权与门禁**（ADR-0048 `D3`–`D6`）— 命令面（`/org wake`）。
 *
 * 缺口背景（审查 P1）：`wakeForCaller`（工具与命令共用的唯一实现）此前零测试——
 * 门禁关 / 非负责人 / 不在组织等拒绝分支一旦回退，正是那次 UAT 的失败模式
 * （负责人既没派活也没唤醒、反而自行发明路径），而 CI 不会有任何信号。
 *
 * 口径：用 stub pi 驱动扩展工厂，仅桩掉 `lifecycle.wakeMember`（真实拉起 tmux 太重且不确定），
 * 断言**返回给调用方与人的文案**（`pi.sendMessage` 的 content）——文案本身就是 ADR-0048 `D6`
 * 要求的"据实回报 + 给出出路"。
 * 工具面（`org_wake`）与命令面共用同一实现，其**在岗可见性与真实调用**由 e2e 覆盖
 * （`test/e2e/extensions/org/smoke.test.sh` 用例 8 / 11）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 桩：仅替换 wakeMember，其余 lifecycle 导出保持真实（供 dispatch 等间接导入）──
const { wakeMemberMock, logger } = vi.hoisted(() => ({
	wakeMemberMock: vi.fn(),
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../extensions/auto/org/lifecycle.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../extensions/auto/org/lifecycle.js')>()),
	wakeMember: wakeMemberMock,
}));

// 日志桩：既降噪（不落盘），又用于断言 ADR-0048 D7 的门禁拒绝留痕
vi.mock('@zenone/pi-logger', () => ({ createLogger: () => logger }));

import ext from '../../../extensions/auto/org/index.js';
import { createOrg, joinOrg, setAutoWake } from '../../../extensions/auto/org/orgstore.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const ORG = 'dev-team';
const ORG_B = 'other-co';

let tmpRoot = '';
let origCwd = '';
let chiefDir = '';
let memberDir = '';
/** 命令面捕获：`pi.sendMessage({customType,content,display})` 的 content 序列 */
let sent: string[] = [];
let handler: (args: string, ctx: unknown) => Promise<void>;

function stubPi(): ExtensionAPI {
	const pi = {
		on: () => undefined,
		events: { on: () => undefined, emit: () => undefined },
		sendMessage: (msg: { content: string }) => {
			sent.push(msg.content);
		},
		registerCommand: (_name: string, def: { handler: typeof handler }) => {
			handler = def.handler;
		},
		registerTool: () => undefined,
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		registerProvider: () => undefined,
	} as unknown as ExtensionAPI;
	ext(pi);
	return pi;
}

/** 在 `dir` 写 agent manifest（身份 = 目录自述） */
function writeManifest(dir: string, name: string): void {
	writeFileSync(join(dir, 'pi.agent.json'), JSON.stringify({ name, role: 'member' }));
}

/** 切到 `dir` 执行一次命令，返回最后一轮 `respond` 文案 */
async function runCmd(dir: string, args: string): Promise<string> {
	process.chdir(dir);
	sent = [];
	await handler(args, { ui: { notify: () => undefined }, sessionManager: {} } as never);
	return sent.at(-1) ?? '';
}

beforeEach(async () => {
	tmpRoot = mkdtempSync(join(tmpdir(), 'org-wake-auth-'));
	origCwd = process.cwd();
	process.env.ORG_ROOT = join(tmpRoot, 'orgdata');
	chiefDir = join(tmpRoot, 'chief');
	memberDir = join(tmpRoot, 'member');
	mkdirSync(chiefDir, { recursive: true });
	mkdirSync(memberDir, { recursive: true });
	writeManifest(chiefDir, 'chief-1');
	writeManifest(memberDir, 'worker-a');
	await createOrg(ORG, { name: 'chief-1', dir: chiefDir });
	await joinOrg(ORG, { manifest: { name: 'worker-a', role: 'member' }, dir: memberDir });
	wakeMemberMock.mockReset();
	for (const l of ['info', 'warn', 'error', 'debug'] as const) logger[l].mockClear();
	stubPi();
});

afterEach(() => {
	process.chdir(origCwd);
	parkOrgRoot();
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe('/org wake — 门禁与权限（ADR-0048 D1/D5/D6）', () => {
	it('门禁关（autoWake 缺省关）：拒绝并给出两条出路，且**不调用** wakeMember', async () => {
		const out = await runCmd(chiefDir, 'wake worker-a');
		expect(out).toContain('未唤醒 worker-a');
		expect(out).toContain('自动唤醒');
		// 出路一：人去看板设置页；出路二：人对该成员当面按 w
		expect(out).toContain('设置页');
		expect(out).toContain('w');
		expect(wakeMemberMock).not.toHaveBeenCalled();
		// D7 留痕：拒绝也要留一行（否则排障只能靠日志缺失反推）
		expect(logger.info).toHaveBeenCalledWith('显式唤醒被拒：门禁关闭（autoWake 关）', {
			org: ORG,
			member: 'worker-a',
		});
	});

	it('非负责人：拒绝并说明权限边界与真正的负责人', async () => {
		await setAutoWake(ORG, true);
		const out = await runCmd(memberDir, 'wake chief-1');
		expect(out).toContain('唤醒权限限本 org 负责人');
		expect(out).toContain('chief-1');
		expect(wakeMemberMock).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith('显式唤醒被拒：非负责人', {
			org: ORG,
			member: 'chief-1',
			caller: 'worker-a',
		});
	});

	it('不在该组织：拒绝并说明（不静默隐藏能力）', async () => {
		await createOrg(ORG_B, { name: 'boss', dir: join(tmpRoot, 'boss') });
		const out = await runCmd(chiefDir, `wake ${ORG_B} worker-a`);
		expect(out).toContain('你不在组织');
		expect(out).toContain(ORG_B);
		expect(wakeMemberMock).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith(
			'显式唤醒被拒：调用者不在该组织',
			expect.objectContaining({ org: ORG_B, member: 'worker-a' }),
		);
	});

	it('缺成员名：回报用法', async () => {
		const out = await runCmd(chiefDir, 'wake');
		expect(out).toContain('用法：/org wake');
		expect(wakeMemberMock).not.toHaveBeenCalled();
	});
});

describe('/org wake — 允许路径的结果回报（ADR-0048 D3/D6）', () => {
	beforeEach(async () => {
		await setAutoWake(ORG, true);
	});

	it('已拉起：报「已唤醒」，并以 selfDir=调用者目录 传参', async () => {
		wakeMemberMock.mockResolvedValue({ started: true, sessionName: 'org-dev-team-worker-a' });
		const out = await runCmd(chiefDir, 'wake worker-a');
		expect(out).toContain('已唤醒 worker-a');
		// selfDir 以调用者当前目录为准（macOS /var → /private/var 软链，故与 process.cwd() 对齐比较）
		const [orgArg, memberArg, opts] = wakeMemberMock.mock.calls[0] as [
			string,
			string,
			{ selfDir: string },
		];
		expect([orgArg, memberArg]).toEqual([ORG, 'worker-a']);
		expect(opts.selfDir).toBe(process.cwd());
	});

	it('幂等（已在岗）：跳过并如实回报', async () => {
		wakeMemberMock.mockResolvedValue({ started: false, skipped: 'online' });
		expect(await runCmd(chiefDir, 'wake worker-a')).toContain('已在岗，无需唤醒');
	});

	it('幂等（正在拉起中）：跳过并如实回报', async () => {
		wakeMemberMock.mockResolvedValue({
			started: false,
			skipped: 'session-exists',
			sessionName: 'org-dev-team-worker-a',
		});
		expect(await runCmd(chiefDir, 'wake worker-a')).toContain('正在拉起中');
	});

	it('自我豁免：目标目录 == 调用者目录 → 拒绝并说明', async () => {
		wakeMemberMock.mockResolvedValue({
			started: false,
			skipped: 'self',
			error: '不能唤醒自己所在的目录（一目录 = 一员工）。',
		});
		expect(await runCmd(chiefDir, 'wake worker-a')).toContain('不能唤醒自己所在的目录');
	});

	it('拉起失败：回报原始原因（不吞错）', async () => {
		wakeMemberMock.mockResolvedValue({ started: false, error: '未找到 tmux' });
		const out = await runCmd(chiefDir, 'wake worker-a');
		expect(out).toContain('未唤醒 worker-a');
		expect(out).toContain('未找到 tmux');
	});
});
