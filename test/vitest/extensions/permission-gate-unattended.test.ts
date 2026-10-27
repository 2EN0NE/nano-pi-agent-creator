/**
 * permission-gate — 远端豁免模式（ADR-0068 D1/D2/D3）走**真实 handler** 的集成用例。
 *
 * 覆盖的是 `index.ts` 里新增的 armed 分支本身（判定函数由 `unattended-exempt.test.ts` 表驱动覆盖）：
 *   - 放行：审计写 `decision: 'allowed-unattended'` 且保留 tier / reasons / originalCommand
 *   - 拒绝：审计写 `decision: 'deny'` + `denyCause: 'unattended'`，`block.reason` 同时含
 *     「为什么」（note）与「怎样合理操作」（remedy）
 *   - 未生效（licensed-idle）：行为不变，仍走 no-UI 拦截（豁免不会被误开）
 *
 * HOME / cwd 全部隔离到临时目录，审计从磁盘读回（断言真实落盘，而不是内存快照）。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type AnyFn = (...args: unknown[]) => unknown;

interface AuditRow {
	decision: string;
	denyCause?: string;
	tier: string | null;
	reasons: string[];
	originalCommand?: string;
}

const ORIGINAL_HOME = process.env.HOME;

let root = '';
let home = '';
let cwd = '';

function auditDir(): string {
	return join(home, '.pi', 'agent', 'extensions-data', 'permission-gate', 'audit');
}

/** 从磁盘读回审计（审计是本次特性的可观测落点，必须断言真实文件内容） */
function readAuditRows(): AuditRow[] {
	const dir = auditDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith('.jsonl'))
		.flatMap((f) =>
			readFileSync(join(dir, f), 'utf8')
				.split('\n')
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as AuditRow),
		);
}

/** 加载 selector 闸门 + permission-gate，并按需要 arm；返回真实的 tool_call handler */
async function boot(opts: { armed: boolean }) {
	vi.resetModules();
	// 闸门状态挂 globalThis（跨模块实例共享），resetModules 清不掉，需显式清
	delete (globalThis as Record<string, unknown>).__piUnattendedState;

	const handlers = new Map<string, AnyFn[]>();
	const flags: Record<string, unknown> = {
		'unattended-confirm': true,
		'no-permission-gate': false,
	};
	const fakePi = {
		registerFlag(name: string, o: { default?: unknown }) {
			flags[name] ??= o.default;
		},
		getFlag(name: string) {
			return flags[name];
		},
		registerCommand() {},
		registerTool() {},
		on(event: string, handler: AnyFn) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	};

	// selector 先初始化：许可（flag）在工厂期就被读取，晚于它的 arm() 才有意义
	const selector = await import('@zenone/pi-selector');
	selector.initUnattended(fakePi as never);

	const pg = await import('../../../extensions/security/permission-gate/index');
	// 三层状态（放行计数 / 手动策略 / 审计）全部锚到临时目录：否则会读到本仓库自己的
	// `.pi/extensions-data/permission-gate/state.json`，让 tool:bash 计数达到阈值 →
	// 命令被动态策略直接 auto 放行，绕开本次要验证的 armed 分支。
	(await import('../../../extensions/security/permission-gate/approval-store')).resetRulesStore({
		homeDir: home,
		cwd,
	});
	(
		await import('../../../extensions/security/permission-gate/manual-strategies')
	).resetManualStrategiesStore({ homeDir: home, cwd });
	(await import('../../../extensions/security/permission-gate/audit-log')).resetAuditStore(home);
	(pg.default as (pi: unknown) => void)(fakePi);

	const ctx = {
		hasUI: false, // print/no-UI 场景：armed 分支先于 no-UI 拦截，正好覆盖新代码
		cwd,
		mode: 'print',
		ui: { notify: vi.fn(), setStatus: vi.fn(), custom: vi.fn() },
		sessionManager: {
			getSessionId: () => 'unattended-int-test',
			getSessionName: () => 'unattended-int-test',
			getEntries: () => [],
		},
	};

	for (const handler of handlers.get('before_agent_start') ?? []) {
		await handler({ type: 'before_agent_start' }, ctx);
	}
	for (const handler of handlers.get('session_start') ?? []) {
		await handler({ type: 'session_start', reason: 'startup' }, ctx);
	}
	if (opts.armed) {
		const disarm = selector.arm('int-test-channel');
		expect(disarm).toBeTypeOf('function');
	}

	const toolCall = handlers.get('tool_call')?.[0];
	expect(toolCall).toBeTypeOf('function');
	return { toolCall: toolCall as AnyFn, ctx };
}

function toolCallEvent(command: string) {
	return { type: 'tool_call', toolName: 'bash', input: { command } };
}

beforeEach(() => {
	// 每个用例独立 HOME + cwd：隔离用户级配置与审计目录
	root = mkdtempSync(join(tmpdir(), 'pg-unattended-'));
	home = join(root, 'home');
	cwd = join(root, 'project');
	mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.HOME = home;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
});

describe('permission-gate — armed 自动放行（cwd 内）', () => {
	it('放行并写 decision=allowed-unattended（保留 tier/reasons/originalCommand）', async () => {
		mkdirSync(join(cwd, '.scratch', 'tmp'), { recursive: true });
		const command = 'rm -rf .scratch/tmp';
		const { toolCall, ctx } = await boot({ armed: true });

		const result = await toolCall(toolCallEvent(command), ctx);
		expect(result).toBeUndefined(); // 放行 = 不 block

		const row = readAuditRows().find((r) => r.originalCommand === command);
		expect(row).toBeDefined();
		expect(row?.decision).toBe('allowed-unattended');
		expect(row?.tier).toBe('critical');
		expect(row?.reasons.length).toBeGreaterThan(0);
	});
});

describe('permission-gate — armed 但无法证明在 cwd 内', () => {
	it('拒绝并写 deny+denyCause=unattended，block.reason 含为什么与怎样合理操作', async () => {
		const command = 'rm -rf /tmp/pg-unattended-outside-probe';
		const { toolCall, ctx } = await boot({ armed: true });

		const result = (await toolCall(toolCallEvent(command), ctx)) as {
			block?: boolean;
			reason?: string;
		};
		expect(result.block).toBe(true);
		// note（为什么）+ remedy（怎样合理操作）都必须回给模型，且指向本次的 cwd
		expect(result.reason).toContain('为什么：');
		expect(result.reason).toContain('怎样合理操作：');
		expect(result.reason).toContain(ctx.cwd);

		const row = readAuditRows().find((r) => r.originalCommand === command);
		expect(row).toMatchObject({ decision: 'deny', denyCause: 'unattended' });
	});
});

describe('permission-gate — 豁免未生效（licensed-idle）', () => {
	it('行为不变：同一命令仍走 no-UI 拦截，不写 allowed-unattended', async () => {
		const command = 'rm -rf .scratch/tmp';
		const { toolCall, ctx } = await boot({ armed: false });

		const result = (await toolCall(toolCallEvent(command), ctx)) as {
			block?: boolean;
			reason?: string;
		};
		expect(result.block).toBe(true);
		expect(result.reason).toContain('no UI');

		const rows = readAuditRows();
		const row = rows.find((r) => r.originalCommand === command);
		expect(row?.decision).toBe('blocked-no-ui');
		expect(rows.some((r) => r.decision === 'allowed-unattended')).toBe(false);
	});
});
