import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * 测试辅助扩展：模拟外部 npm 扩展（如 pi-lens）在 session_start 里
 * 设置一个**不带 `|` 前缀**的 footer status。
 *
 * 用于验证 widget-wrangler 的中间人层（ensureStatusPrefix）能否为其自动补齐 `|`。
 */
export default function (pi: ExtensionAPI) {
	pi.on('session_start', (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus('external-status', 'external-no-pipe');
	});
}
