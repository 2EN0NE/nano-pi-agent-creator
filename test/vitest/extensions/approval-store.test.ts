/**
 * permission-gate — 放行规则三级持久化 Vitest 测试（T4，ADR-0025）
 *
 * 覆盖：critical→会话级（ADR-0033：跨 /reload 保留、30 天过期清理）、
 * warning→项目级、info→用户级、三层合并读取、会话文件过期清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, utimesSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
	resetRulesStore,
	setRulesSessionId,
	clearSessionRules,
	cleanupRulesStore,
	getRuleCounts,
	getRuleCountsWithScope,
	getRuleCountsByLayer,
	recordApproval,
	deleteRuleKey,
	deleteRuleKeyScoped,
	importRuleCounts,
	moveRuleKey,
} from '../../../extensions/security/permission-gate/approval-store';
import {
	resetManualStrategiesStore,
	setManualStrategiesSessionId,
	addManualStrategy,
	getManualStrategies,
	cleanupManualStrategiesStore,
} from '../../../extensions/security/permission-gate/manual-strategies';

let tmpDir: string;
let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `approval-store-test-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	tmpCwd = join(tmpDir, 'cwd');
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
	resetRulesStore({ homeDir: tmpHome, cwd: tmpCwd });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('放行规则三级持久化', () => {
	it('critical 沉淀到会话层，clearSession 后失效', () => {
		setRulesSessionId('sess-1');
		recordApproval('critical', ['cmd:abc']);
		expect(getRuleCounts()['cmd:abc']).toBe(1);

		clearSessionRules();
		expect(getRuleCounts()['cmd:abc']).toBeUndefined();
	});

	it('warning 沉淀到项目层，跨会话保留', () => {
		setRulesSessionId('sess-1');
		recordApproval('warning', ['tool:rm']);
		clearSessionRules();
		// 项目层不受会话清理影响
		expect(getRuleCounts()['tool:rm']).toBe(1);
	});

	it('info 沉淀到用户层，跨项目保留', () => {
		recordApproval('info', ['dir:/tmp']);
		expect(getRuleCounts()['dir:/tmp']).toBe(1);
	});

	it('同一 key 多次确认累加计数', () => {
		setRulesSessionId('sess-1');
		recordApproval('critical', ['cmd:abc']);
		recordApproval('critical', ['cmd:abc']);
		expect(getRuleCounts()['cmd:abc']).toBe(2);
	});

	it('不同 tier 的 key 互不污染', () => {
		setRulesSessionId('sess-1');
		recordApproval('critical', ['cmd:crit']);
		recordApproval('warning', ['cmd:warn']);
		recordApproval('info', ['cmd:info']);

		const counts = getRuleCounts();
		expect(counts['cmd:crit']).toBe(1);
		expect(counts['cmd:warn']).toBe(1);
		expect(counts['cmd:info']).toBe(1);

		// 清理会话后，只有 critical 的 key 消失
		clearSessionRules();
		const after = getRuleCounts();
		expect(after['cmd:crit']).toBeUndefined();
		expect(after['cmd:warn']).toBe(1);
		expect(after['cmd:info']).toBe(1);
	});

	it('critical 需要 sessionId，否则不记录', () => {
		// 未设置 sessionId 时，session 层不可用
		recordApproval('critical', ['cmd:nosess']);
		expect(getRuleCounts()['cmd:nosess']).toBeUndefined();
	});

	it('规则写入磁盘（project 层文件存在，独立于 config.json）', () => {
		recordApproval('warning', ['cmd:persist']);
		const projectFile = join(tmpCwd, '.pi', 'extensions-data', 'permission-gate', 'state.json');
		expect(existsSync(projectFile)).toBe(true);
	});
});

describe('getRuleCountsWithScope（三级持久化 UI 展示）', () => {
	it('返回每个 key 的计数与所在层级', () => {
		setRulesSessionId('sess-1');
		recordApproval('critical', ['cmd:crit']);
		recordApproval('warning', ['cmd:warn']);
		recordApproval('info', ['cmd:info']);

		const scoped = getRuleCountsWithScope();
		expect(scoped['cmd:crit']).toEqual({ count: 1, scope: 'session' });
		expect(scoped['cmd:warn']).toEqual({ count: 1, scope: 'project' });
		expect(scoped['cmd:info']).toEqual({ count: 1, scope: 'user' });
	});

	it('session 层优先级最高，覆盖同 key 的低层', () => {
		// 先记录 warning（project 层）
		recordApproval('warning', ['cmd:dup']);
		// 再记录 critical（session 层），同 key
		setRulesSessionId('sess-1');
		recordApproval('critical', ['cmd:dup']);

		const scoped = getRuleCountsWithScope();
		expect(scoped['cmd:dup']).toEqual({ count: 1, scope: 'session' });
	});

	it('无规则时返回空对象', () => {
		expect(getRuleCountsWithScope()).toEqual({});
	});
});

describe('deleteRuleKey（ADR-0027 删除策略）', () => {
	it('跨三层删除指定 key，审计保留（不涉及 audit）', () => {
		setRulesSessionId('sess-1');
		recordApproval('warning', ['cmd:del']);
		recordApproval('info', ['cmd:del']);
		expect(getRuleCounts()['cmd:del']).toBeTruthy();

		const deleted = deleteRuleKey('cmd:del');
		expect(deleted).toBe(true);
		expect(getRuleCounts()['cmd:del']).toBeUndefined();
	});

	it('删除不存在的 key 返回 false', () => {
		expect(deleteRuleKey('cmd:nonexistent')).toBe(false);
	});
});

describe('importRuleCounts（迁移旧 approvalCounts）', () => {
	it('批量导入计数到 warning 层，支持任意 N', () => {
		importRuleCounts({ 'cmd:a': 5, 'tool:rm': 3 }, 'warning');
		const counts = getRuleCounts();
		expect(counts['cmd:a']).toBe(5);
		expect(counts['tool:rm']).toBe(3);
	});
});

describe('getRuleCountsByLayer（ADR-0029 分层展示）', () => {
	it('返回三层完整独立计数，不遮蔽合并', () => {
		setRulesSessionId('sess-1');
		recordApproval('critical', ['cmd:crit']);
		recordApproval('warning', ['cmd:warn']);
		recordApproval('info', ['cmd:info']);

		const byLayer = getRuleCountsByLayer();
		expect(byLayer.session['cmd:crit']).toBe(1);
		expect(byLayer.project['cmd:warn']).toBe(1);
		expect(byLayer.user['cmd:info']).toBe(1);
	});

	it('同名 key 可同时出现在多层（判定层仍保守遮蔽）', () => {
		setRulesSessionId('sess-1');
		recordApproval('warning', ['tool:rm']); // project 层
		recordApproval('critical', ['tool:rm']); // session 层

		const byLayer = getRuleCountsByLayer();
		expect(byLayer.project['tool:rm']).toBe(1);
		expect(byLayer.session['tool:rm']).toBe(1);
		// 保守合并仍以 session 层为准，判定层语义不变
		expect(getRuleCounts()['tool:rm']).toBe(1);
	});

	it('无规则时三层均为空对象', () => {
		const byLayer = getRuleCountsByLayer();
		expect(byLayer.session).toEqual({});
		expect(byLayer.project).toEqual({});
		expect(byLayer.user).toEqual({});
	});
});

describe('moveRuleKey（ADR-0030 m 键调级）', () => {
	it('计数从源层迁移到目标层（源删目标累加，非复制）', () => {
		setRulesSessionId('sess-1');
		recordApproval('warning', ['cmd:mv']); // project 层 +1
		recordApproval('warning', ['cmd:mv']); // project 层再 +1 → 计数 2
		expect(getRuleCountsByLayer().project['cmd:mv']).toBe(2);

		const moved = moveRuleKey('cmd:mv', 'project', 'user');
		expect(moved).toBe(true);

		const byLayer = getRuleCountsByLayer();
		expect(byLayer.project['cmd:mv']).toBeUndefined();
		expect(byLayer.user['cmd:mv']).toBe(2);
	});

	it('同层迁移返回 false（无操作）', () => {
		expect(moveRuleKey('cmd:x', 'project', 'project')).toBe(false);
	});

	it('源层无该 key 返回 false', () => {
		expect(moveRuleKey('cmd:nonexistent', 'project', 'user')).toBe(false);
	});
});

describe('deleteRuleKeyScoped（ADR-0029 按层删除）', () => {
	it('只删除指定层，其余层保留', () => {
		setRulesSessionId('sess-1');
		recordApproval('warning', ['cmd:dup']); // project 层
		recordApproval('critical', ['cmd:dup']); // session 层

		const deleted = deleteRuleKeyScoped('cmd:dup', 'project');
		expect(deleted).toBe(true);

		const byLayer = getRuleCountsByLayer();
		expect(byLayer.project['cmd:dup']).toBeUndefined();
		expect(byLayer.session['cmd:dup']).toBe(1);
	});

	it('删除不存在的 key 返回 false', () => {
		expect(deleteRuleKeyScoped('cmd:nonexistent', 'project')).toBe(false);
	});
});

describe('graduated 计数与会话手动策略共存（会话层同文件）', () => {
	it('同一会话文件互不覆盖，clearSession 同时清空两层', () => {
		resetManualStrategiesStore({ homeDir: tmpHome, cwd: tmpCwd });
		setRulesSessionId('sess-co');
		setManualStrategiesSessionId('sess-co');

		recordApproval('critical', ['cmd:co']);
		addManualStrategy('cmd:co', 'echo ok', 'session');

		expect(getRuleCounts()['cmd:co']).toBe(1);
		expect(getManualStrategies()['cmd:co']).toBeTruthy();

		// 显式 clearSession：同一会话文件被清除 → 计数与手动策略同时失效
		clearSessionRules();
		expect(getRuleCounts()['cmd:co']).toBeUndefined();
		expect(getManualStrategies()['cmd:co']).toBeUndefined();
	});
});

describe('会话级放行规则跨 /reload 持久化（ADR-0033）', () => {
	it('setSessionId(null) 解绑不删除文件，重新绑定后计数仍存在', () => {
		setRulesSessionId('sess-1');
		recordApproval('critical', ['cmd:reload']);
		const sessionFile = join(
			tmpHome,
			'.pi',
			'agent',
			'extensions-data',
			'permission-gate',
			'sess-1.json',
		);
		expect(existsSync(sessionFile)).toBe(true);

		// 模拟 /reload：session_shutdown 仅解绑（不删文件），session_start 重新绑定
		setRulesSessionId(null);
		expect(existsSync(sessionFile)).toBe(true);

		setRulesSessionId('sess-1');
		expect(getRuleCounts()['cmd:reload']).toBe(1);
	});

	it('cleanupRulesStore 保留固定状态文件，仅删超期会话文件', () => {
		const dir = join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate');
		const sessionFile = join(dir, 'sess-old.json');
		const stateFile = join(dir, 'state.json');
		const manualFile = join(dir, 'manual-strategies.json');

		// 一个超期的会话文件（critical 放行规则落盘）
		setRulesSessionId('sess-old');
		recordApproval('critical', ['cmd:old']);
		const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(sessionFile, oldTime, oldTime);

		// 同目录下两个「永久」状态文件，mtime 也超 30 天（模拟长期未改动）
		mkdirSync(dir, { recursive: true });
		const stateJson = JSON.stringify({ counts: { 'cmd:perm': 5 } });
		const manualJson = JSON.stringify({ strategies: { 'cmd:m': { command: 'echo m' } } });
		writeFileSync(stateFile, stateJson, 'utf8');
		writeFileSync(manualFile, manualJson, 'utf8');
		utimesSync(stateFile, oldTime, oldTime);
		utimesSync(manualFile, oldTime, oldTime);

		const result = cleanupRulesStore(30);

		// 会话文件被清理，state.json / manual-strategies.json 均保留
		expect(result.removed).toBe(1);
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(stateFile)).toBe(true);
		expect(existsSync(manualFile)).toBe(true);
		// 永久状态内容未被破坏
		expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ counts: { 'cmd:perm': 5 } });
		expect(JSON.parse(readFileSync(manualFile, 'utf8'))).toEqual({
			strategies: { 'cmd:m': { command: 'echo m' } },
		});
	});

	it('cleanupManualStrategiesStore 同样保留 state.json（兄弟 store 文件）', () => {
		resetManualStrategiesStore({ homeDir: tmpHome, cwd: tmpCwd });
		const dir = join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate');
		const sessionFile = join(dir, 'sess-manual.json');
		const stateFile = join(dir, 'state.json');

		// 会话级手动策略落盘
		setManualStrategiesSessionId('sess-manual');
		addManualStrategy('cmd:m', 'echo m', 'session');
		const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(sessionFile, oldTime, oldTime);

		// 兄弟 store（approval-store）的 state.json，超期但必须保留
		mkdirSync(dir, { recursive: true });
		writeFileSync(stateFile, JSON.stringify({ counts: { 'cmd:keep': 3 } }), 'utf8');
		utimesSync(stateFile, oldTime, oldTime);

		const result = cleanupManualStrategiesStore(30);

		expect(result.removed).toBe(1);
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(stateFile)).toBe(true);
	});
});
