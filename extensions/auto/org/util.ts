// org — 通用工具（原子 JSON 读写 / 路径 / id / 校验）
import { promises as fs, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type { RpcCommand, RpcEvent, RpcResponse } from './types.js';

const log = createLogger('org');

/** org 数据根（全局，跨项目：一台电脑一个 org）。测试可用 ORG_ROOT 覆盖。 */
export function orgRoot(): string {
	const override = process.env.ORG_ROOT;
	if (override) return override;
	return path.join(os.homedir(), '.pi', 'org');
}

export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

export function readJson<T = unknown>(file: string): Promise<T | null> {
	return fs
		.readFile(file, 'utf8')
		.then((text) => {
			try {
				return JSON.parse(text) as T;
			} catch {
				// 解析失败不再静默：调用方（readRegistry 等）需据此区分「文件缺失」与「文件损坏」，
				// 避免损坏数据被下一次写入静默覆盖。通用读取仍返回 null（不抛），由调用方决定策略。
				log.warn('readJson 解析失败（文件损坏？）', { file });
				return null;
			}
		})
		.catch((error: unknown) => {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				(error as NodeJS.ErrnoException).code === 'ENOENT'
			) {
				return null;
			}
			log.warn('readJson 失败', { file, error: String(error) });
			return null;
		});
}

/** 原子写（tmp + rename），避免并发/半写损坏 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
	await fs.rename(tmp, file);
}

/** realpath 规范化目录（mac /tmp → /private/tmp 等符号链接归一），失败回落 resolve */
export function realDir(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

/** 立即数：ISO 时间 */
export function nowIso(): string {
	return new Date().toISOString();
}

/** 生成短 id：<prefix>_<ts36><rand4> */
export function genId(prefix: string): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 6);
	return `${prefix}_${ts}${rand}`;
}

/** 成员名校验（registry key / 文件名的安全约束） */
export function assertSafeName(name: string): string {
	const trimmed = name.trim();
	if (
		!trimmed ||
		trimmed.length > 64 ||
		/[/\\]/.test(trimmed) ||
		trimmed.includes('..') ||
		/[\u0000-\u001f]/.test(trimmed)
	) {
		throw new Error(`无效的 agent 名「${name}」：须为非空、≤64 字符、不含路径分隔符/换行。`);
	}
	return trimmed;
}

// ── control socket RPC 客户端（control 协议子集）────────────────────────────

/** 向某 control socket 发一个 RPC 命令。
 * waitForEvent='turn_end' 时对齐 control 客户端协议：send 后补发 subscribe，等 turn_end 事件才算完成。
 * 其它情况收到与 command.type 匹配的 response 即返回。 */
export async function rpcCall(
	socketPath: string,
	command: RpcCommand,
	opts?: { timeoutMs?: number; waitForEvent?: string },
): Promise<{ response: RpcResponse; event?: RpcEvent }> {
	const timeoutMs = opts?.timeoutMs ?? 10_000;
	const waitForEvent = opts?.waitForEvent;
	const net = await import('node:net');
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = '';
		let settled = false;
		let mainResponse: RpcResponse | null = null;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				socket.destroy();
				reject(
					new Error(
						`RPC 超时（${timeoutMs}ms）：${socketPath}${waitForEvent ? `，等事件 ${waitForEvent}` : ''}`,
					),
				);
			}
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
		};
		socket.on('connect', () => {
			const id = typeof command.id === 'string' ? command.id : cryptoId();
			socket.write(`${JSON.stringify({ ...command, id })}\n`);
			// 等 turn_end：补发 subscribe（对齐 control 客户端：send + subscribe 同连接）
			if (waitForEvent === 'turn_end') {
				socket.write(`${JSON.stringify({ type: 'subscribe', event: 'turn_end' })}\n`);
			}
		});
		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (!line.trim()) continue;
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (msg.type === 'response') {
					// 只认与 command.type 匹配的 response；subscribe 的 response 忽略
					if (msg.command === command.type) {
						// SAFETY: 已校验 msg.command 匹配，形状按 RpcResponse 解析
						mainResponse = msg as unknown as RpcResponse;
						if (!waitForEvent && !settled) {
							settled = true;
							cleanup();
							resolve({ response: mainResponse });
							return;
						}
					}
					continue;
				}
				if (msg.type === 'event' && waitForEvent && msg.event === waitForEvent) {
					// SAFETY: 已校验 event 名与 waitForEvent 一致
					const event = msg as unknown as RpcEvent;
					if (!settled) {
						settled = true;
						cleanup();
						const okResponse: RpcResponse = mainResponse ?? {
							type: 'response',
							command: String(command.type ?? ''),
							success: true,
						};
						resolve({ response: okResponse, event });
						return;
					}
				}
			}
		});
		socket.on('error', (error: NodeJS.ErrnoException) => {
			if (!settled) {
				settled = true;
				cleanup();
				reject(error);
			}
		});
	});
}

/** socket 连通性探测（文件存在且可连接） */
export async function isSocketAlive(socketPath: string, timeoutMs = 1500): Promise<boolean> {
	try {
		await rpcCall(socketPath, { type: 'ping', id: 'probe' }, { timeoutMs });
		return true;
	} catch {
		return false;
	}
}

const CONNECT_ERROR_CODES = ['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE', 'EACCES'] as const;

/**
 * RPC 错误分类（dispatch 兜底决策依据）：
 * - 'connect'：socket 从未连上（control 未启/已退/中途断）——消息从未送达，应转 inbox，不能让任务悬空；
 * - 'timeout'：连上并发出后等待回报超时——消息可能已送达、对方仍在执行，保持 in_progress。
 */
export function classifyRpcError(error: unknown): 'connect' | 'timeout' {
	const e = error as { code?: string; message?: string } | null;
	if (e && typeof e.code === 'string') {
		// CONNECT_ERROR_CODES 只读数组；includes 收窄为 string 比对
		if ((CONNECT_ERROR_CODES as readonly string[]).includes(e.code)) return 'connect';
	}
	return 'timeout';
}

function cryptoId(): string {
	// SAFETY: Node ≥19 全局带 crypto.randomUUID；此处为宽运行环境降级兜底
	const g = globalThis as { crypto?: { randomUUID?: () => string } };
	if (g.crypto?.randomUUID) return g.crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
