import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { buildTranscript, countUserTurns } from './transcript.js';
import { summarizeRecap } from './summarize.js';

const log = createLogger('pi-recap');

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;
const MIN_TURNS = 3;

function autoEnabled(): boolean {
	const raw = process.env.PI_ENABLE_AWAY_RECAP;
	if (raw === undefined) return true;
	return raw !== '0' && raw.toLowerCase() !== 'false';
}

export default function recapExtension(pi: ExtensionAPI): void {
	let lastAgentEndAt = 0;
	let showedRecapSinceActivity = false;

	async function generateRecap(ctx: any): Promise<string | null> {
		const entries =
			ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
		if (countUserTurns(entries) < 1) return null;
		const transcript = buildTranscript(entries);
		if (!transcript.trim()) return null;
		return summarizeRecap(transcript, ctx);
	}

	pi.on('agent_end', async () => {
		lastAgentEndAt = Date.now();
		showedRecapSinceActivity = false;
		log.debug('Turn ended, idle timer reset', { timestamp: lastAgentEndAt });
	});

	pi.on('before_agent_start', async (_event, ctx) => {
		if (!autoEnabled()) {
			log.debug('Auto recap disabled via PI_ENABLE_AWAY_RECAP');
			return;
		}
		if (!ctx.hasUI) {
			log.debug('No UI available, skipping auto recap');
			return;
		}
		if (showedRecapSinceActivity) {
			log.debug('Recap already shown since last activity, skipping');
			return;
		}
		if (lastAgentEndAt === 0) {
			log.debug('No prior turn yet, skipping auto recap');
			return;
		}

		const idleFor = Date.now() - lastAgentEndAt;
		if (idleFor < IDLE_THRESHOLD_MS) {
			log.debug('Idle time below threshold', { idleFor });
			return;
		}

		const entries =
			ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
		const turns = countUserTurns(entries);
		if (turns < MIN_TURNS) {
			log.debug('Not enough user turns', { turns, min: MIN_TURNS });
			return;
		}

		showedRecapSinceActivity = true;
		log.info('Auto-triggering recap', { idleFor, userTurns: turns });
		void (async () => {
			try {
				const recap = await generateRecap(ctx);
				if (recap) {
					ctx.ui.notify(`回顾：${recap}`, 'info');
					log.info('Auto recap result', { text: recap });
				}
			} catch {
				// recap 是尽力而为的；绝不要阻塞轮次
				log.warn('Auto recap failed (silent, non-blocking)');
			}
		})();
	});

	pi.registerCommand('recap', {
		description: '总结你本次会话进行到哪了',
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				log.debug('No UI available for /recap command');
				return;
			}
			await ctx.waitForIdle();

			log.info('User triggered /recap');
			ctx.ui.setWorkingMessage('正在生成回顾...');
			try {
				const recap = await generateRecap(ctx);
				showedRecapSinceActivity = true;
				if (recap) {
					ctx.ui.notify(`回顾：${recap}`, 'info');
					log.info('Manual recap result', { text: recap });
				} else {
					ctx.ui.notify('会话内容还不够生成回顾。', 'warning');
					log.debug('Manual recap: not enough conversation');
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`回顾失败：${msg}`, 'error');
				log.error('Manual recap failed', { error: msg });
			} finally {
				ctx.ui.setWorkingMessage();
			}
		},
	});
}
