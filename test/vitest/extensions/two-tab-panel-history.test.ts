/**
 * two-tab-panel 历史/分析范围 — headless 测试（UX3）
 *
 * 验证：历史二级 tab（会话 ⊂ 项目 ⊂ 全部）筛选、表头、用户层项目路径列（缩写）、
 * 旧记录「未知」归属、详情溯源（项目全路径 + 会话名）、分析按来源范围聚合。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
	TwoTabPanel,
	type PanelTheme,
} from '../../../extensions/security/permission-gate/two-tab-panel';
import { getDefaultConfig } from '../../../extensions/security/permission-gate/config';
import { resetRulesStore } from '../../../extensions/security/permission-gate/approval-store';
import { resetManualStrategiesStore } from '../../../extensions/security/permission-gate/manual-strategies';
import {
	resetAuditStore,
	type AuditEntry,
} from '../../../extensions/security/permission-gate/audit-log';
import { resetSessionsRoot } from '../../../extensions/security/permission-gate/origins';
import { getProjectKey } from '../../../extensions/security/permission-gate/records';
import { stripAnsi } from '../../../src/tui-testing/index.js';

const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const TAB = '\t';
const ENTER = '\r';

let tmpDir: string;
let tmpHome: string;
let tmpCwd: string;
const origHome = process.env.HOME;
const CUR_SESSION = 'session-cur-0001';

function mockTheme(): PanelTheme {
	return { fg: (_c: string, t: string) => t, bold: (s: string) => s };
}

/** 审计分片目录（tmpHome 隔离注入） */
function auditDir(): string {
	return join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate', 'audit');
}

function appendEntries(entries: AuditEntry[]): void {
	mkdirSync(auditDir(), { recursive: true });
	const file = join(auditDir(), '2026-09-02.jsonl');
	const lines = entries.map((e) => JSON.stringify(e)).join('\n');
	writeFileSync(file, lines + '\n', 'utf8');
}

beforeEach(() => {
	tmpDir = join(tmpdir(), `two-tab-history-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	// cwd 放 home 下 → 列表缩写可呈现 ~/W/repo
	tmpCwd = join(tmpHome, 'W', 'repo');
	mkdirSync(tmpCwd, { recursive: true });
	mkdirSync(tmpHome, { recursive: true });
	process.env.HOME = tmpHome;
	resetRulesStore({ homeDir: tmpHome, cwd: tmpCwd });
	resetManualStrategiesStore({ homeDir: tmpHome, cwd: tmpCwd });
	resetAuditStore(tmpHome);
	resetSessionsRoot(join(tmpHome, '.pi', 'agent', 'sessions'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	process.env.HOME = origHome;
});

function setup() {
	const config = getDefaultConfig();
	const panel = new TwoTabPanel({
		tui: { requestRender: () => {} },
		theme: mockTheme(),
		onClose: () => {},
		ctx: {
			cwd: tmpCwd,
			sessionManager: {
				getSessionId: () => CUR_SESSION,
				getSessionName: () => undefined,
			},
			ui: { input: async () => undefined },
		} as never,
		config,
		onConfigChanged: () => {},
	});
	return { panel, config };
}

/** 切到一级 tab（Tab 循环） */
function gotoLayer(panel: TwoTabPanel, target: string): void {
	const order = ['session', 'project', 'user', 'history', 'analytics', 'settings'];
	const idx = order.indexOf(target);
	for (let i = 0; i < idx; i++) panel.handleInput(TAB);
}

function render(panel: TwoTabPanel): string {
	return panel.render(80).map(stripAnsi).join('\n');
}

/** 当前项目 key（path hash，无 git remote） */
function curKey(): string {
	return getProjectKey(tmpCwd);
}

function makeEntry(p: Partial<AuditEntry> & { decision: AuditEntry['decision'] }): AuditEntry {
	return {
		id: p.id ?? 'x',
		ts: p.ts ?? '2026-09-02T10:00:00.000Z',
		tool: 'bash',
		command: p.command ?? 'rm -rf ./target',
		tier: 'critical',
		reasons: ['rm-rf'],
		projectKey: curKey(),
		...p,
	};
}

describe('历史二级 tab 来源范围（UX3）', () => {
	it('默认用户范围：含全部记录（当前会话/旧记录/他项目），行显示缩写路径，表头存在', () => {
		appendEntries([
			makeEntry({
				decision: 'deny',
				sessionId: CUR_SESSION,
				projectPath: tmpCwd,
				command: 'rm -rf ./a',
			}),
			makeEntry({
				// 旧记录：无 sessionId/projectPath（迁移自 approvals.json）
				decision: 'deny',
				projectKey: curKey(),
				command: 'rm -rf ./old',
			}),
			makeEntry({
				decision: 'deny',
				sessionId: 'session-other',
				projectPath: join(tmpHome, 'Other', 'repo'),
				command: 'rm -rf ./b',
				projectKey: getProjectKey(join(tmpHome, 'Other', 'repo')),
			}),
		]);
		const { panel } = setup();
		gotoLayer(panel, 'history');
		const out = render(panel);
		// 二级 tab + 表头
		expect(out).toContain('[会话]  [项目]  [用户]');
		expect(out).toMatch(/状态 决策\s+项目/);
		// 缩写路径列（~/W/repo、~/O/repo）
		expect(out).toContain('~/W/repo');
		expect(out).toContain('~/O/repo');
		// 旧记录标「未知」
		expect(out).toContain('未知');
	});

	it('会话范围：仅当前会话记录（不含旧记录与他项目）', () => {
		appendEntries([
			makeEntry({ decision: 'deny', sessionId: CUR_SESSION, projectPath: tmpCwd }),
			makeEntry({ decision: 'deny' }), // 旧记录
			makeEntry({
				decision: 'deny',
				sessionId: 'session-other',
				projectPath: join(tmpHome, 'Other', 'repo'),
			}),
		]);
		const { panel } = setup();
		gotoLayer(panel, 'history');
		panel.handleInput(LEFT); // → 项目
		panel.handleInput(LEFT); // → 会话
		const out = render(panel);
		expect(out).toContain('rm -rf ./target');
		expect(out).not.toContain('未知');
	});

	it('项目范围：当前项目（含旧记录经 projectKey 匹配），不含他项目', () => {
		appendEntries([
			makeEntry({ decision: 'deny', sessionId: CUR_SESSION, projectPath: tmpCwd }),
			makeEntry({ decision: 'deny', projectKey: curKey(), command: 'rm -rf ./old' }), // 旧记录同项目
			makeEntry({
				decision: 'deny',
				projectPath: join(tmpHome, 'Other', 'repo'),
				command: 'rm -rf ./other',
				projectKey: getProjectKey(join(tmpHome, 'Other', 'repo')),
			}),
		]);
		const { panel } = setup();
		gotoLayer(panel, 'history');
		panel.handleInput(LEFT); // → 项目
		const out = render(panel);
		expect(out).toContain('rm -rf ./target');
		expect(out).toContain('rm -rf ./old'); // 旧记录（同项目）可见
		expect(out).not.toContain('rm -rf ./other'); // 他项目不可见
		expect(out).not.toContain('~/O/repo');
	});

	it('会话/项目范围表头无项目列；用户范围表头含项目列', () => {
		appendEntries([
			makeEntry({ decision: 'deny', sessionId: CUR_SESSION, projectPath: tmpCwd }),
			makeEntry({ decision: 'deny' }),
		]);
		const { panel } = setup();
		gotoLayer(panel, 'history');
		panel.handleInput(LEFT); // 项目
		expect(render(panel)).toMatch(/状态 决策\s+命令/);
		expect(render(panel)).not.toMatch(/状态 决策\s+项目/);
		panel.handleInput(RIGHT); // 回用户
		expect(render(panel)).toMatch(/状态 决策\s+项目/);
	});

	it('空范围空态消息（会话范围无当前会话记录）', () => {
		appendEntries([makeEntry({ decision: 'deny', sessionId: 'other' })]);
		const { panel } = setup();
		gotoLayer(panel, 'history');
		panel.handleInput(LEFT); // 项目
		panel.handleInput(LEFT); // 会话
		expect(render(panel)).toContain('会话级历史');
	});
});

describe('历史详情溯源（UX3）', () => {
	it('enter 详情显示项目全路径 + 会话 ID/名（改名后读最新）', () => {
		appendEntries([
			makeEntry({
				decision: 'deny',
				sessionId: CUR_SESSION,
				projectPath: tmpCwd,
				sessionName: '旧会话名',
			}),
		]);
		// 会话文件（改名后）：最新 session_info = 新名字
		const sdir = join(tmpHome, '.pi', 'agent', 'sessions', '--cwd-slug--');
		mkdirSync(sdir, { recursive: true });
		writeFileSync(
			join(sdir, `2026-09-01T00-00-00-000Z_${CUR_SESSION}.jsonl`),
			[
				JSON.stringify({ type: 'session', id: CUR_SESSION }),
				JSON.stringify({ type: 'session_info', name: '改名后的会话' }),
			].join('\n') + '\n',
			'utf8',
		);
		const { panel } = setup();
		gotoLayer(panel, 'history');
		panel.handleInput(ENTER); // 展开详情
		// 宽渲染：路径长于 80 列时详情会换行续行，用足够宽度断言单行完整路径
		const out = panel.render(200).map(stripAnsi).join('\n');
		expect(out).toContain(`项目: ${tmpCwd}`);
		expect(out).toContain('会话: 改名后的会话');
		expect(out).toContain(`会话ID: ${CUR_SESSION}`);
	});
});

describe('分析按来源范围聚合（UX3）', () => {
	it('会话范围只统计本会话；用户范围统计全部', () => {
		appendEntries([
			makeEntry({ decision: 'deny', sessionId: CUR_SESSION, projectPath: tmpCwd }),
			makeEntry({ decision: 'auto', sessionId: CUR_SESSION, projectPath: tmpCwd }),
			makeEntry({
				decision: 'deny',
				sessionId: 'other',
				projectPath: join(tmpHome, 'Other', 'repo'),
			}),
		]);
		const { panel } = setup();
		gotoLayer(panel, 'analytics'); // analyticsScope 默认 session
		let out = render(panel);
		expect(out).toContain('本次会话');
		expect(out).toContain('确认:0  自动:1  拦截:1');
		// 切到用户范围（环序 session→project→user，LEFT 一次即到 user）
		panel.handleInput(LEFT);
		out = render(panel);
		expect(out).toContain('全部项目');
		expect(out).toContain('确认:0  自动:1  拦截:2');
	});
});
