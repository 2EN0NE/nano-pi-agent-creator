import { type Theme, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import {
	Container,
	Markdown,
	SelectList,
	Text,
	truncateToWidth,
	type Component,
	type SelectItem,
} from '@earendil-works/pi-tui';
import { matchesKey, Key } from '@earendil-works/pi-tui';
import { bottomBorder, topBorder } from '../../../../src/tui/helpers.js';
import type { TodoRecord, TodoMenuAction, TodoOverlayAction } from '../types.js';
import { formatTodoId, isTodoDone, isTodoClosed, todoStatusLabel } from '../storage.js';

// ── Action Menu ──────────────────────────────────────

export interface TodoMenuHandlers {
	onSelect: (action: TodoMenuAction) => void;
	onCancel: () => void;
}

export class TodoActionMenuComponent extends Container {
	private selectList: SelectList;
	private titleText: string;

	constructor(theme: Theme, todo: TodoRecord, handlers: TodoMenuHandlers) {
		super();
		const done = isTodoDone(todo.status);
		const closed = isTodoClosed(todo.status);
		const resolved = done || closed;
		const title = todo.title || '(无标题)';
		this.titleText = `待办操作 ${formatTodoId(todo.id)} "${title}"`;
		const options: SelectItem[] = [
			{ value: 'view', label: '查看', description: '查看待办详情' },
			...(resolved
				? []
				: [
						{ value: 'work', label: '处理', description: '开始处理待办' },
						{ value: 'refine', label: '细化', description: '细化任务' },
					]),
			// Status transitions
			...(closed
				? [{ value: 'reopen', label: '恢复', description: '恢复待办' }]
				: done
					? [
							{ value: 'reopen', label: '恢复', description: '重新打开待办' },
							{ value: 'close', label: '隐藏', description: '隐藏待办' },
						]
					: [
							{ value: 'done', label: '完成', description: '标记为已完成' },
							{ value: 'close', label: '隐藏', description: '隐藏待办' },
						]),
			...(todo.assigned_to_session && !resolved
				? [{ value: 'release', label: '释放', description: '释放分配' }]
				: []),
			{
				value: 'copyPath',
				label: '复制路径',
				description: '复制绝对路径到剪贴板',
			},
			{
				value: 'copyText',
				label: '复制文本',
				description: '复制标题和正文到剪贴板',
			},
			{ value: 'delete', label: '删除', description: '删除待办（硬删除）' },
		];

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
		this.addChild(new Text(theme.fg('dim', '回车 确认  Esc 返回')));
	}

	getTitle(): string {
		return `── ${this.titleText} `;
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
	private titleText: string;

	constructor(theme: Theme, message: string, handlers: DeleteConfirmHandlers) {
		super();
		this.titleText = message;
		const options: SelectItem[] = [
			{ value: 'yes', label: '是' },
			{ value: 'no', label: '否' },
		];

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
		this.addChild(new Text(theme.fg('dim', '回车 确认  Esc 取消')));
	}

	getTitle(): string {
		return `── ${this.titleText} `;
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
		return body || '_暂无详情。_';
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
		const top = borderColor(topBorder('── Todo ', innerWidth + 2));
		const bottom = borderColor(bottomBorder(innerWidth + 2));
		const framedLines = lines.map((line) => '  ' + truncateToWidth(line, innerWidth));

		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private buildTitleLine(width: number): string {
		const titleText = this.todo.title
			? ` ${this.todo.title} `
			: ` Todo ${formatTodoId(this.todo.id)} `;
		return truncateToWidth(this.theme.fg('accent', titleText.trim()), width);
	}

	private buildMetaLine(width: number): string {
		const status = this.todo.status || 'open';
		const resolved = isTodoDone(status) || isTodoClosed(status);
		const statusColor = resolved ? 'dim' : 'success';
		const tagText = this.todo.tags.length ? this.todo.tags.join(', ') : '无标签';
		const line =
			this.theme.fg('accent', formatTodoId(this.todo.id)) +
			this.theme.fg('muted', ' | ') +
			this.theme.fg(statusColor, todoStatusLabel(status)) +
			this.theme.fg('muted', ' | ') +
			this.theme.fg('muted', tagText);
		return truncateToWidth(line, width);
	}

	private buildActionLine(width: number): string {
		const enter = this.theme.fg('accent', '回车') + this.theme.fg('muted', ' 处理待办');
		const esc = this.theme.fg('dim', '退出 返回');
		const nav = this.theme.fg('dim', '上下 移动  左右 翻页');
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
