// org — tmux 交互（成员唤醒形态：TUI + tmux，ADR-0040 D1）
//
// 为何是 tmux：三种可选形态里只有「TUI + PTY」能同时满足**独立常驻**（不随唤醒者退出而死）
// 与**人类可观察**（可 `tmux attach` 直接看成员干活）。实测依据：
// ① `pi -a` 无 PTY 起不了会话（扩展加载了但 session_start 永不触发）；
// ② `pi --mode rpc` 无 PTY 可起会话，但 stdin EOF 即退出——成员寿命会绑在唤醒者身上；
// ③ `tmux new-session` 重名被拒 → 命名本身即天然互斥锁（无需自造锁文件）。
import { execFile } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// org-tmux：tmux 交互的失败必须留痕（ADR-0048 D7）——此前该模块零日志
const log = createLogger('org-tmux');

/**
 * 成员 tmux 会话名：一目录 = 一员工 → 每 (org, 成员) 一个会话。
 *
 * 必须归一 `.` 与 `:`：tmux 把它们当 target 分隔符（`-t a.b` 解析成 session `a` + pane `b`），
 * 且 `new-session -s a.b` 会把它们静默替换为 `_`。若原样传入：
 * - `has-session -t a.b` 恒失败（幂等闸门失效，会重复 `new-session` 撞 `duplicate session`）；
 * - `kill-session -t a.b` 命中不到目标。
 * 这里按 tmux 的替换规则（`.`/`:` → `_`）统一归一，保证建/查/杀用同一个名字。
 */
export function tmuxSessionName(org: string, member: string): string {
	return `org-${org}-${member}`.replace(/[.:]/g, '_');
}

/** tmux 是否可用（缺失时唤醒必须给出可见提示，而不是静默失败） */
export async function tmuxAvailable(): Promise<boolean> {
	try {
		await execFileAsync('tmux', ['-V']);
		return true;
	} catch {
		return false;
	}
}

/** 同名会话是否已存在（唤醒幂等的第二道闸：封死"已拉起但 socket 尚未注册"的竞态窗口） */
export async function hasSession(name: string): Promise<boolean> {
	try {
		await execFileAsync('tmux', ['has-session', '-t', name]);
		return true;
	} catch {
		return false;
	}
}

export async function killSession(name: string): Promise<void> {
	try {
		await execFileAsync('tmux', ['kill-session', '-t', name]);
	} catch (e) {
		// 杀掉**最后一个**会话会让 tmux server 随之退出，CLI 可能以非 0 退出
		//（实测报 "server exited unexpectedly"）。目标（会话不存在）已达成，
		// 故用 has-session 复核；只有会话仍在才算真失败。
		if (await hasSession(name)) throw e;
	}
}

/**
 * pane 是否已退出（配合 remain-on-exit 读「为什么没起来」）。
 * 无法判定（会话不存在 / 输出不可解析）返回 null——调用方据此**不要**误判为死亡。
 */
export async function paneDead(name: string): Promise<boolean | null> {
	try {
		const { stdout } = await execFileAsync('tmux', [
			'display-message',
			'-p',
			'-t',
			name,
			'#{pane_dead}',
		]);
		const value = stdout.trim();
		if (value === '1') return true;
		if (value === '0') return false;
		return null;
	} catch {
		return null;
	}
}

/** 抓取 pane 当前可见输出（含回滚尾部）；失败返回 null */
export async function capturePane(name: string, lines = 40): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('tmux', [
			'capture-pane',
			'-p',
			'-t',
			name,
			'-S',
			`-${lines}`,
		]);
		return stdout;
	} catch {
		return null;
	}
}

/** 开关 remain-on-exit（唤醒校验窗口用：开＝退出后留住 pane，关＝恢复常规行为） */
export async function setRemainOnExit(name: string, on: boolean): Promise<void> {
	await execFileAsync('tmux', ['set-option', '-t', name, 'remain-on-exit', on ? 'on' : 'off']);
}

/** 单引号安全转义（命令经 tmux 交给 shell 执行，成员目录可能含空格/特殊字符） */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 以分离会话启动成员：会话内执行 `command args...`，cwd 为成员目录。
 *
 * 环境变量以命令行前缀显式注入：tmux server 的环境是**首个客户端**的快照，不能假设
 * 与我们当前进程一致。生产环境注入 PATH/HOME/ORG_ROOT 即可（其余变量通常已随 tmux
 * server 继承自用户的 shell）；测试沙箱依赖这里的 HOME/ORG_ROOT 覆盖来隔离数据。
 */
export async function newDetachedSession(opts: {
	name: string;
	cwd: string;
	command: string;
	args: string[];
	env?: Record<string, string | undefined>;
	/**
	 * 退出后保留 pane（唤醒后要读「为什么没起来」的首屏输出，ADR-0051 审查 06）。
	 * 只在唤醒的校验窗口内开启，窗口结束由调用方关掉——否则死会话残留会挡住下次唤醒
	 * （唤醒幂等的第二道闸是 `has-session`）。
	 */
	remainOnExit?: boolean;
}): Promise<void> {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(opts.env ?? {})) {
		if (value === undefined || value === '') continue;
		parts.push(`${key}=${shellQuote(value)}`);
	}
	parts.push(shellQuote(opts.command), ...opts.args.map(shellQuote));
	const cmdline = parts.join(' ');
	const argv = ['new-session', '-d', '-s', opts.name, '-c', opts.cwd, cmdline];
	// `;` 是 tmux 的命令分隔符，必须作为**独立 argv 元素**传入（拼进字符串会被当成命令内容）
	if (opts.remainOnExit) argv.push(';', 'set-option', '-t', opts.name, 'remain-on-exit', 'on');
	await execFileAsync('tmux', argv).catch((e: unknown) => {
		log.error('tmux 建会话失败', {
			session: opts.name,
			cwd: opts.cwd,
			command: opts.command,
			err: e instanceof Error ? e.message : String(e),
		});
		throw e;
	});
}

async function which(cmd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('which', [cmd], { env: process.env });
		const found = stdout.trim();
		return found.length > 0 ? found : null;
	} catch {
		return null;
	}
}

/**
 * 解析"用哪个 pi 启动成员"：
 * ① 优先 PATH 里的 `pi`（**与人手工启动成员同源**，也是唯一在测试沙箱里正确的选择：
 *    此时 `process.argv[1]` 是 tsx/vitest 自己的脚本，不能拿来当 pi）；
 * ② PATH 里没有（如 pi 是 shell function/alias）→ 用当前进程的 argv 复现：
 *    `execPath + 脚本路径`（生产的 pi 启动器是 `#!/usr/bin/env node` 脚本，argv[1] 即它）。
 *
 * 注意：不能用「argv[1] 以 .js 结尾」来判断——真实 `pi` 启动器没有 `.js` 后缀。
 */
export async function resolvePiCommand(): Promise<{
	command: string;
	prefixArgs: string[];
} | null> {
	const onPath = await which('pi');
	if (onPath) return { command: onPath, prefixArgs: [] };
	const script = process.argv[1];
	if (script && !script.startsWith('-')) {
		return { command: process.execPath, prefixArgs: [script] };
	}
	return null;
}
