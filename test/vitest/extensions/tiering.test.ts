/**
 * permission-gate — 危险分级判定 Vitest 测试（ADR-0025）
 *
 * 覆盖三维轴判定：权限相关、危险命令、路径空间（系统目录/敏感凭证）、patterns 带 tier、未命中放行。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { assessTier } from '../../../extensions/security/permission-gate/tiering';
import { getDefaultConfig } from '../../../extensions/security/permission-gate/config';
import {
	warmBashParser,
	resetWarmBashParser,
} from '../../../extensions/security/permission-gate/bash-parser';

const cfg = getDefaultConfig();

beforeAll(async () => {
	// 预热 tree-sitter，使 assessTier 走精确解析路径（T5）
	await warmBashParser();
});

describe('assessTier — 权限相关命令（一律 critical）', () => {
	it('sudo 一律 critical（不解析后续命令）', () => {
		const r = assessTier('sudo ls', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('permission-related');
	});

	it('chmod 权限变更 → critical', () => {
		const r = assessTier('chmod 777 /tmp/x', cfg);
		expect(r!.tier).toBe('critical');
	});

	it('chown 权限变更 → critical', () => {
		const r = assessTier('chown user /tmp/x', cfg);
		expect(r!.tier).toBe('critical');
	});
});

describe('assessTier — 危险命令（一律 critical）', () => {
	it('dd 写盘 → critical', () => {
		const r = assessTier('dd if=/dev/zero of=/tmp/x', cfg);
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('destructive');
	});

	it('mkfs.ext4 前缀匹配 → critical', () => {
		const r = assessTier('mkfs.ext4 /dev/sda1', cfg);
		expect(r!.tier).toBe('critical');
	});

	it('shutdown → critical', () => {
		const r = assessTier('shutdown -h now', cfg);
		expect(r!.tier).toBe('critical');
	});
});

describe('assessTier — 路径空间（敏感凭证）', () => {
	it('读 /etc/passwd → critical（敏感凭证，非普通系统目录读）', () => {
		const r = assessTier('cat /etc/passwd', cfg);
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('credential');
	});

	it('读 ~/.ssh/id_rsa → critical', () => {
		const r = assessTier('cat ~/.ssh/id_rsa', cfg);
		expect(r!.tier).toBe('critical');
	});

	it('读 .env → critical（项目内凭证）', () => {
		const r = assessTier('cat /project/.env', cfg);
		expect(r!.tier).toBe('critical');
	});

	it('读 *.pem / *.key（glob 后缀，非字面隐藏文件）→ critical', () => {
		expect(assessTier('cat /project/server.pem', cfg)!.tier).toBe('critical');
		expect(assessTier('cat /tmp/ca.key', cfg)!.tier).toBe('critical');
	});
});

describe('assessTier — 路径空间（系统目录，读/写区分）', () => {
	it('写系统目录 → critical', () => {
		const r = assessTier('rm /etc/foo', cfg);
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('system-dir-write');
	});

	it('读系统目录（非凭证文件）→ warning', () => {
		const r = assessTier('cat /etc/hosts', cfg);
		expect(r!.tier).toBe('warning');
		expect(r!.reasons).toContain('system-dir-read');
	});

	it('重定向写入系统目录 → critical（tree-sitter 路径不丢弃重定向目标）', () => {
		const r = assessTier('echo x > /etc/cron.d/foo', cfg);
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('system-dir-write');
	});

	it('重定向写入敏感凭证路径 → critical（tree-sitter 路径不丢弃重定向目标）', () => {
		const r = assessTier('cat f > ~/.ssh/authorized_keys', cfg);
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('credential');
	});
});

describe('assessTier — 用户 patterns（带 tier）', () => {
	it('命中 warning pattern → warning', () => {
		const r = assessTier('git push --force origin main', cfg);
		expect(r!.tier).toBe('warning');
	});

	it('命中 critical pattern → critical', () => {
		const r = assessTier('rm -rf /tmp/build', cfg);
		expect(r!.tier).toBe('critical');
	});
});

describe('assessTier — 未命中放行', () => {
	it('普通命令未命中任何规则 → null（放行）', () => {
		expect(assessTier('ls -la', cfg)).toBeNull();
		expect(assessTier('echo hello', cfg)).toBeNull();
		expect(assessTier('pwd', cfg)).toBeNull();
	});
});

describe('assessTier — 无害设备文件豁免（/dev/null 等不误判 critical）', () => {
	it('2>/dev/null 丢弃 stderr 不判 critical（tree-sitter 路径）', () => {
		const r = assessTier(
			'ls -la src/ src/skills/cmb-asset-analyzer/ src/ledger/ src/core/ 2>/dev/null',
			cfg,
		);
		expect(r).toBeNull();
	});

	it('写 /dev/null（丢弃数据）不判 system-dir-write', () => {
		expect(assessTier('echo x > /dev/null', cfg)).toBeNull();
	});

	it('读 /dev/zero / /dev/urandom 不判 system-dir-read', () => {
		expect(assessTier('cat /dev/zero', cfg)).toBeNull();
		expect(assessTier('cat /dev/urandom', cfg)).toBeNull();
	});

	it('写块设备 /dev/sda 仍 critical（pattern 收窄后保留块设备拦截）', () => {
		const r = assessTier('echo x > /dev/sda', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
	});

	it('dd 写盘仍 critical（危险命令不受设备豁免影响）', () => {
		const r = assessTier('dd if=/dev/zero of=/tmp/x', cfg);
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('destructive');
	});

	it('冷路径（fallback）：/dev/null 放行、/dev/sda 仍 critical', async () => {
		resetWarmBashParser();
		try {
			// 无害设备豁免在 fallback 路径同样生效：extractPaths 剥出 /dev/null 后放行
			expect(assessTier('echo x > /dev/null', cfg)).toBeNull();
			// 块设备写仍命中路径空间层 → system-dir-write
			const r = assessTier('echo x > /dev/sda', cfg);
			expect(r).not.toBeNull();
			expect(r!.tier).toBe('critical');
			expect(r!.reasons).toContain('system-dir-write');
		} finally {
			await warmBashParser();
		}
	});
});

describe('assessTier — fallback 降级路径（parser 未预热）', () => {
	it('patterns 与单命令判定取最高，降级不低估安全等级', async () => {
		resetWarmBashParser();
		try {
			const cfg2 = getDefaultConfig();
			cfg2.patterns.push({ pattern: 'cat /etc/hosts', tier: 'critical' });
			// 单命令判定：system-dir-read → warning；pattern → critical；取最高 → critical
			const r = assessTier('cat /etc/hosts', cfg2);
			expect(r).not.toBeNull();
			expect(r!.tier).toBe('critical');
			expect(r!.reasons).toContain('pattern');
		} finally {
			await warmBashParser();
		}
	});
});

describe('assessTier — 引号/展开路径不逃逸路径空间（预热态 fail-open 回归）', () => {
	it('双引号系统目录删除 → critical（与裸路径一致）', () => {
		const r = assessTier('rm "/etc/foo"', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('system-dir-write');
	});

	it('单引号凭证读取 → critical', () => {
		const r = assessTier("cat '/etc/passwd'", cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('credential');
	});

	it('引号重定向到系统目录 → critical（重定向目标不再丢失）', () => {
		const r = assessTier('echo x > "/etc/cron.d/foo"', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('system-dir-write');
	});

	it('引号凭证复制（~ 展开）→ critical', () => {
		const r = assessTier('cp "~/.aws/credentials" /tmp/x', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.reasons).toContain('credential');
	});

	it('$HOME / ${HOME} 展开的凭证路径 → critical（home 归一化）', () => {
		const a = assessTier('cat "$HOME/.ssh/id_rsa"', cfg);
		expect(a).not.toBeNull();
		expect(a!.tier).toBe('critical');
		expect(a!.reasons).toContain('credential');

		const b = assessTier('cat "${HOME}/.aws/credentials"', cfg);
		expect(b).not.toBeNull();
		expect(b!.tier).toBe('critical');
		expect(b!.reasons).toContain('credential');
	});

	it('冷路径：无空格重定向 >/etc 前缀剥除 → critical', async () => {
		resetWarmBashParser();
		try {
			const r = assessTier('echo x >/etc/cron.d/foo', cfg);
			expect(r).not.toBeNull();
			expect(r!.tier).toBe('critical');
			expect(r!.reasons).toContain('system-dir-write');
		} finally {
			await warmBashParser();
		}
	});
});

describe('assessTier — 多命中明细（hits）', () => {
	it('sudo rm -rf /etc 同时命中 权限相关 + 系统目录写 + 拦截模式', () => {
		const r = assessTier('sudo rm -rf /etc', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		const reasonKeys = r!.hits.map((h) => h.reason);
		expect(reasonKeys).toContain('permission-related');
		expect(reasonKeys).toContain('system-dir-write');
		expect(reasonKeys).toContain('pattern');
		// 来源区分：内置清单 vs 拦截模式
		expect(r!.hits.find((h) => h.reason === 'permission-related')!.source).toBe('builtin');
		expect(r!.hits.find((h) => h.reason === 'pattern')!.source).toBe('pattern');
	});

	it('cat /etc/passwd 同时命中 凭证 + 系统目录读，取最高 critical', () => {
		const r = assessTier('cat /etc/passwd', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		const reasonKeys = r!.hits.map((h) => h.reason);
		expect(reasonKeys).toContain('credential');
		expect(reasonKeys).toContain('system-dir-read');
	});

	it('内置危险命令命中携带官方解释文案（note 注入）', () => {
		const r = assessTier('dd if=/dev/zero of=/tmp/x', cfg);
		const hit = r!.hits.find((h) => h.reason === 'destructive');
		expect(hit).toBeDefined();
		expect(hit!.explain).toContain('覆写磁盘');
	});

	it('默认拦截模式命中携带预填解释文案', () => {
		const r = assessTier('rm -rf /tmp/build', cfg);
		const hit = r!.hits.find((h) => h.reason === 'pattern');
		expect(hit).toBeDefined();
		expect(hit!.explain).toContain('递归强制删除');
	});

	it('reasons 保持去重后的扁平分类 key（兼容审计）', () => {
		const r = assessTier('sudo rm -rf /etc', cfg);
		expect(r!.reasons).toEqual([...new Set(r!.reasons)]);
		expect(r!.reasons).toContain('permission-related');
	});
});

describe('assessTier — 前缀命令的真实命令提取（effective）', () => {
	it('env KEY=VAL 前缀不吞真实写命令（env FOO=bar tee /etc/...）', () => {
		const r = assessTier('env FOO=bar tee /etc/cron.d/evil', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.hits.map((h) => h.reason)).toContain('system-dir-write');
	});

	it('sudo -u 带值选项不吞真实写命令（sudo -u root tee /etc/...）', () => {
		const r = assessTier('sudo -u root tee /etc/cron.d/evil', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.hits.map((h) => h.reason)).toContain('system-dir-write');
	});

	it('nice -n 带值选项不吞真实写命令（nice -n 10 tee /etc/...）', () => {
		const r = assessTier('nice -n 10 tee /etc/cron.d/evil', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.hits.map((h) => h.reason)).toContain('system-dir-write');
	});

	it('前缀命令后藏危险命令仍命中清单（env shred ...）', () => {
		const r = assessTier('env shred /home/user/secret.txt', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.hits.map((h) => h.reason)).toContain('destructive');
	});

	it('前缀命令后藏危险命令仍命中清单（nohup dd ...）', () => {
		const r = assessTier('nohup dd if=/dev/zero of=/tmp/x', cfg);
		expect(r).not.toBeNull();
		expect(r!.tier).toBe('critical');
		expect(r!.hits.map((h) => h.reason)).toContain('destructive');
	});
});
