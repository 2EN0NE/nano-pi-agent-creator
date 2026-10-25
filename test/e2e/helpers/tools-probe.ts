/**
 * e2e 探针：打印 pi 在每次请求前声明的活动工具集。
 *
 * 用途：preset e2e 断言"会话恢复后工具集是否回到默认工具选择"（ADR-0065）——
 * 工具可用性在非交互模式下无法通过模型行为观察，只能看运行时声明。
 * 仅测试用，不进 extensions/。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
	pi.on('before_agent_start', () => {
		console.log(`[tools-probe] active=${JSON.stringify(pi.getActiveTools())}`);
	});
}
