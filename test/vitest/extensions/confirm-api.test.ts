import { describe, it, expect, beforeEach } from 'vitest';
import {
	installPermissionGateApi,
	registerPendingRequest,
	resolvePendingRequest,
	resetConfirmApi,
	type PermissionGateApi,
} from '../../../extensions/security/permission-gate/confirm-api';

let api: PermissionGateApi;

beforeEach(() => {
	resetConfirmApi();
	installPermissionGateApi();
	api = (globalThis as { __permissionGateApi?: PermissionGateApi })
		.__permissionGateApi as PermissionGateApi;
});

function g(): PermissionGateApi {
	return (globalThis as { __permissionGateApi?: PermissionGateApi })
		.__permissionGateApi as PermissionGateApi;
}

describe('confirm-api 通道无关确认接口（T7）', () => {
	it('install 暴露 globalThis.__permissionGateApi（幂等）', () => {
		expect(g()).toBeDefined();
		installPermissionGateApi(); // 重复安装不报错
		expect(g()).toBeDefined();
	});

	it('registerPendingRequest 生成 shortCode + 入 pending 列表', () => {
		const { shortCode, result } = registerPendingRequest({
			requestId: 'req-1',
			tool: 'bash',
			command: 'rm -rf /tmp/x',
			level: 'critical',
			reasons: ['destructive'],
		});
		expect(shortCode).toMatch(/^[a-z0-9]{6}$/);
		expect(result).toBeInstanceOf(Promise);

		const pending = api.listPending();
		expect(pending).toHaveLength(1);
		expect(pending[0].requestId).toBe('req-1');
		expect(pending[0].shortCode).toBe(shortCode);
		expect(pending[0].level).toBe('critical');
	});

	it('onPendingRequest 订阅回调收到请求', () => {
		const received: string[] = [];
		const unsub = api.onPendingRequest((req) => received.push(req.requestId));
		registerPendingRequest({
			requestId: 'req-2',
			tool: 'bash',
			command: 'sudo rm /x',
			level: 'critical',
			reasons: ['permission-related'],
		});
		expect(received).toEqual(['req-2']);

		unsub();
		registerPendingRequest({
			requestId: 'req-3',
			tool: 'bash',
			command: 'x',
			level: 'warning',
			reasons: [],
		});
		expect(received).toEqual(['req-2']); // 已退订，不再收到
	});

	it('confirm() 程序化确认（等效 TUI allow）', async () => {
		const { result } = registerPendingRequest({
			requestId: 'req-4',
			tool: 'bash',
			command: 'dd if=/dev/zero of=/dev/sda',
			level: 'critical',
			reasons: ['destructive'],
		});

		const ok = await api.confirm('req-4', 'allow');
		expect(ok).toBe(true);
		await expect(result).resolves.toBe('allow');
		expect(api.listPending()).toHaveLength(0);
	});

	it('confirm() 未知 requestId 返回 false', async () => {
		await expect(api.confirm('unknown', 'deny')).resolves.toBe(false);
	});

	it('resolvePendingRequest TUI 路径也能解析', async () => {
		const { result } = registerPendingRequest({
			requestId: 'req-5',
			tool: 'bash',
			command: 'x',
			level: 'warning',
			reasons: [],
		});
		const ok = resolvePendingRequest('req-5', 'deny');
		expect(ok).toBe(true);
		await expect(result).resolves.toBe('deny');
	});

	it('resetConfirmApi 清空状态与全局 API', () => {
		registerPendingRequest({
			requestId: 'req-6',
			tool: 'bash',
			command: 'x',
			level: 'info',
			reasons: [],
		});
		resetConfirmApi();
		expect(
			(globalThis as { __permissionGateApi?: PermissionGateApi }).__permissionGateApi,
		).toBeUndefined();
	});
});
