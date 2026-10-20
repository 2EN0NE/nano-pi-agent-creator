/**
 * org 生命周期测试共用辅助：假 control socket（协议子集）+ runtime 记录写入。
 *
 * 仅测试侧使用（不放进 src/tui-testing——那是 TUI 通用件，与 org 领域无关）。
 * 假 socket 只应答 `ping`，与 `extensions/auto/control` 的协议子集一致，
 * 使「在岗判定」可以在真实 unix socket 上验证，无需 mock `node:net`。
 */
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isSocketAlive } from '../../../extensions/auto/org/util.js';
import { runtimeFile } from '../../../extensions/auto/org/orgstore.js';
import { writeJsonAtomic } from '../../../extensions/auto/org/util.js';
import type { RuntimeRecord } from '../../../extensions/auto/org/presence.js';

/** 启动假 control socket；返回的 server 由调用方在 afterEach 关闭 */
export async function listenFakeControl(socketPath: string): Promise<net.Server> {
	const server = net.createServer((socket) => {
		socket.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString('utf8').split('\n')) {
				if (!line.trim()) continue;
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (msg.type === 'ping') {
					socket.write(
						`${JSON.stringify({ type: 'response', command: 'ping', success: true })}\n`,
					);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
	return server;
}

/** 关闭全部 server（用例 teardown） */
export async function closeServers(servers: net.Server[]): Promise<void> {
	for (const s of servers.splice(0)) {
		await new Promise<void>((r) => s.close(() => r()));
	}
}

export interface RuntimeOverrides {
	socketPath: string;
	dir?: string;
	pid?: number;
	sessionId?: string;
	busy?: boolean;
	startedAt?: string;
	updatedAt?: string;
}

/**
 * 写入成员 runtime 记录（模拟成员进程自己写的那份）。
 *
 * ⚠️ `over.dir` 缺省为 `/tmp/<name>`（占位值）。**凡要驱动 `stopMember` 的用例必须显式传
 * 该成员在名册里的真实目录**——`stopMember` 会用 `runtime.dir` 核对 pid 归属（防陈旧记录里
 * 被复用的 pid 被误杀），不符即拒绝停止；占位值会让「睡眠」路径静默不生效。
 */
export async function writeRuntimeFile(
	org: string,
	name: string,
	over: RuntimeOverrides,
): Promise<RuntimeRecord> {
	const rec: RuntimeRecord = {
		schemaVersion: 1,
		name,
		dir: over.dir ?? `/tmp/${name}`,
		pid: over.pid ?? 4242,
		socketPath: over.socketPath,
		sessionId: over.sessionId ?? `sess-${name}`,
		busy: over.busy ?? false,
		startedAt: over.startedAt ?? new Date().toISOString(),
		updatedAt: over.updatedAt ?? new Date().toISOString(),
	};
	await writeJsonAtomic(runtimeFile(org, name), rec);
	return rec;
}

/** 假成员进程源码：真实 node 进程 + unix socket（应答 ping），可被 kill */
const FAKE_MEMBER_SOURCE = `
import * as net from 'node:net';
const server = net.createServer((socket) => {
	socket.on('data', (chunk) => {
		for (const line of chunk.toString('utf8').split('\\n')) {
			if (!line.trim()) continue;
			let msg;
			try { msg = JSON.parse(line); } catch { continue; }
			if (msg.type === 'ping') {
				socket.write(JSON.stringify({ type: 'response', command: 'ping', success: true }) + '\\n');
			}
		}
	});
});
server.listen(process.argv[2]);
`;

/**
 * 起一个"假成员进程"（真实 node 进程监听 unix socket），返回其 pid。
 * 用于验证睡眠（kill）路径：runtime 记录的 pid/socket 都是真的。
 */
export async function spawnFakeMember(opts: {
	scriptPath: string;
	socketPath: string;
}): Promise<number> {
	writeFileSync(opts.scriptPath, FAKE_MEMBER_SOURCE, 'utf8');
	const child = spawn(process.execPath, [opts.scriptPath, opts.socketPath], {
		stdio: 'ignore',
	});
	if (!child.pid) throw new Error('假成员进程启动失败（无 pid）');
	for (let i = 0; i < 80; i++) {
		if (await isSocketAlive(opts.socketPath, 200).catch(() => false)) return child.pid;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error('假成员 socket 未就绪');
}

/** 清理：确保假成员进程不再存活 */
export function killIfAlive(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		/* 已退出 */
	}
}
