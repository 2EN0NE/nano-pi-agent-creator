/**
 * 远端通道模拟器 —— permission-gate 远端豁免用例的测试辅助扩展（ADR-0068）。
 *
 * 真实通道（如 wechatbot）在连接就绪时 `arm(owner)`；这里在 `session_start` 直接占用，
 * 让 permission-gate 的 armed 分支生效。`--unattended-confirm` 仍必须由启动命令提供
 * （许可 = 启动 flag，生效 = arm，两者分离是本次设计的关键）。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { arm } from '@zenone/pi-selector';

export default function (pi: ExtensionAPI) {
	pi.on('session_start', () => {
		const disarm = arm('e2e-channel');
		if (!disarm) {
			console.error('[arm-channel] arm() 被拒绝：启动命令未带 --unattended-confirm');
		}
	});
}
