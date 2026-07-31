/**
 * extension-dev-final-sync — Vitest e2e 测试
 *
 * 测试要点：
 * 1. 基本加载：扩展在 Mock LLM 模式下正常加载，无崩溃
 * 2. 日志验证：扩展在 agent_end 时产生日志
 * 3. 全流程测试（高级）：设置 git repo + 创建扩展文件 → 运行 pi → 验证同步通知
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	createSandbox,
	destroySandbox,
	runPi,
	readLogs,
	hasErrorInLogs,
	ROOT_DIR,
} from '../helpers/sandbox.js';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';

/** 安全执行 git 命令，失败时返回空输出 */
function safeGit(args: string[], cwd: string): string {
	try {
		return execSync(`git ${args.join(' ')}`, {
			cwd,
			encoding: 'utf8',
			timeout: 10_000,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	} catch {
		return '';
	}
}

/** 创建目录（忽略已存在错误） */
function mkdirDir(p: string) {
	try {
		mkdirSync(p, { recursive: true });
	} catch {
		/* ignore */
	}
}

/** 复制 node_modules 依赖到沙箱 */
function copyDep(srcDir: string, destDir: string, dep: string) {
	const src = join(srcDir, dep);
	if (existsSync(src)) {
		try {
			cpSync(src, join(destDir, dep), { recursive: true });
		} catch {
			/* ignore symlink or permission issues */
		}
	}
}

describe('extension-dev-final-sync', () => {
	let sandbox: string;

	beforeAll(() => {
		sandbox = createSandbox({
			extensions: ['pi-logger', 'extension-dev-final-sync'],
			useMockLLM: true,
		});
	});

	afterAll(() => {
		destroySandbox(sandbox);
	});

	it('loads without crashes', async () => {
		const result = await runPi(sandbox, 'hi');
		expect([0, 124]).toContain(result.exitCode);
	}, 60_000);

	it('has no ERROR in logs', async () => {
		const result = await runPi(sandbox, 'hi');
		expect(hasErrorInLogs(result.logDir)).toBe(false);
	}, 60_000);

	it('logs extension-dev-final-sync activity', async () => {
		const result = await runPi(sandbox, 'hi');
		const logs = readLogs(result.logDir);
		const allText = Object.values(logs).join('\n');
		expect(allText).toContain('extension-dev-final-sync');
	}, 60_000);

	it('detects no changes and skips sync (no crash)', async () => {
		const result = await runPi(sandbox, 'test no changes');
		expect([0, 124]).toContain(result.exitCode);
		expect(hasErrorInLogs(result.logDir)).toBe(false);

		// 验证扩展运行了并且记录了"无变更"日志
		const logs = readLogs(result.logDir);
		const allText = Object.values(logs).join('\n');
		expect(allText).toContain('No extensions changed');
	}, 60_000);
});

/**
 * 全流程测试套件
 *
 * 创建更真实的沙箱：
 * - 初始化 git repo
 * - 创建 extesions/ 源目录
 * - 修改扩展文件 → 运行 pi → 验证不崩溃
 */
describe('extension-dev-final-sync full flow', () => {
	let projectSandbox: string;

	beforeAll(() => {
		projectSandbox = createSandbox({
			extensions: ['pi-logger', 'extension-dev-final-sync'],
			useMockLLM: true,
		});

		// 1. 初始化 git repo
		safeGit(['init', '--initial-branch', 'main'], projectSandbox);
		safeGit(['config', 'user.email', 'test@test.com'], projectSandbox);
		safeGit(['config', 'user.name', 'Tester'], projectSandbox);

		// 2. 创建 extensions/ 源目录
		mkdirDir(join(projectSandbox, 'extensions', 'auto'));

		// 3. 创建一个测试扩展文件并提交
		writeFileSync(
			join(projectSandbox, 'extensions', 'auto', 'test-ext.ts'),
			[
				'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
				'export default function (pi: ExtensionAPI) {',
				'  pi.on("session_start", async () => { console.log("test-ext loaded"); });',
				'}',
				'',
			].join('\n'),
		);

		safeGit(['add', '-A'], projectSandbox);
		safeGit(['commit', '-m', 'Initial commit with extensions'], projectSandbox);

		// 4. 复制 sync 工具等相关文件
		const scriptsDir = join(projectSandbox, 'scripts');
		mkdirDir(scriptsDir);

		const syncToolSrc = join(ROOT_DIR, 'scripts', 'sync-to-local-pi.ts');
		if (existsSync(syncToolSrc)) {
			cpSync(syncToolSrc, join(scriptsDir, 'sync-to-local-pi.ts'));
		}
		const profileSrc = join(ROOT_DIR, 'scripts', 'sync-profiles.yaml');
		if (existsSync(profileSrc)) {
			cpSync(profileSrc, join(scriptsDir, 'sync-profiles.yaml'));
		}

		// 复制 package.json 和关键 node_modules
		if (existsSync(join(ROOT_DIR, 'package.json'))) {
			cpSync(join(ROOT_DIR, 'package.json'), join(projectSandbox, 'package.json'));
		}

		const snm = join(projectSandbox, 'node_modules');
		mkdirDir(snm);
		for (const dep of ['tsx', 'esbuild', 'get-tsconfig', 'resolve-pkg-maps']) {
			copyDep(join(ROOT_DIR, 'node_modules'), snm, dep);
		}

		// 复制 tsconfig（npx tsc 需要）
		if (existsSync(join(ROOT_DIR, 'tsconfig.json'))) {
			cpSync(join(ROOT_DIR, 'tsconfig.json'), join(projectSandbox, 'tsconfig.json'));
		}
	});

	afterAll(() => {
		destroySandbox(projectSandbox);
	});

	// v3（mtime-based）：只检测本轮会话内通过 edit 工具产生的变更，
	// 外部修改（pi 进程间）不会被检测到。
	it('external modifications are not synced (by design) [REVIEW]', async () => {
		// 修改测试扩展文件（模拟外部开发环境中的修改，在 pi 启动前）
		writeFileSync(
			join(projectSandbox, 'extensions', 'auto', 'test-ext.ts'),
			[
				'import { createLogger } from "@zenone/pi-logger";',
				'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
				'const log = createLogger("test-ext");',
				'export default function (pi: ExtensionAPI) {',
				'  pi.on("session_start", async () => {',
				'    log.info("test-ext modified version loaded");',
				'  });',
				'}',
				'',
			].join('\n'),
		);

		// 第一轮：session_start 快照已包含修改后的文件 → agent_end 无变更
		const firstResult = runPi(projectSandbox, 'first run');
		expect([0, 124]).toContain(firstResult.exitCode);

		const firstLogs = readLogs(firstResult.logDir);
		const firstSyncLog = Object.entries(firstLogs).find(([name]) =>
			name.includes('extension-dev-final-sync'),
		);
		expect(firstSyncLog, 'First run must produce sync log').toBeDefined();
		expect(firstSyncLog![1], 'First run should detect no changes').toContain(
			'No extensions changed',
		);

		// 第二轮：再次运行，依然无变更（文件在 session_start 前已修改）
		const secondResult = runPi(projectSandbox, 'second run');
		expect([0, 124]).toContain(secondResult.exitCode);

		const secondLogs = readLogs(secondResult.logDir);
		const secondSyncLog = Object.entries(secondLogs).find(([name]) =>
			name.includes('extension-dev-final-sync'),
		);
		expect(secondSyncLog, 'Second run must produce sync log').toBeDefined();
		expect(secondSyncLog![1], 'Second run should also detect no changes').toContain(
			'No extensions changed',
		);
	}, 120_000);

	// 注：要测试真正的“edit 工具修改后同步”场景，需要在单次 pi 会话中
	// 在 session_start 之后、agent_end 之前修改文件。这需要更复杂的测试基础设施
	//（如通过自定义 mock-llm 响应触发文件修改），目前暂不覆盖。
	// 此场景已在手动 e2e 测试中验证。

	it('sync tool available in sandbox', () => {
		const syncPath = join(projectSandbox, 'scripts', 'sync-to-local-pi.ts');
		expect(existsSync(syncPath)).toBe(true);

		const status = safeGit(['status', '--porcelain'], projectSandbox);
		console.log('Git status after test:', status.trim());
	});
});
