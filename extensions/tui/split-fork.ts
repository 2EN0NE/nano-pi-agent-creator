import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('split-fork');

log.debug('Extension loaded');

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return [process.execPath];
	}

	return ['pi'];
}

function buildPiStartupInput(sessionFile: string | undefined, prompt: string): string {
	const commandParts = [...getPiInvocationParts()];

	if (sessionFile) {
		commandParts.push('--session', sessionFile);
	}

	if (prompt.length > 0) {
		commandParts.push('--', prompt);
	}

	return `${commandParts.map(shellQuote).join(' ')}\n`;
}

async function createForkedSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionDir = path.dirname(sessionFile);
	const branchEntries = ctx.sessionManager.getBranch();
	const currentHeader = ctx.sessionManager.getHeader();

	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, '-');
	const newSessionId = randomUUID();
	const newSessionFile = path.join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

	const newHeader = {
		type: 'session',
		version: currentHeader?.version ?? 3,
		id: newSessionId,
		timestamp,
		cwd: currentHeader?.cwd ?? ctx.cwd,
		parentSession: sessionFile,
	};

	const lines =
		[JSON.stringify(newHeader), ...branchEntries.map((entry) => JSON.stringify(entry))].join(
			'\n',
		) + '\n';

	await fs.mkdir(sessionDir, { recursive: true });
	await fs.writeFile(newSessionFile, lines, 'utf8');

	return newSessionFile;
}

export default function (pi: ExtensionAPI): void {
	log.debug('registerCommand: split-fork');
	pi.registerCommand('split-fork', {
		description: '将会话分叉到右侧 Ghostty 分屏中的新 pi 进程。用法：/split-fork [可选提示词]',
		handler: async (args, ctx) => {
			if (process.platform !== 'darwin') {
				ctx.ui.notify('/split-fork 目前需要 macOS（Ghostty AppleScript）。', 'warning');
				return;
			}

			const wasBusy = !ctx.isIdle();
			const prompt = args.trim();
			const forkedSessionFile = await createForkedSession(ctx);
			const startupInput = buildPiStartupInput(forkedSessionFile, prompt);

			const result = await pi.exec('osascript', [
				'-e',
				GHOSTTY_SPLIT_SCRIPT,
				'--',
				ctx.cwd,
				startupInput,
			]);
			if (result.code !== 0) {
				const reason =
					result.stderr?.trim() || result.stdout?.trim() || 'unknown osascript error';
				ctx.ui.notify(`启动 Ghostty 分屏失败：${reason}`, 'error');
				if (forkedSessionFile) {
					ctx.ui.notify(`已创建分叉会话：${forkedSessionFile}`, 'info');
				}
				return;
			}

			if (forkedSessionFile) {
				const fileName = path.basename(forkedSessionFile);
				const suffix = prompt ? ' 并发送提示词' : '';
				ctx.ui.notify(`已分叉到 ${fileName}（新的 Ghostty 分屏）${suffix}。`, 'info');
				if (wasBusy) {
					ctx.ui.notify(
						'已从当前已提交状态分叉（正在进行的轮次在原会话中继续）。',
						'info',
					);
				}
			} else {
				ctx.ui.notify('已打开新的 Ghostty 分屏（没有可分叉的持久化会话）。', 'warning');
			}
		},
	});
}
