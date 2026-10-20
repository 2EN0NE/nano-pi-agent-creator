/**
 * 收件箱消化（ADR-0054 `D5`/`D7`/`D10`/`D11`）
 *
 * 三条硬约束（本文件即回归网）：
 *   ① 先注入成功、再删除——注入失败时消息必须仍在（旧实现 takeInbox 先删 → 注入失败即永久丢失）；
 *   ② 同一 id 不重复注入（注入过但没删掉的只补 ack）；
 *   ③ 同一完成事件（`[evt:...]`）的重复投递不重复喂给模型。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	ackInbox,
	formatInboxContent,
	hasFreshInbox,
	peekInbox,
	planContent,
	planInboxFlush,
	flushInbox,
	commitInboxFlush,
	writeInboxState,
} from '../../../extensions/auto/org/inbox.js';
import { inboxDir, inboxStateFile } from '../../../extensions/auto/org/orgstore.js';

const ORG = 'dev-team';
const ME = 'worker-a';
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'org-inbox-'));
	process.env.ORG_ROOT = root;
	mkdirSync(inboxDir(ORG, ME), { recursive: true });
});

afterEach(() => {
	parkOrgRoot();
	rmSync(root, { recursive: true, force: true });
});

function put(id: string, message: string): void {
	writeFileSync(
		join(inboxDir(ORG, ME), `${id}.json`),
		JSON.stringify({ at: '2026-09-14T00:00:00.000Z', message }),
	);
}

describe('peek / ack（只读与显式清理分离）', () => {
	it('peek 不删除文件，ack 才删', async () => {
		put('msg-1', '第一条');
		put('msg-2', '第二条');
		const recs = await peekInbox(ORG, ME);
		expect(recs.map((r) => r.id)).toEqual(['msg-1', 'msg-2']);
		expect(await peekInbox(ORG, ME)).toHaveLength(2); // 仍在
		expect(await ackInbox(ORG, ME, ['msg-1'])).toBe(1);
		expect((await peekInbox(ORG, ME)).map((r) => r.id)).toEqual(['msg-2']);
	});

	it('ack 不存在的 id 不报错（幂等）', async () => {
		expect(await ackInbox(ORG, ME, ['nope'])).toBe(0);
	});
});

describe('D11：先注入成功、再删除', () => {
	it('注入失败 → 消息全部保留（不得出现"删了但没送到"）', async () => {
		put('msg-1', '重要任务');
		const res = await flushInbox(ORG, ME, { inject: () => false, reason: 'test' });
		expect(res.failed).toBe(true);
		expect(res.injected).toBe(0);
		expect(await peekInbox(ORG, ME)).toHaveLength(1);
	});

	it('注入成功 → 记账并删除', async () => {
		put('msg-1', '重要任务');
		let seen = '';
		const res = await flushInbox(ORG, ME, {
			inject: (c) => {
				seen = c;
				return true;
			},
		});
		expect(res.injected).toBe(1);
		expect(seen).toContain('重要任务');
		expect(seen).toContain('[msg:msg-1]');
		expect(await peekInbox(ORG, ME)).toHaveLength(0);
	});
});

describe('D7：同一 id 不重复注入', () => {
	it('已注入过的记录只补 ack，不再喂给模型', async () => {
		put('msg-1', '任务甲');
		const first = await flushInbox(ORG, ME, { inject: () => true });
		expect(first.injected).toBe(1);
		// 模拟"注入成功但上次没删掉"：重建同名记录
		put('msg-1', '任务甲');
		let injectedAgain = 0;
		const second = await flushInbox(ORG, ME, {
			inject: () => {
				injectedAgain += 1;
				return true;
			},
		});
		expect(second.injected).toBe(0);
		expect(second.replayed).toBe(1);
		expect(injectedAgain).toBe(0);
		expect(await peekInbox(ORG, ME)).toHaveLength(0);
	});

	it('未注入过的新记录仍会被注入', async () => {
		put('msg-1', '任务甲');
		await flushInbox(ORG, ME, { inject: () => true });
		put('msg-2', '任务乙');
		const res = await flushInbox(ORG, ME, { inject: () => true });
		expect(res.injected).toBe(1);
	});
});

describe('D10：完成事件的重复投递去重', () => {
	it('同一 [evt:id] 的第二份投递不再注入', async () => {
		put('msg-1', '[evt:task-1:S-1:delivered] 交付了 A');
		await flushInbox(ORG, ME, { inject: () => true });
		put('msg-2', '[evt:task-1:S-1:delivered] 交付了 A（另一路投递）');
		const res = await flushInbox(ORG, ME, { inject: () => true });
		expect(res.injected).toBe(0);
		expect(res.deduped).toBe(1);
	});
});

describe('多成员聚合（ADR-0054 D3：只触发一次）', () => {
	it('plan 汇总全部成员，content 带归属前缀', async () => {
		mkdirSync(inboxDir(ORG, 'worker-b'), { recursive: true });
		put('msg-1', '给 A 的任务');
		writeFileSync(
			join(inboxDir(ORG, 'worker-b'), 'msg-9.json'),
			JSON.stringify({ at: '2026-09-14T00:00:00.000Z', message: '给 B 的任务' }),
		);
		const plan = await planInboxFlush([
			{ org: ORG, agent: ME },
			{ org: ORG, agent: 'worker-b' },
		]);
		expect(plan.total).toBe(2);
		const content = planContent(plan);
		expect(content).toContain('给 A 的任务');
		expect(content).toContain('给 B 的任务');
		// 未提交前不得删除（先算后写）
		expect(await peekInbox(ORG, ME)).toHaveLength(1);
		await commitInboxFlush(plan);
		expect(await peekInbox(ORG, ME)).toHaveLength(0);
	});
});

describe('内容可见（D5）', () => {
	it('清单带 id，超条数上限时如实标注剩余', async () => {
		put('msg-1', 'a');
		put('msg-2', 'b');
		put('msg-3', 'c');
		const text = formatInboxContent(await peekInbox(ORG, ME), { maxItems: 2 });
		expect(text).toContain('[msg:msg-1]');
		expect(text).toContain('另 1 条');
	});

	it('超内容上限的消息留在收件箱、下一批补投（D5/D11：渲染集 = ack 集，不得静默丢失）', async () => {
		for (let i = 1; i <= 8; i++) put(`msg-${i}`, `第 ${i} 条`);
		let firstSeen = '';
		const first = await flushInbox(ORG, ME, {
			inject: (c) => {
				firstSeen = c;
				return true;
			},
		});
		// 内容上限（5）条注入并 ack；其余 3 条**必须还在收件箱**。
		// 旧实现「展示前 5 条、ack 全部 8 条」会让 3 条从未进入上下文就被删除（静默丢失）。
		expect(first.injected).toBe(5);
		expect(first.acked).toBe(5);
		expect(await peekInbox(ORG, ME)).toHaveLength(3);
		expect(firstSeen).toContain('[msg:msg-5]');
		expect(firstSeen).not.toContain('[msg:msg-6]');
		expect(firstSeen).toContain('另有 3 条留在收件箱');

		// 下一批把剩下的 3 条补投，收件箱归零
		const second = await flushInbox(ORG, ME, { inject: () => true });
		expect(second.injected).toBe(3);
		expect(await peekInbox(ORG, ME)).toHaveLength(0);
	});

	it('hasFreshInbox：全部已注入过时为假（自愈不再反复触发）', async () => {
		put('msg-1', 'x');
		expect(await hasFreshInbox(ORG, ME)).toBe(true);
		await flushInbox(ORG, ME, { inject: () => true });
		expect(await hasFreshInbox(ORG, ME)).toBe(false);
	});

	it('已注入未 ack 的残留：fresh=0 但仍可 commit 清理（自愈清理分支的数据前提）', async () => {
		put('msg-1', 'x');
		// 制造「注入过」的簿记但保留文件：模拟 commitInboxFlush 在写簿记与删除之间中断
		await writeInboxState(ORG, ME, {
			injected: { 'msg-1': '2026-09-14T00:00:00.000Z' },
			events: {},
		});
		const plan = await planInboxFlush([{ org: ORG, agent: ME }]);
		expect(plan.total).toBe(0); // 无新内容 → 不触发轮次
		expect(plan.entries[0]?.replay).toHaveLength(1); // 但有残留可清
		await commitInboxFlush(plan);
		expect(await peekInbox(ORG, ME)).toHaveLength(0); // 清理后归零
	});

	it('簿记文件落在 inbox-state/（与收件箱分离，可独立清理）', async () => {
		put('msg-1', 'x');
		await flushInbox(ORG, ME, { inject: () => true });
		const { existsSync } = await import('node:fs');
		expect(existsSync(inboxStateFile(ORG, ME))).toBe(true);
	});
});
