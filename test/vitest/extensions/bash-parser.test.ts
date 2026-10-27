/**
 * permission-gate — tree-sitter bash 解析器 Vitest 测试
 *
 * 覆盖：命令名提取、路径参数提取、重定向（读写方向）、复合命令拆分、fallback 降级。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
	warmBashParser,
	parseBashCommand,
	resetWarmBashParser,
} from '../../../extensions/security/permission-gate/bash-parser';

beforeAll(async () => {
	await warmBashParser();
});

describe('parseBashCommand — 命令名与路径提取', () => {
	it('提取简单命令名与绝对路径参数', () => {
		const r = parseBashCommand('rm -rf /etc/foo');
		expect(r.ok).toBe(true);
		expect(r.commands).toHaveLength(1);
		expect(r.commands[0].commandName).toBe('rm');
		expect(r.commands[0].pathArguments).toContain('/etc/foo');
	});

	it('sudo 作为 command_name 被提取（不解析后续命令）', () => {
		const r = parseBashCommand('sudo rm -rf /');
		expect(r.ok).toBe(true);
		expect(r.commands[0].commandName).toBe('sudo');
		expect(r.commands[0].pathArguments).toContain('/');
	});

	it('权限相关命令 chmod 提取路径', () => {
		const r = parseBashCommand('chmod 777 /etc/passwd');
		expect(r.ok).toBe(true);
		expect(r.commands[0].commandName).toBe('chmod');
		expect(r.commands[0].pathArguments).toContain('/etc/passwd');
	});

	it('flag 型路径 --dir=/etc/foo 提取出 /etc/foo（现有手写 tokenizer 会漏）', () => {
		const r = parseBashCommand('rm --dir=/etc/foo');
		expect(r.ok).toBe(true);
		expect(r.commands[0].pathArguments).toContain('/etc/foo');
	});
});

describe('parseBashCommand — 重定向（读写方向）', () => {
	it('写重定向 > 目标方向为 write', () => {
		const r = parseBashCommand('cat /etc/passwd > /tmp/x');
		expect(r.ok).toBe(true);
		expect(r.commands[0].commandName).toBe('cat');
		expect(r.commands[0].pathArguments).toContain('/etc/passwd');
		expect(r.commands[0].redirects).toEqual([
			{ operator: '>', target: '/tmp/x', direction: 'write' },
		]);
	});

	it('读重定向 < 目标方向为 read', () => {
		const r = parseBashCommand('sh < /tmp/script.sh');
		expect(r.ok).toBe(true);
		expect(r.commands[0].redirects).toEqual([
			{ operator: '<', target: '/tmp/script.sh', direction: 'read' },
		]);
	});
	// 回归：`2>&1` / `>&-` 是 **fd 复制**，不打开任何文件。曾把目标当成普通 word（`1` / `2`），
	// 于是它变成一条「写重定向到相对路径 1」——审计 targets 出现虚假路径，分级层也凭空得到 write=true。
	it.each([
		['stdout 复制到 stderr', 'cat f 2>&1'],
		['stderr 复制到 stdout', 'cat f >&2'],
		['关闭 fd', 'cat f >&-'],
		['stdin 复制', 'cat f 0<&3'],
	])('%s → 不算重定向（fd 复制不是文件目标）', (_label, cmd) => {
		const r = parseBashCommand(cmd);
		expect(r.ok).toBe(true);
		expect(r.commands[0].redirects).toEqual([]);
	});

	it('`>&` 的目标是路径时仍是写重定向（bash 等价于 &>）', () => {
		const r = parseBashCommand('cat f >& /tmp/x');
		expect(r.commands[0].redirects).toEqual([
			{ operator: '>&', target: '/tmp/x', direction: 'write' },
		]);
	});
});

describe('parseBashCommand — 复合命令拆分', () => {
	it('list（&&）拆分成多条命令', () => {
		const r = parseBashCommand('cd /tmp && rm -rf build');
		expect(r.ok).toBe(true);
		expect(r.commands).toHaveLength(2);
		expect(r.commands[0].commandName).toBe('cd');
		expect(r.commands[0].pathArguments).toContain('/tmp');
		expect(r.commands[1].commandName).toBe('rm');
	});
});

describe('parseBashCommand — fallback 降级', () => {
	it('parser 未预热时返回 ok:false（调用方降级 whole-string）', () => {
		resetWarmBashParser();
		const r = parseBashCommand('rm -rf /etc/foo');
		expect(r.ok).toBe(false);
		expect(r.commands).toEqual([]);
	});
});

describe('parseBashCommand — 引号路径与引号重定向目标（fail-open 回归）', () => {
	beforeAll(async () => {
		// fallback 降级用例会 resetWarmBashParser，需重新预热
		await warmBashParser();
	});

	it('双引号绝对路径：去除引号后仍提取为路径', () => {
		const r = parseBashCommand('rm "/etc/foo"');
		expect(r.ok).toBe(true);
		expect(r.commands[0].pathArguments).toContain('/etc/foo');
	});

	it('单引号凭证路径：去除引号后仍提取', () => {
		const r = parseBashCommand("cat '/etc/passwd'");
		expect(r.ok).toBe(true);
		expect(r.commands[0].pathArguments).toContain('/etc/passwd');
	});

	it('双引号重定向目标（string 节点）被提取且去引号', () => {
		const r = parseBashCommand('echo x > "/etc/cron.d/foo"');
		expect(r.ok).toBe(true);
		expect(r.commands[0].redirects).toEqual([
			{ operator: '>', target: '/etc/cron.d/foo', direction: 'write' },
		]);
	});

	it('变量展开路径文本保留（由分级层做 home 归一化）', () => {
		const r = parseBashCommand('cp "$HOME/.aws/credentials" /tmp/x');
		expect(r.ok).toBe(true);
		expect(r.commands[0].pathArguments).toContain('$HOME/.aws/credentials');
	});
});

describe('parseBashCommand — 不可归属的节点必须显式交出（fail-closed 的前提）', () => {
	// 这些节点不是 word，不进 arguments；若解析器直接丢掉，调用方会把「没提取到」
	// 误读成「命令里没有」→ 远端豁免下 `rm -rf ./x $DANGER` 会被判成「只碰 ./x」。
	it.each([
		['变量展开', 'rm -rf ./x $DANGER', '$DANGER'],
		['花括号展开', 'rm -rf ./x ${DANGER}', '${DANGER}'],
		['命令替换', 'rm -rf ./x $(echo /etc)', '$(echo /etc)'],
		['反引号替换', 'rm -rf ./x `echo /etc`', '`echo /etc`'],
		['参数拼接', 'rm -rf ./x a$b', 'a$b'],
		['环境变量前缀', 'FOO=1 rm -rf ./x', 'FOO=1'],
		['进程替换', 'rm -rf ./x >(cat)', '>(cat)'],
	])('%s → commands[0].unresolved 含 %s，且该文本不进 arguments', (_l, cmd, frag) => {
		const r = parseBashCommand(cmd);
		expect(r.ok).toBe(true);
		expect(r.commands[0].unresolved.join('\n')).toContain(frag);
		expect(r.commands[0].arguments.join('\n')).not.toContain(frag);
	});

	it('纯字面路径命令没有 unresolved（不误伤放行路径）', () => {
		expect(parseBashCommand('rm -rf .scratch/tmp').commands[0].unresolved).toEqual([]);
		expect(
			parseBashCommand('rm -rf .scratch/tmp > /dev/null 2>&1').commands[0].unresolved,
		).toEqual([]);
	});

	it('单条命令的写重定向仍归属到该命令（不进 unattributedRedirects）', () => {
		const r = parseBashCommand('rm -rf ./x > /tmp/out');
		expect(r.commands[0].redirects).toEqual([
			{ operator: '>', target: '/tmp/out', direction: 'write' },
		]);
		expect(r.unattributedRedirects).toEqual([]);
	});

	// `(rm -rf ./x) > /tmp/out` 的写目标挂在 subshell 上，不属于任何一条命令：
	// 只按 command 提取会整条丢失 → 调用方误判「没有越界写目标」。
	it.each([
		['subshell', '(rm -rf ./x) > /tmp/out'],
		['group', '{ rm -rf ./x; } > /tmp/out'],
	])('%s 的写重定向 → unattributedRedirects（命令自身无 redirects）', (_l, cmd) => {
		const r = parseBashCommand(cmd);
		expect(r.commands[0].redirects).toEqual([]);
		expect(r.unattributedRedirects.join('\n')).toContain('/tmp/out');
	});

	it('复合体的**读**重定向不记为不可归属（不误伤）', () => {
		const r = parseBashCommand('(rm -rf ./x) < /tmp/input');
		expect(r.unattributedRedirects).toEqual([]);
	});
});
