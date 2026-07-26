/**
 * pi-lab e2e 测试辅助扩展
 *
 * 注册一个测试实验，用于 smoke 测试验证实验框架可用性。
 * 在测试沙箱中通过 run_pi_and_check 自动加载。
 *
 * 使用 registerWeakExperiment（方案 A — 弱依赖），在 session_start 中延迟注册。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-lab-test-helper');

export default function (pi: ExtensionAPI) {
	pi.on('session_start', async () => {
		const mgr = (globalThis as any).__labApi?.getExperimentManager?.();
		if (!mgr) {
			log.warn('pi-lab not available, cannot register test experiment');
			return;
		}

		const exp = mgr.registerWeakExperiment({
			name: 'e2e-test-experiment',
			contextKey: () => 'e2e',
			arms: [
				{ id: 'arm-a', label: 'Strategy A' },
				{ id: 'arm-b', label: 'Strategy B' },
			],
			strategy: 'thompson-sampling',
		});

		log.info('test-experiment registered');
	});
}
