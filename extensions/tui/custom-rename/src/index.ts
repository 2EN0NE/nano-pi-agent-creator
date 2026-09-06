import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

import { registerAutoRenameCommand } from './commands.js';
import { callRenameLLM, resolveRenameModel } from './llm.js';
import { countSuccessfulAssistantReplies, loadRenameConfig } from './pure.js';

const log = createLogger('custom-rename');

/**
 * turn_end 事件的宽松类型（参考 pi extensions/types.ts 的 TurnEndEvent）。
 * message 收紧为带 stopReason 的宽松结构（快速路径读取），不依赖 pi 类型导出。
 */
interface TurnEndLikeEvent {
	type: 'turn_end';
	turnIndex: number;
	message: { stopReason?: string } & object;
	toolResults: unknown[];
}

/**
 * rename in-flight 防重标志（session 级，模块单例）。
 *
 * 场景：首个成功 turn_end 触发 rename#1（LLM 调用最多 30s）。若用户在窗口内发起
 * 第二轮、且其首 iteration 为 toolUse，该轮 turn_end 时 entries 中成功 stop 计数
 * 可能未变，会重复触发 rename#2——两个并发调用可能都通过 getSessionName 重查并先后
 * setSessionName（后者覆盖前者）。该标志保证同一时刻只有一个 rename 在途。
 *
 * 只在真正发起 LLM 调用前置位、异步回调（成功/失败）后释放；模型不可用等前置失败
 * 路径不置位（见 warnedModelRef 注释），不会把「配置问题」误当成「调用在途」而卡死后续修复。
 *
 * /reload 后模块状态重置为 false 是安全行为（新实例从零开始，会重新评估未命名会话）。
 */
let renameInFlight = false;

/**
 * 最近一次「模型不可用」告警对应的 model ref（session 级，模块单例）。
 *
 * 模型不可用（ref 未配置 / 未注册 / 无凭证）是配置问题而非瞬时错误——若每个成功 turn
 * 都重新告警会刷屏。因此同一 ref 只向用户告警一次，之后静默跳过；一旦用户通过
 * /auto-rename 面板把 ref 换成可用模型（或模型恢复可用），下一个可触发 turn 重新评估，
 * 「按提示修好模型后本会话即可自动重命名」，无需 /reload 或新开会话。
 *
 * 缓存键为 config.model.ref 原始值：未配置时为空串，用户一旦填入模型即视为新 ref 重新评估。
 */
let warnedModelRef: string | null = null;

/**
 * 上次 rename 尝试时的成功回复计数（节流游标）。
 *
 * 用途：rename 失败（LLM 错误/超时等，in-flight 已释放）后避免每个成功 turn 都重试——
 * 距上次尝试不足 2 个成功回复不重试（`lastAttemptCount === 0` 表示从未尝试，放行）。
 *
 * 该游标与 renameInFlight 一样是模块级：/reload 重置为 0 → 未命名会话 reload 后
 * 下一个成功回复即重新评估（reload 补命名场景），不受 reload 前失败尝试的节流影响。
 */
let lastAttemptCount = 0;

/** 仅供 vitest 注入重置；生产代码不要调用。 */
export function __resetRenameInFlightForTest(): void {
	renameInFlight = false;
	lastAttemptCount = 0;
	warnedModelRef = null;
}

/**
 * custom-rename extension 工厂函数。
 * 会话在「未命名」状态下完成任意成功 turn 后，用独立模型生成会话标题并 setSessionName 落库。
 *
 * 触发语义（v2）：不再要求「首轮成功回复」——凡未命名会话，首个可触发的成功 turn
 * 即发起（新会话 = 首轮；/reload 后多轮历史的未命名会话 = reload 后第一个成功回复，
 * 命名依据来自历史 entries 的首条用户请求 + 本轮回复）。rename 成功后会话有名字，
 * getSessionName 非空 → 后续自动 skip，天然只命名一次。
 */
export default function renameSessionExtension(pi: ExtensionAPI): void {
	registerAutoRenameCommand(pi);

	pi.on('turn_end', async (event: TurnEndLikeEvent, ctx: ExtensionContext) => {
		try {
			// 1. 开关检查（loadRenameConfig：pi-config 双层 + 环境变量覆盖）
			const config = loadRenameConfig();
			if (!config.enabled) return;

			// 2. O(1) 快速路径：turn_end 每个 iteration 发一次，只有 stopReason==='stop' 的
			// 最终 turn 才触发（过滤 toolUse 中间轮与 error/aborted/length 异常轮）
			if (event.message.stopReason !== 'stop') {
				log.debug('skip: stopReason=%s', event.message.stopReason);
				return;
			}

			// 3. 成功回复基数检查：至少 1 个成功（stop）回复才有可依据的对话。
			// /reload 后 entries 保留，计数为历史累计——只要 ≥1 即满足（不再要求 ===1）。
			const entries = ctx.sessionManager.getEntries();
			const successCount = countSuccessfulAssistantReplies(entries);
			if (successCount < 1) {
				log.debug('skip: no successful reply yet');
				return;
			}

			// 4. 已命名检查：会话已有名字（本插件 rename 成功 / 用户手动命名）→ 不再自动改。
			// 该检查替代旧 count===1 的防重复职责——名字存在即天然只命名一次。
			if (pi.getSessionName()) {
				log.debug('skip: session already named');
				return;
			}

			// 5. in-flight 防重：上一个 rename 的 LLM 调用未返回（含其后的 setSessionName）
			// 期间不再触发新 rename。异步完成后释放标志（仅在真实调用期间置位，见模块注释）。
			if (renameInFlight) {
				log.debug('skip: rename in flight');
				return;
			}

			// 6. 模型可用性检查：每次可触发 turn 都重查（registry 查找，廉价），配置修复后
			// 自动恢复、无需 /reload。不可用属配置问题：同一 ref 只告警一次（warnedModelRef
			// 缓存），避免每个成功 turn 刷 warning；且不消耗 lastAttemptCount / renameInFlight
			// —— 用户按提示用 /auto-rename 换可用模型后，下一个成功 turn 即重新评估触发。
			// 实测高频坑：config 里的模型不在 modelRegistry（如 models.json 只配了 cli-proxy）。
			if (!resolveRenameModel(ctx, config.model)) {
				const ref = config.model.ref || '(未配置)';
				if (warnedModelRef === config.model.ref) {
					log.debug('skip: model unavailable (already warned, ref=%s)', ref);
				} else {
					warnedModelRef = config.model.ref;
					ctx.ui.notify(
						`自动重命名未执行：模型 ${ref} 不可用。用 /auto-rename 选择可用模型后，下一成功轮自动重试`,
						'warning',
					);
					log.warn('model unavailable (%s)', ref);
				}
				return;
			}
			warnedModelRef = null;

			// 7. 重试节流：上次真实 LLM 尝试失败后，距其不足 2 个成功回复不重试
			// （防每轮空转 LLM）。lastAttemptCount===0（从未尝试，含 /reload 后新实例）→ 放行。
			if (lastAttemptCount > 0 && successCount < lastAttemptCount + 2) {
				log.debug(
					'skip: retry throttle (count=%d, last=%d)',
					successCount,
					lastAttemptCount,
				);
				return;
			}
			// 记录本次尝试（无论成败；失败由节流控制重试节奏）
			lastAttemptCount = successCount;
			renameInFlight = true;

			// 8. LLM 生成标题并落库。用 detached promise 脱离 await 链（fire-and-forget）：
			// handler 立即 resolve，LLM 调用与 setSessionName 在后台异步完成，不阻塞 agent 循环。
			void callRenameLLM(ctx, config, event.message)
				.then((title) => {
					if (!title) return;
					// 防覆盖：落库前重查——LLM 调用窗口内用户手动命名的竞态由此兜住
					if (pi.getSessionName()) {
						log.debug('skip: name exists');
						return;
					}
					pi.setSessionName(title);
					// rename 成功对用户可见：notify 横幅（一次性事件，不占状态栏常驻位）。
					ctx.ui.notify(`会话已重命名为「${title}」`, 'info');
					log.info('renamed to "%s"', title);
				})
				.catch((e) => log.error('rename LLM failed', { error: String(e) }))
				.finally(() => {
					renameInFlight = false;
				});
			// rename 是 best-effort，任何 LLM 失败都静默跳过保留原 label，不进 session history。
		} catch (e) {
			// best-effort 降级：turn_end handler 同步部分抛错时记录但不阻断 agent 循环。
			log.error('failed', { error: String(e) });
		}
	});
}
