/**
 * plannotator-tui / herdr — 与 Herdr 的边界：会话判定、二进制定位、参数拼装、进程调用。
 *
 * 面板由 herdr 侧打开，这里只发起：`plannotator-tui herdr open|last|terminal --deliver-to <pane>`。
 * 二进制路径从 herdr 的 plugins.json 读，插件重装换目录也能跟上，也不要求它在 PATH 上。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const run = promisify(execFile);

/** herdr / plannotator-tui 都是短 RPC（面板由 herdr 侧打开），超时即当失败，避免命令永久挂住。 */
const EXEC_TIMEOUT_MS = 15_000;

const log = createLogger('plannotator-tui');

export type ReviewKind = 'file' | 'last' | 'newest' | 'terminal';

export interface HerdrSession {
	paneId: string;
	cwd: string;
}

/** 只有在 herdr 的 pane 里才能打开面板；否则提前给出可读提示。 */
export function herdrSession(cwd: string): HerdrSession | null {
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== '1' || !paneId) return null;
	return { paneId, cwd };
}

/** 插件自带的 plannotator-tui 二进制；PLANNOTATOR_TUI_BIN 可覆盖（官方脚本同名变量）。 */
export function tuiBinary(): { binary: string } | { problem: string } {
	const override = process.env.PLANNOTATOR_TUI_BIN;
	if (override) {
		return existsSync(override)
			? { binary: override }
			: { problem: `PLANNOTATOR_TUI_BIN 指向的文件不存在：${override}` };
	}

	const registry = join(homedir(), '.config', 'herdr', 'plugins.json');
	if (!existsSync(registry)) {
		return { problem: `找不到 plannotator-tui：Herdr 的 annotate 插件未安装（${registry}）` };
	}
	let plugins: unknown;
	try {
		plugins = JSON.parse(readFileSync(registry, 'utf8'));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { problem: `读取 Herdr 插件清单失败：${registry}（${message}）` };
	}
	const entries = Array.isArray(plugins)
		? (plugins as { plugin_id?: string; plugin_root?: string }[])
		: [];
	const root = entries.find((plugin) => plugin.plugin_id === 'annotate')?.plugin_root;
	if (!root) {
		return { problem: `Herdr 插件清单里没有 annotate 的安装目录：${registry}` };
	}
	const binary = join(root, 'bin', 'plannotator-tui.exe');
	return existsSync(binary)
		? { binary }
		: { problem: `找不到 plannotator-tui：annotate 插件未提供该二进制（${binary}）` };
}

/** 四种评审目标对应的 argv（不含可执行文件本身）。 */
export function tuiArgs(kind: ReviewKind, paneId: string, target: string): string[] {
	switch (kind) {
		case 'file':
			return ['herdr', 'open', target, '--deliver-to', paneId];
		case 'last':
			return ['herdr', 'last', '--deliver-to', paneId];
		case 'newest':
			return ['herdr', 'last', '--newest', '--deliver-to', paneId];
		case 'terminal':
			return ['herdr', 'terminal', '--deliver-to', paneId];
	}
}

function failure(ctx: ExtensionCommandContext, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	log.error(`执行失败：${message}`);
	ctx.ui.notify(`执行失败：${message}`, 'error');
}

/** 打开评审面板。`file` 目标既可以是文件也可以是文件夹（plannotator-tui 原生两档模式）。 */
export async function openReview(
	ctx: ExtensionCommandContext,
	session: HerdrSession,
	kind: ReviewKind,
	target: string,
): Promise<void> {
	if (kind === 'file' && !existsSync(target)) {
		log.warn(`评审目标不存在：${target}`);
		ctx.ui.notify(`找不到路径：${target}`, 'warning');
		return;
	}
	const lookup = tuiBinary();
	if ('problem' in lookup) {
		log.warn(lookup.problem);
		ctx.ui.notify(lookup.problem, 'error');
		return;
	}
	try {
		await run(lookup.binary, tuiArgs(kind, session.paneId, target), {
			cwd: session.cwd,
			timeout: EXEC_TIMEOUT_MS,
		});
		log.info(`已打开评审面板：${kind}${target ? ` ${target}` : ''}`);
		ctx.ui.notify(`已在 Herdr 面板打开：${kind === 'file' ? target : kind}`, 'info');
	} catch (error) {
		failure(ctx, error);
	}
}
