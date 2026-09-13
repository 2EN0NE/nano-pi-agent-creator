/**
 * 成员消息的发送者头（ADR-0044 D2/D3）。
 *
 * 覆盖 org 侧的**注入**逻辑，并用契约测试锁住与 control 侧的**解析 / 呈现**一致
 * （两处各自本地实现，靠测试防漂移——与 CONTROL_SOCKET_EVENT 同一策略）。
 */
import { describe, it, expect } from 'vitest';
import { senderHeader, withSenderHeader } from '../../../extensions/auto/org/sender.js';
import {
	parseSenderInfo,
	senderLabel,
	stripSenderInfo,
} from '../../../extensions/auto/control/sender-info.js';

describe('senderHeader', () => {
	it('产出的头是机器可解析的 JSON，sender 用成员名', () => {
		expect(senderHeader('boss')).toBe('<sender_info>{"member":"boss"}</sender_info>');
	});
});

describe('withSenderHeader', () => {
	it('注入头 + 换行 + 原文', () => {
		expect(withSenderHeader('你好', 'boss')).toBe(
			'<sender_info>{"member":"boss"}</sender_info>\n你好',
		);
	});

	it('无 sender（人类操作者发起）→ 不注入，人类消息与成员消息可分', () => {
		expect(withSenderHeader('你好')).toBe('你好');
		expect(withSenderHeader('你好', '   ')).toBe('你好');
	});

	it('幂等：对已带头的消息再注入，不叠加第二个头（重复投递 / 改派）', () => {
		const once = withSenderHeader('你好', 'boss');
		const twice = withSenderHeader(once, 'boss');
		expect(twice.match(/<sender_info>/g)).toHaveLength(1);
		expect(twice).toBe(once);
	});

	it('改派：换发送者时头被替换为新的（不保留旧发送者）', () => {
		const byBoss = withSenderHeader('你好', 'boss');
		const byOther = withSenderHeader(byBoss, 'worker-a');
		expect(parseSenderInfo(byOther)?.member).toBe('worker-a');
	});
});

describe('契约：control 侧能解析并呈现 org 注入的头（防漂移）', () => {
	it('parseSenderInfo 解出 member', () => {
		expect(parseSenderInfo(withSenderHeader('正文', 'worker-a'))?.member).toBe('worker-a');
	});

	it('senderLabel 渲染成 `[成员名]:`（ADR-0044 D3）', () => {
		expect(senderLabel(parseSenderInfo(withSenderHeader('正文', 'worker-a')))).toBe(
			'[worker-a]:',
		);
	});

	it('stripSenderInfo 剥掉头后只剩正文（正文不重复展示机器格式）', () => {
		expect(stripSenderInfo(withSenderHeader('正文内容', 'worker-a'))).toBe('正文内容');
	});

	it('无头的消息（人类输入）解析为 null → 不加成员标签', () => {
		expect(parseSenderInfo('人类直接输入')).toBeNull();
		expect(senderLabel(parseSenderInfo('人类直接输入'))).toBeNull();
	});
});
