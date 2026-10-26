/**
 * preset 默认工具集护栏
 *
 * pi 的 `DEFAULT_TOOL_NAMES`（"未配置 `defaultTools` 时的启动默认"）只在核心模块导出，
 * **没有从包根 re-export**（包 exports 只有 `.` 与 `./rpc-entry`）——所以 preset 只能硬编码
 * 同名字面量，且无法靠 import 保证一致。
 *
 * 这个测试就是那个"保证"：基座升级后 pi 若改了内置默认工具集，preset 的解析结果会静默
 * 与 pi 语义分叉（不报错、只算错），本测试会立刻红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_TOOL_NAMES } from '../../../extensions/meta/preset/tools.ts';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const SETTINGS_MANAGER = join(
	REPO_ROOT,
	'node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js',
);

/** 从 pi 的构建产物里读出内置默认工具集（无法 import，只能读源）。 */
function readPiDefaultToolNames(): string[] {
	const src = readFileSync(SETTINGS_MANAGER, 'utf8');
	const m = src.match(/DEFAULT_TOOL_NAMES\s*=\s*\[([^\]]*)\]/);
	if (!m) {
		throw new Error(
			`无法在 ${SETTINGS_MANAGER} 中定位 DEFAULT_TOOL_NAMES —— pi 的内部结构变了，` +
				`请更新本测试的读取方式（护栏失效比测试失败更危险）。`,
		);
	}
	return m[1]
		.split(',')
		.map((s) => s.trim().replace(/^["']|["']$/g, ''))
		.filter(Boolean);
}

describe('preset 的默认工具集与 pi 保持一致', () => {
	it('DEFAULT_TOOL_NAMES 与 pi 内置默认集逐项相同', () => {
		const piDefaults = readPiDefaultToolNames();
		expect(
			DEFAULT_TOOL_NAMES,
			`pi 改了内置默认工具集（现在是 ${piDefaults.join(', ')}）。请同步 preset 的 ` +
				`DEFAULT_TOOL_NAMES 与 ADR-0065 的维护提示，否则 preset 会按过时的默认集解析。`,
		).toEqual(piDefaults);
	});

	it('pi 的默认集仍然只含仓库基线四件套（回归证据）', () => {
		// 这条不是为了"测试常量"，而是把"1.4.0 的默认集是什么"留成可观测证据：
		// 若上游新增/移除内置默认工具，上面那条会红，这条说明变化前后的具体内容。
		expect(readPiDefaultToolNames()).toEqual(['read', 'bash', 'edit', 'write']);
	});
});
