/**
 * custom-rename pure — 纯函数与 pi-config 双层配置读写测试。
 *
 * 覆盖：countSuccessfulAssistantReplies / cleanTitle / normalizeRenameConfig /
 * 环境变量覆盖 / loadRenameConfig（双层合并）/ saveRenameConfig（用户级原子写）。
 *
 * 文件系统隔离：__setStoreForTest(createRenameStore({ cwd, homeDir })) 注入临时目录，
 * 不读写真实 ~/.pi/agent/extensions-data。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	cleanTitle,
	countAssistantReplies,
	countSuccessfulAssistantReplies,
	createRenameStore,
	DEFAULT_RENAME_CONFIG,
	loadFileRenameConfig,
	loadRenameConfig,
	normalizeRenameConfig,
	saveRenameConfig,
	__setStoreForTest,
} from '../../../extensions/tui/custom-rename/src/pure.js';

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
	tmpHome = mkdtempSync(join(tmpdir(), 'custom-rename-home-'));
	tmpCwd = mkdtempSync(join(tmpdir(), 'custom-rename-cwd-'));
	__setStoreForTest(createRenameStore({ cwd: tmpCwd, homeDir: tmpHome }));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmpHome, { recursive: true, force: true });
	rmSync(tmpCwd, { recursive: true, force: true });
});

// ── countAssistantReplies / countSuccessfulAssistantReplies ──

describe('countSuccessfulAssistantReplies', () => {
	it('混合 stopReason（stop×1/toolUse/error/length/user/compaction）→ 只数 stop 的 assistant', () => {
		const entries = [
			{ type: 'message', message: { role: 'user' } },
			{ type: 'message', message: { role: 'assistant', stopReason: 'stop' } },
			{ type: 'message', message: { role: 'assistant', stopReason: 'toolUse' } },
			{ type: 'message', message: { role: 'assistant', stopReason: 'error' } },
			{ type: 'message', message: { role: 'assistant', stopReason: 'length' } },
			{ type: 'compaction' },
		];
		expect(countSuccessfulAssistantReplies(entries)).toBe(1);
	});

	it('2 个 stop → 2（已有成功轮后不再触发）', () => {
		const entries = [
			{ type: 'message', message: { role: 'assistant', stopReason: 'stop' } },
			{ type: 'message', message: { role: 'assistant', stopReason: 'stop' } },
		];
		expect(countSuccessfulAssistantReplies(entries)).toBe(2);
	});

	it('仅 error 轮 → 0（error 轮不命名，延迟到下一成功轮）', () => {
		const entries = [{ type: 'message', message: { role: 'assistant', stopReason: 'error' } }];
		expect(countSuccessfulAssistantReplies(entries)).toBe(0);
	});

	it('assistant 无 stopReason 字段 → 不计（只认显式 stop）', () => {
		const entries = [{ type: 'message', message: { role: 'assistant' } }];
		expect(countSuccessfulAssistantReplies(entries)).toBe(0);
	});
});

describe('countAssistantReplies', () => {
	it('[user, assistant] → 1；非 message entry 不计', () => {
		const entries = [
			{ type: 'message', message: { role: 'user' } },
			{ type: 'message', message: { role: 'assistant' } },
			{ type: 'toolResult' },
		];
		expect(countAssistantReplies(entries)).toBe(1);
	});
});

// ── cleanTitle ──

describe('cleanTitle', () => {
	it('trim 首尾空白', () => {
		expect(cleanTitle('  修复登录 bug  ', 50)).toBe('修复登录 bug');
	});

	it('去引号 + markdown 强调', () => {
		expect(cleanTitle('"**重构 API 层**"', 50)).toBe('重构 API 层');
	});

	it('去中文引号', () => {
		expect(cleanTitle('“标题”', 50)).toBe('标题');
	});

	it('空串 / 纯空白 → 空串', () => {
		expect(cleanTitle('', 50)).toBe('');
		expect(cleanTitle('   ', 50)).toBe('');
	});

	it('多行标题（含 \\n）→ 换行压成单空格', () => {
		expect(cleanTitle('重构API层\n更新文档', 50)).toBe('重构API层 更新文档');
	});

	it('尾部中文句号/英文逗号清除；中间标点保留', () => {
		expect(cleanTitle('修复登录超时。', 50)).toBe('修复登录超时');
		expect(cleanTitle('refactor-loader,', 50)).toBe('refactor-loader');
		expect(cleanTitle('v1.2.3', 50)).toBe('v1.2.3');
	});

	it('超长文本截断到 maxLength 码点', () => {
		expect(cleanTitle('一二三四五六七八九十', 5)).toBe('一二三四五');
	});
});

// ── DEFAULT_RENAME_CONFIG / normalizeRenameConfig ──

describe('DEFAULT_RENAME_CONFIG', () => {
	it('默认值：enabled=false / model=空 ref / maxTitleLength=50 / thinkingLevel=off', () => {
		expect(DEFAULT_RENAME_CONFIG).toEqual({
			enabled: false,
			model: { type: 'ref', ref: '' },
			maxTitleLength: 50,
			thinkingLevel: 'off',
		});
	});
});

describe('normalizeRenameConfig', () => {
	it('非对象（null/array/string）→ 全默认', () => {
		expect(normalizeRenameConfig(null)).toEqual(DEFAULT_RENAME_CONFIG);
		expect(normalizeRenameConfig([1, 2])).toEqual(DEFAULT_RENAME_CONFIG);
		expect(normalizeRenameConfig('x')).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it('空对象 → 全默认', () => {
		expect(normalizeRenameConfig({})).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it('合法完整配置 → 原样返回', () => {
		const cfg = {
			enabled: true,
			model: { type: 'ref', ref: 'a/b' },
			maxTitleLength: 30,
			thinkingLevel: 'high',
		};
		expect(normalizeRenameConfig(cfg)).toEqual(cfg);
	});

	it('粒度容错：enabled 坏但 model/maxTitleLength 合法时各自独立处理', () => {
		const raw = {
			enabled: 'yes',
			model: { type: 'ref', ref: 'a/b' },
			maxTitleLength: 30,
		};
		expect(normalizeRenameConfig(raw)).toEqual({
			enabled: false,
			model: { type: 'ref', ref: 'a/b' },
			maxTitleLength: 30,
			thinkingLevel: 'off',
		});
	});

	it('model 非法（未知 type / 非 ref 形式）→ 回默认空 ref', () => {
		expect(normalizeRenameConfig({ model: { type: 'fallback' } }).model).toEqual(
			DEFAULT_RENAME_CONFIG.model,
		);
		expect(normalizeRenameConfig({ model: 'a/b' }).model).toEqual(DEFAULT_RENAME_CONFIG.model);
	});

	it('thinkingLevel 非法 → 回默认 off', () => {
		expect(normalizeRenameConfig({ thinkingLevel: 'ultra' }).thinkingLevel).toBe('off');
		expect(normalizeRenameConfig({ thinkingLevel: 42 }).thinkingLevel).toBe('off');
	});
});

// ── loadRenameConfig / saveRenameConfig（pi-config 双层 + env 覆盖） ──

describe('loadRenameConfig / saveRenameConfig', () => {
	it('无配置文件 → 默认值', () => {
		expect(loadRenameConfig()).toEqual(DEFAULT_RENAME_CONFIG);
		expect(loadFileRenameConfig()).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it('loadFileRenameConfig 不含 env 覆盖（面板保存基准，防 env 值固化进配置文件）', () => {
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: false, maxTitleLength: 30 });
		vi.stubEnv('PI_RENAME_ENABLED', 'true');
		vi.stubEnv('PI_RENAME_MODEL', 'deepseek/chat');
		vi.stubEnv('PI_RENAME_MAX_TITLE_LENGTH', '100');
		// 运行时配置：env 覆盖生效
		expect(loadRenameConfig().enabled).toBe(true);
		expect(loadRenameConfig().model).toEqual({ type: 'ref', ref: 'deepseek/chat' });
		// 文件层基准：仅反映落盘内容（用户级 enabled=false / maxTitleLength=30），env 不泄漏
		const fileCfg = loadFileRenameConfig();
		expect(fileCfg.enabled).toBe(false);
		expect(fileCfg.model).toEqual(DEFAULT_RENAME_CONFIG.model);
		expect(fileCfg.maxTitleLength).toBe(30);
	});

	it('saveRenameConfig 写用户级，loadRenameConfig 读回', () => {
		const ok = saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: true });
		expect(ok.success).toBe(true);
		expect(loadRenameConfig().enabled).toBe(true);
	});

	it('项目级覆盖用户级（双层合并）', () => {
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: true, maxTitleLength: 30 });
		const projectFile = join(tmpCwd, '.pi', 'extensions-data', 'custom-rename', 'config.json');
		mkdirSync(join(projectFile, '..'), { recursive: true });
		writeFileSync(projectFile, JSON.stringify({ maxTitleLength: 20 }), 'utf-8');
		const cfg = loadRenameConfig();
		expect(cfg.enabled).toBe(true); // 用户级保留
		expect(cfg.maxTitleLength).toBe(20); // 项目级覆盖
	});

	it('环境变量覆盖（PI_RENAME_*）优先级最高', () => {
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: false });
		vi.stubEnv('PI_RENAME_ENABLED', 'true');
		vi.stubEnv('PI_RENAME_MODEL', 'deepseek/chat');
		vi.stubEnv('PI_RENAME_MAX_TITLE_LENGTH', '100');
		vi.stubEnv('PI_RENAME_THINKING_LEVEL', 'minimal');
		const cfg = loadRenameConfig();
		expect(cfg.enabled).toBe(true);
		expect(cfg.model).toEqual({ type: 'ref', ref: 'deepseek/chat' });
		expect(cfg.maxTitleLength).toBe(100);
		expect(cfg.thinkingLevel).toBe('minimal');
	});

	it('环境变量无效值静默忽略（回落配置文件/默认）', () => {
		vi.stubEnv('PI_RENAME_ENABLED', 'yes');
		vi.stubEnv('PI_RENAME_MODEL', 'invalid');
		vi.stubEnv('PI_RENAME_MAX_TITLE_LENGTH', '-5');
		vi.stubEnv('PI_RENAME_THINKING_LEVEL', 'ultra');
		expect(loadRenameConfig()).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it('PI_RENAME_MODEL 含斜杠的 modelId（a/b/c）→ 接受（与 config ref 同口径 parseModelRef）', () => {
		vi.stubEnv('PI_RENAME_MODEL', 'deepseek/org/repo');
		const cfg = loadRenameConfig();
		expect(cfg.model).toEqual({ type: 'ref', ref: 'deepseek/org/repo' });
	});

	it('saveRenameConfig 确实落盘到用户级文件', () => {
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: true });
		const userFile = join(
			tmpHome,
			'.pi',
			'agent',
			'extensions-data',
			'custom-rename',
			'config.json',
		);
		expect(existsSync(userFile)).toBe(true);
		expect(JSON.parse(readFileSync(userFile, 'utf-8')).enabled).toBe(true);
	});
});
