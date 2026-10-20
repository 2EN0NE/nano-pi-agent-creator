/**
 * 在岗判定（ADR-0041 D1 → **修订：ADR-0043 D2**）。
 *
 * 在岗 = 该 cwd 已注册 org（由调用方判定）**且** 本会话真的能被成员消息触达：
 * 判据是 control 建立的控制 socket **可连**（物理真相）。
 *
 * 旧实现查 `--session-control` argv——它只表示「启动时请求建 socket」，
 * 而且 `getFlag` 按扩展隔离（org 读 control 注册的 flag 恒为 undefined），
 * 与「socket 真的建成了」并不等价。本文件覆盖新的进程侧判据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeServers, listenFakeControl } from './org-lifecycle-helpers.js';
import {
	CONTROL_SOCKET_EVENT,
	decideDutyAction,
	dutyState,
	isSelfOnDuty,
	offDutyReason,
	offDutyStatusText,
	onDutyRefusal,
	selfSocketPath,
} from '../../../extensions/auto/org/onduty.js';
import { CONTROL_SOCKET_CHANNEL } from '../../../extensions/auto/control/switch.js';

// os.homedir() 在**调用时**读 $HOME → 用临时 HOME 隔离 socket 目录，避免写真实 ~/.pi。
// 注意用 **短** 路径（/tmp/...）：macOS 的 unix socket 路径上限约 104 字符，
// 而 os.tmpdir() 在 macOS 是长长的 /var/folders/...（listen 会 EINVAL）。
const realHome = process.env.HOME;
let home = '';

beforeAll(() => {
	home = mkdtempSync('/tmp/org-on-');
	process.env.HOME = home;
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

describe('selfSocketPath', () => {
	it('与 control 的 socket 约定同路径：<home>/.pi/session-control/<sessionId>.sock', () => {
		expect(selfSocketPath('abc')).toBe(join(home, '.pi', 'session-control', 'abc.sock'));
	});
});

describe('isSelfOnDuty（判据 = socket 真的可连）', () => {
	it('socket 在监听 → 在岗', async () => {
		const p = selfSocketPath('sess-live');
		mkdirSync(dirname(p), { recursive: true });
		const server = await listenFakeControl(p);
		try {
			expect(await isSelfOnDuty('sess-live')).toBe(true);
		} finally {
			await closeServers([server]);
		}
	});

	it('socket 不存在（即使 argv 带 --session-control）→ 不在岗', async () => {
		expect(await isSelfOnDuty('sess-gone')).toBe(false);
	});

	it('socket 曾存在但已关闭 → 不在岗（离岗后立刻反映）', async () => {
		const p = selfSocketPath('sess-closed');
		mkdirSync(dirname(p), { recursive: true });
		const server = await listenFakeControl(p);
		expect(await isSelfOnDuty('sess-closed')).toBe(true);
		await closeServers([server]);
		expect(await isSelfOnDuty('sess-closed')).toBe(false);
	});

	it('空 sessionId → 不在岗（不猜路径）', async () => {
		expect(await isSelfOnDuty('')).toBe(false);
	});
});

describe('offDutyReason', () => {
	it('说明原因**并给出进入在岗的方法**（可发现性：ADR-0043 D3 / ADR-0045 L4）', () => {
		const r = offDutyReason();
		expect(r).toContain('--session-control');
		expect(r).toContain('/control on');
	});
});

describe('CONTROL_SOCKET_EVENT 契约（防漂移）', () => {
	it('与 control 的 CONTROL_SOCKET_CHANNEL 同名——否则 /control on|off 热切换静默失效', () => {
		// org 与 control 各自本地持有字面量（避免加载期硬依赖），靠本契约测试锁住一致。
		expect(CONTROL_SOCKET_EVENT).toBe(CONTROL_SOCKET_CHANNEL);
	});
});

describe('在岗三态（ADR-0046 D2）', () => {
	it('在岗实况优先：已上岗即 on（无论必要条件缓存如何）', () => {
		expect(dutyState({ onDuty: true, socketUp: true })).toBe('on');
		expect(dutyState({ onDuty: true, socketUp: false })).toBe('on');
	});

	it('未上岗时按必要条件分「可上岗 / 不可上岗」', () => {
		expect(dutyState({ onDuty: false, socketUp: true })).toBe('eligible');
		expect(dutyState({ onDuty: false, socketUp: false })).toBe('unavailable');
	});
});

describe('未上岗状态栏文案（ADR-0046 D2：状态 + 出路）', () => {
	it('未加入任何 org → 指路建/加入组织', () => {
		const t = offDutyStatusText({ orgCount: 0, socketUp: false });
		expect(t).toContain('未加入');
		expect(t).toContain('/org create');
	});

	it('可上岗未上岗 → 「待上岗」并给出上岗动作', () => {
		const t = offDutyStatusText({ orgCount: 1, socketUp: true });
		expect(t).toContain('待上岗');
		expect(t).toContain('/org on');
	});

	it('不可上岗 → 「未连接」并给出必要条件动作', () => {
		const t = offDutyStatusText({ orgCount: 1, socketUp: false });
		expect(t).toContain('未连接');
		expect(t).toContain('/control on');
	});

	it('纯文本 + `|` 前缀（样式规范，且不得含双宽 emoji）', () => {
		for (const t of [
			offDutyStatusText({ orgCount: 0, socketUp: false }),
			offDutyStatusText({ orgCount: 1, socketUp: true }),
			offDutyStatusText({ orgCount: 1, socketUp: false }),
		]) {
			expect(t.startsWith('|')).toBe(true);
			expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)).toBe(false);
		}
	});
});

describe('socket 广播 → 在岗动作（ADR-0046 D1/D2/D4）', () => {
	it('运行中人工 /control on（origin=runtime）**不自动上岗** —— control 对 org 的驱动已解除', () => {
		expect(decideDutyAction({ enabled: true, origin: 'runtime' }, false)).toBe('stay');
	});

	it('启动意图（origin=startup）且未上岗 → 自动上岗（保留启动便利，B5）', () => {
		expect(decideDutyAction({ enabled: true, origin: 'startup' }, false)).toBe('go-on-duty');
	});

	it('启动意图但已在岗 → 幂等不动', () => {
		expect(decideDutyAction({ enabled: true, origin: 'startup' }, true)).toBe('stay');
	});

	it('必要条件丢失且在岗 → 强制回落（ADR-0046 D2）', () => {
		expect(decideDutyAction({ enabled: false, origin: 'runtime' }, true)).toBe('go-off-duty');
	});

	it('必要条件丢失且未在岗 → 只需刷新状态栏，不动在岗状态', () => {
		expect(decideDutyAction({ enabled: false, origin: 'runtime' }, false)).toBe('stay');
	});

	it('缺 origin 字段 → 按 runtime 处理（保守：不自动上岗）', () => {
		expect(decideDutyAction({ enabled: true }, false)).toBe('stay');
	});
});

describe('/org on 的受理判定（ADR-0046 D3：拒绝必给出路）', () => {
	it('未加入 org → 指路 create / join', () => {
		const r = onDutyRefusal({ orgCount: 0, socketUp: true });
		expect(r).toContain('/org create');
	});

	it('必要条件缺失 → 同时给出 /control on 与 /org on 两步', () => {
		const r = onDutyRefusal({ orgCount: 1, socketUp: false });
		expect(r).toContain('/control on');
		expect(r).toContain('/org on');
	});

	it('可上岗 → 放行（null）', () => {
		expect(onDutyRefusal({ orgCount: 1, socketUp: true })).toBeNull();
	});
});
