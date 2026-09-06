/**
 * UV Extension - Redirects Python tooling to uv equivalents
 *
 * This extension wraps the bash tool to prepend intercepted-commands to PATH,
 * which contains shim scripts that intercept common Python tooling commands
 * and redirect agents to use uv instead.
 *
 * Intercepted commands:
 * - pip/pip3: Blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: Blocked with uv equivalents (uv init, uv add, uv sync, uv run)
 * - python/python3: Redirected through `uv run` to a real interpreter path,
 *   with special handling to block `python -m pip`, `python -m venv`, and
 *   `python -m py_compile`
 *
 * The shim scripts are located in the intercepted-commands directory and
 * provide helpful error messages with the equivalent uv commands.
 *
 * Note: PATH shims are bypassable via explicit interpreter paths
 * (for example `.venv/bin/python`). To close that gap, this extension also
 * blocks disallowed invocations at bash spawn time.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('uv');

log.debug('Extension loaded');

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, '..', '..', 'intercepted-commands');

function getBlockedCommandMessage(command: string): string | null {
	// Match commands at the start of a shell segment (start/newline/; /&& /|| /|)
	const pipCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip\s*(?:$|\s)/m;
	const pip3CommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip3\s*(?:$|\s)/m;
	const poetryCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?poetry\s*(?:$|\s)/m;

	// Match python invocations including explicit paths like .venv/bin/python
	// and .venv/bin/python3.12.
	const pythonPipPattern =
		/(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*pip\b|\s-mpip\b)/m;
	const pythonVenvPattern =
		/(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*venv\b|\s-mvenv\b)/m;
	const pythonPyCompilePattern =
		/(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*py_compile\b|\s-mpy_compile\b)/m;

	if (pipCommandPattern.test(command)) {
		return [
			'错误：pip 已被禁用。请改用 uv：',
			'',
			'  为脚本安装包：uv run --with PACKAGE python script.py',
			'  为项目添加依赖：uv add PACKAGE',
			'',
		].join('\n');
	}

	if (pip3CommandPattern.test(command)) {
		return [
			'错误：pip3 已被禁用。请改用 uv：',
			'',
			'  为脚本安装包：uv run --with PACKAGE python script.py',
			'  为项目添加依赖：uv add PACKAGE',
			'',
		].join('\n');
	}

	if (poetryCommandPattern.test(command)) {
		return [
			'错误：poetry 已被禁用。请改用 uv：',
			'',
			'  初始化项目：uv init',
			'  添加依赖：uv add PACKAGE',
			'  同步依赖：uv sync',
			'  运行命令：uv run COMMAND',
			'',
		].join('\n');
	}

	if (pythonPipPattern.test(command)) {
		return [
			"错误：'python -m pip' 已被禁用。请改用 uv：",
			'',
			'  为脚本安装包：uv run --with PACKAGE python script.py',
			'  为项目添加依赖：uv add PACKAGE',
			'',
		].join('\n');
	}

	if (pythonVenvPattern.test(command)) {
		return [
			"错误：'python -m venv' 已被禁用。请改用 uv：",
			'',
			'  创建虚拟环境：uv venv',
			'',
		].join('\n');
	}

	if (pythonPyCompilePattern.test(command)) {
		return [
			"错误：'python -m py_compile' 已被禁用，因为它会向 __pycache__ 写入 .pyc 文件。",
			'',
			'  验证语法而不产生字节码输出：uv run python -m ast path/to/file.py >/dev/null',
			'',
		].join('\n');
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	// Instead of registering a competing bash tool, hook into tool_call to
	// prepend the intercepted-commands PATH and block disallowed commands.
	// This avoids conflicts with other extensions (e.g. sandbox) that also
	// register or replace the bash tool.
	pi.on('tool_call', (event, _ctx) => {
		if (event.toolName !== 'bash') return;

		const input = event.input as { command: string; timeout?: number };

		// Prepend intercepted-commands directory to PATH
		input.command = `export PATH="${interceptedCommandsPath}:$PATH"\n${input.command}`;

		// Block disallowed commands
		const blockedMessage = getBlockedCommandMessage(input.command);
		if (blockedMessage) {
			return { block: true, reason: blockedMessage };
		}
	});
}
