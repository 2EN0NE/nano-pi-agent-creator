/**
 * org 看板 — 所属组织区分 / tab 排序 / 在岗计数（ADR-0070 D1–D8）
 *
 * 覆盖用户可见行为：
 * - **01** 面板落到「我的组织」：默认 tab = 所属中最近派活那家；所属段在前、段内按最近派活倒序
 * - **01** 排序键变化导致重排时，当前查看的 org 按**名字**跟住（不跳别家）
 * - **02** 视觉：所属 muted / 非所属 dim；两段之间有 `│`；无所属时整排 dim + 一行尾注（单 org 也是）
 * - **03** 每个 tab 带单格盲文点阵 = 该 org 在岗人数；当前 org 走权威判据、其余走廉价 pid 判据
 *
 * 只 mock 文件系统（临时 ORG_ROOT/HOME 与临时成员目录），Pi API 全不涉及——看板是纯 TUI 组件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrg, joinOrg } from '../../../extensions/auto/org/orgstore.js';
import { createTaskWithId } from '../../../extensions/auto/org/task.js';
import { OrgBoard } from '../../../extensions/auto/org/board.js';
import { makeMockTheme, stripAnsi } from '../../../src/tui-testing/index.js';
import { writeRuntimeFile } from './org-lifecycle-helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = '';
let dirs: string[] = [];

function mockTui() {
	return { requestRender: () => {}, setFocus: () => {} } as any;
}

/** 记录 theme.fg 的调用（断言"哪段文字取了哪个 token"） */
function probeTheme() {
	const calls: { color: string; text: string }[] = [];
	return {
		calls,
		theme: {
			fg: (color: string, text: string) => {
				calls.push({ color, text });
				return text;
			},
			bold: (t: string) => t,
			bg: (_c: string, t: string) => t,
		},
	};
}

/** 建一个 org（负责人目录 = 该 org 专属临时目录） */
async function makeOrg(name: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	await createOrg(name, { name: 'chief', dir });
	return dir;
}

/** 往某 org 派一条任务（`createdAt` 显式给值 = 控制"最近派活"排序键） */
async function dispatchAt(org: string, createdAt: string, title = 't') {
	await createTaskWithId(org, {
		org,
		title,
		background: '',
		items: [],
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		createdAt,
		status: 'todo',
		subTasks: [{ id: 'S1', description: 's', dueAt: null, assignees: [] }],
		history: [],
	} as never);
}

async function makeBoard(ownOrgs: string[], theme?: unknown) {
	const board = new OrgBoard(
		'chief',
		mockTui(),
		(theme ?? makeMockTheme()) as never,
		() => {},
		{},
		ownOrgs,
	);
	for (let i = 0; i < 120; i++) {
		const lines = board.render(80);
		if (!lines.some((l) => l.includes('加载中'))) return board;
		await sleep(10);
	}
	return board;
}

/** org tab 行 = 含盲文点阵的那一行（chip 形状 `[ 名字 ⠀ ]`），避免误取视角 tab 行 */
const tabLine = (board: OrgBoard, w = 80) =>
	stripAnsi(board.render(w).find((l) => /[\u2800-\u28ff]/.test(stripAnsi(l))) ?? '');
const titleLine = (board: OrgBoard, w = 80) => stripAnsi(board.render(w)[0] ?? '');
const joined = (board: OrgBoard, w = 80) => stripAnsi(board.render(w).join('\n'));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'org-board-own-'));
	mkdirSync(join(root, 'home'), { recursive: true });
	dirs = [];
	process.env.ORG_ROOT = join(root, 'orgdata');
	process.env.HOME = join(root, 'home');
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	parkOrgRoot();
});

describe('01 tab 排序：所属段在前、段内按最近派活倒序', () => {
	it('默认落点 = 所属中最近派活的那家（不是字母序第一）', async () => {
		await makeOrg('aaa-other');
		await makeOrg('zzz-mine');
		await dispatchAt('aaa-other', '2026-10-10T00:00:00.000Z');
		await dispatchAt('zzz-mine', '2026-10-01T00:00:00.000Z');

		const board = await makeBoard(['zzz-mine']);
		// 所属只有 zzz-mine（即使它派活更早、字母序更靠后）→ 仍默认落在它
		expect(titleLine(board)).toContain('── org:zzz-mine');
	});

	it('所属段在前、非所属段在后；段内按派活倒序', async () => {
		await makeOrg('aaa-mine-old');
		await makeOrg('bbb-other');
		await makeOrg('ccc-mine-new');
		await dispatchAt('aaa-mine-old', '2026-10-01T00:00:00.000Z');
		await dispatchAt('bbb-other', '2026-10-20T00:00:00.000Z');
		await dispatchAt('ccc-mine-new', '2026-10-10T00:00:00.000Z');

		const board = await makeBoard(['aaa-mine-old', 'ccc-mine-new']);
		const line = tabLine(board);
		// 所属段：ccc-mine-new（10-10）> aaa-mine-old（10-01）；非所属：bbb-other
		expect(line.indexOf('ccc-mine-new')).toBeLessThan(line.indexOf('aaa-mine-old'));
		expect(line.indexOf('aaa-mine-old')).toBeLessThan(line.indexOf('bbb-other'));
	});

	it('排序键变化导致重排时，当前查看的 org 按名字跟住（不跳别家）', async () => {
		await makeOrg('aaa');
		await makeOrg('ccc');
		await dispatchAt('aaa', '2026-10-05T00:00:00.000Z');
		await dispatchAt('ccc', '2026-10-01T00:00:00.000Z');

		// 两家都所属 → 所属段内按派活倒序：aaa（10-05）在前，故默认看 aaa
		const board = await makeBoard(['aaa', 'ccc']);
		expect(titleLine(board)).toContain('── org:aaa');

		// 别家（ccc）来了更新的派活 → 顺序变成 ccc, aaa
		await dispatchAt('ccc', '2026-10-30T00:00:00.000Z');
		board.handleInput('r'); // 全量刷新（重算排序键 + 重排）
		for (let i = 0; i < 120; i++) {
			if (tabLine(board).indexOf('ccc') < tabLine(board).indexOf('aaa')) break;
			await sleep(10);
		}
		expect(tabLine(board).indexOf('ccc')).toBeLessThan(tabLine(board).indexOf('aaa'));
		// 关键断言：屏幕仍停在同一家（按名字跟住），没有被下标平移换到别家
		expect(titleLine(board)).toContain('── org:aaa');
	});
});

describe('02 视觉区分：所属 muted / 非所属 dim / 分段 / 尾注', () => {
	it('两段之间有分隔符 `│`，且无所属时不画', async () => {
		await makeOrg('mine');
		await makeOrg('other');
		const board = await makeBoard(['mine']);
		expect(tabLine(board)).toContain('│');

		const noOwn = await makeBoard([]);
		expect(tabLine(noOwn)).not.toContain('│');
	});

	it('非所属 tab 的文字取 dim，所属取 muted（当前 tab 取 accent）', async () => {
		await makeOrg('mine');
		await makeOrg('other');
		const probe = probeTheme();
		const board = await makeBoard(['mine'], probe.theme);
		board.render(80);
		expect(probe.calls.some((c) => c.color === 'dim' && c.text.includes('other'))).toBe(true);
		expect(probe.calls.some((c) => c.color === 'accent' && c.text.includes('mine'))).toBe(true);
	});

	it('无所属：整排 dim + 一行尾注（多 org）', async () => {
		await makeOrg('alpha');
		await makeOrg('beta');
		const probe = probeTheme();
		const board = await makeBoard([], probe.theme);
		expect(joined(board)).toContain('本目录未加入任何组织');
		// 所属为空 → 两枚 chip 的名字段都取 dim
		// 四态矩阵里这一格：alpha 是**当前** tab（accent），beta 是非当前非所属（dim）
		expect(probe.calls.some((c) => c.color === 'accent' && c.text.includes('alpha'))).toBe(
			true,
		);
		expect(probe.calls.some((c) => c.color === 'dim' && c.text.includes('beta'))).toBe(true);
	});

	it('无所属且**只有一个** org 时也给尾注（旧行为是零提示）', async () => {
		await makeOrg('solo');
		const board = await makeBoard([]);
		const text = joined(board);
		expect(text).toContain('本目录未加入任何组织');
		// 单 org 仍不渲染 tab 行（不造"只有一个 tab 的假 tab 栏"）
		expect(text).not.toContain('[ solo');
	});

	it('单 org 且属于我：不显示尾注', async () => {
		await makeOrg('solo');
		const board = await makeBoard(['solo']);
		expect(joined(board)).not.toContain('本目录未加入任何组织');
	});
});

describe('03 tab 上的在岗人数（盲文点阵）', () => {
	it('无人在岗 = 空白盲符（U+2800），chip 形状稳定', async () => {
		await makeOrg('alpha');
		await makeOrg('beta');
		const board = await makeBoard([]);
		expect(tabLine(board)).toMatch(/\[ alpha \u2800 \]/);
		expect(tabLine(board)).toMatch(/\[ beta \u2800 \]/);
	});

	it('**其余 org** 走廉价 pid 判据：runtime 在且 pid 存活即算在岗（点阵 ⠁）', async () => {
		await makeOrg('alpha'); // 当前 org（idxs 首位）→ 走权威判据
		const dirB = await makeOrg('beta'); // 非当前 → 走廉价判据
		await joinOrg('beta', { manifest: { name: 'w1', role: 'member' }, dir: dirB }).catch(
			() => {},
		);
		// socket 故意不可连：廉价判据只看 pid，这正是 ADR-0070 D7 接受的精度损失
		await writeRuntimeFile('beta', 'w1', {
			pid: process.pid,
			socketPath: join(root, 'no-such.sock'),
		});
		const board = await makeBoard([]);
		expect(tabLine(board)).toMatch(/\[ beta \u2801 \]/);
		expect(tabLine(board)).toMatch(/\[ alpha \u2800 \]/);
	});

	it('**当前 org** 走权威判据：socket 不可连 → 即使 pid 存活也算 0', async () => {
		const dirA = await makeOrg('alpha'); // 当前 org
		await makeOrg('beta');
		await joinOrg('alpha', { manifest: { name: 'w1', role: 'member' }, dir: dirA }).catch(
			() => {},
		);
		await writeRuntimeFile('alpha', 'w1', {
			pid: process.pid,
			socketPath: join(root, 'no-such.sock'),
		});
		const board = await makeBoard([]);
		// 与上一条同样的 runtime 形状，只因"是不是当前 org"得出相反结论
		expect(tabLine(board)).toMatch(/\[ alpha \u2800 \]/);
	});
});

/** 进设置视角并把光标挪到指定行（同 org.board.test.ts 的 gotoSettingsRow） */
async function gotoSettingsRow(board: OrgBoard, label: string): Promise<void> {
	board.handleInput('\u001b[C'); // → 成员
	board.handleInput('\u001b[C'); // → 设置
	const selLine = () =>
		board
			.render(100)
			.map(stripAnsi)
			.find((l) => l.startsWith('>')) ?? '';
	for (let i = 0; i < 12; i++) {
		if (selLine().includes(label)) return;
		board.handleInput('\u001b[B');
	}
	throw new Error(`设置页未找到行「${label}」`);
}

/** 等到条件成立（异步动作完成后才会落盘/重排） */
async function waitFor(fn: () => boolean): Promise<void> {
	for (let i = 0; i < 120; i++) {
		if (fn()) return;
		await sleep(15);
	}
}

describe('04 面板内变更所属：新建 / 改名后 own 立刻生效', () => {
	it('新建公司（cwd 成为负责人）后：尾注消失，新组织进所属段', async () => {
		await makeOrg('alpha');
		const board = await makeBoard([]);
		expect(joined(board)).toContain('本目录未加入任何组织'); // 初始：本目录不属于任何组织

		await gotoSettingsRow(board, '新建公司');
		board.handleInput('\r'); // → 输入屏
		for (const ch of 'my-new-org') board.handleInput(ch);
		board.handleInput('\r'); // 创建（cwd 登记为负责人 = 所属）

		await waitFor(() => !joined(board).includes('本目录未加入任何组织'));
		const text = joined(board);
		expect(text).not.toContain('本目录未加入任何组织');
		expect(titleLine(board)).toContain('── org:my-new-org');
		// 所属段在前：新组织排在非所属的 alpha 之前，且两段之间有分界符
		const line = tabLine(board);
		expect(line).toContain('│');
		expect(line.indexOf('my-new-org')).toBeLessThan(line.indexOf('alpha'));
	});

	it('改名当前组织后：own 跟着新名字走（不退化成非所属）', async () => {
		// 成员目录 = cwd，才能用真实判据（findOrgsForDir）验证改名后的所属
		await createOrg('mine', { name: 'chief', dir: process.cwd() });
		await makeOrg('alpha');
		const board = await makeBoard(['mine']);
		expect(joined(board)).not.toContain('本目录未加入任何组织');

		await gotoSettingsRow(board, '重命名公司');
		board.handleInput('\r'); // → 输入屏（预填当前名）
		for (let i = 0; i < 'mine'.length; i++) board.handleInput('\u007f'); // 清空预填
		for (const ch of 'renamed') board.handleInput(ch);
		board.handleInput('\r'); // 改名

		await waitFor(() => joined(board).includes('org:renamed'));
		const text = joined(board);
		expect(text).toContain('org:renamed');
		expect(text).not.toContain('本目录未加入任何组织'); // 改名不该丢掉"所属"
		const line = tabLine(board);
		expect(line).toContain('│');
		expect(line.indexOf('renamed')).toBeLessThan(line.indexOf('alpha'));
	});
});
