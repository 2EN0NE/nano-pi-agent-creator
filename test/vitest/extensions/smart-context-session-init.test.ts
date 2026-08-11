/**
 * smart-context session-init 实验 — 单元测试
 *
 * 测试子任务检测 + pi-lab 实验注册 + 模型路由逻辑，
 * 与 Pi 运行时解耦（mock pi-lab API）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// 待测逻辑（从 smart-context 提取的可测试函数）
// ============================================================================

interface SessionInitConfig {
	/** 当前会话的 parentSession（undefined = 主会话） */
	parentSession?: string;
}

interface PiLabBridge {
	isAvailable: boolean;
	selectArm: (experimentName: string) => Promise<string>;
	recordOutcome: (experimentName: string, armId: string, success: boolean) => Promise<void>;
}

interface SessionInitResult {
	/** 该会话的默认模型策略 */
	profile: 'fast' | 'balanced';
	/** 是否检测到子任务 */
	isSubtask: boolean;
}

/**
 * 决定会话初始化时的模型策略。
 * - 子任务（parentSession 存在）→ 走 session-init 实验选 arm
 * - 主会话 → balanced（正常路由）
 */
async function decideSessionInit(
	config: SessionInitConfig,
	lab: PiLabBridge,
): Promise<SessionInitResult> {
	const isSubtask = !!config.parentSession;

	if (!isSubtask) {
		return { profile: 'balanced', isSubtask: false };
	}

	if (!lab.isAvailable) {
		// pi-lab 不可用，子任务默认用 fast
		return { profile: 'fast', isSubtask: true };
	}

	// pi-lab 可用，通过实验选 arm
	const arm = await lab.selectArm('smart-context::session-init');
	// arm 映射到 profile
	const profile = arm === 'fast-profile' ? 'fast' : 'balanced';
	return { profile, isSubtask: true };
}

// ============================================================================
// Tests
// ============================================================================

function mockLab(available = true, selectReturn = 'fast-profile'): PiLabBridge {
	return {
		isAvailable: available,
		selectArm: vi.fn().mockResolvedValue(selectReturn),
		recordOutcome: vi.fn().mockResolvedValue(undefined),
	};
}

describe('decideSessionInit', () => {
	it('returns balanced for main session (no parent)', async () => {
		const lab = mockLab();
		const result = await decideSessionInit({}, lab);
		expect(result.isSubtask).toBe(false);
		expect(result.profile).toBe('balanced');
		expect(lab.selectArm).not.toHaveBeenCalled();
	});

	it('returns fast for subtask when pi-lab unavailable', async () => {
		const lab = mockLab(false);
		const result = await decideSessionInit({ parentSession: '/some/path' }, lab);
		expect(result.isSubtask).toBe(true);
		expect(result.profile).toBe('fast');
		expect(lab.selectArm).not.toHaveBeenCalled();
	});

	it('selects arm via pi-lab for subtask when available', async () => {
		const lab = mockLab(true, 'balanced-profile');
		const result = await decideSessionInit({ parentSession: '/some/path' }, lab);
		expect(result.isSubtask).toBe(true);
		expect(result.profile).toBe('balanced');
		expect(lab.selectArm).toHaveBeenCalledWith('smart-context::session-init');
	});

	it('maps fast-profile arm to fast', async () => {
		const lab = mockLab(true, 'fast-profile');
		const result = await decideSessionInit({ parentSession: '/some/path' }, lab);
		expect(result.profile).toBe('fast');
	});

	it('maps unknown arm to balanced (fallback)', async () => {
		const lab = mockLab(true, 'unknown-arm');
		const result = await decideSessionInit({ parentSession: '/some/path' }, lab);
		expect(result.profile).toBe('balanced');
	});
});
