import { type Theme, DynamicBorder, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import {
	Container,
	Markdown,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type SelectItem,
} from '@earendil-works/pi-tui';
import { matchesKey, Key } from '@earendil-works/pi-tui';
import type { TodoRecord, TodoMenuAction, TodoOverlayAction } from '../types.js';
import { formatTodoId, isTodoClosed } from '../storage.js';

// ── Action Menu ──────────────────────────────────────

export interface TodoMenuHandlers {
	onSelect: (action: TodoMenuAction) => void;
	onCancel: () => void;
}

export class TodoActionMenuComponent extends Container {
	private selectList: SelectList;

	constructor(theme: Theme, todo: TodoRecord, handlers: TodoMenuHandlers) {
		super();
		const closed = isTodoClosed(todo.status);
		const title = todo.title || '(untitled)';
		const options: SelectItem[] = [
			{ value: 'view', label: 'view', description: 'View todo' },
			{ value: 'work', label: 'work', description: 'Work on todo' },
			{ value: 'refine', label: 'refine', description: 'Refine task' },
			...(closed
				? [{ value: 'reopen', label: 'reopen', description: 'Reopen todo' }]
				: [{ value: 'close', label: 'close', description: 'Close todo' }]),
			...(todo.assigned_to_session
				? [{ value: 'release', label: 'release', description: 'Release assignment' }]
				: []),
			{
				value: 'copyPath',
				label: 'copy path',
				description: 'Copy absolute path to clipboard',
			},
			{
				value: 'copyText',
				label: 'copy text',
				description: 'Copy title and body to clipboard',
			},
			{ value: 'delete', label: 'delete', description: 'Delete todo' },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		this.addChild(
			new Text(
				theme.fg('accent', theme.bold(`Actions for ${formatTodoId(todo.id)} "${title}"`)),
			),
		);

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg('accent', text),
			selectedText: (text) => theme.fg('accent', text),
			description: (text) => theme.fg('muted', text),
			scrollInfo: (text) => theme.fg('dim', text),
			noMatch: (text) => theme.fg('warning', text),
		});

		this.selectList.onSelect = (item) => handlers.onSelect(item.value as TodoMenuAction);
		this.selectList.onCancel = () => handlers.onCancel();

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg('dim', 'Enter to confirm  Esc back')));
		this.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

// ── Delete Confirm ────────────────────────────────────

export interface DeleteConfirmHandlers {
	onConfirm: (confirmed: boolean) => void;
}

export class TodoDeleteConfirmComponent extends Container {
	private selectList: SelectList;

	constructor(theme: Theme, message: string, handlers: DeleteConfirmHandlers) {
		super();
		const options: SelectItem[] = [
			{ value: 'yes', label: 'Yes' },
			{ value: 'no', label: 'No' },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		this.addChild(new Text(theme.fg('accent', message)));

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg('accent', text),
			selectedText: (text) => theme.fg('accent', text),
			description: (text) => theme.fg('muted', text),
			scrollInfo: (text) => theme.fg('dim', text),
			noMatch: (text) => theme.fg('warning', text),
		});

		this.selectList.onSelect = (item) => handlers.onConfirm(item.value === 'yes');
		this.selectList.onCancel = () => handlers.onConfirm(false);

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg('dim', 'Enter to confirm  Esc cancel')));
		this.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

// ── Detail Overlay ────────────────────────────────────

export interface DetailOverlayHandlers {
	onAction: (action: TodoOverlayAction) => void;
}

export class TodoDetailOverlayComponent implements Component {
	private todo: TodoRecord;
	private theme: Theme;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private handlers: DetailOverlayHandlers;
	private keybindings: KeybindingMatcher;

	constructor(
		theme: Theme,
		keybindings: KeybindingMatcher,
		todo: TodoRecord,
		handlers: DetailOverlayHandlers,
	) {
		this.theme = theme;
		this.keybindings = keybindings;
		this.todo = todo;
		this.handlers = handlers;
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMarkdownText(): string {
		const body = this.todo.body?.trim();
		return body || '_No details yet._';
	}

	private getMaxHeight(): number {
		return 20; // Fixed max height
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, 'tui.select.cancel')) {
			this.handlers.onAction('back');
			return;
		}
		if (kb.matches(keyData, 'tui.select.confirm')) {
			this.handlers.onAction('work');
			return;
		}
		if (kb.matches(keyData, 'tui.select.up')) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(keyData, 'tui.select.down')) {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(keyData, 'tui.select.pageUp') || matchesKey(keyData, Key.left)) {
			this.scrollBy(-(this.viewHeight || 1));
			return;
		}
		if (kb.matches(keyData, 'tui.select.pageDown') || matchesKey(keyData, Key.right)) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		const maxHeight = this.getMaxHeight();
		const headerLines = 3;
		const footerLines = 3;
		const borderLines = 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(
			this.scrollOffset,
			this.scrollOffset + contentHeight,
		);
		const lines: string[] = [];

		lines.push(this.buildTitleLine(innerWidth));
		lines.push(this.buildMetaLine(innerWidth));
		lines.push('');

		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push('');
		}

		lines.push('');
		lines.push(this.buildActionLine(innerWidth));

		const borderColor = (text: string) => this.theme.fg('borderMuted', text);
		const top = borderColor(`${'─'.repeat(innerWidth + 2)}`);
		const bottom = borderColor(`├${'─'.repeat(innerWidth)}┤`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor('│') + truncated + ' '.repeat(padding) + borderColor('│');
		});

		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private buildTitleLine(width: number): string {
		const titleText = this.todo.title
			? ` ${this.todo.title} `
			: ` Todo ${formatTodoId(this.todo.id)} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(this.theme.fg('accent', titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			this.theme.fg('borderMuted', '─'.repeat(leftWidth)) +
			this.theme.fg('accent', titleText) +
			this.theme.fg('borderMuted', '─'.repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		const status = this.todo.status || 'open';
		const statusColor = isTodoClosed(status) ? 'dim' : 'success';
		const tagText = this.todo.tags.length ? this.todo.tags.join(', ') : 'no tags';
		const line =
			this.theme.fg('accent', formatTodoId(this.todo.id)) +
			this.theme.fg('muted', ' | ') +
			this.theme.fg(statusColor, status) +
			this.theme.fg('muted', ' | ') +
			this.theme.fg('muted', tagText);
		return truncateToWidth(line, width);
	}

	private buildActionLine(width: number): string {
		const enter = this.theme.fg('accent', 'enter') + this.theme.fg('muted', ' work on todo');
		const esc = this.theme.fg('dim', 'esc back');
		const nav = this.theme.fg('dim', 'up/down move  left/right page');
		const pieces = [enter, esc, nav];

		let line = pieces.join(this.theme.fg('muted', ' | '));
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			const scrollInfo = this.theme.fg('dim', ` ${start}-${end}/${this.totalLines}`);
			line += scrollInfo;
		}

		return truncateToWidth(line, width);
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
	}
}

// KeybindingMatcher type alias
type KeybindingMatcher = { matches: (...args: any[]) => boolean };
export type { KeybindingMatcher };
