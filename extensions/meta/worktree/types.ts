/**
 * pi-worktree — 共享类型定义
 */
export interface WorktreeInfo {
	name: string;
	branch: string;
	path?: string;
}

export interface OpResult {
	ok: boolean;
	message: string;
	path?: string;
}

export type NodeModulesStrategy = 'symlink' | 'copy' | 'install' | 'none';

export interface Prefs {
	widgetHidden: boolean;
	lastNodeModulesStrategy: NodeModulesStrategy;
}
