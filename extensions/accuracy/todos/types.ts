import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';

export const TODO_ID_PREFIX = 'TODO-';
export const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
export const LOCK_TTL_MS = 30 * 60 * 1000;

/** JSON front matter stored at top of each todo file. */
export interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	/** Session this todo is assigned to (auto-set on create). */
	assigned_to_session?: string;
	/** Which directory this todo lives in: "project" = .pi/todos/, "global" = ~/.pi/todos/. */
	project_id?: string;
}

/** Full todo record: front matter + body. */
export interface TodoRecord extends TodoFrontMatter {
	body: string;
}

export interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

export interface TodoSettings {
	gc: boolean;
	gcDays: number;
}

/** Todo plugin persistent config (widget + UI settings). */
export interface TodoPluginConfig {
	/** Widget visibility. */
	widgetShow: boolean;
	/** Widget scope: session / project / global. */
	widgetScope: 'session' | 'project' | 'global';
	/** Widget display style. */
	widgetDisplay: 'summary' | 'details';
	/** Widget filter. */
	widgetFilter: 'all' | 'pending-only';
	/** Sort field for todo lists. */
	sortField: 'created-at' | 'title';
	/** Sort direction. */
	sortDirection: 'asc' | 'desc';
	/** Whether to show summary or detail in todos panel (default: summary = compact). */
	compactView: boolean;
}

export const DEFAULT_PLUGIN_CONFIG: TodoPluginConfig = {
	widgetShow: true,
	widgetScope: 'session',
	widgetDisplay: 'summary',
	widgetFilter: 'pending-only',
	sortField: 'created-at',
	sortDirection: 'desc',
	compactView: true,
};

export const PLUGIN_NAME = 'todos';

export const TodoParams = Type.Object({
	action: StringEnum([
		'list',
		'list-all',
		'get',
		'create',
		'update',
		'append',
		'delete',
		'claim',
		'release',
	] as const),
	id: Type.Optional(Type.String({ description: 'Todo id (TODO-<hex> or raw hex filename)' })),
	title: Type.Optional(Type.String({ description: 'Short summary shown in lists' })),
	status: Type.Optional(Type.String({ description: 'Todo status' })),
	tags: Type.Optional(Type.Array(Type.String({ description: 'Todo tag' }))),
	body: Type.Optional(
		Type.String({
			description: 'Long-form details (markdown). Update replaces; append adds.',
		}),
	),
	force: Type.Optional(Type.Boolean({ description: "Override another session's assignment" })),
	scope: Type.Optional(
		StringEnum(['session', 'project', 'global'] as const, {
			description: 'Scope for list: "session" (default), "project", or "global"',
		}),
	),
});

export type TodoAction =
	'list' | 'list-all' | 'get' | 'create' | 'update' | 'append' | 'delete' | 'claim' | 'release';

export type TodoMenuAction =
	| 'work'
	| 'refine'
	| 'close'
	| 'reopen'
	| 'release'
	| 'delete'
	| 'copyPath'
	| 'copyText'
	| 'view';

export type TodoOverlayAction = 'back' | 'work';

export type TodoToolDetails =
	| {
			action: 'list' | 'list-all';
			todos: TodoFrontMatter[];
			currentSessionId?: string;
			error?: string;
	  }
	| {
			action: 'get' | 'create' | 'update' | 'append' | 'delete' | 'claim' | 'release';
			todo: TodoRecord;
			error?: string;
	  };

export type TodoScope = 'session' | 'project' | 'global';

export type TabId = 'session' | 'project' | 'global' | 'settings';

/** Sort configuration for todo lists. */
export type SortConfig = {
	field: 'created-at' | 'title';
	direction: 'asc' | 'desc';
};
