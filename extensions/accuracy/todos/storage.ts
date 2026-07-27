import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { createLogger } from '@zenone/pi-logger';
import { resolveConfigPaths } from '@zenone/pi-config';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
	TODO_ID_PREFIX,
	TODO_ID_PATTERN,
	LOCK_TTL_MS,
	type LockInfo,
	type TodoFrontMatter,
	type TodoRecord,
	type TodoSettings,
} from './types.js';

const log = createLogger('todos:storage');

const TODO_DIR_NAME = '.pi/todos';
const TODO_PATH_ENV = 'PI_TODO_PATH';
const TODO_SETTINGS_NAME = 'settings.json';
const DEFAULT_TODO_SETTINGS: TodoSettings = { gc: true, gcDays: 7 };

// ── ID formatting ─────────────────────────────────────

export function formatTodoId(id: string): string {
	return `${TODO_ID_PREFIX}${id}`;
}

export function normalizeTodoId(id: string): string {
	let trimmed = id.trim();
	if (trimmed.startsWith('#')) trimmed = trimmed.slice(1);
	if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX))
		trimmed = trimmed.slice(TODO_ID_PREFIX.length);
	return trimmed;
}

export function validateTodoId(id: string): { id: string } | { error: string } {
	const normalized = normalizeTodoId(id);
	if (!normalized || !TODO_ID_PATTERN.test(normalized)) {
		return { error: 'Invalid todo id. Expected TODO-<hex>.' };
	}
	return { id: normalized.toLowerCase() };
}

export function displayTodoId(id: string): string {
	return formatTodoId(normalizeTodoId(id));
}

// ── Path resolution ───────────────────────────────────

export function getTodosDir(cwd: string): string {
	const overridePath = process.env[TODO_PATH_ENV];
	if (overridePath && overridePath.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}
	return path.resolve(cwd, TODO_DIR_NAME);
}

export function getGlobalTodosDir(): string {
	const homedir = process.env.HOME || process.env.USERPROFILE || '';
	return path.resolve(homedir, TODO_DIR_NAME);
}

export function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

export function getLockPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.lock`);
}

// ── Settings ──────────────────────────────────────────

function getTodoSettingsPath(cwd: string): string {
	return resolveConfigPaths('todos', { cwd }).projectFile;
}

function getOldTodoSettingsPath(todosDir: string): string {
	return path.join(todosDir, TODO_SETTINGS_NAME);
}

function normalizeTodoSettings(raw: Partial<TodoSettings>): TodoSettings {
	return {
		gc: raw.gc ?? DEFAULT_TODO_SETTINGS.gc,
		gcDays: Math.max(0, Math.floor(raw.gcDays ?? DEFAULT_TODO_SETTINGS.gcDays)),
	};
}

export async function readTodoSettings(todosDir: string, cwd: string): Promise<TodoSettings> {
	const settingsPath = getTodoSettingsPath(cwd);
	let data: Partial<TodoSettings> = {};

	try {
		const raw = await fs.readFile(settingsPath, 'utf8');
		data = JSON.parse(raw) as Partial<TodoSettings>;
	} catch {
		const oldPath = getOldTodoSettingsPath(todosDir);
		try {
			const oldRaw = await fs.readFile(oldPath, 'utf8');
			data = JSON.parse(oldRaw) as Partial<TodoSettings>;
			const dir = path.dirname(settingsPath);
			if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
			await fs.unlink(oldPath);
			log.info('migrated todo settings from %s to %s', oldPath, settingsPath);
		} catch {
			// use defaults
		}
	}

	return normalizeTodoSettings(data);
}

// ── Garbage collection ────────────────────────────────

export async function garbageCollectTodos(todosDir: string, settings: TodoSettings): Promise<void> {
	if (!settings.gc) return;

	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch {
		return;
	}

	const cutoff = Date.now() - settings.gcDays * 24 * 60 * 60 * 1000;
	const mdFiles = entries.filter((e) => e.endsWith('.md'));
	await Promise.all(
		mdFiles.map(async (entry) => {
			const id = entry.slice(0, -3);
			const filePath = path.join(todosDir, entry);
			try {
				const content = await fs.readFile(filePath, 'utf8');
				const { frontMatter } = splitFrontMatter(content);
				const parsed = parseFrontMatter(frontMatter, id);
				if (!isTodoClosed(parsed.status)) return 'skipped';
				const createdAt = Date.parse(parsed.created_at);
				if (!Number.isFinite(createdAt)) return 'invalid-date';
				if (createdAt < cutoff) {
					await fs.unlink(filePath);
					return 'deleted';
				}
				return 'kept';
			} catch {
				return 'error';
			}
		}),
	);

	// Clean orphaned .lock files older than LOCK_TTL_MS
	const lockFiles = entries.filter((e) => e.endsWith('.lock'));
	if (lockFiles.length > 0) {
		const now = Date.now();
		await Promise.all(
			lockFiles.map(async (entry) => {
				const lockPath = path.join(todosDir, entry);
				try {
					const stat = await fs.stat(lockPath);
					if (now - stat.mtimeMs > LOCK_TTL_MS) {
						await fs.unlink(lockPath);
						return 'deleted-lock';
					}
				} catch {
					return 'lock-error';
				}
				return 'lock-kept';
			}),
		);
	}
}

// ── File format helpers ───────────────────────────────

export function isTodoClosed(status: string): boolean {
	return ['closed', 'done'].includes(status.toLowerCase());
}

export function getTodoStatus(todo: TodoFrontMatter): string {
	return todo.status || 'open';
}

function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === '\\') {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === '{') {
			depth++;
			continue;
		}
		if (char === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

export function splitFrontMatter(content: string): {
	frontMatter: string;
	body: string;
} {
	if (!content.startsWith('{')) return { frontMatter: '', body: content };
	const endIndex = findJsonObjectEnd(content);
	if (endIndex === -1) return { frontMatter: '', body: content };
	return {
		frontMatter: content.slice(0, endIndex + 1),
		body: content.slice(endIndex + 1).replace(/^\r?\n+/, ''),
	};
}

export function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
	const data: TodoFrontMatter = {
		id: idFallback,
		title: '',
		tags: [],
		status: 'open',
		created_at: '',
		assigned_to_session: undefined,
		project_id: undefined,
	};
	const trimmed = text.trim();
	if (!trimmed) return data;
	try {
		const parsed = JSON.parse(trimmed) as Partial<TodoFrontMatter> | null;
		if (!parsed || typeof parsed !== 'object') return data;
		if (typeof parsed.id === 'string' && parsed.id) data.id = parsed.id;
		if (typeof parsed.title === 'string') data.title = parsed.title;
		if (typeof parsed.status === 'string' && parsed.status) data.status = parsed.status;
		if (typeof parsed.created_at === 'string') data.created_at = parsed.created_at;
		if (typeof parsed.assigned_to_session === 'string' && parsed.assigned_to_session.trim()) {
			data.assigned_to_session = parsed.assigned_to_session;
		}
		if (typeof parsed.project_id === 'string' && parsed.project_id) {
			data.project_id = parsed.project_id;
		}
		if (Array.isArray(parsed.tags)) {
			data.tags = parsed.tags.filter((tag): tag is string => typeof tag === 'string');
		}
	} catch {
		// ignore
	}
	return data;
}

export function parseTodoContent(content: string, idFallback: string): TodoRecord {
	const { frontMatter, body } = splitFrontMatter(content);
	const parsed = parseFrontMatter(frontMatter, idFallback);
	return {
		id: idFallback,
		title: parsed.title,
		tags: parsed.tags ?? [],
		status: parsed.status,
		created_at: parsed.created_at,
		assigned_to_session: parsed.assigned_to_session,
		body: body ?? '',
	};
}

export function serializeTodo(todo: TodoRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			assigned_to_session: todo.assigned_to_session || undefined,
			project_id: todo.project_id || 'project',
		},
		null,
		2,
	);
	const body = (todo.body ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
	if (!body) return `${frontMatter}\n`;
	return `${frontMatter}\n\n${body}\n`;
}

// ── File operations ───────────────────────────────────

export async function ensureTodosDir(todosDir: string): Promise<void> {
	await fs.mkdir(todosDir, { recursive: true });
}

export async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
	const content = await fs.readFile(filePath, 'utf8');
	return parseTodoContent(content, idFallback);
}

export function readTodoFileSync(filePath: string, idFallback: string): TodoRecord {
	const content = readFileSync(filePath, 'utf8');
	return parseTodoContent(content, idFallback);
}

export async function writeTodoFile(filePath: string, todo: TodoRecord): Promise<void> {
	await fs.writeFile(filePath, serializeTodo(todo), 'utf8');
}

export async function generateTodoId(todosDir: string): Promise<string> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const id = crypto.randomBytes(4).toString('hex');
		if (!existsSync(getTodoPath(todosDir, id))) return id;
	}
	throw new Error('Failed to generate unique todo id');
}

export async function listTodos(
	todosDir: string,
	dirType?: 'project' | 'global',
): Promise<TodoFrontMatter[]> {
	let entries: string[] = [];
	try {
		entries = await fs.readdir(todosDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			log.error('failed to readdir %s: %s', todosDir, (err as Error).message);
		}
		return [];
	}
	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith('.md')) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const content = await fs.readFile(filePath, 'utf8');
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
				assigned_to_session: parsed.assigned_to_session,
				project_id: parsed.project_id || dirType || 'project',
			});
		} catch (err) {
			log.error('failed to read todo %s: %s', filePath, (err as Error).message);
		}
	}
	return sortTodos(todos);
}

export function listTodosSync(todosDir: string, dirType?: 'project' | 'global'): TodoFrontMatter[] {
	let entries: string[] = [];
	try {
		entries = readdirSync(todosDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			log.error('failed to readdirSync %s: %s', todosDir, (err as Error).message);
		}
		return [];
	}
	const todos: TodoFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith('.md')) continue;
		const id = entry.slice(0, -3);
		const filePath = path.join(todosDir, entry);
		try {
			const content = readFileSync(filePath, 'utf8');
			const { frontMatter } = splitFrontMatter(content);
			const parsed = parseFrontMatter(frontMatter, id);
			todos.push({
				id,
				title: parsed.title,
				tags: parsed.tags ?? [],
				status: parsed.status,
				created_at: parsed.created_at,
				assigned_to_session: parsed.assigned_to_session,
				project_id: parsed.project_id || dirType || 'project',
			});
		} catch (err) {
			log.error('failed to read todo %s: %s', filePath, (err as Error).message);
		}
	}
	return sortTodos(todos);
}

/** Read all todos from both project and global dirs, merge and dedupe, tagging with project_id. */
export async function listAllTodos(cwd: string): Promise<TodoFrontMatter[]> {
	const projectDir = getTodosDir(cwd);
	const globalDir = getGlobalTodosDir();

	const [projectTodos, globalTodos] = await Promise.all([
		listTodos(projectDir, 'project'),
		globalDir && globalDir !== projectDir ? listTodos(globalDir, 'global').catch(() => []) : [],
	]);

	// Merge: global first, then project (project wins on id collision)
	const seen = new Set<string>();
	return [...globalTodos, ...projectTodos].filter((t) => {
		if (seen.has(t.id)) return false;
		seen.add(t.id);
		return true;
	});
}

/** Filter a merged todo list by scope. */
export function filterTodosByScope(
	todos: TodoFrontMatter[],
	scope: 'session' | 'project' | 'global',
	currentSessionId?: string,
): TodoFrontMatter[] {
	if (scope === 'session') {
		if (!currentSessionId) return [];
		// Explicitly assigned to this session, OR unassigned project-level todos
		return todos.filter(
			(t) =>
				t.assigned_to_session === currentSessionId ||
				(!t.assigned_to_session && (t.project_id === 'project' || !t.project_id)),
		);
	}
	if (scope === 'project') {
		return todos.filter((t) => t.project_id === 'project' || !t.project_id);
	}
	return todos; // global = all
}

// ── Sorting & filtering ───────────────────────────────

export function sortTodos(
	todos: TodoFrontMatter[],
	sortField?: 'created-at' | 'title',
	sortDirection?: 'asc' | 'desc',
): TodoFrontMatter[] {
	return [...todos].sort((a, b) => {
		const aClosed = isTodoClosed(a.status);
		const bClosed = isTodoClosed(b.status);
		if (aClosed !== bClosed) return aClosed ? 1 : -1;

		if (sortField === 'title') {
			const cmp = (a.title || '').localeCompare(b.title || '');
			return sortDirection === 'asc' ? cmp : -cmp;
		}

		// default: created-at
		const cmp = (a.created_at || '').localeCompare(b.created_at || '');
		return sortDirection === 'asc' ? cmp : -cmp;
	});
}

export async function filterTodosAsync(
	todos: TodoFrontMatter[],
	query: string,
): Promise<TodoFrontMatter[]> {
	const { fuzzyMatch } = await import('@earendil-works/pi-tui');
	if (!query.trim()) return todos;

	const tokens = query.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return todos;

	const matches: Array<{ todo: TodoFrontMatter; score: number }> = [];
	for (const todo of todos) {
		const text = buildTodoSearchText(todo);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) matches.push({ todo, score: totalScore });
	}

	return matches
		.sort((a, b) => {
			const aClosed = isTodoClosed(a.todo.status);
			const bClosed = isTodoClosed(b.todo.status);
			if (aClosed !== bClosed) return aClosed ? 1 : -1;
			return a.score - b.score;
		})
		.map((m) => m.todo);
}

function buildTodoSearchText(todo: TodoFrontMatter): string {
	const tags = todo.tags.join(' ');
	const assignment = todo.assigned_to_session ? `assigned:${todo.assigned_to_session}` : '';
	return `${formatTodoId(todo.id)} ${todo.id} ${todo.title} ${tags} ${todo.status} ${assignment}`.trim();
}

// ── Lock management ───────────────────────────────────

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, 'utf8');
		return JSON.parse(raw) as LockInfo;
	} catch {
		return null;
	}
}

async function acquireLock(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<(() => Promise<void>) | { error: string }> {
	const lockPath = getLockPath(todosDir, id);
	const now = Date.now();
	const session = ctx.sessionManager.getSessionFile();

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(lockPath, 'wx');
			const info: LockInfo = {
				id,
				pid: process.pid,
				session,
				created_at: new Date(now).toISOString(),
			};
			await handle.writeFile(JSON.stringify(info, null, 2), 'utf8');
			await handle.close();
			return async () => {
				try {
					await fs.unlink(lockPath);
				} catch {
					// ignore
				}
			};
		} catch (error: any) {
			if (error?.code !== 'EEXIST') {
				return { error: `Failed to acquire lock: ${error?.message ?? 'unknown error'}` };
			}
			const stats = await fs.stat(lockPath).catch(() => null);
			const lockAge = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1;
			if (lockAge <= LOCK_TTL_MS) {
				const info = await readLockInfo(lockPath);
				const owner = info?.session ? ` (session ${info.session})` : '';
				return {
					error: `Todo ${displayTodoId(id)} is locked${owner}. Try again later.`,
				};
			}
			if (!ctx.hasUI) {
				return {
					error: `Todo ${displayTodoId(id)} lock is stale; rerun in interactive mode to steal it.`,
				};
			}
			const ok = await ctx.ui.confirm(
				'Todo locked',
				`Todo ${displayTodoId(id)} appears locked. Steal the lock?`,
			);
			if (!ok) return { error: `Todo ${displayTodoId(id)} remains locked.` };
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}

	return { error: `Failed to acquire lock for todo ${displayTodoId(id)}.` };
}

export async function withTodoLock<T>(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	fn: () => Promise<T>,
): Promise<T | { error: string }> {
	const lock = await acquireLock(todosDir, id, ctx);
	if (typeof lock === 'object' && 'error' in lock) return lock;
	try {
		return await fn();
	} finally {
		await lock();
	}
}

// ── Business operations ───────────────────────────────

export function clearAssignmentIfClosed(todo: TodoFrontMatter): void {
	if (isTodoClosed(todo.status)) {
		todo.assigned_to_session = undefined;
	}
}

export function getTodoTitle(todo: TodoFrontMatter): string {
	return todo.title || '(untitled)';
}

export function formatAssignmentSuffix(todo: TodoFrontMatter): string {
	return todo.assigned_to_session ? ` (assigned: ${todo.assigned_to_session})` : '';
}

export function renderAssignmentSuffix(
	theme: { fg: (color: any, text: string) => string },
	todo: TodoFrontMatter,
	currentSessionId?: string,
): string {
	if (!todo.assigned_to_session) return '';
	const isCurrent = todo.assigned_to_session === currentSessionId;
	const color = isCurrent ? 'success' : 'dim';
	const suffix = isCurrent ? ', current' : '';
	return theme.fg(color, ` (assigned: ${todo.assigned_to_session}${suffix})`);
}

export function splitTodosByAssignment(todos: TodoFrontMatter[]): {
	assignedTodos: TodoFrontMatter[];
	openTodos: TodoFrontMatter[];
	closedTodos: TodoFrontMatter[];
} {
	const assignedTodos: TodoFrontMatter[] = [];
	const openTodos: TodoFrontMatter[] = [];
	const closedTodos: TodoFrontMatter[] = [];
	for (const todo of todos) {
		if (isTodoClosed(todo.status)) {
			closedTodos.push(todo);
			continue;
		}
		if (todo.assigned_to_session) {
			assignedTodos.push(todo);
		} else {
			openTodos.push(todo);
		}
	}
	return { assignedTodos, openTodos, closedTodos };
}

export function buildRefinePrompt(todoId: string, title: string): string {
	return (
		`let's refine task ${formatTodoId(todoId)} "${title}": ` +
		'Ask me for the missing details needed to refine the todo together. Do not rewrite the todo yet and do not make assumptions. ' +
		'Avoid asking me to paste the issue again, since I gave it to you already. Ask clear, concrete questions and wait for my answers before drafting any structured description.\n\n'
	);
}

export function formatTodoHeading(todo: TodoFrontMatter): string {
	const tagText = todo.tags.length ? ` [${todo.tags.join(', ')}]` : '';
	return `${formatTodoId(todo.id)} ${getTodoTitle(todo)}${tagText}${formatAssignmentSuffix(todo)}`;
}

export function formatTodoList(todos: TodoFrontMatter[]): string {
	if (!todos.length) return 'No todos.';
	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(`${label} (${sectionTodos.length}):`);
		if (!sectionTodos.length) {
			lines.push('  none');
			return;
		}
		for (const todo of sectionTodos) {
			lines.push(`  ${formatTodoHeading(todo)}`);
		}
	};
	pushSection('Assigned todos', assignedTodos);
	pushSection('Open todos', openTodos);
	pushSection('Closed todos', closedTodos);
	return lines.join('\n');
}

export function serializeTodoForAgent(todo: TodoRecord): string {
	return JSON.stringify({ ...todo, id: formatTodoId(todo.id) }, null, 2);
}

export function serializeTodoListForAgent(todos: TodoFrontMatter[]): string {
	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const mapTodo = (t: TodoFrontMatter) => ({ ...t, id: formatTodoId(t.id) });
	return JSON.stringify(
		{
			assigned: assignedTodos.map(mapTodo),
			open: openTodos.map(mapTodo),
			closed: closedTodos.map(mapTodo),
		},
		null,
		2,
	);
}

// ── CRUD with locks ───────────────────────────────────

export async function ensureTodoExists(filePath: string, id: string): Promise<TodoRecord | null> {
	if (!existsSync(filePath)) return null;
	return readTodoFile(filePath, id);
}

export async function appendTodoBody(
	filePath: string,
	todo: TodoRecord,
	text: string,
): Promise<TodoRecord> {
	const spacer = todo.body.trim().length ? '\n\n' : '';
	todo.body = `${todo.body.replace(/\s+$/, '')}${spacer}${text.trim()}\n`;
	await writeTodoFile(filePath, todo);
	return todo;
}

export async function updateTodoStatus(
	todosDir: string,
	id: string,
	status: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ('error' in validated) return { error: validated.error };
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) return { error: `Todo ${displayTodoId(id)} not found` };

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		existing.status = status;
		clearAssignmentIfClosed(existing);
		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (typeof result === 'object' && 'error' in result) return { error: result.error };
	return result;
}

export async function claimTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ('error' in validated) return { error: validated.error };
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) return { error: `Todo ${displayTodoId(id)} not found` };
	const sessionId = ctx.sessionManager.getSessionId();

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		if (isTodoClosed(existing.status))
			return { error: `Todo ${displayTodoId(id)} is closed` } as const;
		const assigned = existing.assigned_to_session;
		if (assigned && assigned !== sessionId && !force) {
			return {
				error: `Todo ${displayTodoId(id)} is already assigned to session ${assigned}. Use force to override.`,
			} as const;
		}
		if (assigned !== sessionId) {
			existing.assigned_to_session = sessionId;
			await writeTodoFile(filePath, existing);
		}
		return existing;
	});

	if (typeof result === 'object' && 'error' in result) return { error: result.error };
	return result;
}

export async function releaseTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ('error' in validated) return { error: validated.error };
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) return { error: `Todo ${displayTodoId(id)} not found` };
	const sessionId = ctx.sessionManager.getSessionId();

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		const assigned = existing.assigned_to_session;
		if (!assigned) return existing;
		if (assigned !== sessionId && !force) {
			return {
				error: `Todo ${displayTodoId(id)} is assigned to session ${assigned}. Use force to release.`,
			} as const;
		}
		existing.assigned_to_session = undefined;
		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (typeof result === 'object' && 'error' in result) return { error: result.error };
	return result;
}

export async function deleteTodo(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<TodoRecord | { error: string }> {
	const validated = validateTodoId(id);
	if ('error' in validated) return { error: validated.error };
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) return { error: `Todo ${displayTodoId(id)} not found` };

	const result = await withTodoLock(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` } as const;
		await fs.unlink(filePath);
		return existing;
	});

	if (typeof result === 'object' && 'error' in result) return { error: result.error };
	return result;
}
