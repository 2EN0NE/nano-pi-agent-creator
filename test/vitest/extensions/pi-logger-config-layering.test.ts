/**
 * pi-logger — 配置分层与路径解析（AGENTS.md「pi-logger 例外」回归）
 *
 * 两条此前无任何自动化保护的不变量：
 *   1. **路径解析与标准一致**：pi-logger 为破 import 环把路径解析改为自带实现
 *      （`config.ts` 的 `resolveLoggerConfigPaths`），而 `scripts/check-config-compliance.ts`
 *      对整个 pi-logger 目录豁免 → 漂移没有任何门禁；一旦漂移，用户级/项目级配置
 *      **静默失效**（日志级别与输出目标不生效，所有扩展的排障同时降级）。
 *   2. **三层合并优先级** bundled → user → project（后者覆盖前者，且不丢 bundled 独有字段）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGGER = resolve(__dirname, '../../../extensions/meta/pi-logger');
const ORIGINAL_HOME = process.env.HOME;

let baseDir: string;
let cwd: string;
let home: string;

function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data));
}

beforeEach(() => {
	baseDir = mkdtempSync(join(tmpdir(), 'pi-logger-cfg-'));
	cwd = join(baseDir, 'project');
	home = join(baseDir, 'home');
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
	// loadConfiguration 内部用 homedir() 解析用户级路径 → 必须指向沙箱
	process.env.HOME = home;
});

afterEach(() => {
	process.env.HOME = ORIGINAL_HOME;
	rmSync(baseDir, { recursive: true, force: true });
});

describe('pi-logger 配置分层', () => {
	it('自带路径解析与 @zenone/pi-config 标准逐路径相等（漂移哨兵）', async () => {
		const { resolveLoggerConfigPaths } = await import(resolve(LOGGER, 'config.ts'));
		const { resolveConfigPaths } = await import('@zenone/pi-config');

		const mine = resolveLoggerConfigPaths(cwd, home);
		const std = resolveConfigPaths('pi-logger', { cwd, homeDir: home });

		expect(mine.userDir).toBe(std.userDir);
		expect(mine.userFile).toBe(std.userFile);
		expect(mine.projectDir).toBe(std.projectDir);
		expect(mine.projectFile).toBe(std.projectFile);
	});

	it('三层合并：project 覆盖 user、user 覆盖 bundled，bundled 独有字段不丢', async () => {
		// 用户级：把 file appender 级别收紧（bundled 为 trace）
		writeJson(join(home, '.pi/agent/extensions-data/pi-logger/config.json'), {
			defaultLevel: 'warn',
			appenders: { file: { level: 'warn' } },
		});
		// 项目级：覆盖 user 的 defaultLevel，并把日志目录改成 cwd 相对路径
		writeJson(join(cwd, '.pi/extensions-data/pi-logger/config.json'), {
			defaultLevel: 'debug',
			appenders: { file: { path: './rel-logs' } },
		});

		const { loadConfiguration, getRuntimeConfig } = await import(resolve(LOGGER, 'config.ts'));
		loadConfiguration(cwd);
		const cfg = getRuntimeConfig();

		expect(cfg.defaultLevel).toBe('debug'); // project 赢 user(warn) 赢 bundled(info)
		expect(cfg.appenders.file.level).toBe('warn'); // user 覆盖 bundled(trace)
		expect(cfg.appenders.file.path).toBe(resolve(cwd, 'rel-logs')); // 相对路径按 cwd 解析
		expect(cfg.appenders.file.pattern).toContain('%m'); // bundled 独有字段保留（合并不丢）
		expect(cfg.loggers.review).toBe('debug'); // bundled 的 loggers 未被覆盖（不丢）
	});

	it('无用户级/项目级文件时回退 bundled（不写死 homedir 绝对路径）', async () => {
		const { loadConfiguration, getRuntimeConfig } = await import(resolve(LOGGER, 'config.ts'));
		loadConfiguration(cwd);
		const cfg = getRuntimeConfig();

		expect(cfg.defaultLevel).toBe('info'); // bundled
		expect(cfg.appenders.file.path).toBe(resolve(cwd, '.pi/logs')); // bundled 的 './.pi/logs'
	});
});
