/**
 * control 扩展 — Vitest 结构化测试
 *
 * 测试会话控制扩展的核心功能：
 * 1. 扩展加载不崩溃
 * 2. pi-logger 日志输出正常（lifecycle 日志）
 * 3. 无 ERROR 级别日志
 * 4. Mock LLM 返回正常
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	createSandbox,
	destroySandbox,
	runPi,
	readLogs,
	hasErrorInLogs,
	hasMockResponse,
} from '../helpers/sandbox';

describe('control extension (meta)', () => {
	let sandbox: string;

	beforeAll(() => {
		sandbox = createSandbox({
			extensions: ['pi-logger', 'control'],
			useMockLLM: true,
		});
	});

	afterAll(() => {
		destroySandbox(sandbox);
	});

	it('loads without crashing', async () => {
		const result = await runPi(sandbox, 'hi');
		expect([0, 124]).toContain(result.exitCode);
	}, 60_000);

	it('produces log files via pi-logger', async () => {
		const result = await runPi(sandbox, 'hi');
		const logs = readLogs(result.logDir);
		expect(Object.keys(logs).length).toBeGreaterThan(0);
	}, 60_000);

	it('has no ERROR level in logs', async () => {
		const result = await runPi(sandbox, 'hi');
		expect(hasErrorInLogs(result.logDir)).toBe(false);
	}, 60_000);

	it('stdout has mock LLM response', async () => {
		const result = await runPi(sandbox, 'hi');
		expect(hasMockResponse(result.stdout)).toBe(true);
	}, 60_000);
});
