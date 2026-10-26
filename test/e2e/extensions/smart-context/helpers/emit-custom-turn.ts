import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * e2e 辅助扩展：在首个 run 完全 settle 后，发一条自定义消息并触发新一轮 run。
 *
 * 用途：构造 `before_agent_start` 的 `messageType: "custom"` 分支（loop / goal / org
 * 等插件的 `sendMessage({ triggerTurn: true })` 走的是同一条路径），用于验证
 * smart-context 这类消费者不会把"没有 event.prompt"当成错误。
 *
 * 用 `agent_settled` 而不是 `agent_end`：`agent_end` 时 run 仍在收尾，triggerTurn
 * 不生效；在 settled 期间发出的 prompt 会被 pi 延后到 settled 结束再执行。
 */
export default function (pi: ExtensionAPI) {
	let fired = false;

	pi.on('agent_settled', () => {
		if (fired) return;
		fired = true;
		console.log('[emit-custom-turn] sending custom message with triggerTurn');
		pi.sendMessage(
			{
				customType: 'e2e-custom-turn',
				content: '[e2e] 自定义触发的续跑 run',
				display: false,
			},
			{ triggerTurn: true },
		);
	});
}
