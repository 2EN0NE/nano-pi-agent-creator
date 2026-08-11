/**
 * smart-context — session-init 实验
 *
 * 在 session_start 中检测子任务（parentSession），
 * 通过 pi-lab 实验选择模型策略。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('smart-context:session-init');

// ── Types ──────────────────────────────────────────────────────────

export interface PiLabBridge {
	isAvailable: boolean;
	selectArm: (experimentName: string) => Promise<string>;
}

export interface SessionInitResult {
	profile: 'fast' | 'balanced';
	isSubtask: boolean;
	experimentUsed: boolean;
}

// ── Bridge ─────────────────────────────────────────────────────────

/** 从 globalThis 获取 pi-lab 桥接 */
export function getPiLabBridge(): PiLabBridge {
	const labApi = (globalThis as any).__labApi;
	if (!labApi) return { isAvailable: false, selectArm: async () => 'balanced-profile' };

	try {
		const mgr = labApi.getExperimentManager();
		if (!mgr) return { isAvailable: false, selectArm: async () => 'balanced-profile' };

		return {
			isAvailable: true,
			selectArm: async (name: string) => {
				const exp = mgr.getExperiment(name);
				if (!exp) {
					log.warn('Experiment not found | name=%s', name);
					return 'balanced-profile';
				}
				return exp.select();
			},
		};
	} catch (err) {
		log.warn('pi-lab bridge failed', {
			error: err instanceof Error ? err.message : String(err),
		});
		return { isAvailable: false, selectArm: async () => 'balanced-profile' };
	}
}

// ── Decision ───────────────────────────────────────────────────────

/** 决定会话初始化时的模型策略 */
export async function decideSessionInit(
	ctx: ExtensionContext,
	lab: PiLabBridge,
): Promise<SessionInitResult> {
	const header = ctx.sessionManager.getHeader();
	const isSubtask = !!header?.parentSession;

	if (!isSubtask) {
		return { profile: 'balanced', isSubtask: false, experimentUsed: false };
	}

	if (!lab.isAvailable) {
		ctx.ui.notify(
			'pi-lab not available — subtask session defaulting to fast profile',
			'warning',
		);
		return { profile: 'fast', isSubtask: true, experimentUsed: false };
	}

	const arm = await lab.selectArm('smart-context::session-init');
	const profile = arm === 'fast-profile' ? 'fast' : 'balanced';
	log.info('Session init experiment | arm=%s profile=%s', arm, profile);
	return { profile, isSubtask: true, experimentUsed: true };
}

// ── Extension hook ─────────────────────────────────────────────────

/**
 * 在 session_start 中注册 session-init 实验并应用到路由。
 */
export async function setupSessionInit(pi: ExtensionAPI, ctx: ExtensionContext) {
	const lab = getPiLabBridge();

	if (lab.isAvailable) {
		const mgr = (globalThis as any).__labApi.getExperimentManager();
		try {
			mgr.registerWeakExperiment({
				name: 'session-init',
				namespace: 'smart-context',
				contextKey: 'global',
				arms: [
					{ id: 'fast-profile', label: 'Fast — all flash for subtasks' },
					{ id: 'balanced-profile', label: 'Balanced — per-profile routing' },
				],
				strategy: 'thompson-sampling',
			});
			log.info('session-init experiment registered');
		} catch (err) {
			log.warn('Failed to register session-init', {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const result = await decideSessionInit(ctx, lab);

	if (result.isSubtask && result.profile === 'fast') {
		const profile = await getFastProfile(ctx);
		if (profile) {
			const model = ctx.modelRegistry.find(profile.provider, profile.model);
			if (model) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (auth.ok && auth.apiKey) {
					await pi.setModel(model);
					log.info(
						'Subtask session | switched to fast model | provider=%s model=%s',
						profile.provider,
						profile.model,
					);
				}
			}
		}
	}
}

async function getFastProfile(ctx: ExtensionContext) {
	try {
		const { resolveProfile } = await import('./config.js');
		const profile = resolveProfile(ctx.cwd);
		return profile.routing.trivial;
	} catch {
		return null;
	}
}
