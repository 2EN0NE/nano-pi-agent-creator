/**
 * ViTest 测试辅助库 — 沙箱管理
 *
 * 提供与 bash run-e2e.sh 等价的沙箱创建/销毁能力，
 * 支持 Mock LLM 自动注入，方便在 Vitest 中编写结构化测试。
 */

import { execSync } from 'node:child_process';
import {
	mkdirSync,
	cpSync,
	existsSync,
	rmSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { resolve, dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录 */
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 临时测试目录 */
export const TMP_DIR = resolve(ROOT_DIR, '.pi/tmp');

export interface SandboxOptions {
	extensions?: string | string[];
	useMockLLM?: boolean;
}

export interface PiResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	logDir: string;
	elapsedMs: number;
}

/** 扩展分类子目录 */
const EXT_CATEGORIES = ['tui', 'context', 'security', 'auto', 'accuracy', 'verification', 'meta'];

/** 全局 pi 二进制缓存 */
let _piBin: string | null = null;

/**
 * 解析全局 pi 二进制路径，避免本地 node_modules/.bin/pi 旧版本
 */
export function resolvePiBin(): string {
	if (_piBin) return _piBin;

	const candidates: string[] = [];

	// 1. 环境变量 PI_BIN
	if (process.env.PI_BIN) {
		candidates.push(process.env.PI_BIN);
	}

	// 2. npm 全局前缀
	try {
		const prefix = execSync('npm config get prefix 2>/dev/null', {
			encoding: 'utf8',
			timeout: 3000,
		}).trim();
		if (prefix) candidates.push(`${prefix}/bin/pi`);
	} catch {
		/* ignore */
	}

	// 3. PATH 查找（排除 node_modules/.bin）
	try {
		const cleanPath = (process.env.PATH || '')
			.split(':')
			.filter((p) => !p.includes('node_modules/.bin'))
			.join(':');
		if (cleanPath) {
			const out = execSync('command -v pi 2>/dev/null || which pi 2>/dev/null', {
				encoding: 'utf8',
				timeout: 5000,
				env: { ...process.env, PATH: cleanPath },
			});
			const found = out.trim();
			if (found) candidates.push(found);
		}
	} catch {
		/* ignore */
	}

	for (const c of candidates) {
		if (existsSync(c)) {
			_piBin = c;
			return _piBin;
		}
	}

	_piBin = 'pi';
	return _piBin;
}

/**
 * 在沙箱中查找扩展源文件
 */
function findExtension(name: string): { path: string; isDir: boolean } | null {
	for (const cat of EXT_CATEGORIES) {
		const dir = resolve(ROOT_DIR, `extensions/${cat}/${name}`);
		if (existsSync(dir) && existsSync(resolve(dir, 'index.ts'))) {
			return { path: dir, isDir: true };
		}
	}

	const flatFile = resolve(ROOT_DIR, `extensions/${name}.ts`);
	if (existsSync(flatFile)) {
		return { path: flatFile, isDir: false };
	}

	for (const cat of EXT_CATEGORIES) {
		const catFile = resolve(ROOT_DIR, `extensions/${cat}/${name}.ts`);
		if (existsSync(catFile)) {
			return { path: catFile, isDir: false };
		}
	}

	// test/helpers/ 共享辅助扩展
	const testHelperDir = resolve(ROOT_DIR, `test/helpers/${name}`);
	const testHelperFile = resolve(ROOT_DIR, `test/helpers/${name}.ts`);
	if (existsSync(testHelperDir)) return { path: testHelperDir, isDir: true };
	if (existsSync(testHelperFile)) return { path: testHelperFile, isDir: false };

	// test/extensions/<target>/helpers/<name> 按约定放置的测试辅助扩展
	const testExtHelperDir = resolve(ROOT_DIR, 'test/extensions');
	if (existsSync(testExtHelperDir)) {
		const entries = readdirSync(testExtHelperDir);
		for (const entry of entries) {
			// 目录形式：test/extensions/<target>/helpers/<name>/index.ts
			const helperDirPath = resolve(testExtHelperDir, entry, 'helpers', name);
			const helperIndex = resolve(helperDirPath, 'index.ts');
			if (existsSync(helperIndex)) {
				return { path: helperDirPath, isDir: true };
			}
			// 单文件形式：test/extensions/<target>/helpers/<name>.ts
			const helperFile = resolve(testExtHelperDir, entry, 'helpers', `${name}.ts`);
			if (existsSync(helperFile)) {
				return { path: helperFile, isDir: false };
			}
		}
	}

	return null;
}

/**
 * 创建隔离测试沙箱
 */
export function createSandbox(options: SandboxOptions = {}): string {
	const slug = `vitest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const testHome = resolve(TMP_DIR, slug);
	mkdirSync(testHome, { recursive: true });

	const piExtDir = resolve(testHome, '.pi/extensions');
	const piLogsDir = resolve(testHome, '.pi/logs');
	mkdirSync(piExtDir, { recursive: true });
	mkdirSync(piLogsDir, { recursive: true });

	let extList: string[] = [];
	if (typeof options.extensions === 'string') {
		extList = options.extensions
			.split(',')
			.map((e) => e.trim())
			.filter(Boolean);
	} else if (Array.isArray(options.extensions)) {
		extList = options.extensions;
	}

	const ciMode = process.env.CI === 'true';
	const useMock = options.useMockLLM ?? ciMode;
	if (useMock && !extList.some((e) => e.startsWith('mock-llm'))) {
		extList.unshift('mock-llm');
	}

	for (const extName of extList) {
		const found = findExtension(extName);
		if (!found) {
			console.warn(`[sandbox] Extension not found: ${extName}`);
			continue;
		}
		const target = resolve(piExtDir, extName);
		if (found.isDir) {
			cpSync(found.path, target, { recursive: true });
		} else {
			mkdirSync(target, { recursive: true });
			cpSync(found.path, resolve(target, 'index.ts'));
		}
	}

	const piLoggerCfg = resolve(ROOT_DIR, 'extensions/meta/pi-logger/pi-logger.json');
	if (existsSync(piLoggerCfg)) {
		cpSync(piLoggerCfg, resolve(testHome, '.pi/pi-logger.json'));
	}

	const isolatedHome = resolve(testHome, 'home');
	mkdirSync(isolatedHome, { recursive: true });
	const homeAgent = resolve(isolatedHome, '.pi/agent');
	mkdirSync(homeAgent, { recursive: true });

	// 模型配置：仅 useMock || CI 时写入 mock 配置；否则复制用户真实配置
	if (useMock || ciMode) {
		writeFileSync(
			resolve(homeAgent, 'models-store.json'),
			JSON.stringify(
				{
					'mock-llm': {
						models: [
							{
								id: 'mock-model-1',
								name: 'Mock Model (CI)',
								api: 'openai-completions',
								provider: 'mock-llm',
								apiKey: 'ci-noop-key',
								baseUrl: 'http://localhost:0',
							},
						],
						default: 'mock-model-1',
					},
				},
				null,
				2,
			),
		);
	} else {
		// 非 mock 模式：复制用户真实配置
		const realHome = process.env.HOME || '';
		const userModels = resolve(realHome, '.pi/agent/models-store.json');
		const userModelsLegacy = resolve(realHome, '.pi/agent/models.json');
		if (existsSync(userModels)) {
			cpSync(userModels, resolve(homeAgent, 'models-store.json'));
		} else if (existsSync(userModelsLegacy)) {
			cpSync(userModelsLegacy, resolve(homeAgent, 'models-store.json'));
		}
	}

	// @zenone/pi-logger 符号链接（与 bash run-e2e.sh 行为一致）
	const sandboxNodeModules = resolve(testHome, 'node_modules/@zenone');
	mkdirSync(sandboxNodeModules, { recursive: true });
	const piLoggerTarget = resolve(sandboxNodeModules, 'pi-logger');
	if (!existsSync(piLoggerTarget)) {
		try {
			rmSync(piLoggerTarget, { force: true });
		} catch {
			/* ignore */
		}
		const piLoggerSrc = resolve(ROOT_DIR, 'extensions/meta/pi-logger');
		if (existsSync(piLoggerSrc)) {
			// 目录扩展用符号链接（避免 jiti 在 fork 中找不到本地包）
			cpSync(piLoggerSrc, piLoggerTarget, { recursive: true });
		}
	}

	const piCfgH = resolve(testHome, '.pi/pi-logger.json');
	if (existsSync(piCfgH)) {
		cpSync(piCfgH, resolve(homeAgent, 'pi-logger.json'));
	}

	return testHome;
}

/**
 * 销毁测试沙箱
 */
export function destroySandbox(testHome: string): void {
	if (testHome && testHome.startsWith(TMP_DIR) && existsSync(testHome)) {
		rmSync(testHome, { recursive: true, force: true });
	}
}

/**
 * 在沙箱中运行 pi（同步执行，更适合 forked 环境）
 */
export function runPi(testHome: string, prompt: string, timeoutMs = 60_000): PiResult {
	const isolatedHome = resolve(testHome, 'home');
	const start = Date.now();
	const piBin = process.env.PI_BIN || resolvePiBin();

	// 构建运行环境 PATH：全局 npm bin 目录优先
	const piDir = dirname(piBin === 'pi' ? resolvePiBin() : piBin);
	const cleanPath = [
		piDir,
		...(process.env.PATH || '').split(':').filter((p) => !p.includes('node_modules/.bin')),
	].join(':');

	const execEnv = {
		...process.env,
		HOME: isolatedHome,
		PATH: cleanPath,
	};

	try {
		const stdout = execSync(`${piBin} -a --no-session -p ${JSON.stringify(prompt)}`, {
			cwd: testHome,
			timeout: timeoutMs,
			env: execEnv,
			maxBuffer: 10 * 1024 * 1024,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		return {
			stdout: stdout.toString(),
			stderr: '',
			exitCode: 0,
			logDir: resolve(testHome, '.pi/logs'),
			elapsedMs: Date.now() - start,
		};
	} catch (err: unknown) {
		const e = err as {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			status?: number;
			code?: number;
			message?: string;
		};
		return {
			stdout: (e.stdout || '').toString(),
			stderr: (e.stderr || '').toString(),
			exitCode: typeof e.status === 'number' ? e.status : 1,
			logDir: resolve(testHome, '.pi/logs'),
			elapsedMs: Date.now() - start,
		};
	}
}

/**
 * 读取日志目录内容
 */
export function readLogs(logDir: string): Record<string, string> {
	const logs: Record<string, string> = {};
	if (!existsSync(logDir)) return logs;
	for (const file of readdirSync(logDir)) {
		if (file.endsWith('.log')) {
			logs[file] = readFileSync(pathJoin(logDir, file), 'utf-8');
		}
	}
	return logs;
}

/**
 * 检查 stdout 中是否有 mock LLM 回复
 */
export function hasMockResponse(stdout: string): boolean {
	return stdout.includes('Mock LLM is ready.');
}

/**
 * 检查日志中是否有 ERROR 级别记录
 */
export function hasErrorInLogs(logDir: string): boolean {
	if (!existsSync(logDir)) return false;
	for (const file of readdirSync(logDir)) {
		if (file.endsWith('.log')) {
			const content = readFileSync(pathJoin(logDir, file), 'utf-8');
			if (content.includes('ERROR')) return true;
		}
	}
	return false;
}
