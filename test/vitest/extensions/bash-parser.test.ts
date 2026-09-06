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
