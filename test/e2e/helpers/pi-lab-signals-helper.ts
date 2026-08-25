/**
 * pi-lab 被动信号 e2e 测试辅助扩展
 *
 * 注册两个实验用于验证 ticket 02/03 的被动信号源与 AA 自检：
 *   - lifecycle-exp：普通实验，验证通用过程指标（turn_token_usage / tool_latency_ms 等）自动注入
 *   - aa-check-exp：isAA 假臂对照（两臂指向同一实现），验证 SRM 偏离告警 + AA 后验校准提示
 *
 * 每个 turn_start select 登记活跃臂，使 lifecycle 通用指标按 turn 归因到实验
 * （assignKey 固定为字符串 → 稳定同臂，用于触发「单臂样本」的 SRM 偏离 + AA 校准路径）。
 *
 * 注意：这是测试辅助扩展，只 mock 实验注册（走真实 pi-lab 桥接），
 * 未 mock 任何 pi API，符合 e2e 分层铁律。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-lab-signals-helper');

interface LabExperiment {
	select: (context?: unknown) => Promise<string>;
}

export default function (pi: ExtensionAPI) {
	let lifecycleExp: LabExperiment | null = null;
	let aaExp: LabExperiment | null = null;

	pi.on('session_start', async () => {
		const mgr = (globalThis as any).__labApi?.getExperimentManager?.();
		if (!mgr) {
			log.warn('pi-lab not available — signals helper disabled');
			return;
		}

		lifecycleExp = mgr.registerWeakExperiment({
			name: 'lifecycle-exp',
			contextKey: 'global',
			assignKey: 'e2e-fixed-session',
			arms: [
				{ id: 'arm-a', label: 'Arm A' },
				{ id: 'arm-b', label: 'Arm B' },
			],
		}) as LabExperiment | null;

		aaExp = mgr.registerWeakExperiment({
			name: 'aa-check-exp',
			isAA: true,
			contextKey: 'global',
			assignKey: 'e2e-fixed-session',
			arms: [
				{ id: 'arm-a', label: 'Arm A (same impl)' },
				{ id: 'arm-b', label: 'Arm B (same impl)' },
			],
		}) as LabExperiment | null;

		log.info('signals helper registered (lifecycle-exp + aa-check-exp)');
	});

	// 每个 turn 开始 select 登记活跃臂（lifecycle 归因目标）。
	// 依赖监听器注册顺序：pi-lab 的 turn_start（attributor.startTurn 清空活跃臂）须先于
	// 本 helper 的 select 执行，否则登记会被立即清空。该顺序由 e2e 测试显式扩展列表
	// `tui_expect_test "pi-lab,pi-lab-signals-helper"` 保证（pi-lab 先加载、先注册先执行）。
	pi.on('turn_start', async () => {
		try {
			if (lifecycleExp) await lifecycleExp.select(null);
			if (aaExp) await aaExp.select(null);
		} catch (err) {
			log.warn('select failed', { error: String(err) });
		}
	});
}
