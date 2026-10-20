/**
 * 组织背景（`org.json:background`）—— ADR-0042 D5 / ticket 02。
 *
 * 覆盖：存储层读写与清除；看板设置页的「组织背景（本组织）」行 → 输入态（预填当前值）
 * → 保存 / 清空 / Esc 取消。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrg, readOrg, setBackground } from '../../../extensions/auto/org/orgstore.js';
import { OrgBoard } from '../../../extensions/auto/org/board.js';
import { makeMockTheme, stripAnsi } from '../../../src/tui-testing/index.js';
import { visibleWidth } from '@earendil-works/pi-tui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORG = 'dev-team';

let root = '';
const chiefDir = join(tmpdir(), 'org-bg-chief');

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'org-bg-'));
	process.env.ORG_ROOT = root;
	mkdirSync(chiefDir, { recursive: true });
	await createOrg(ORG, { name: 'chief', dir: chiefDir });
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
		const lines = board.render(80);
		if (!lines.some((l) => l.includes('加载中'))) return board;
		await sleep(10);
	}
	throw new Error('看板加载超时');
}

/** 进入设置视角并把光标移到指定标签行（按标签定位，避免索引写死） */
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

describe('setBackground（存储层）', () => {
	it('写入后可读回', async () => {
		await setBackground(ORG, '做目录绑定的多 agent 协作');
		expect((await readOrg(ORG)).background).toBe('做目录绑定的多 agent 协作');
	});

	it('前后空白被裁剪', async () => {
		await setBackground(ORG, '  背景  ');
		expect((await readOrg(ORG)).background).toBe('背景');
	});

	it('空串 / 全空白 = 清除该字段（不是留空串）', async () => {
		await setBackground(ORG, '有内容');
		await setBackground(ORG, '   ');
		expect('background' in (await readOrg(ORG))).toBe(false);
	});

	it('不破坏同文件的其它字段', async () => {
		await setBackground(ORG, '背景');
		const org = await readOrg(ORG);
		expect(org.name).toBe(ORG);
		expect(org.members.map((m) => m.name)).toContain('chief');
	});
});

describe('看板「组织背景」输入态', () => {
	it('设置页有该行；未填写时摘要提示未填写', async () => {
		const board = await makeBoard();
		await gotoSettingsRow(board, '组织背景');
		expect(stripAnsi(board.render(100).join('\n'))).toContain('（未填写）');
	});

	it('Enter 进入输入态并预填当前值（编辑心智 §3.3）', async () => {
		await setBackground(ORG, '当前背景');
		const board = await makeBoard();
		await gotoSettingsRow(board, '组织背景');
		board.handleInput('\r');
		const text = stripAnsi(board.render(100).join('\n'));
		expect(text).toContain('组织背景（本组织：dev-team）');
		expect(text).toContain('当前背景');
	});

	it('追加输入后 Enter 保存 → 落盘', async () => {
		const board = await makeBoard();
		await gotoSettingsRow(board, '组织背景');
		board.handleInput('\r');
		for (const ch of '多agent') board.handleInput(ch);
		board.handleInput('\r');
		await sleep(30);
		expect((await readOrg(ORG)).background).toBe('多agent');
	});

	it('预填值全删后 Enter = 清除该字段', async () => {
		await setBackground(ORG, '待清除');
		const board = await makeBoard();
		await gotoSettingsRow(board, '组织背景');
		board.handleInput('\r');
		for (let i = 0; i < '待清除'.length; i++) board.handleInput('\u007f');
		board.handleInput('\r');
		await sleep(30);
		expect('background' in (await readOrg(ORG))).toBe(false);
	});

	it('Esc 取消不写盘', async () => {
		await setBackground(ORG, '原值');
		const board = await makeBoard();
		await gotoSettingsRow(board, '组织背景');
		board.handleInput('\r');
		board.handleInput('X');
		board.handleInput('\u001b');
		await sleep(30);
		expect((await readOrg(ORG)).background).toBe('原值');
		// 回到设置列表（不再是输入态）
		expect(stripAnsi(board.render(100).join('\n'))).not.toContain('背景：');
	});

	it('超长背景折行渲染且不超宽', async () => {
		await setBackground(ORG, '背景'.repeat(80));
		const board = await makeBoard();
		await gotoSettingsRow(board, '组织背景');
		board.handleInput('\r');
		const lines = board.render(80);
		for (const l of lines) {
			// 每行都不超过终端宽度（含 CJK 双宽，须用 visibleWidth 而非 .length）
			expect(visibleWidth(l)).toBeLessThanOrEqual(80);
		}
	});
});
