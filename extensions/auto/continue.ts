import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('continue');

/** Send a literal continuation prompt, but never steer or queue one mid-run. */
export default function (pi: ExtensionAPI) {
	log.info('Extension loaded — continue shortcut registered');

	function handleContinue(ctx: any): void {
		// isIdle() also remains false while Pi is retrying, compacting, or has
		// queued messages, so this cannot accidentally create a follow-up.
		if (!ctx.isIdle()) return;
		log.info('Sending continue via shortcut');
		pi.sendUserMessage('continue');
	}

	// session_start 时注册（消除加载顺序竞险：hub 在所有扩展工厂函数执行后才挂载）
	pi.on('session_start', () => {
		const shortcutHub = (globalThis as any).__shortcutsApi;
		if (shortcutHub?.register) {
			shortcutHub.register({
				name: 'continue',
				keys: ['c'],
				description: 'agent 停止时继续',
				handler: handleContinue,
			});
		} else {
			pi.registerShortcut('shift+alt+enter', {
				description: 'agent 停止时继续',
				handler: handleContinue,
			});
		}
	});
}
