/**
 * pi-session-tree package.json 导出结构验证
 *
 * 回归：package.json 新增 main + exports.default（兼容 require/旧式解析），
 * 防止 main/default 指向不存在的文件导致第三方（custom-compaction 等）解析失败。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const pkgPath = resolve(__dirname, '../../../extensions/meta/pi-session-tree/package.json');
const pkgDir = dirname(pkgPath);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
	main?: string;
	exports?: Record<string, { import?: string; default?: string } | string>;
};

describe('pi-session-tree package.json 导出结构', () => {
	it('main 指向的文件存在', () => {
		expect(pkg.main).toBe('./index.ts');
		expect(existsSync(resolve(pkgDir, pkg.main!))).toBe(true);
	});

	it('exports["."].import 与 .default 均指向 index.ts', () => {
		const dot = pkg.exports?.['.'] as { import?: string; default?: string };
		expect(dot.import).toBe('./index.ts');
		expect(dot.default).toBe('./index.ts');
		expect(existsSync(resolve(pkgDir, dot.default!))).toBe(true);
	});

	it('exports["./types"].import 指向 types.ts', () => {
		const types = pkg.exports?.['./types'] as { import?: string };
		expect(types.import).toBe('./types.ts');
		expect(existsSync(resolve(pkgDir, types.import!))).toBe(true);
	});
});
