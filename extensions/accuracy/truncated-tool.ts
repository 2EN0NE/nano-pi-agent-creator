/**
 * Truncated Tool Example - Demonstrates proper output truncation for custom tools
 *
 * Custom tools MUST truncate their output to avoid overwhelming the LLM context.
 * The built-in limit is 50KB (~10k tokens) and 2000 lines, whichever is hit first.
 *
 * This example shows how to:
 * 1. Use the built-in truncation utilities
 * 2. Write full output to a temp file when truncated
 * 3. Inform the LLM where to find the complete output
 * 4. Custom rendering of tool calls and results
 *
 * The `rg` tool here wraps ripgrep with proper truncation. Compare this to the
 * built-in `grep` tool in src/core/tools/grep.ts for a more complete implementation.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { Type } from 'typebox';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('truncated-tool');

log.debug('Extension loaded');

const RgParams = Type.Object({
	pattern: Type.String({ description: '搜索模式（正则表达式）' }),
	path: Type.Optional(Type.String({ description: '要搜索的目录（默认：当前目录）' })),
	glob: Type.Optional(Type.String({ description: "文件 glob 模式，例如 '*.ts'" })),
});

interface RgDetails {
	pattern: string;
	path?: string;
	glob?: string;
	matchCount: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: 'rg',
		label: 'ripgrep',
		// Document the truncation limits in the tool description so the LLM knows
		description: `使用 ripgrep 搜索文件内容。输出被截断到 ${DEFAULT_MAX_LINES} 行或 ${formatSize(DEFAULT_MAX_BYTES)}（先达到哪个算哪个）。如果被截断，完整输出保存到临时文件。`,
		parameters: RgParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { pattern, path: searchPath, glob } = params;

			// Build the ripgrep command
			const args = ['rg', '--line-number', '--color=never'];
			if (glob) args.push('--glob', glob);
			args.push(pattern);
			args.push(searchPath || '.');

			let output: string;
			try {
				output = execSync(args.join(' '), {
					cwd: ctx.cwd,
					encoding: 'utf-8',
					maxBuffer: 100 * 1024 * 1024, // 100MB buffer to capture full output
				});
			} catch (err: any) {
				// ripgrep exits with 1 when no matches found
				if (err.status === 1) {
					return {
						content: [{ type: 'text', text: '未找到匹配' }],
						details: { pattern, path: searchPath, glob, matchCount: 0 } as RgDetails,
					};
				}
				throw new Error(`ripgrep 失败：${err.message}`);
			}

			if (!output.trim()) {
				return {
					content: [{ type: 'text', text: '未找到匹配' }],
					details: { pattern, path: searchPath, glob, matchCount: 0 } as RgDetails,
				};
			}

			// Apply truncation using built-in utilities
			// truncateHead keeps the first N lines/bytes (good for search results)
			// truncateTail keeps the last N lines/bytes (good for logs/command output)
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			// Count matches (each non-empty line with a match)
			const matchCount = output.split('\n').filter((line) => line.trim()).length;

			const details: RgDetails = {
				pattern,
				path: searchPath,
				glob,
				matchCount,
			};

			let resultText = truncation.content;

			if (truncation.truncated) {
				// Save full output to a temp file so LLM can access it if needed
				const tempDir = await mkdtemp(join(tmpdir(), 'pi-rg-'));
				const tempFile = join(tempDir, 'output.txt');
				await withFileMutationQueue(tempFile, async () => {
					await writeFile(tempFile, output, 'utf8');
				});

				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				// Add truncation notice - this helps the LLM understand the output is incomplete
				const truncatedLines = truncation.totalLines - truncation.outputLines;
				const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

				resultText += `\n\n[输出已截断：显示 ${truncation.outputLines} / ${truncation.totalLines} 行`;
				resultText += `（${formatSize(truncation.outputBytes)} / ${formatSize(truncation.totalBytes)}）。`;
				resultText += ` 省略 ${truncatedLines} 行（${formatSize(truncatedBytes)}）。`;
				resultText += ` 完整输出保存到：${tempFile}]`;
			}

			return {
				content: [{ type: 'text', text: resultText }],
				details,
			};
		},

		// Custom rendering of the tool call (shown before/during execution)
		renderCall(args, theme, _context) {
			let text = theme.fg('toolTitle', theme.bold('rg '));
			text += theme.fg('accent', `"${args.pattern}"`);
			if (args.path) {
				text += theme.fg('muted', ` 于 ${args.path}`);
			}
			if (args.glob) {
				text += theme.fg('dim', ` --glob ${args.glob}`);
			}
			return new Text(text, 0, 0);
		},

		// Custom rendering of the tool result
		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as RgDetails | undefined;

			// Handle streaming/partial results
			if (isPartial) {
				return new Text(theme.fg('warning', '搜索中...'), 0, 0);
			}

			// No matches
			if (!details || details.matchCount === 0) {
				return new Text(theme.fg('dim', '未找到匹配'), 0, 0);
			}

			// Build result display
			let text = theme.fg('success', `${details.matchCount} 个匹配`);

			// Show truncation warning if applicable
			if (details.truncation?.truncated) {
				text += theme.fg('warning', '（已截断）');
			}

			// In expanded view, show the actual matches
			if (expanded) {
				const content = result.content[0];
				if (content?.type === 'text') {
					// Show first 20 lines in expanded view, or all if fewer
					const lines = content.text.split('\n').slice(0, 20);
					for (const line of lines) {
						text += `\n${theme.fg('dim', line)}`;
					}
					if (content.text.split('\n').length > 20) {
						text += `\n${theme.fg('muted', '...（使用 read 工具查看完整输出）')}`;
					}
				}

				// Show temp file path if truncated
				if (details.fullOutputPath) {
					text += `\n${theme.fg('dim', `完整输出：${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
