/**
 * permission-gate — 出处账本 Vitest 测试（Ticket 03 / ADR-0025 第四轴）
 *
 * 覆盖：解析阶梯 ①命令内字面路径片段 ②命令内变量绑定 ③跨命令变量账本
 * ④不可判定（失败即拒绝）、六类创建动作、按会话 ID 从审计日志重建。
 *
 * 用例取自本仓真实审计数据里的实际命令形态（`rm -rf "$T"` 占 54%）。
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import {
	ProvenanceLedger,
	tokenizeExpressions,
} from '../../../extensions/security/permission-gate/provenance';
import type { AuditEntry } from '../../../extensions/security/permission-gate/audit-log';

const CWD = '/proj';

function auditEntry(over: Partial<AuditEntry> & { ts?: string }): AuditEntry {
	return {
		id: 'id-' + Math.random(),
		ts: over.ts ?? '2026-09-12T10:00:00.000Z',
		tool: 'bash',
		command: 'cmd',
		tier: 'warning',
		decision: 'allow',
		reasons: [],
		...over,
	};
}

describe('tokenizeExpressions', () => {
	it('去掉引号（目标表达式保留变量引用）', () => {
		expect(tokenizeExpressions('rm -rf "$T"')).toEqual(['rm', '-rf', '$T']);
	});

	it('$(...) 内的空白不切分 token', () => {
		expect(tokenizeExpressions('T=$(mktemp -d) && ls')).toEqual(['T=$(mktemp -d)', '&&', 'ls']);
	});

	it('单引号内容不解析', () => {
		expect(tokenizeExpressions("echo '$A b'")).toEqual(['echo', '$A b']);
	});
});

describe('阶梯① — 命令内字面路径片段', () => {
	it('同命令内 mkdir -p 出来的路径 → 本会话创建', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('mkdir -p /proj/.pi/tmp/x && rm -rf /proj/.pi/tmp/x', CWD)).toBe('yes');
	});

	it('同命令内变量拼接 + mkdir（真实形态：R=… T="$R/…" mkdir -p "$T" rm -rf "$T"）', () => {
		const l = new ProvenanceLedger();
		const cmd =
			'R="/proj" && T="$R/.pi/tmp/manual-event-check" && mkdir -p "$T" && echo x > "$T/a" && rm -rf "$T"';
		expect(l.judge(cmd, CWD)).toBe('yes');
	});

	it('`cd` / `ls` 这类无害路径不算目标（否则永远判不出来）', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('cd /proj && rm -rf /tmp/other-thing', CWD)).toBe('no');
	});
});

describe('阶梯② — 命令内变量绑定', () => {
	it('T=$(mktemp -d) 同命令内删除 → 本会话创建（名字静态不可知也成立）', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('T=$(mktemp -d) && rm -rf "$T"', CWD)).toBe('yes');
	});

	it('mktemp 派生路径（"$T/sub"）同样算本会话创建', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('T=$(mktemp -d) && rm -rf "$T/sessions"', CWD)).toBe('yes');
	});

	it('$PWD 展开为 cwd 后可解析', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('S="$PWD/.pi/tmp/dbg" && mkdir -p "$S" && rm -rf "$S"', CWD)).toBe('yes');
	});
});

describe('阶梯③ — 会话级变量账本（跨命令）', () => {
	it('上一条命令的 mktemp 绑定在下一命令可用', () => {
		const l = new ProvenanceLedger();
		l.observe('SB=$(mktemp -d)', CWD);
		expect(l.judge('rm -rf "$SB"', CWD)).toBe('yes');
	});

	it('上一条命令 mkdir 出来的目录，下一命令删除 → 本会话创建', () => {
		const l = new ProvenanceLedger();
		l.observe('R="/proj"', CWD);
		l.observe('mkdir -p "$R/.pi/tmp/y"', CWD);
		expect(l.judge('rm -rf "$R/.pi/tmp/y"', CWD)).toBe('yes');
	});

	it('创建目录内的子路径也算本会话创建（整个脚手架都是我们的）', () => {
		const l = new ProvenanceLedger();
		l.observe('mkdir -p /proj/.pi/tmp/scaffold', CWD);
		expect(l.judge('rm -rf /proj/.pi/tmp/scaffold/deep/file', CWD)).toBe('yes');
	});

	it('多行脚本：跨行变量绑定 + 匿名临时目录', () => {
		const l = new ProvenanceLedger();
		const script = [
			'cd /proj',
			'SB=$(mktemp -d)',
			'mkdir -p "$SB/home/.pi/agent"',
			'rm -rf "$SB"',
		].join('\n');
		l.observe(script, CWD);
		expect(l.judge('rm -rf "$SB"', CWD)).toBe('yes');
	});
});

describe('阶梯④ — 不可判定（失败即拒绝，不猜）', () => {
	it('未绑定变量 → unknown', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('rm -rf "$NEVER_BOUND/x"', CWD)).toBe('unknown');
	});

	it('未处理的命令替换 → unknown', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('rm -rf $(ls -1dt /tmp/x-* | head -1)', CWD)).toBe('unknown');
	});

	it('没有改动目标（纯读命令）→ unknown', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('ls -la /proj', CWD)).toBe('unknown');
		expect(l.judge('', CWD)).toBe('unknown');
	});
});

describe('非本会话创建 → no', () => {
	it('空账本下删除 /tmp 下别人的东西 → no', () => {
		const l = new ProvenanceLedger();
		expect(l.judge('rm -rf /tmp/other-process-dir', CWD)).toBe('no');
	});

	it('/tmp 下有我们的条目，但目标不是它 → 仍然 no（不因「同在 /tmp」放宽）', () => {
		const l = new ProvenanceLedger();
		l.observe('mkdir -p /tmp/mine', CWD);
		expect(l.judge('rm -rf /tmp/mine', CWD)).toBe('yes');
		expect(l.judge('rm -rf /tmp/someone-else', CWD)).toBe('no');
	});
});

describe('创建动作覆盖（Ticket 03 清单）', () => {
	it('mkdir', () => {
		const l = new ProvenanceLedger();
		l.observe('mkdir -p /tmp/a/b', CWD);
		// 命令里明确写出的路径 → 本会话创建
		expect(l.judge('rm -rf /tmp/a/b', CWD)).toBe('yes');
		// 祖先目录 /tmp/a 未曾被写成创建目标 → 不归我们（失败即拒绝，不回溯登记）
		expect(l.judge('rm -rf /tmp/a', CWD)).toBe('no');
	});

	it('不把既有祖先目录误登记成「本会话创建」（ADR-0060 唯一护栏）', () => {
		const l = new ProvenanceLedger();
		// 实测复现：mkdir -p <tmpdir>/probe 后，<tmpdir> 自身曾被登记，
		// 导致 rm -rf <tmpdir>/别人的目录 被判为 yes（误放行、不可逆）。
		l.observe(`mkdir -p ${tmpdir()}/probe`, CWD);
		expect(l.judge(`rm -rf ${tmpdir()}/someone-elses-dir`, CWD)).toBe('no');
		expect(l.judge(`rm -rf ${tmpdir()}/probe`, CWD)).toBe('yes');
	});

	it('不把共享根下既有目录误登记（mkdir -p /tmp/owner/sub 不拥有 /tmp/owner）', () => {
		const l = new ProvenanceLedger();
		l.observe('mkdir -p /tmp/owner/sub', CWD);
		expect(l.judge('rm -rf /tmp/owner/other', CWD)).toBe('no');
	});

	it('touch', () => {
		const l = new ProvenanceLedger();
		l.observe('touch /tmp/f1', CWD);
		expect(l.judge('rm -f /tmp/f1', CWD)).toBe('yes');
	});

	it('tee', () => {
		const l = new ProvenanceLedger();
		l.observe('cat /etc/hosts | tee /tmp/f2', CWD);
		expect(l.judge('rm -f /tmp/f2', CWD)).toBe('yes');
	});

	it('git clone（显式目录）', () => {
		const l = new ProvenanceLedger();
		l.observe('git clone https://example.com/x /tmp/repo', CWD);
		expect(l.judge('rm -rf /tmp/repo', CWD)).toBe('yes');
	});

	it('写重定向（含 heredoc）', () => {
		const l = new ProvenanceLedger();
		l.observe('cat > /tmp/f3 <<EOF\nhello\nEOF', CWD);
		expect(l.judge('rm -f /tmp/f3', CWD)).toBe('yes');
	});

	it('重定向到 /dev/null 不登记', () => {
		const l = new ProvenanceLedger();
		l.observe('echo x > /dev/null', CWD);
		expect(l.size.createdPaths).toBe(0);
	});
});

describe('按会话 ID 从审计日志重建（跨 /reload）', () => {
	it('只回放本会话、且实际执行过的命令', () => {
		const l = new ProvenanceLedger();
		const entries: AuditEntry[] = [
			auditEntry({
				sessionId: 's1',
				decision: 'allow',
				originalCommand: 'SB=$(mktemp -d)',
				projectPath: CWD,
			}),
			auditEntry({
				sessionId: 's1',
				decision: 'blocked-no-ui',
				originalCommand: 'mkdir -p /tmp/not-executed',
				projectPath: CWD,
			}),
			auditEntry({
				sessionId: 's2',
				decision: 'allow',
				originalCommand: 'mkdir -p /tmp/other-session',
				projectPath: CWD,
			}),
			auditEntry({
				sessionId: 's1',
				decision: 'deny',
				originalCommand: 'mkdir -p /tmp/user-declined',
				projectPath: CWD,
			}),
		];

		const replayed = l.rebuild(entries, 's1', CWD);
		expect(replayed).toBe(1); // 只有第一条真的执行过

		expect(l.judge('rm -rf "$SB"', CWD)).toBe('yes');
		// 被拦截 / 被拒绝的命令没有改变文件系统，不得算作「我创建的」
		expect(l.judge('rm -rf /tmp/not-executed', CWD)).toBe('no');
		expect(l.judge('rm -rf /tmp/user-declined', CWD)).toBe('no');
		// 别的会话创建的更不算
		expect(l.judge('rm -rf /tmp/other-session', CWD)).toBe('no');
	});

	it('重建后跨命令变量仍然可用，且 projectPath 作为 cwd 回放', () => {
		const l = new ProvenanceLedger();
		l.rebuild(
			[
				auditEntry({
					sessionId: 's1',
					decision: 'auto',
					originalCommand: 'R="." && mkdir -p "$R/.pi/tmp/replay"',
					projectPath: '/proj',
				}),
			],
			's1',
			'/fallback',
		);
		expect(l.judge('rm -rf /proj/.pi/tmp/replay', '/proj')).toBe('yes');
	});
});
