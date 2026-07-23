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

// ── 软链接目标 ──

export interface SymlinkTargetDef {
	id: string;
	label: string; // 面板显示名，如 '.husky/'
	relativePath: string; // 从仓库根到目标的相对路径
	hint: string; // 右侧提示，如 'Git hooks'
}

/** 预设软链接目标列表（顺序即面板显示顺序） */
export const PRESET_SYMLINK_TARGETS: SymlinkTargetDef[] = [
	{ id: 'husky', label: '.husky/', relativePath: '.husky', hint: 'Git hooks' },
	{ id: 'pi', label: '.pi/', relativePath: '.pi', hint: 'Pi plugins/config' },
	{
		id: 'node_modules',
		label: 'node_modules/',
		relativePath: 'node_modules',
		hint: 'Node packages',
	},
	{ id: 'vendor', label: 'vendor/', relativePath: 'vendor', hint: 'Ruby/Bundler packages' },
	{ id: 'venv', label: '.venv/', relativePath: '.venv', hint: 'Python virtualenv' },
	{ id: 'target', label: 'target/', relativePath: 'target', hint: 'Rust build cache' },
	{ id: 'build', label: 'build/', relativePath: 'build', hint: 'Build output' },
	{ id: 'dist', label: 'dist/', relativePath: 'dist', hint: 'Build output' },
];

/** 用户选择的软链接配置 */
export interface SymlinkSelections {
	targets: SymlinkTargetDef[]; // 选中的预设目标（含 node_modules）
	customPaths: string[]; // 从「其他」输入的自定义路径
	nodeModulesStrategy: NodeModulesStrategy; // 仅 node_modules 被选中时相关
}

export interface Prefs {
	widgetHidden: boolean;
	lastNodeModulesStrategy: NodeModulesStrategy;
	lastSymlinkTargetIds: string[];
}
