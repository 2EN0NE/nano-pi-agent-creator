/**
 * 看板成员简介（ADR-0042 D7 / ticket 07）—— headless snapshot 测试。
 *
 * 列表：简介缩略列在「名字+标签」与「目录」之间，20 显示列（≥100 列）/10 列（≥80 列）/隐藏（<80 列）；
 *       超出以 … 截断、空显示 (无)、目录列右端对齐。
 * 详情：`简介：` 折行显示全貌（不截断），空显示（未填写）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrg, joinOrg } from '../../../extensions/auto/org/orgstore.js';
import { OrgBoard } from '../../../extensions/auto/org/board.js';
import { makeMockTheme, stripAnsi } from '../../../src/tui-testing/index.js';
import { visibleWidth } from '@earendil-works/pi-tui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORG = 'dev-team';
const SHORT = '写解析器';
const LONG = '这是一个非常非常长的简介需要在列表里被截断而详情页里必须完整可见';

let root = '';
const chiefDir = join(tmpdir(), 'org-bp-chief');
const workerDir = join(tmpdir(), 'org-bp-wa');
const workerBDir = join(tmpdir(), 'org-bp-wb');

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'org-bp-'));
	process.env.ORG_ROOT = root;
	for (const d of [chiefDir, workerDir, workerBDir]) mkdirSync(d, { recursive: true });
	// chief 无简介（空显示 (无)）；worker-a 短简介；worker-b 长简介（必截断）
	await createOrg(ORG, { name: 'chief', dir: chiefDir });
	await joinOrg(ORG, {
		manifest: { name: 'worker-a', role: 'member', description: SHORT },
		dir: workerDir,
	});
	await joinOrg(ORG, {
		manifest: { name: 'worker-b', role: 'member', description: LONG },
		dir: workerBDir,
	});
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function mockTui() {
	return { requestRender: () => {}, setFocus: () => {} } as never;
}

async function makeBoard(): Promise<OrgBoard> {
	const board = new OrgBoard('chief', mockTui(), makeMockTheme() as never, () => {}, {});
	for (let i = 0; i < 120; i++) {
		if (!board.render(80).some((l) => l.includes('加载中'))) return board;
		await sleep(10);
	}
	throw new Error('看板加载超时');
}

/** 切到「成员」视角，返回去 ANSI 后的行 */
async function peopleLines(width: number): Promise<string[]> {
	const board = await makeBoard();
	board.handleInput('\u001b[C'); // 任务 → 成员
	return board.render(width).map(stripAnsi);
}

function rowOf(lines: string[], name: string): string {
	// 目录列用沙箱目录名定位（临时目录在 /var/folders 下，不会被 home 化成 ~/）
	const row = lines.find((l) => l.includes(name) && l.includes('org-bp-'));
	if (!row) throw new Error(`未找到 ${name} 的成员行；实际：\n${lines.join('\n')}`);
	return row;
}

describe('成员列表：简介缩略列（ADR-0042 D7）', () => {
	it('120 列：短简介完整、长简介截断、空简介显示 (无)', async () => {
		const lines = await peopleLines(120);
		expect(rowOf(lines, 'worker-a')).toContain(SHORT);
		// 截断列有界：保留开头、不出现全文（全貌只在详情页）
		expect(rowOf(lines, 'worker-b')).toContain('这是一个');
		expect(rowOf(lines, 'worker-b')).not.toContain(LONG);
		expect(rowOf(lines, 'chief')).toContain('(无)');
	});

	// 取两个**目录长度相同**的成员：目录列渲染一致 ⇒ 总宽一致 ⟺ 简介列是定宽列
	it('120 列：简介列是**定宽**列（长短简介的两行总宽一致）', async () => {
		const lines = await peopleLines(120);
		expect(visibleWidth(rowOf(lines, 'worker-a'))).toBe(visibleWidth(rowOf(lines, 'worker-b')));
	});

	it('100 列：缩略降到 10 列（短简介仍在，长简介仍截断）', async () => {
		const lines = await peopleLines(100);
		expect(rowOf(lines, 'worker-a')).toContain(SHORT);
		expect(rowOf(lines, 'worker-b')).toContain('这是一个');
		expect(rowOf(lines, 'worker-b')).not.toContain(LONG);
	});

	it('70 列：整列隐藏（既无 (无)、也无简介文字）', async () => {
		const lines = await peopleLines(70);
		expect(rowOf(lines, 'worker-b')).not.toContain('这是一个');
		expect(rowOf(lines, 'worker-a')).not.toContain(SHORT);
		expect(rowOf(lines, 'chief')).not.toContain('(无)');
	});

	it('80/100/120 列三档均不超宽，且目录列仍可见', async () => {
		for (const width of [80, 100, 120]) {
			const lines = await peopleLines(width);
			for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
			for (const name of ['chief', 'worker-a', 'worker-b']) {
				expect(rowOf(lines, name)).toContain('org-bp-');
			}
		}
	});
});

describe('成员详情：简介全貌（ADR-0042 D7）', () => {
	async function detailLines(name: string, width = 120): Promise<string[]> {
		const board = await makeBoard();
		board.handleInput('\u001b[C'); // 任务 → 成员
		// 光标移到目标成员行（成员序 = 加入序：chief、worker-a、worker-b）
		const order = ['chief', 'worker-a', 'worker-b'];
		for (let i = 0; i < order.indexOf(name); i++) board.handleInput('\u001b[B');
		board.handleInput('\r'); // 进详情
		return board.render(width).map(stripAnsi);
	}

	it('长简介在详情页完整可见（不截断）', async () => {
		const text = (await detailLines('worker-b')).join('\n');
		expect(text).toContain('简介：');
		// 折行会把长文切开 → 去掉换行后应包含全文
		expect(text.replace(/\n/g, '')).toContain(LONG.replace(/\n/g, ''));
	});

	it('短简介原样显示', async () => {
		const text = (await detailLines('worker-a')).join('\n');
		expect(text).toContain(`简介：${SHORT}`);
	});

	it('空简介显示（未填写）', async () => {
		const text = (await detailLines('chief')).join('\n');
		expect(text).toContain('简介：（未填写）');
	});

	it('详情页不超宽（含长简介折行）', async () => {
		for (const width of [80, 120]) {
			const lines = await detailLines('worker-b', width);
			for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
		}
	});
});
