/**
 * pi-config: pi 扩展入口
 *
 * 注册 /config 命令，用于巡检各插件的配置文件状态。
 *
 * 命令用法：
 *   /config          — 列出所有已知插件的配置文件状态
 *   /config <name>   — 显示指定插件的各层原始 JSON
 *
 * 本模块作为 pi 扩展被自动加载（在 sync-profiles.yaml 的 user-install 中声明）。
 * 同时作为 npm 包 @zenone/pi-config 提供库 API（见 api.ts）。
 */

import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const log = createLogger('pi-config:ext');

// ============================================================================
// Config roots
// ============================================================================

/** User-level extensions-data root */
function userExtDataRoot(): string {
	return join(homedir(), '.pi', 'agent', 'extensions-data');
}

/** Project-level extensions-data root */
function projectExtDataRoot(cwd: string): string {
	return join(cwd, '.pi', 'extensions-data');
}

// ============================================================================
// Helpers
// ============================================================================

interface PluginEntry {
	name: string;
	userFile: string;
	userExists: boolean;
	userMtime: string;
	userValid: boolean;
	projectFile: string;
	projectExists: boolean;
	projectMtime: string;
	projectValid: boolean;
}

function fmtTime(ms: number): string {
	const d = new Date(ms);
	const iso = d.toISOString().replace('T', ' ').slice(0, 19);
	return iso;
}

function isValidJson(path: string): { valid: boolean; preview: string } {
	try {
		const raw = readFileSync(path, 'utf-8');
		if (raw.trim().length === 0) return { valid: false, preview: '' };
		const parsed = JSON.parse(raw);
		const preview = JSON.stringify(parsed, null, 2);
		return {
			valid: true,
			preview: preview.length > 2000 ? preview.slice(0, 2000) + '\n... (truncated)' : preview,
		};
	} catch {
		return { valid: false, preview: '' };
	}
}

function scanPluginDir(name: string, cwd: string): PluginEntry {
	const userFile = join(userExtDataRoot(), name, 'config.json');
	const projectFile = join(projectExtDataRoot(cwd), name, 'config.json');

	const userExists = existsSync(userFile);
	const projectExists = existsSync(projectFile);

	let userMtime = '';
	let projectMtime = '';
	if (userExists) {
		try {
			userMtime = fmtTime(statSync(userFile).mtimeMs);
		} catch {
			userMtime = '?';
		}
	}
	if (projectExists) {
		try {
			projectMtime = fmtTime(statSync(projectFile).mtimeMs);
		} catch {
			projectMtime = '?';
		}
	}

	return {
		name,
		userFile,
		userExists,
		userMtime,
		userValid: userExists ? isValidJson(userFile).valid : false,
		projectFile,
		projectExists,
		projectMtime,
		projectValid: projectExists ? isValidJson(projectFile).valid : false,
	};
}

function listPluginDirectories(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
}

// ============================================================================
// Report builders
// ============================================================================

function buildListReport(userRoot: string, projectRoot: string, cwd: string): string[] {
	const lines: string[] = [];
	lines.push('=== pi-config: 插件配置状态 ===');
	lines.push('');

	// Collect unique plugin names from both roots
	const userDirs = new Set(listPluginDirectories(userRoot));
	const projectDirs = new Set(listPluginDirectories(projectRoot));
	const allPlugins = new Set([...userDirs, ...projectDirs]);

	if (allPlugins.size === 0) {
		lines.push('  (未发现任何插件配置目录)');
		lines.push('');
		lines.push(`  用户级: ${userRoot}`);
		lines.push(`  项目级: ${projectRoot}`);
		return lines;
	}

	// Header
	lines.push('  Plugin          User  Project  Active/Notes');
	lines.push('  ──────────────  ────  ───────  ─────────────');

	for (const name of [...allPlugins].sort()) {
		const entry = scanPluginDir(name, cwd);
		const user = entry.userValid ? 'OK' : entry.userExists ? 'INV' : '--';
		const proj = entry.projectValid ? 'OK' : entry.projectExists ? 'INV' : '--';

		let note = 'default';
		if (entry.projectValid) note = 'project';
		else if (entry.userValid) note = 'user';

		lines.push(`  ${name.padEnd(17)} ${user.padEnd(4)}  ${proj.padEnd(7)} ${note}`);
	}

	lines.push('');
	lines.push(`  OK=有效  INV=格式错误  --=不存在`);
	lines.push(`  用户级: ${userRoot}`);
	lines.push(`  项目级: ${projectRoot}`);
	lines.push('');
	lines.push('  > /config <插件名> 查看各层详情');

	return lines;
}

function buildDetailReport(pluginName: string, cwd: string): string[] {
	const lines: string[] = [];
	lines.push(`=== /config ${pluginName} ===`);
	lines.push('');

	const entry = scanPluginDir(pluginName, cwd);

	// User
	lines.push('─ 用户级 ────────────────────────');
	lines.push(`  路径: ${entry.userFile}`);
	lines.push(`  存在: ${entry.userExists}  |  修改: ${entry.userMtime}`);
	if (entry.userExists) {
		const { valid, preview } = isValidJson(entry.userFile);
		lines.push(`  解析: ${valid ? 'OK' : 'INVALID'}`);
		if (valid) {
			lines.push('  内容:');
			lines.push(preview);
		}
	}
	lines.push('');

	// Project
	lines.push('─ 项目级 ────────────────────────');
	lines.push(`  路径: ${entry.projectFile}`);
	lines.push(`  存在: ${entry.projectExists}  |  修改: ${entry.projectMtime}`);
	if (entry.projectExists) {
		const { valid, preview } = isValidJson(entry.projectFile);
		lines.push(`  解析: ${valid ? 'OK' : 'INVALID'}`);
		if (valid) {
			lines.push('  内容:');
			lines.push(preview);
		}
	}
	lines.push('');

	return lines;
}

// ============================================================================
// Extension entry
// ============================================================================

export default function configExtension(pi: ExtensionAPI) {
	log.info('pi-config extension loaded');

	pi.registerCommand('config', {
		description: '查看插件配置文件状态。用法：/config [插件名]',
		handler: async (args: string, ctx: any) => {
			const tokens = args
				.split(/\s+/)
				.map((x) => x.trim())
				.filter(Boolean);
			const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : process.cwd();

			const userRoot = userExtDataRoot();
			const projectRoot = projectExtDataRoot(cwd);

			let lines: string[];
			if (tokens.length > 0) {
				lines = buildDetailReport(tokens[0], cwd);
			} else {
				lines = buildListReport(userRoot, projectRoot, cwd);
			}

			try {
				await ctx.sendUserMessage?.('[Config] ' + lines.join('\n'));
			} catch {
				// Fallback: log via pi-logger when TUI unavailable
				log.info('/config output:\n' + lines.join('\n'));
			}
		},
	});

	log.info('/config command registered');
}
