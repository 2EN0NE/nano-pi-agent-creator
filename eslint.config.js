import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';

export default [
	{
		ignores: [
			'node_modules',
			'**/dist/**',
			'build',
			'.husky/**',
			'**/package-lock.json',
			'.pi/**',
		],
	},
	prettierConfig,
	{
		files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				console: 'readonly',
				process: 'readonly',
				Buffer: 'readonly',
				fetch: 'readonly',
				AbortSignal: 'readonly',
				AbortController: 'readonly',
				TextDecoder: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
			},
		},
		rules: {
			...js.configs.recommended.rules,
			'no-empty': ['error', { allowEmptyCatch: true }],
		},
	},
	{
		files: ['**/scripts/**/*.js'],
		languageOptions: {
			globals: {
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
				document: 'readonly',
				window: 'readonly',
				navigator: 'readonly',
				console: 'readonly',
				process: 'readonly',
				Buffer: 'readonly',
				fetch: 'readonly',
				AbortSignal: 'readonly',
				AbortController: 'readonly',
				TextDecoder: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
			},
		},
	},
];
