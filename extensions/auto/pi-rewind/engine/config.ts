/**
 * Checkpoint 引擎的路径排除策略（纯函数）。
 *
 * 内置高置信排除先生效，用户 `exclude` 追加，用户 `include` 以 `!` 重新包含。
 * 配置读取/校验由扩展层经 `@zenone/pi-config` 完成。
 */

const DEFAULT_EXCLUDE_PATTERNS = [
	'.git',
	'node_modules/',
	'dist/',
	'build/',
	'target/',
	'.gradle/',
	'.ark/',
	'.next/',
	'.nuxt/',
	'.svelte-kit/',
	'.angular/',
	'.vite/',
	'.parcel-cache/',
	'.turbo/',
	'coverage/',
	'.cache/',
	'.venv/',
	'venv/',
	'.tox/',
	'__pycache__/',
	'.pytest_cache/',
	'.mypy_cache/',
	'.ruff_cache/',
	'htmlcov/',
	'*.pyc',
	'Pods/',
	'.expo/',
	'.cxx/',
	'.externalNativeBuild/',
	'.build/',
	'DerivedData/',
	'.terraform/',
	'.serverless/',
	'.aws-sam/',
	'**/.idea/workspace.xml',
	'**/.idea/tasks.xml',
	'**/.idea/caches/',
	'**/.idea/shelf/',
	'**/.idea/localHistory/',
	'**/.idea/compile-server/',
	'*.iws',
	'**/.DS_Store',
	'**/Thumbs.db',
	'**/Desktop.ini',
	'.vscode-test/',
	'*.swp',
	'*.swo',
	'*.log',
	'*.tmp',
] as const;

function normalizeIncludePatterns(patterns: readonly string[]): readonly string[] {
	return patterns.map((pattern) => (pattern.startsWith('!') ? pattern : `!${pattern}`));
}

/** 合并内置排除 + 用户 exclude + 用户 include（include 以 `!` 重新包含）。 */
export function resolveExcludePatterns(
	userExclude: readonly string[],
	userInclude: readonly string[],
): readonly string[] {
	return [...DEFAULT_EXCLUDE_PATTERNS, ...userExclude, ...normalizeIncludePatterns(userInclude)];
}

export { DEFAULT_EXCLUDE_PATTERNS };
