/**
 * ci-watch 配置持久化 — Vitest 组件测试
 *
 * 覆盖 TUI 面板编辑轮询配置后的写回路径（saveConfig）：
 *   - 组装当前 state 的 pollConfig + autoMaxWaitMs 写入 'user' 层
 *   - configStore 为 null 时安全降级（不抛错）
 *
 * 读取路径（config.json → 轮询行为生效）由 e2e 场景 7/9/10 覆盖。
 * TUI 键盘交互（SelectList 导航 + ui.input 对话框流）在 expect 下 flaky
 * 风险高，不在此层测试。
 */
import { describe, it, expect, vi } from 'vitest';
import { saveConfig, type TuiState } from '../../../extensions/verification/ci-watch/src/index';
import type { ConfigStore } from '@zenone/pi-config';

function makeState(overrides: Partial<TuiState> = {}): TuiState {
	return {
		autoMode: false,
		pollConfig: { minMs: 1000, maxMs: 2000, stepMs: 1000 },
		pollConfigExpanded: false,
		menuValue: null,
		monitoringStatus: null,
		autoMaxWaitMs: 5000,
		...overrides,
	};
}

function makeStore(): ConfigStore<{ pollConfig: TuiState['pollConfig']; autoMaxWaitMs?: number }> {
	return {
		save: vi.fn(),
		get: vi.fn(),
		reload: vi.fn(),
	} as unknown as ConfigStore<{ pollConfig: TuiState['pollConfig']; autoMaxWaitMs?: number }>;
}

describe('saveConfig（配置写回持久化）', () => {
	it('保存当前 state 的 pollConfig 与 autoMaxWaitMs 到 user 层', () => {
		const store = makeStore();
		const state = makeState({
			pollConfig: { minMs: 3000, maxMs: 5000, stepMs: 1000 },
			autoMaxWaitMs: 9000,
		});

		saveConfig(state, store);

		expect(store.save).toHaveBeenCalledWith(
			{ pollConfig: { minMs: 3000, maxMs: 5000, stepMs: 1000 }, autoMaxWaitMs: 9000 },
			'user',
		);
	});

	it('编辑 __config_min 后 state 变更能被持久化（编辑流组装）', () => {
		const store = makeStore();
		const state = makeState({ pollConfig: { minMs: 1000, maxMs: 2000, stepMs: 1000 } });

		// 模拟 handlePanelAction('__config_min') 输入 "5" 后的 state 变更
		state.pollConfig.minMs = 5 * 1000;
		saveConfig(state, store);

		expect(store.save).toHaveBeenCalledWith(
			{ pollConfig: { minMs: 5000, maxMs: 2000, stepMs: 1000 }, autoMaxWaitMs: 5000 },
			'user',
		);
	});

	it('configStore 为 null 时安全降级（不抛错）', () => {
		const state = makeState();
		expect(() => saveConfig(state, null)).not.toThrow();
	});
});
