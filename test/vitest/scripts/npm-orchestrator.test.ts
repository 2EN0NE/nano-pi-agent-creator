/**
 * npm-orchestrator — Vitest 单元测试
 *
 * 覆盖：
 *   - utils.isNpmPackageDir
 *   - PackageManager.scanLocalPackages
 *   - PackageManager.writeRootPackageJson
 *   - PackageManager.hasRootDependencyChanged
 *   - BridgeBuilder.ensureBridges
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { isNpmPackageDir } from '../../../scripts/lib/utils.js';
import { PackageManager } from '../../../scripts/lib/package-manager.js';
import type { ResolvedResource } from '../../../scripts/lib/package-manager.js';
import { BridgeBuilder } from '../../../scripts/lib/bridge-builder.js';

// ============================================================================
// Test utilities
// ============================================================================

let tmpDir: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `npm-orch-test-${randomBytes(4).toString('hex')}`);
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** 创建一个目录扩展（含 package.json 和 index.ts） */
function createDirExt(base: string, name: string, pkgOverrides?: Record<string, unknown>): string {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'index.ts'), 'export default function() {}\n', 'utf8');
	const pkg: Record<string, unknown> = {
		name: `@zenone/${name}`,
		version: '1.0.0',
		description: `Test package ${name}`,
		...pkgOverrides,
	};
	writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
	return dir;
}

/** 创建一个 npm 风格扩展（带 pi.extensions 字段） */
function createNpmExt(base: string, name: string): string {
	const dir = createDirExt(base, name, {
		pi: { extensions: ['./dist/index.js'] },
	});
	// npm 风格扩展的入口在 src/index.ts
	const srcDir = join(dir, 'src');
	mkdirSync(srcDir, { recursive: true });
	writeFileSync(join(srcDir, 'index.ts'), 'export default function() {}\n', 'utf8');
	// 删除根 index.ts（npm 扩展用桥接替代）
	// 不删也行，测试中将检查桥接是否被创建
	return dir;
}

function makeResource(name: string, targetDir: string, isDir: boolean): ResolvedResource {
	return {
		type: 'extensions',
		name,
		sourcePath: join(targetDir, name),
		targetPath: isDir
			? join(targetDir, 'extensions', name)
			: join(targetDir, 'extensions', `${name}.ts`),
		isDirectory: isDir,
	};
}

// ============================================================================
// 1. utils.isNpmPackageDir
// ============================================================================

describe('isNpmPackageDir', () => {
	it('returns true for directory with pi field in package.json', () => {
		const dir = createDirExt(tmpDir, 'test-ext', { pi: { extensions: ['./dist/index.js'] } });
		expect(isNpmPackageDir(dir)).toBe(true);
	});

	it('returns false for directory without package.json', () => {
		const dir = join(tmpDir, 'no-pkg');
		mkdirSync(dir, { recursive: true });
		expect(isNpmPackageDir(dir)).toBe(false);
	});

	it('returns false for directory with package.json but no pi field', () => {
		const dir = createDirExt(tmpDir, 'plain-ext', {});
		expect(isNpmPackageDir(dir)).toBe(false);
	});

	it('returns false for non-existent directory', () => {
		expect(isNpmPackageDir(join(tmpDir, 'nonexistent'))).toBe(false);
	});

	it('returns false for directory with pi field but empty extensions array', () => {
		const dir = createDirExt(tmpDir, 'empty-pi', { pi: { extensions: [] } });
		expect(isNpmPackageDir(dir)).toBe(false);
	});
});

// ============================================================================
// 2. PackageManager.scanLocalPackages
// ============================================================================

describe('PackageManager.scanLocalPackages', () => {
	it('returns empty map when no @zenone packages exist', () => {
		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const result = pm.scanLocalPackages();
		expect(result.size).toBe(0);
	});

	it('scans target extensions dir for @zenone packages', () => {
		const extDir = join(tmpDir, 'extensions');
		mkdirSync(extDir, { recursive: true });
		createDirExt(extDir, 'pi-logger', {});
		createDirExt(extDir, 'pi-config', {});

		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const result = pm.scanLocalPackages();
		expect(result.size).toBe(2);
		expect(result.has('@zenone/pi-logger')).toBe(true);
		expect(result.get('@zenone/pi-logger')).toBe('./extensions/pi-logger');
		expect(result.has('@zenone/pi-config')).toBe(true);
		expect(result.get('@zenone/pi-config')).toBe('./extensions/pi-config');
	});

	it('scans only @zenone/* packages, ignoring others', () => {
		const extDir = join(tmpDir, 'extensions');
		mkdirSync(extDir, { recursive: true });
		createDirExt(extDir, 'pi-logger', { name: '@zenone/pi-logger' });
		createDirExt(extDir, 'some-lib', { name: 'some-lib' }); // not @zenone

		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const result = pm.scanLocalPackages();
		expect(result.size).toBe(1);
		expect(result.has('@zenone/pi-logger')).toBe(true);
		expect(result.has('some-lib')).toBe(false);
	});

	it('falls back to source project dir for packages not in target', () => {
		// target 无扩展，source 有
		const sourceDir = join(tmpDir, 'source');
		const sourceExtDir = join(sourceDir, 'extensions');
		mkdirSync(sourceExtDir, { recursive: true });
		createDirExt(sourceExtDir, 'pi-logger', {});

		const targetDir = join(tmpDir, 'target');
		mkdirSync(targetDir, { recursive: true });

		const pm = new PackageManager({ targetDir, projectRoot: sourceDir });
		const result = pm.scanLocalPackages();
		expect(result.size).toBe(1);
		expect(result.has('@zenone/pi-logger')).toBe(true);
		// 来自 source 的包使用绝对路径
		expect(result.get('@zenone/pi-logger')).toContain('pi-logger');
	});
});

// ============================================================================
// 3. PackageManager.writeRootPackageJson
// ============================================================================

describe('PackageManager.writeRootPackageJson', () => {
	it('creates root package.json with private=true and type=module', () => {
		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const packages = new Map([['@zenone/pi-logger', './extensions/pi-logger']]);
		const result = pm.writeRootPackageJson(packages);

		expect(result.added).toBe(1);
		expect(result.removed).toBe(0);
		expect(result.total).toBe(1);

		const pkgPath = join(tmpDir, 'package.json');
		expect(existsSync(pkgPath)).toBe(true);
		const content = JSON.parse(readFileSync(pkgPath, 'utf8'));
		expect(content.private).toBe(true);
		expect(content.type).toBe('module');
		expect(content.dependencies['@zenone/pi-logger']).toBe('./extensions/pi-logger');
	});

	it('removes stale @zenone entries while preserving non-@zenone ones', () => {
		// 先创建已有的 package.json
		const pkg = {
			private: true,
			type: 'module',
			dependencies: {
				'@zenone/pi-logger': './extensions/pi-logger',
				'@zenone/pi-config': './extensions/pi-config',
				'some-lib': '^1.0.0', // 非 @zenone，应保留
			},
		};
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const packages = new Map([['@zenone/pi-logger', './extensions/pi-logger']]); // pi-config 已不存在
		const result = pm.writeRootPackageJson(packages);

		expect(result.added).toBe(0);
		expect(result.removed).toBe(1); // pi-config 被移除
		expect(result.total).toBe(1);

		const content = JSON.parse(readFileSync(join(tmpDir, 'package.json'), 'utf8'));
		expect(content.dependencies['@zenone/pi-logger']).toBe('./extensions/pi-logger');
		expect(content.dependencies['@zenone/pi-config']).toBeUndefined(); // 已移除
		expect(content.dependencies['some-lib']).toBe('^1.0.0'); // 保留
	});

	it('does not modify file in dry-run mode', () => {
		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir, dryRun: true });
		const packages = new Map([['@zenone/pi-logger', './extensions/pi-logger']]);
		const result = pm.writeRootPackageJson(packages);

		expect(result.added).toBe(1);
		expect(existsSync(join(tmpDir, 'package.json'))).toBe(false); // dry-run: 未写入
	});

	it('returns no changes when target package.json already matches', () => {
		const initial = {
			private: true,
			type: 'module',
			dependencies: {
				'@zenone/pi-logger': './extensions/pi-logger',
			},
		};
		writeFileSync(
			join(tmpDir, 'package.json'),
			JSON.stringify(initial, null, 2) + '\n',
			'utf8',
		);

		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const packages = new Map([['@zenone/pi-logger', './extensions/pi-logger']]);
		const result = pm.writeRootPackageJson(packages);

		expect(result.added).toBe(0);
		expect(result.removed).toBe(0);
		expect(result.total).toBe(1);
	});
});

// ============================================================================
// 4. PackageManager.hasRootDependencyChanged
// ============================================================================

describe('PackageManager.hasRootDependencyChanged', () => {
	it('returns true when no package.json exists', () => {
		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const packages = new Map([['@zenone/pi-logger', './extensions/pi-logger']]);
		expect(pm.hasRootDependencyChanged(packages)).toBe(true);
	});

	it('returns false when package.json already has matching entries', () => {
		const pkg = {
			private: true,
			type: 'module',
			dependencies: {
				'@zenone/pi-logger': './extensions/pi-logger',
			},
		};
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const packages = new Map([['@zenone/pi-logger', './extensions/pi-logger']]);
		expect(pm.hasRootDependencyChanged(packages)).toBe(false);
	});

	it('returns true when entries mismatch', () => {
		const pkg = {
			private: true,
			type: 'module',
			dependencies: {
				'@zenone/pi-logger': './extensions/pi-logger',
			},
		};
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		// pi-config 不在 package.json 中
		const packages = new Map([
			['@zenone/pi-logger', './extensions/pi-logger'],
			['@zenone/pi-config', './extensions/pi-config'],
		]);
		expect(pm.hasRootDependencyChanged(packages)).toBe(true);
	});

	it('returns true when there are stale @zenone entries', () => {
		const pkg = {
			private: true,
			type: 'module',
			dependencies: {
				'@zenone/pi-logger': './extensions/pi-logger',
				'@zenone/pi-config': './extensions/pi-config', // stale
			},
		};
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

		const pm = new PackageManager({ targetDir: tmpDir, projectRoot: tmpDir });
		const packages = new Map([['@zenone/pi-logger', './extensions/pi-logger']]);
		expect(pm.hasRootDependencyChanged(packages)).toBe(true);
	});
});

// ============================================================================
// 5. BridgeBuilder.ensureBridges
// ============================================================================

describe('BridgeBuilder.ensureBridges', () => {
	it('creates bridges for npm-style extensions', () => {
		const extDir = join(tmpDir, 'extensions');
		mkdirSync(extDir, { recursive: true });
		createNpmExt(extDir, 'ci-watch');

		const bb = new BridgeBuilder({ dryRun: false });
		const resources = [makeResource('ci-watch', tmpDir, true)];
		const result = bb.ensureBridges(resources);

		expect(result.created).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.failed).toBe(0);

		const bridgePath = join(extDir, 'ci-watch', 'index.ts');
		expect(existsSync(bridgePath)).toBe(true);
		const content = readFileSync(bridgePath, 'utf8');
		expect(content).toContain('export { default } from "./src/index.ts"');
	});

	it('skips non-npm-style extensions', () => {
		const extDir = join(tmpDir, 'extensions');
		mkdirSync(extDir, { recursive: true });
		createDirExt(extDir, 'plain-ext', {}); // 无 pi 字段

		const bb = new BridgeBuilder({ dryRun: false });
		const resources = [makeResource('plain-ext', tmpDir, true)];
		const result = bb.ensureBridges(resources);

		expect(result.created).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.failed).toBe(0);
	});

	it('skips single-file extensions', () => {
		const bb = new BridgeBuilder({ dryRun: false });
		// 单文件资源 isDirectory=false
		const resources: ResolvedResource[] = [
			{
				type: 'extensions',
				name: 'foo',
				sourcePath: join(tmpDir, 'foo.ts'),
				targetPath: join(tmpDir, 'extensions', 'foo.ts'),
				isDirectory: false,
			},
		];
		const result = bb.ensureBridges(resources);
		expect(result.created).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.failed).toBe(0);
	});

	it('reports failed when src/index.ts is missing', () => {
		const extDir = join(tmpDir, 'extensions');
		mkdirSync(extDir, { recursive: true });
		// 有 pi 字段但无 src/index.ts
		createDirExt(extDir, 'broken', { pi: { extensions: ['./dist/index.js'] } });

		const bb = new BridgeBuilder({ dryRun: false });
		const resources = [makeResource('broken', tmpDir, true)];
		const result = bb.ensureBridges(resources);

		expect(result.created).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.details[0].reason).toContain('src/index.ts not found');
	});

	it('reuses existing bridges without creating duplicates', () => {
		const extDir = join(tmpDir, 'extensions');
		mkdirSync(extDir, { recursive: true });
		createNpmExt(extDir, 'ci-watch');

		// 先创建桥接
		const bb = new BridgeBuilder({ dryRun: false });
		const resources = [makeResource('ci-watch', tmpDir, true)];
		bb.ensureBridges(resources);

		// 再次运行
		const result = bb.ensureBridges(resources);
		expect(result.created).toBe(0);
		expect(result.skipped).toBe(1);
		expect(result.failed).toBe(0);
	});

	it('dry-run mode does not create files', () => {
		const extDir = join(tmpDir, 'extensions');
		mkdirSync(extDir, { recursive: true });
		createNpmExt(extDir, 'ci-watch');
		// 手动删除桥接文件以模拟"尚未创建"的状态
		const bridgePath = join(extDir, 'ci-watch', 'index.ts');
		if (existsSync(bridgePath)) rmSync(bridgePath);

		const bb = new BridgeBuilder({ dryRun: true });
		const resources = [makeResource('ci-watch', tmpDir, true)];
		const result = bb.ensureBridges(resources);

		expect(result.created).toBe(1); // dry-run report
		expect(existsSync(bridgePath)).toBe(false); // 未实际写入
	});
});

it('explicitNames creates bridges for non-npm-style directory extensions', () => {
	const extDir = join(tmpDir, 'extensions');
	mkdirSync(extDir, { recursive: true });
	// 普通目录扩展（无 pi 字段，但有 src/index.ts）
	const dir = join(extDir, 'custom-ext');
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'index.ts'), 'export default function() {}\n', 'utf8');
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'custom-ext', version: '1.0.0' }) + '\n',
		'utf8',
	);

	const bb = new BridgeBuilder({ dryRun: false });
	const resources = [makeResource('custom-ext', tmpDir, true)];
	// 通过 explicitNames 强制识别为 npm 风格
	const result = bb.ensureBridges(resources, ['custom-ext']);

	expect(result.created).toBe(1);
	expect(result.failed).toBe(0);
	expect(existsSync(join(dir, 'index.ts'))).toBe(true);
});

it('dry-run falls back to sourcePath when target directory does not exist', () => {
	const extDir = join(tmpDir, 'source-extensions');
	mkdirSync(extDir, { recursive: true });
	// source 目录下有 npm 风格扩展
	createNpmExt(extDir, 'cloud-ext');

	const bb = new BridgeBuilder({ dryRun: true });
	// targetPath 指向不存在的目录
	const resources: ResolvedResource[] = [
		{
			type: 'extensions',
			name: 'cloud-ext',
			sourcePath: join(extDir, 'cloud-ext'),
			targetPath: join(tmpDir, 'target', 'extensions', 'cloud-ext'),
			isDirectory: true,
		},
	];
	const result = bb.ensureBridges(resources);

	// 应通过 sourcePath 检测到 npm 风格，报告 created
	expect(result.created).toBe(1);
	expect(result.skipped).toBe(0);
	expect(result.failed).toBe(0);
});
