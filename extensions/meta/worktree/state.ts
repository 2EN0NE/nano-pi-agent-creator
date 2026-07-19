/**
 * pi-worktree — 全局状态 + 持久化
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type { WorktreeState } from './types';
import { findHubRoot } from './lib/git.js';

const log = createLogger('pi-worktree');

// ═══════════════════════════════════════════
// 全局状态
// ═══════════════════════════════════════════
export let activeWorktree: string | null = null;
export let activeWorktreePaths: Map<string, string> = new Map();
export let worktreeMode = true;
export let widgetHidden = false;

export function setActiveWorktree(name: string | null): void {
	activeWorktree = name;
}
export function getActiveWorktree(): string | null {
	return activeWorktree;
}
export function setWorktreeMode(mode: boolean): void {
	worktreeMode = mode;
}
export function setWidgetHidden(hidden: boolean): void {
	widgetHidden = hidden;
}

export function clearActiveWorktree(): void {
	activeWorktree = null;
	activeWorktreePaths.clear();
}

export function addWorktreePath(repo: string, path: string): void {
	activeWorktreePaths.set(repo, path);
}

export function removeWorktreePath(repo: string): void {
	activeWorktreePaths.delete(repo);
}

// ═══════════════════════════════════════════
// 状态持久化
// ═══════════════════════════════════════════
const STATE_DIR = '.pi/worktree-sessions';

function getStatePath(cwd: string, sessionId: string): string | null {
	const root = findHubRoot(cwd);
	if (!root) return null;
	const fileName = sessionId ? `${sessionId}.json` : '_default.json';
	return join(root, STATE_DIR, fileName);
}

export function saveState(cwd: string, sessionId: string): void {
	const path = getStatePath(cwd, sessionId);
	if (!path) return;
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify(
			{
				mode: worktreeMode,
				active: activeWorktree,
				paths: Object.fromEntries(activeWorktreePaths),
				widgetHidden,
			} satisfies WorktreeState,
			null,
			2,
		),
	);
}

export function loadState(cwd: string, sessionId: string): void {
	const path = getStatePath(cwd, sessionId);
	if (!path || !existsSync(path)) return;
	try {
		const state: WorktreeState = JSON.parse(readFileSync(path, 'utf-8'));
		worktreeMode = state.mode;
		activeWorktree = state.active;
		activeWorktreePaths = new Map(Object.entries(state.paths || {}));
		widgetHidden = state.widgetHidden ?? false;
	} catch (err) {
		log.error('Failed to load worktree state.json', { error: String(err) });
	}
}

// ═══════════════════════════════════════════
// Worktree 上下文（供 agent 工具查询）
// ═══════════════════════════════════════════
export function buildWorktreeContext(): string {
	if (!worktreeMode && !activeWorktree)
		return 'Worktree mode: OFF. No active worktree. Work in normal repo directories.';
	if (worktreeMode && !activeWorktree)
		return 'Worktree mode: ON. No active worktree yet — create one before editing files.';
	const mappings = [...activeWorktreePaths.entries()].map(([r, p]) => `  ${r} → ${p}`).join('\n');
	return `Worktree mode: ON. Active worktree: "${activeWorktree}"\nRepo paths:\n${mappings}`;
}

// ═══════════════════════════════════════════
// 仓库发现缓存
// ═══════════════════════════════════════════
let _cachedHubRoot: string | null = null;
let _cachedRepos: string[] | null = null;

export function invalidateRepoCache(): void {
	_cachedHubRoot = null;
	_cachedRepos = null;
}

export function getCachedHubRoot(): string | null {
	return _cachedHubRoot;
}

export function setCachedHubRoot(root: string | null): void {
	_cachedHubRoot = root;
}

export function getCachedRepos(): string[] | null {
	return _cachedRepos;
}

export function setCachedRepos(repos: string[]): void {
	_cachedRepos = repos;
}
