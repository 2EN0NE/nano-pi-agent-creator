/**
 * plannotator-tui — 命令行为测试（headless，不启动 pi）
 *
 * 覆盖：Herdr 环境门控、二进制定位（PLANNOTATOR_TUI_BIN / plugins.json / 损坏清单）、
 * 四种评审的 argv 映射与 cwd、路径解析、未知参数与**已移除的终端批注参数**、
 * 顶层菜单的分发与取消。
 *
 * 外部依赖隔离：`PLANNOTATOR_TUI_BIN` 指向临时目录里的假脚本，仅记录 argv 与 cwd；
 * `pi.exec` 被替换为恒失败的桩（不真的跑 git）；pi-logger 被 mock 掉
 * （既不写真实 ~/.pi/logs，也可断言失败日志）。
 *
 * 候选集解析与选择器的渲染/按键分别在 `plannotator-tui-git.test.ts`、
 * `plannotator-tui-picker.test.ts` 覆盖，此处不重复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loggerCalls = vi.hoisted(() => [] as { level: string; message: string }[]);

vi.mock('@zenone/pi-logger', () => {
	const record = (level: string) => (message: string) => {
		loggerCalls.push({ level, message });
	};
	return {
		createLogger: () => ({
			info: record('info'),
			debug: record('debug'),
			warn: record('warn'),
			error: record('error'),
		}),
	};
});

import ext from '../../../extensions/tui/plannotator-tui/index.js';

type Handler = (args: string, ctx: any) => Promise<void>;

type ExecResult = { code: number; stdout: string; stderr: string; killed: boolean };
type ExecLike = (command: string, args: string[]) => Promise<ExecResult>;

/** 默认行为：所有 git 命令失败 → 任何仓库型入口都落到「不在 git 仓库里」。 */
const noRepo: ExecLike = async () => ({ code: 1, stdout: '', stderr: '', killed: false });

/** 一个"在仓库里"的 exec：`rev-parse` 成功，其余按 `afterRevParse` 决定。 */
function inRepo(afterRevParse: ExecLike): ExecLike {
	return async (command, args) => {
		if (args[0] === 'rev-parse') {
			return { code: 0, stdout: '/repo\n', stderr: '', killed: false };
		}
		return afterRevParse(command, args);
	};
}

/** 假 pi：只提供 handler 需要的两件事；`state.exec` 让各用例替换 git 行为。 */
function makePi() {
	let handler: Handler | undefined;
	const state: { exec: ExecLike } = { exec: noRepo };
	const pi = {
		registerCommand: (_name: string, def: { handler: Handler }) => {
			handler = def.handler;
		},
		exec: (command: string, args: string[]) => state.exec(command, args),
	};
	ext(pi as never);
	if (!handler) throw new Error('plannotator-tui 未注册命令');
	return { handler, pi, state };
}

const { handler, pi, state: piState } = makePi();

const PANE_ID = 'w9:p7';

/** `ui.custom` 的答案队列：字符串 = 顶层菜单选中项，undefined = 取消。 */
function makeCtx(menuAnswers: (string | undefined)[] = [], cwd = process.cwd()) {
	const notes: string[] = [];
	const pending = [...menuAnswers];
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			custom: async () => {
				const answer = pending.shift();
				notes.push(`custom -> ${answer}`);
				return answer;
			},
			notify: (message: string, level?: string) => {
				notes.push(`notify[${level ?? 'info'}] ${message}`);
			},
		},
	};
	return { ctx, notes };
}

let tmp: string;
let tuiLog: string;

/** 写一个只记录 argv / cwd 的假可执行文件。 */
function writeFake(name: string, body: string): string {
	const file = join(tmp, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}

function fakeTui(): string {
	return writeFake(
		'fake-plannotator-tui',
		`printf '%s\\n' "$*" >> "${tuiLog}"\nprintf 'cwd=%s\\n' "$(pwd)" >> "${tuiLog}"`,
	);
}

function tuiCalls(): string[] {
	if (!existsSync(tuiLog)) return [];
	return readFileSync(tuiLog, 'utf8').trim().split('\n').filter(Boolean);
}

function useHerdrEnv(overrides: Record<string, string> = {}): void {
	vi.stubEnv('HERDR_ENV', '1');
	vi.stubEnv('HERDR_PANE_ID', PANE_ID);
	for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'plannotator-tui-'));
	tuiLog = join(tmp, 'tui-calls.log');
	loggerCalls.length = 0;
	vi.stubEnv('PLANNOTATOR_TUI_BIN', '');
	piState.exec = noRepo;
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tmp, { recursive: true, force: true });
});

describe('plannotator-tui — Herdr 门控', () => {
	it('不在 Herdr 会话时告警并记录日志，不弹选择器', async () => {
		vi.stubEnv('HERDR_ENV', '');
		vi.stubEnv('HERDR_PANE_ID', '');
		const { ctx, notes } = makeCtx();

		await handler('', ctx);

		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain('当前不在 Herdr 会话里');
		expect(notes[0]).toContain('notify[warning]');
		expect(
			loggerCalls.some((c) => c.level === 'warn' && c.message.includes('不在 Herdr')),
		).toBe(true);
	});

	it('HERDR_ENV=1 但缺 HERDR_PANE_ID 同样视为不在 Herdr', async () => {
		vi.stubEnv('HERDR_ENV', '1');
		vi.stubEnv('HERDR_PANE_ID', '');
		const { ctx, notes } = makeCtx();

		await handler('last', ctx);

		expect(notes.join('\n')).toContain('当前不在 Herdr 会话里');
		expect(tuiCalls()).toHaveLength(0);
	});
});

describe('plannotator-tui — 二进制定位', () => {
	it('PLANNOTATOR_TUI_BIN 指向不存在的文件时给出明确提示', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: join(tmp, 'no-such-binary') });
		const { ctx, notes } = makeCtx();

		await handler('last', ctx);

		expect(notes.join('\n')).toContain(`PLANNOTATOR_TUI_BIN 指向的文件不存在：${tmp}`);
		expect(loggerCalls.some((c) => c.level === 'warn')).toBe(true);
	});

	it('既无覆盖也无 plugins.json 时提示 annotate 插件未安装', async () => {
		useHerdrEnv();
		// 无 PLANNOTATOR_TUI_BIN 覆盖 → 走 ~/.config/herdr/plugins.json 探测；用临时 HOME 隔离
		const emptyHome = join(tmp, 'home');
		vi.stubEnv('HOME', emptyHome);
		const { ctx, notes } = makeCtx();

		await handler('terminal', ctx);

		expect(notes.join('\n')).toContain('找不到 plannotator-tui');
		expect(tuiCalls()).toHaveLength(0);
	});

	it('从 plugins.json 的 annotate 安装目录发现二进制（生产路径）', async () => {
		useHerdrEnv();
		const home = join(tmp, 'home');
		const root = join(home, 'plugins', 'annotate');
		mkdirSync(join(root, 'bin'), { recursive: true });
		mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
		const binary = join(root, 'bin', 'plannotator-tui.exe');
		writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${tuiLog}"\n`, { mode: 0o755 });
		writeFileSync(
			join(home, '.config', 'herdr', 'plugins.json'),
			JSON.stringify([
				{ plugin_id: 'other', plugin_root: join(home, 'plugins', 'other') },
				{ plugin_id: 'annotate', plugin_root: root },
			]),
		);
		vi.stubEnv('HOME', home);
		const { ctx } = makeCtx();

		await handler('last', ctx);

		expect(tuiCalls()[0]).toBe(`herdr last --deliver-to ${PANE_ID}`);
	});

	it('plugins.json 损坏时给出可读提示，不抛异常', async () => {
		useHerdrEnv();
		const home = join(tmp, 'home');
		mkdirSync(join(home, '.config', 'herdr'), { recursive: true });
		writeFileSync(join(home, '.config', 'herdr', 'plugins.json'), '{ not json');
		vi.stubEnv('HOME', home);
		const { ctx, notes } = makeCtx();

		await expect(handler('last', ctx)).resolves.toBeUndefined();

		expect(notes.join('\n')).toContain('读取 Herdr 插件清单失败');
		expect(
			loggerCalls.some(
				(c) => c.level === 'warn' && c.message.includes('读取 Herdr 插件清单失败'),
			),
		).toBe(true);
		expect(tuiCalls()).toHaveLength(0);
	});
});

describe('plannotator-tui — 评审 argv 映射', () => {
	it.each([
		['last', 'herdr last --deliver-to ' + PANE_ID],
		['newest', 'herdr last --newest --deliver-to ' + PANE_ID],
		['terminal', 'herdr terminal --deliver-to ' + PANE_ID],
	])('%s → %s', async (alias, expected) => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const { ctx } = makeCtx();

		await handler(alias, ctx);

		expect(tuiCalls()[0]).toBe(expected);
		expect(tuiCalls()).toContain(`cwd=${realpathSync(process.cwd())}`);
	});

	it('存在的文件路径 → herdr open <绝对路径>', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const doc = join(tmp, 'note.md');
		writeFileSync(doc, '# hi\n');
		const { ctx } = makeCtx();

		await handler(doc, ctx);

		expect(tuiCalls()[0]).toBe(`herdr open ${doc} --deliver-to ${PANE_ID}`);
	});

	it('相对路径按 ctx.cwd 解析（不是 process.cwd）', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const workdir = join(tmp, 'project');
		mkdirSync(workdir);
		writeFileSync(join(workdir, 'note.md'), '# hi\n');
		const { ctx } = makeCtx([], workdir);

		await handler('note.md', ctx);

		expect(tuiCalls()[0]).toBe(
			`herdr open ${join(workdir, 'note.md')} --deliver-to ${PANE_ID}`,
		);
	});

	it('open 别名 → 评审当前目录（文件夹模式）', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const workdir = join(tmp, 'project');
		mkdirSync(workdir);
		const { ctx } = makeCtx([], workdir);

		await handler('open', ctx);

		expect(tuiCalls()[0]).toBe(`herdr open ${workdir} --deliver-to ${PANE_ID}`);
	});
});

describe('plannotator-tui — 参数', () => {
	it('拼错的子命令给出用法提示，不当作路径', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const { ctx, notes } = makeCtx();

		await handler('sendd', ctx);

		expect(notes.join('\n')).toContain('无法识别的参数：sendd');
		expect(notes.join('\n')).toContain('可用：open | last | newest | terminal');
		expect(tuiCalls()).toHaveLength(0);
	});

	it.each(['send', 'paste'])('已移除的 %s 只提示、不调用二进制', async (removed) => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const { ctx, notes } = makeCtx();

		await handler(removed, ctx);

		expect(notes.join('\n')).toContain(`终端批注能力已移除：${removed}`);
		expect(loggerCalls.some((c) => c.level === 'warn' && c.message.includes('已移除'))).toBe(
			true,
		);
		expect(tuiCalls()).toHaveLength(0);
	});
});

describe('plannotator-tui — 顶层菜单', () => {
	it('取消菜单 → 无副作用', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const { ctx, notes } = makeCtx([undefined]);

		await handler('', ctx);

		expect(notes).toHaveLength(1);
		expect(tuiCalls()).toHaveLength(0);
	});

	it('agent 最新回复 → 交给 plannotator-tui 的 --newest', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const { ctx, notes } = makeCtx(['agent 最新回复']);

		await handler('', ctx);

		expect(tuiCalls()[0]).toBe(`herdr last --newest --deliver-to ${PANE_ID}`);
		expect(notes.join('\n')).toContain('已在 Herdr 面板打开：newest');
	});

	it('未提交的变更 → 非 git 仓库时给出可读提示', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		const { ctx, notes } = makeCtx(['未提交的变更…']);

		await handler('', ctx);

		expect(notes.join('\n')).toContain('当前目录不在 git 仓库里');
		expect(tuiCalls()).toHaveLength(0);
		expect(notes.join('\n')).not.toContain('notify[error]');
	});

	it('未提交的变更 → git 失败报 error（不伪装成「没有变更」）', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		piState.exec = inRepo(async () => ({
			code: 128,
			stdout: '',
			stderr: 'fatal: index file corrupt',
			killed: false,
		}));
		const { ctx, notes } = makeCtx(['未提交的变更…']);

		await handler('', ctx);

		expect(notes.join('\n')).toContain('无法读取未提交的变更：git status 失败');
		expect(notes.join('\n')).toContain('notify[error]');
		expect(
			loggerCalls.some((c) => c.level === 'warn' && c.message.includes('git status 失败')),
		).toBe(true);
		expect(tuiCalls()).toHaveLength(0);
	});

	it('未提交的变更 → 查询成功但为空时给出「没有变更」', async () => {
		useHerdrEnv({ PLANNOTATOR_TUI_BIN: fakeTui() });
		piState.exec = inRepo(async () => ({ code: 0, stdout: '', stderr: '', killed: false }));
		const { ctx, notes } = makeCtx(['未提交的变更…']);

		await handler('', ctx);

		expect(notes.join('\n')).toContain('没有未提交的变更');
		expect(notes.join('\n')).not.toContain('无法读取');
		expect(tuiCalls()).toHaveLength(0);
	});
});
