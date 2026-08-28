import {
	type Theme,
	type ExtensionContext,
	copyToClipboard,
	rawKeyHint,
} from '@earendil-works/pi-coding-agent';
import { Input, parseKey, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { topBorder, bottomBorder } from '../../../../src/tui/helpers.js';
import { TabBar } from './tab-bar.js';
import { SettingsPanel } from './settings.js';
import { TodoActionMenuComponent, TodoDeleteConfirmComponent } from './actions.js';
import type { TabId, TodoFrontMatter, TodoRecord, TodoMenuAction, SortConfig } from '../types.js';
import {
	formatTodoId,
	isTodoDone,
	isTodoClosed,
	renderAssignmentSuffix,
	sortTodos,
	getTodosDir,
	getTodoPath,
	ensureTodoExists,
	updateTodoStatus,
	releaseTodoAssignment,
	deleteTodo,
	listAllTodos,
	todoStatusLabel,
	sortFieldLabel,
	sortDirectionLabel,
	scopeLabel,
	tabLabel,
} from '../storage.js';
import { getConfig, reloadConfig } from '../config.js';

export interface PanelHandlers {
	onWorkOnTodo: (todoId: string, title: string) => void;
	onRefineTodo: (todoId: string, title: string) => void;
	onClose: () => void;
	onConfigChanged?: () => void;
	onDataChanged?: () => void;
}

type PanelMode = 'list' | 'action-menu' | 'delete-confirm' | 'settings';

const ALL_TABS: Array<{ id: TabId; label: string }> = [
	{ id: 'session', label: '会话' },
	{ id: 'project', label: '项目' },
	{ id: 'global', label: '全局' },
	{ id: 'settings', label: '设置' },
];

export class TodoPanel implements Component {
	private theme: Theme;
	private tabBar: TabBar;
	private activeTab: TabId = 'session';
	private mode: PanelMode = 'list';
	private settingsPanel: SettingsPanel | null = null;
	private actionMenu: TodoActionMenuComponent | null = null;
	private deleteConfirm: TodoDeleteConfirmComponent | null = null;
	private projectTodos: TodoFrontMatter[] = [];
	private searchInput: Input;
	private searchQuery = '';
	private filteredTodos: TodoFrontMatter[] = [];
	private selectedIndex = 0;
	private currentSessionId: string | undefined;
	private sortConfig: SortConfig;
	private handlers: PanelHandlers;
	private ctx: ExtensionContext;
	private tui: { requestRender: () => void };

	constructor(
		theme: Theme,
		ctx: ExtensionContext,
		tui: { requestRender: () => void },
		handlers: PanelHandlers,
		allTodos: TodoFrontMatter[],
		currentSessionId?: string,
		private framed = false,
	) {
		this.theme = theme;
		this.ctx = ctx;
		this.tui = tui;
		this.handlers = handlers;
		this.projectTodos = allTodos;
		this.currentSessionId = currentSessionId;

		const cfg = getConfig();
		this.sortConfig = {
			field: cfg.sortField,
			direction: cfg.sortDirection,
		};

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) void this.openActionMenu(selected);
		};

		this.tabBar = new TabBar({
			theme,
			activeTab: this.activeTab,
			tabs: ALL_TABS,
			onSwitch: (tabId) => this.switchTab(tabId),
		});

		this.applyFilter();
	}

	private getCurrentScopeTodos(): TodoFrontMatter[] {
		if (this.activeTab === 'session') {
			if (!this.currentSessionId) return [];
			return this.projectTodos.filter((t) => t.assigned_to_session === this.currentSessionId);
		}
		if (this.activeTab === 'global') {
			// Global shows ALL todos from both project and global dirs, deduped by id
			return this.projectTodos;
		}
		if (this.activeTab === 'project') {
			return this.projectTodos.filter((t) => t.project_id === 'project' || !t.project_id);
		}
		return [];
	}

	private getCurrentScopeLabel(): string {
		return scopeLabel(this.activeTab);
	}

	private switchTab(tabId: TabId): void {
		if (tabId === 'settings') {
			this.mode = 'settings';
			this.tabBar.setOptions({ activeTab: 'settings' });
			this.settingsPanel = new SettingsPanel(this.theme, {
				onClose: () => this.exitSettings(),
			});
		} else {
			this.activeTab = tabId;
			this.mode = 'list';
			this.tabBar.setOptions({ activeTab: tabId });
			this.selectedIndex = 0;
			this.searchInput.setValue('');
			this.searchQuery = '';
			this.applyFilter();
		}
		this.tui.requestRender();
	}

	private exitSettings(): void {
		this.mode = 'list';
		this.tabBar.setOptions({ activeTab: this.activeTab });
		reloadConfig();
		const cfg = getConfig();
		this.sortConfig = { field: cfg.sortField, direction: cfg.sortDirection };
		this.applyFilter();
		this.tui.requestRender();
		// Notify extension that config has changed (widget refresh, etc.)
		this.handlers.onConfigChanged?.();
	}

	private applyFilter(): void {
		const todos = this.getCurrentScopeTodos();
		const sorted = sortTodos(todos, this.sortConfig.field, this.sortConfig.direction);

		if (!this.searchQuery.trim()) {
			this.filteredTodos = sorted;
		} else {
			const q = this.searchQuery.toLowerCase();
			this.filteredTodos = sorted.filter(
				(t) =>
					t.title.toLowerCase().includes(q) ||
					t.id.toLowerCase().includes(q) ||
					t.tags.some((tag) => tag.toLowerCase().includes(q)),
			);
		}
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredTodos.length - 1),
		);
	}

	private async openActionMenu(todo: TodoFrontMatter): Promise<void> {
		const todosDir = getTodosDir(this.ctx.cwd);
		const filePath = getTodoPath(todosDir, todo.id);
		const record = await ensureTodoExists(filePath, todo.id);
		if (!record) {
			this.ctx.ui.notify(`未找到待办 ${formatTodoId(todo.id)}`, 'error');
			return;
		}
		this.actionMenu = new TodoActionMenuComponent(this.theme, record, {
			onSelect: (action) => void this.handleActionMenuSelect(record, action),
			onCancel: () => {
				this.mode = 'list';
				this.actionMenu = null;
				this.tui.requestRender();
			},
		});

		this.mode = 'action-menu';
		this.tui.requestRender();
	}

	private async handleActionMenuSelect(
		record: TodoRecord,
		action: TodoMenuAction,
	): Promise<void> {
		if (action === 'work') {
			this.handlers.onWorkOnTodo(record.id, record.title || '(无标题)');
			return;
		}
		if (action === 'refine') {
			this.handlers.onRefineTodo(record.id, record.title || '(无标题)');
			return;
		}
		if (action === 'view') {
			void this.showDetailOverlay(record);
			return;
		}
		if (action === 'copyPath') {
			const todosDir = getTodosDir(this.ctx.cwd);
			const filePath = getTodoPath(todosDir, record.id);
			const absolutePath = import.meta.url ? filePath : filePath;
			try {
				copyToClipboard(absolutePath);
				this.ctx.ui.notify(`已复制: ${absolutePath}`, 'info');
			} catch (error) {
				this.ctx.ui.notify(`路径: ${absolutePath}`, 'info');
			}
			this.mode = 'list';
			this.tui.requestRender();
			return;
		}
		if (action === 'copyText') {
			const title = record.title || '(无标题)';
			const body = record.body?.trim() || '';
			const text = body ? `# ${title}\n\n${body}` : `# ${title}`;
			try {
				copyToClipboard(text);
				this.ctx.ui.notify(`已复制: "${title}"`, 'info');
			} catch {
				this.ctx.ui.notify(`"${title}"`, 'info');
			}
			this.mode = 'list';
			this.tui.requestRender();
			return;
		}
		if (action === 'close' || action === 'reopen' || action === 'done') {
			const todosDir = getTodosDir(this.ctx.cwd);
			const nextStatus = action === 'done' ? 'done' : action === 'close' ? 'close' : 'open';
			const result = await updateTodoStatus(todosDir, record.id, nextStatus, this.ctx);
			if ('error' in result) {
				this.ctx.ui.notify(result.error, 'error');
			} else {
				const label =
					action === 'done' ? '已完成' : action === 'close' ? '已关闭' : '已恢复';
				this.ctx.ui.notify(`${label}待办 ${formatTodoId(record.id)}`, 'info');
			}
			await this.refreshData();
			this.mode = 'list';
			this.handlers.onDataChanged?.();
			this.tui.requestRender();
			return;
		}
		if (action === 'release') {
			const todosDir = getTodosDir(this.ctx.cwd);
			const result = await releaseTodoAssignment(todosDir, record.id, this.ctx, true);
			if ('error' in result) {
				this.ctx.ui.notify(result.error, 'error');
			} else {
				this.ctx.ui.notify(`已释放待办 ${formatTodoId(record.id)}`, 'info');
			}
			await this.refreshData();
			this.mode = 'list';
			this.handlers.onDataChanged?.();
			this.tui.requestRender();
			return;
		}
		if (action === 'delete') {
			this.deleteConfirm = new TodoDeleteConfirmComponent(
				this.theme,
				`删除待办 ${formatTodoId(record.id)}？此操作不可撤销。`,
				{
					onConfirm: async (confirmed) => {
						if (!confirmed) {
							this.mode = 'list';
							this.tui.requestRender();
							return;
						}
						const todosDir = getTodosDir(this.ctx.cwd);
						const delResult = await deleteTodo(todosDir, record.id, this.ctx);
						if ('error' in delResult) {
							this.ctx.ui.notify(delResult.error, 'error');
						} else {
							this.ctx.ui.notify(`已删除待办 ${formatTodoId(record.id)}`, 'info');
						}
						await this.refreshData();
						this.mode = 'list';
						this.handlers.onDataChanged?.();
						this.tui.requestRender();
					},
				},
			);
			this.mode = 'delete-confirm';
			this.tui.requestRender();
		}
	}

	private async showDetailOverlay(record: TodoRecord): Promise<void> {
		const { TodoDetailOverlayComponent } = await import('./actions.js');
		await this.ctx.ui.custom<void>((_innerTui, innerTheme, innerKb, done) => {
			const overlay = new TodoDetailOverlayComponent(innerTheme, innerKb, record, {
				onAction: (act) => {
					if (act === 'back') done();
					else {
						done();
						void this.handleActionMenuSelect(record, 'work');
					}
				},
			});
			return overlay;
		});
		this.actionMenu = new TodoActionMenuComponent(this.theme, record, {
			onSelect: (action) => void this.handleActionMenuSelect(record, action),
			onCancel: () => {
				this.mode = 'list';
				this.actionMenu = null;
				this.tui.requestRender();
			},
		});
	}

	private async refreshData(): Promise<void> {
		this.projectTodos = await listAllTodos(this.ctx.cwd);
		this.applyFilter();
	}

	private cycleSortField(): void {
		this.sortConfig.field = this.sortConfig.field === 'created-at' ? 'title' : 'created-at';
		this.applyFilter();
		this.tui.requestRender();
	}

	private cycleSortDirection(): void {
		this.sortConfig.direction = this.sortConfig.direction === 'asc' ? 'desc' : 'asc';
		this.applyFilter();
		this.tui.requestRender();
	}

	// ── Component interface ──────────────────────────

	handleInput(keyData: string): void {
		if (this.mode === 'list') {
			this.handleListInput(keyData);
		} else if (this.mode === 'action-menu') {
			this.actionMenu?.handleInput(keyData);
		} else if (this.mode === 'delete-confirm') {
			this.deleteConfirm?.handleInput(keyData);
		} else if (this.mode === 'settings') {
			// Esc / Left / Right: exit settings and switch to the corresponding tab
			// parseKey 统一归一（\x1b[C/\x1bOC/ArrowRight 等各终端序列 → right/left），
			// 修复应用模式（DECCKM）终端发 \x1bOC/\x1bOD 时左右键无反应的问题。
			const key = parseKey(keyData) ?? keyData;
			if (key === 'escape') {
				this.exitSettings();
				return;
			}
			if (key === 'right') {
				this.tabBar.cycleNext();
				return;
			}
			if (key === 'left') {
				this.tabBar.cyclePrev();
				return;
			}
			this.settingsPanel?.handleInput(keyData);
		}
	}

	private handleListInput(keyData: string): void {
		// parseKey 统一归一（\x1b[C/\x1bOC/ArrowRight 等各终端序列 → right/left），
		// 修复应用模式（DECCKM）终端发 \x1bOC/\x1bOD 时左右键无反应的问题（同 prompt-editor）。
		const key = parseKey(keyData) ?? keyData;
		if (key === 'right') {
			this.tabBar.cycleNext();
			return;
		}
		if (key === 'left') {
			this.tabBar.cyclePrev();
			return;
		}
		if (key === 'alt+s') {
			this.cycleSortField();
			return;
		}
		if (key === 'alt+d') {
			this.cycleSortDirection();
			return;
		}
		if (this.filteredTodos.length === 0) {
			if (key === 'escape') this.handlers.onClose();
			return;
		}
		if (key === 'up') {
			this.selectedIndex =
				this.selectedIndex === 0 ? this.filteredTodos.length - 1 : this.selectedIndex - 1;
			this.tui.requestRender();
			return;
		}
		if (key === 'down') {
			this.selectedIndex =
				this.selectedIndex === this.filteredTodos.length - 1 ? 0 : this.selectedIndex + 1;
			this.tui.requestRender();
			return;
		}
		if (key === 'enter') {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) void this.openActionMenu(selected);
			return;
		}
		if (key === 'escape') {
			this.handlers.onClose();
			return;
		}
		this.searchInput.handleInput(keyData);
		const newQuery = this.searchInput.getValue();
		if (newQuery !== this.searchQuery) {
			this.searchQuery = newQuery;
			this.selectedIndex = 0;
			this.applyFilter();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		// 顶边框标题统一在最上（tab 栏之前），按 mode 取标题文本——
		// 与其他插件一致（标题嵌入顶部横线作为面板隔离），修复 settings/action-menu
		// 标题曾出现在 tab 栏之后的错位。
		if (this.framed) {
			lines.push(this.theme.fg('accent', topBorder(this.getTitle(), width)));
		}
		const tabLines = this.tabBar.render(width);
		lines.push(...tabLines);
		lines.push('');

		if (this.mode === 'list') {
			lines.push(...this.renderList(width));
		} else if (this.mode === 'action-menu') {
			if (this.actionMenu) lines.push(...this.actionMenu.render(width));
		} else if (this.mode === 'delete-confirm') {
			if (this.deleteConfirm) lines.push(...this.deleteConfirm.render(width));
		} else if (this.mode === 'settings') {
			if (this.settingsPanel) lines.push(...this.settingsPanel.render(width));
		}

		if (this.framed) {
			lines.push(this.theme.fg('accent', bottomBorder(width)));
		}

		return lines;
	}

	private getTitle(): string {
		switch (this.mode) {
			case 'list':
			case 'settings':
				// settings 只是 todos 的一个 tab，标题与其他 tab 保持一致（插件名）
				return '── Todos ';
			case 'action-menu':
				return this.actionMenu?.getTitle() ?? '── Todos ';
			case 'delete-confirm':
				return this.deleteConfirm?.getTitle() ?? '── Todos ';
			default:
				return '── Todos ';
		}
	}

	private renderList(width: number): string[] {
		const lines: string[] = [];
		const scope = this.getCurrentScopeLabel();
		const allTodos = this.getCurrentScopeTodos();
		const openCount = allTodos.filter(
			(t) => !isTodoDone(t.status) && !isTodoClosed(t.status),
		).length;
		const totalCount = allTodos.length;
		const scopeInfo = this.theme.fg(
			'accent',
			this.theme.bold(`${scope} 待办 (${openCount}/${totalCount})`),
		);
		const sortLabel = sortFieldLabel(this.sortConfig.field);
		const sortDir = sortDirectionLabel(this.sortConfig.direction);
		const sortHint = this.theme.fg(
			'dim',
			` 排序: ${sortLabel} ${sortDir}  (${rawKeyHint('alt+s', '字段')}, ${rawKeyHint('alt+d', '方向')})`,
		);

		lines.push(truncateToWidth(scopeInfo + sortHint, width));
		lines.push('');

		const searchLabel = this.theme.fg('muted', '搜索: ');
		const searchValue = this.searchQuery
			? this.searchQuery
			: this.theme.fg('dim', '输入过滤...');
		lines.push(truncateToWidth(`${searchLabel}${searchValue}`, width));
		lines.push('');

		if (this.filteredTodos.length === 0) {
			lines.push(this.theme.fg('dim', '  无待办'));
			return lines.map((l) => truncateToWidth(l, width));
		}

		const maxVisible = Math.max(3, 15);
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxVisible / 2),
				this.filteredTodos.length - maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredTodos.length);

		for (let i = startIndex; i < endIndex; i++) {
			const todo = this.filteredTodos[i];
			if (!todo) continue;
			const isSelected = i === this.selectedIndex;
			const done = isTodoDone(todo.status);
			const closed = isTodoClosed(todo.status);
			const resolved = done || closed;
			const prefix = isSelected ? this.theme.fg('accent', '> ') : '  ';
			const titleColor = isSelected ? 'accent' : resolved ? 'dim' : 'text';
			const statusColor = resolved ? 'dim' : 'success';
			const tagText = todo.tags.length ? ` [${todo.tags.join(', ')}]` : '';
			const assignmentText = renderAssignmentSuffix(this.theme, todo, this.currentSessionId);
			const line =
				prefix +
				this.theme.fg('accent', todo.id) +
				' ' +
				this.theme.fg(statusColor, todoStatusLabel(todo.status)) +
				' ' +
				this.theme.fg(titleColor, todo.title || '(无标题)') +
				this.theme.fg('muted', tagText) +
				assignmentText;
			lines.push(truncateToWidth(line, width));
		}

		if (startIndex > 0 || endIndex < this.filteredTodos.length) {
			const scrollInfo = this.theme.fg(
				'dim',
				`  (${this.selectedIndex + 1}/${this.filteredTodos.length})`,
			);
			lines.push(truncateToWidth(scrollInfo, width));
		}

		lines.push('');
		// Accent divider separating list content from footer
		lines.push(truncateToWidth(this.theme.fg('accent', '─'.repeat(Math.max(0, width))), width));
		lines.push('');
		lines.push(
			truncateToWidth(
				this.theme.fg(
					'dim',
					`左右: 切换标签  回车: 操作  ${rawKeyHint('alt+s', '排序字段')}  ${rawKeyHint('alt+d', '排序方向')}  Esc: 关闭`,
				),
				width,
			),
		);

		return lines;
	}

	invalidate(): void {
		this.tabBar.invalidate();
		this.settingsPanel?.invalidate();
		this.actionMenu?.invalidate();
	}
}
