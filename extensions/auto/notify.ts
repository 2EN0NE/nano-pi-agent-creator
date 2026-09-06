/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses OSC 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui';
import { createLogger } from '@zenone/pi-logger';
import { execFile } from 'node:child_process';

const log = createLogger('notify');

log.debug('Extension loaded');

/** macOS 原生桌面通知（osascript，异步不阻塞主流程） */
const notifyOsascript = (title: string, body: string): void => {
	if (process.platform !== 'darwin') return;
	// 除反斜杠与双引号外，还须中和换行——换行会被 osascript 当作语句分隔符，
	// body/title 来源半可信（命令文本/agent 输出），可注入额外 AppleScript 语句。
	const esc = (s: string) =>
		s
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/[\r\n]+/g, ' ');
	const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
	execFile('osascript', ['-e', script], () => {
		// 忽略结果（通知失败不影响主流程）
	});
};

/**
 * Send a desktop notification via OSC 777 escape sequence + macOS osascript.
 */
const notify = (title: string, body: string): void => {
	// OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	notifyOsascript(title, body);
};

const isTextPart = (part: unknown): part is { type: 'text'; text: string } =>
	Boolean(
		part &&
		typeof part === 'object' &&
		'type' in part &&
		part.type === 'text' &&
		'text' in part,
	);

const extractLastAssistantText = (
	messages: Array<{ role?: string; content?: unknown }>,
): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== 'assistant') {
			continue;
		}

		const content = message.content;
		if (typeof content === 'string') {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content
				.filter(isTextPart)
				.map((part) => part.text)
				.join('\n')
				.trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => '',
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => '',
	quote: (text) => text,
	quoteBorder: () => '',
	hr: () => '',
	listBullet: () => '',
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join('\n');
};

const formatNotification = (text: string | null): { title: string; body: string } => {
	const simplified = text ? simpleMarkdown(text) : '';
	const normalized = simplified.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return { title: '准备接收输入', body: '' };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: 'π', body };
};

export default function (pi: ExtensionAPI) {
	// SAFETY: globalThis 上挂载通知 API 弱桥接，运行时由本模块唯一写入
	const notifyGlobal = globalThis as unknown as {
		__notifyApi?: { notify: typeof notify };
	};
	notifyGlobal.__notifyApi = { notify };

	pi.on('agent_end', async (event) => {
		log.debug('event: agent_end');
		const lastText = extractLastAssistantText(event.messages ?? []);
		const { title, body } = formatNotification(lastText);
		notify(title, body);
	});
}
