/**
 * pi-home-guard.sh — e2e pi 配置根 guard 的行为测试
 *
 * 覆盖：run-e2e.sh 前置到 PATH 的 `pi` shim 的决策逻辑。它决定「这次 pi 调用会不会
 * 被重定向到隔离配置根」，是「e2e 永不写真实 ~/.pi」这条铁律的唯一开关，故单测覆盖：
 *   - HOME = 真实 home   → 注入 PI_CODING_AGENT_DIR（忘记隔离的用例被兜住）
 *   - HOME = 沙箱        → 原样透传（已隔离的用例语义不变）
 *   - HOME 未设置        → 也注入（`env -u HOME` 不能成为绕过口）
 *   - 调用方已设 PI_CODING_AGENT_DIR → 不覆盖（显式指定的配置根优先）
 *
 * 另覆盖：
 *   - 真实 pi / 真实 home 的回退来源：环境变量缺失时读 guard 根下的 `real-pi`/`real-home`
 *     文件。这条路径是 org 经 tmux 唤醒成员时的实际路径（tmux session 用 server 的环境
 *     快照，拿不到 E2E_*），缺了它 shim 会直接失败。
 *   - 参数透传；关键信息既无环境变量又无文件时**快速失败**（不静默写真实配置）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../../e2e/helpers/pi-home-guard.sh', import.meta.url));

/** 宿主环境里这些变量会干扰判定：全部从基线里剔除，只由各用例显式提供。 */
const GUARD_VARS: readonly string[] = [
	'PI_CODING_AGENT_DIR',
	'E2E_GUARD_ROOT',
	'E2E_REAL_PI',
	'E2E_REAL_HOME',
	'E2E_MODULE_AGENT_DIR',
];

let root: string;
let stubPi: string;
let agentDir: string;
let guardRoot: string;
let shim: string;

/** 桩 pi：把关心的环境量与参数原样打出来，供断言。 */
function writeStubPi(): string {
	const p = join(root, 'real-pi');
	writeFileSync(
		p,
		[
			'#!/bin/sh',
			'printf "HOME=%s\\n" "${HOME:-<unset>}"',
			'printf "PI_CODING_AGENT_DIR=%s\\n" "${PI_CODING_AGENT_DIR:-<unset>}"',
			'printf "ARGV=%s\\n" "$*"',
			'exit 7',
			'',
		].join('\n'),
	);
	chmodSync(p, 0o755);
	return p;
}

interface GuardResult {
	stdout: string;
	status: number;
}

function execEnv(overrides: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === 'string' && !GUARD_VARS.includes(k)) env[k] = v;
	}
	for (const [k, v] of Object.entries(overrides)) {
		if (v === undefined) delete env[k];
		else env[k] = v;
	}
	return env;
}

function runWith(
	bin: string,
	args: string[],
	overrides: Record<string, string | undefined>,
): GuardResult {
	try {
		const stdout = execFileSync(bin, args, { env: execEnv(overrides), encoding: 'utf-8' });
		return { stdout, status: 0 };
	} catch (err) {
		// `${VAR:?msg}` 的报错走 stderr；两路都收，断言才对得住"快速失败且说明了原因"
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? 1 };
	}
}

/** 以 `<guard_root>/bin/pi` 符号链接（= run-e2e.sh 前置到 PATH 的形态）执行 shim。 */
function runShim(overrides: Record<string, string | undefined>): GuardResult {
	return runWith(shim, ['-a', '--no-session', '-p', 'hi'], overrides);
}

/** 直接以 `/bin/sh <helper>` 执行（等价于直接调试 helper，$0 是 helper 自身路径）。 */
function runGuard(overrides: Record<string, string | undefined>): GuardResult {
	return runWith('/bin/sh', [GUARD, '-a', '--no-session', '-p', 'hi'], overrides);
}

/** 模拟 run-e2e.sh 把真实 pi / 真实 home 落盘到 guard 根（tmux 场景的唯一来源）。 */
function writeRealPiHome(pi: string, home: string): void {
	writeFileSync(join(guardRoot, 'real-pi'), `${pi}\n`);
	writeFileSync(join(guardRoot, 'real-home'), `${home}\n`);
}

beforeEach(() => {
	root = join(tmpdir(), `pi-guard-${randomBytes(4).toString('hex')}`);
	mkdirSync(root, { recursive: true });
	stubPi = writeStubPi();
	agentDir = join(root, 'agent');
	mkdirSync(agentDir, { recursive: true });
	guardRoot = join(root, 'guard');
	shim = join(guardRoot, 'bin', 'pi');
	mkdirSync(join(guardRoot, 'bin'), { recursive: true });
	symlinkSync(GUARD, shim);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('pi-home-guard', () => {
	it('HOME 仍是真实 home → 注入隔离配置根', () => {
		const r = runGuard({
			HOME: '/Users/real-home',
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: stubPi,
			E2E_MODULE_AGENT_DIR: agentDir,
		});
		expect(r.status).toBe(7); // 转发真实 pi 的退出码
		expect(r.stdout).toContain(`PI_CODING_AGENT_DIR=${agentDir}`);
		expect(r.stdout).toContain('HOME=/Users/real-home');
	});

	it('HOME 只差一个尾斜杠 → 仍视为真实 home 并注入（等价写法不是绕过口）', () => {
		const r = runGuard({
			HOME: '/Users/real-home/',
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: stubPi,
			E2E_MODULE_AGENT_DIR: agentDir,
		});
		expect(r.status).toBe(7);
		expect(r.stdout).toContain(`PI_CODING_AGENT_DIR=${agentDir}`);
	});

	it('HOME 已换到沙箱 → 不注入（用例自行隔离的语义不变）', () => {
		const r = runGuard({
			HOME: '/tmp/sandbox/home',
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: stubPi,
			E2E_MODULE_AGENT_DIR: agentDir,
		});
		expect(r.status).toBe(7);
		expect(r.stdout).toContain('PI_CODING_AGENT_DIR=<unset>');
		expect(r.stdout).toContain('HOME=/tmp/sandbox/home');
	});

	it('HOME 未设置 → 也注入（env -u HOME 不是绕过口）', () => {
		const r = runGuard({
			HOME: undefined,
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: stubPi,
			E2E_MODULE_AGENT_DIR: agentDir,
		});
		expect(r.status).toBe(7);
		expect(r.stdout).toContain(`PI_CODING_AGENT_DIR=${agentDir}`);
	});

	it('调用方已显式指定 PI_CODING_AGENT_DIR → 不覆盖（视为已隔离）', () => {
		const r = runGuard({
			HOME: '/Users/real-home',
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: stubPi,
			E2E_MODULE_AGENT_DIR: agentDir,
			PI_CODING_AGENT_DIR: '/tmp/caller-sandbox',
		});
		expect(r.status).toBe(7);
		expect(r.stdout).toContain('PI_CODING_AGENT_DIR=/tmp/caller-sandbox');
	});

	it('参数原样透传给真实 pi', () => {
		const r = runGuard({
			HOME: '/Users/real-home',
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: stubPi,
			E2E_MODULE_AGENT_DIR: agentDir,
		});
		expect(r.stdout).toContain('ARGV=-a --no-session -p hi');
	});

	it('未注入分支不需要 E2E_MODULE_AGENT_DIR', () => {
		const r = runGuard({
			HOME: '/tmp/sandbox/home',
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: stubPi,
			E2E_MODULE_AGENT_DIR: undefined,
		});
		expect(r.status).toBe(7);
	});

	it('注入分支缺 E2E_MODULE_AGENT_DIR → 快速失败（不静默写真实配置）', () => {
		const r = runGuard({
			HOME: '/Users/real-home',
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: stubPi,
			E2E_MODULE_AGENT_DIR: undefined,
		});
		expect(r.status).not.toBe(7);
		expect(r.stdout).toContain('E2E_MODULE_AGENT_DIR');
	});

	it('既无 E2E_REAL_PI 也无 real-pi 文件 → 快速失败', () => {
		const r = runGuard({
			HOME: '/Users/real-home',
			E2E_REAL_HOME: '/Users/real-home',
			E2E_REAL_PI: undefined,
			E2E_MODULE_AGENT_DIR: agentDir,
		});
		expect(r.status).not.toBe(7);
		expect(r.stdout).toContain('E2E_REAL_PI');
	});

	it('无任何 E2E_* 环境变量时，从 guard 根文件读真实 pi/home（tmux server 环境快照场景）', () => {
		writeRealPiHome(stubPi, '/Users/real-home');
		const r = runShim({
			HOME: '/tmp/sandbox/home',
			E2E_REAL_PI: undefined,
			E2E_REAL_HOME: undefined,
			E2E_MODULE_AGENT_DIR: undefined,
		});
		expect(r.status).toBe(7); // 走到了真实 pi，而不是在 shim 里失败
		expect(r.stdout).toContain('PI_CODING_AGENT_DIR=<unset>');
		expect(r.stdout).toContain('ARGV=-a --no-session -p hi');
	});

	it('无 E2E_* 但也未隔离 HOME 时：文件提供 real-home + 环境提供隔离根 → 仍注入', () => {
		writeRealPiHome(stubPi, '/Users/real-home');
		const r = runShim({
			HOME: '/Users/real-home',
			E2E_REAL_PI: undefined,
			E2E_REAL_HOME: undefined,
			E2E_MODULE_AGENT_DIR: agentDir,
		});
		expect(r.status).toBe(7);
		expect(r.stdout).toContain(`PI_CODING_AGENT_DIR=${agentDir}`);
	});

	it('缺 real-home 文件且无 E2E_REAL_HOME → 快速失败', () => {
		writeFileSync(join(guardRoot, 'real-pi'), `${stubPi}\n`);
		const r = runShim({
			HOME: '/tmp/sandbox/home',
			E2E_REAL_HOME: undefined,
			E2E_REAL_PI: undefined,
		});
		expect(r.status).not.toBe(7);
		expect(r.stdout).toContain('E2E_REAL_HOME');
	});

	it('helper 文件存在且可执行（run-e2e.sh 以符号链接前置到 PATH）', () => {
		expect(existsSync(GUARD)).toBe(true);
	});
});
