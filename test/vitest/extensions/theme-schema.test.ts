/**
 * 主题 schema 门禁
 *
 * 为什么需要常驻门禁：pi 在启动时按**打包内的编译期 schema** 校验主题，
 * 顶层与 `colors` 两层都是 `additionalProperties: false`，且 `colors` 有 51 个
 * required token。上游一旦增删 token，本仓主题会在 pi **启动时直接 throw**
 * （不是降级成默认主题）。这类破坏只会在"某天 pi 起不来"时暴露，所以固化成测试。
 *
 * 同时校验 `$schema` 指向官方 URL（纯编辑器补全用；运行时不会 fetch，见 ADR-0067）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const THEMES_DIR = join(REPO_ROOT, 'themes');
const SCHEMA_PATH = join(
	REPO_ROOT,
	'node_modules/@earendil-works/pi-coding-agent/schemas/theme.schema.json',
);

const EXPECTED_SCHEMA_URL = 'https://pi.dev/schemas/theme.schema.json';

interface ThemeSchema {
	additionalProperties: boolean;
	properties: {
		colors: {
			additionalProperties: boolean;
			required: string[];
			properties: Record<string, unknown>;
		};
	};
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as ThemeSchema;
const allowedTopLevelKeys = Object.keys(
	(schema as unknown as { properties: Record<string, unknown> }).properties,
);
const allowedColorKeys = Object.keys(schema.properties.colors.properties);
const requiredColorKeys = schema.properties.colors.required;

const themeFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith('.json'));

describe('themes 与 pi 打包的 theme schema 保持一致', () => {
	it('至少有一个主题文件（防止目录读错导致空跑通过）', () => {
		expect(themeFiles.length).toBeGreaterThan(0);
	});

	for (const file of themeFiles) {
		const theme = JSON.parse(readFileSync(join(THEMES_DIR, file), 'utf8'));

		describe(file, () => {
			it(`$schema 指向 ${EXPECTED_SCHEMA_URL}`, () => {
				expect(theme.$schema).toBe(EXPECTED_SCHEMA_URL);
			});

			it('没有 schema 不认识的顶层键（additionalProperties: false）', () => {
				const extra = Object.keys(theme).filter((k) => !allowedTopLevelKeys.includes(k));
				expect(
					extra,
					`主题含 schema 未定义的顶层键：${extra.join(', ')}。pi 启动时会因主题不合法直接报错，请删除这些键。`,
				).toEqual([]);
			});

			it('colors 无缺失 token', () => {
				const present = new Set(Object.keys(theme.colors ?? {}));
				const missing = requiredColorKeys.filter((k) => !present.has(k));
				expect(
					missing,
					`缺少必需颜色 token：${missing.join(', ')}。pi 改了主题 schema，请补齐这些 token。`,
				).toEqual([]);
			});

			it('colors 无多余 token', () => {
				const extra = Object.keys(theme.colors ?? {}).filter(
					(k) => !allowedColorKeys.includes(k),
				);
				expect(
					extra,
					`颜色 token 已不被 pi 认识：${extra.join(', ')}。请删除（否则主题校验失败）。`,
				).toEqual([]);
			});
		});
	}
});
