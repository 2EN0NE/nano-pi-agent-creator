/**
 * extractExtNames — 单元测试
 *
 * 验证从 git diff / git status 输出中提取扩展名的正则规则，
 * 覆盖所有路径格式。
 */
import { describe, it, expect } from 'vitest';

/**
 * extractExtNames 的纯逻辑实现（与 extension-dev-final-sync.ts 中完全一致）。
 * 抽取出来单独测试，避免加载 ExtensionAPI 等依赖。
 */
function extractExtNames(output: string, set: Set<string>): void {
	for (const file of output.split('\n')) {
		const f = file.trim();
		if (!f.startsWith('extensions/')) continue;

		// 单文件：extensions/category/name.ts(x)
		const fileMatch = f.match(/^extensions\/[^/]+\/([^/]+)\.tsx?$/);
		// 目录扩展根入口：extensions/category/name/index.ts(x)
		const dirMatch = f.match(/^extensions\/[^/]+\/([^/]+)\/index\.tsx?$/);
		// 裸目录（git status --porcelain 对未跟踪目录的输出）
		const bareDirMatch = f.match(/^extensions\/[^/]+\/([^/.]+)\/?$/);
		// 目录扩展深层 .ts 文件：extensions/category/name/any/file.ts(x)
		const subMatch = f.match(/^extensions\/[^/]+\/([^/]+)\/.*\.tsx?$/);
		// 目录扩展非 .ts 深层文件：extensions/category/name/any/file.ext
		// 必须 4+ 层深度（extensions/cat/name/file），排除 category 级文件
		const nonTSDeepMatch = f.match(/^extensions\/[^/]+\/([^/]+)\/.+$/);

		const match = fileMatch || dirMatch || bareDirMatch;

		if (match) {
			set.add(match[1]);
		} else if (subMatch) {
			set.add(subMatch[1]);
		} else if (nonTSDeepMatch) {
			set.add(nonTSDeepMatch[1]);
		}
	}
}

/** 辅助：调用 extractExtNames 返回提取的扩展名数组 */
function extract(output: string): string[] {
	const set = new Set<string>();
	extractExtNames(output, set);
	return [...set].sort();
}

describe('extractExtNames', () => {
	// ── 单文件扩展 ──────────────────────────────────────────

	it('提取 .ts 单文件扩展', () => {
		expect(extract('extensions/auto/foo.ts')).toEqual(['foo']);
		expect(extract('extensions/tui/bar.ts')).toEqual(['bar']);
		expect(extract('extensions/context/smart-context.ts')).toEqual(['smart-context']);
	});

	it('提取 .tsx 单文件扩展', () => {
		expect(extract('extensions/auto/foo.tsx')).toEqual(['foo']);
		expect(extract('extensions/accuracy/checker.tsx')).toEqual(['checker']);
	});

	it('不提取扩展名中包含 .ts 但不是文件后缀的路径（边界：正则 .tsx?$ 要求结尾）', () => {
		// 这些路径不以 .ts/.tsx 结尾，不应被 fileMatch 匹配
		expect(extract('extensions/auto/foo.ts.bak')).toEqual([]);
	});

	// ── 目录扩展 index.ts ──────────────────────────────────

	it('提取 index.ts 目录扩展', () => {
		expect(extract('extensions/meta/worktree/index.ts')).toEqual(['worktree']);
		expect(extract('extensions/tui/whimsical/index.ts')).toEqual(['whimsical']);
	});

	it('提取 index.tsx 目录扩展', () => {
		expect(extract('extensions/auto/loop/index.tsx')).toEqual(['loop']);
	});

	// ── 裸目录路径（git status 输出）──────────────────────

	it('提取带结尾斜杠的裸目录路径', () => {
		// git status --porcelain 对未跟踪目录的输出
		expect(extract('extensions/meta/worktree/')).toEqual(['worktree']);
		expect(extract('extensions/security/sandbox/')).toEqual(['sandbox']);
	});

	it('提取不带结尾斜杠的裸目录路径', () => {
		expect(extract('extensions/meta/worktree')).toEqual(['worktree']);
		expect(extract('extensions/tui/selector')).toEqual(['selector']);
	});

	it('裸目录不与深层文件混淆', () => {
		// bareDirMatch 只匹配 "category/name" 两层，不匹配 "category/name/xxx.ts"
		expect(extract('extensions/meta/worktree/lib/git.ts')).toEqual(['worktree']);
	});

	// ── 目录扩展深层文件 ───────────────────────────────────

	it('从深层 .ts 文件中提取扩展名', () => {
		expect(extract('extensions/tui/whimsical/lib/anim.ts')).toEqual(['whimsical']);
		expect(extract('extensions/meta/worktree/lib/git.ts')).toEqual(['worktree']);
		expect(extract('extensions/security/sandbox/src/index.ts')).toEqual(['sandbox']);
	});

	it('从深层 .tsx 文件中提取扩展名', () => {
		expect(extract('extensions/tui/recap/components/view.tsx')).toEqual(['recap']);
	});

	// ── 非扩展路径 ─────────────────────────────────────────

	it('忽略非 extensions/ 路径', () => {
		expect(extract('scripts/sync-profiles.yaml')).toEqual([]);
		expect(extract('test/vitest/extensions/test.ts')).toEqual([]);
		expect(extract('README.md')).toEqual([]);
	});

	it('忽略空行和空白', () => {
		expect(extract('\n  \n')).toEqual([]);
	});

	// ── 多行输入 ───────────────────────────────────────────

	it('从多行输出中提取多个扩展名（去重）', () => {
		const input = [
			'extensions/auto/foo.ts',
			'extensions/meta/worktree/index.ts',
			'extensions/auto/foo.ts', // 重复
			'extensions/tui/whimsical/lib/style.ts',
		].join('\n');

		expect(extract(input)).toEqual(['foo', 'whimsical', 'worktree']);
	});

	it('从 git status 输出（带 ?? 前缀）中提取', () => {
		// git status --porcelain 的原始输出格式
		// 实际调用前会先 filter .startsWith('?? ').map(l => l.slice(3))
		// 所以传入的是已 strip 过的路径
		const afterStrip = ['extensions/meta/worktree/', 'extensions/auto/foo.tsx'].join('\n');

		expect(extract(afterStrip)).toEqual(['foo', 'worktree']);
	});

	it('从 git diff 输出中提取', () => {
		const input = [
			'extensions/meta/worktree/index.ts',
			'extensions/meta/worktree/lib/git.ts',
			'extensions/auto/extension-dev-final-sync.ts',
		].join('\n');

		expect(extract(input)).toEqual(['extension-dev-final-sync', 'worktree']);
	});

	// ── 边界场景 ───────────────────────────────────────────

	it('深层目录文件只提取中间的扩展名，不提取最后文件名', () => {
		// subMatch 的 group(1) 是扩展名（name），不是最后文件名
		expect(extract('extensions/meta/worktree/lib/handlers/clean.ts')).toEqual(['worktree']);
	});

	it('路径中包含类似扩展名的文本也不误匹配', () => {
		// bareDirMatch 要求 "^extensions/cat/name/?$"，不能有多余内容
		expect(extract('extensions/meta/worktree-lib/foo.ts')).toEqual(['worktree-lib']);
	});

	it('目录名包含点号时不被 bareDirMatch 误匹配', () => {
		// [^/.]+ 确保 bareDirMatch 不匹配含点号的路径段
		expect(extract('extensions/auto/foo.ts.bak')).toEqual([]);
		expect(extract('extensions/meta/v1.0/')).toEqual([]);
	});

	// ── 非 .ts 文件变更检测（Issue 4） ────────────────────

	it('package.json 变更应检测到目录扩展名', () => {
		expect(extract('extensions/meta/worktree/package.json')).toEqual(['worktree']);
	});

	it('非 .ts 深层文件变更应检测到目录扩展名', () => {
		expect(extract('extensions/tui/whimsical/assets/config.yaml')).toEqual(['whimsical']);
		expect(extract('extensions/meta/worktree/.gitignore')).toEqual(['worktree']);
	});

	it('非 .ts 目录扩展根文件变更应检测到扩展名', () => {
		expect(extract('extensions/meta/pi-config/README.md')).toEqual(['pi-config']);
	});

	it('多个非 .ts 文件同时变更应去重', () => {
		const input = [
			'extensions/meta/worktree/package.json',
			'extensions/meta/worktree/.gitignore',
			'extensions/meta/worktree/tsconfig.json',
			'extensions/auto/foo.ts',
		].join('\n');
		expect(extract(input)).toEqual(['foo', 'worktree']);
	});

	it('根目录 extensions/package.json 不变更不被误认为扩展变更', () => {
		expect(extract('extensions/package.json')).toEqual([]);
	});

	it('非 TS 文件在扩展分类根目录不变更不误检测', () => {
		expect(extract('extensions/auto/README.md')).toEqual([]);
	});
});
