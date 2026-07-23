/**
 * scripts/lib/utils.ts — 共享工具函数
 *
 * 供 package-manager 和 bridge-builder 共享使用。
 * 不依赖其他 scripts/lib 模块。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 检查目录是否为 npm 风格的扩展包：
 * 目录下有 package.json 且包含 "pi" 字段（pi.extensions 为数组）。
 */
export function isNpmPackageDir(dir: string): boolean {
	const pkgPath = join(dir, 'package.json');
	if (!existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		return !!(pkg.pi && Array.isArray(pkg.pi.extensions) && pkg.pi.extensions.length > 0);
	} catch {
		return false;
	}
}
