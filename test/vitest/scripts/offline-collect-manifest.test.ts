/**
 * offline collect 清单不变量 — Vitest 集成测试（无网络、无 pi 运行时）
 *
 * 钉住 ADR-0069「源码安装」的两条会让目标机**静默丢掉整个安全栈**的不变量：
 *   1. `@zenone/*` 本地包必须按源码 import 闭包补齐（纯库包 `@zenone/pi-state` 不在
 *      user-install profile 里，漏了它 → pi-config 加载失败 → 十几个扩展级联失败 → 探针隔离）；
 *   2. 纯库包必须标 `library: true`（pack 才不会给它造入口桥接、安装时才被当库目录）。
 *
 * 直接跑真实脚本（而非抽出来的纯函数）：清单推导在 collect.mjs 顶部即依赖仓库真实布局，
 * 复刻一份纯函数等于测影子实现；这里用空 agent 目录把外部依赖降到零。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const COLLECT = join(REPO_ROOT, 'scripts/offline/collect.mjs');

interface ManifestEntry {
	name: string;
	packageName?: string;
	library?: boolean;
	source?: string;
	entry?: string | null;
	needsBridge?: boolean;
}

interface Manifest {
	arch: string;
	localDev: boolean;
	extensions: ManifestEntry[];
	zenoneLinks: { name: string; dir: string }[];
}

function collectManifest(): Manifest {
	const work = mkdtempSync(join(tmpdir(), 'pi-offline-collect-'));
	try {
		mkdirSync(join(work, 'agent'), { recursive: true });
		const out = join(work, 'manifest.json');
		execFileSync(
			process.execPath,
			[COLLECT, '--arch', 'local', '--agent-dir', join(work, 'agent'), '--out', out],
			{ cwd: REPO_ROOT, stdio: 'pipe' },
		);
		return JSON.parse(readFileSync(out, 'utf8')) as Manifest;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function* walkSources(target: string): Generator<string> {
	const st = statSync(target);
	if (st.isFile()) {
		if (/\.(ts|mts|js|mjs|cjs)$/.test(target)) yield target;
		return;
	}
	for (const entry of readdirSync(target)) {
		if (entry === 'node_modules' || entry.startsWith('.')) continue;
		yield* walkSources(join(target, entry));
	}
}

const manifest = collectManifest();

describe('offline collect 清单', () => {
	it('--arch local 标记为 localDev（e2e 走完整安装路径的前提）', () => {
		expect(manifest.arch).toBe('local');
		expect(manifest.localDev).toBe(true);
	});

	it('纯库包 @zenone/pi-state 随包（且标 library），不依赖 profile 是否列出', () => {
		const piState = manifest.extensions.find((e) => e.packageName === '@zenone/pi-state');
		expect(piState, 'pi-state 必须出现在 extensions 里').toBeDefined();
		expect(piState?.library).toBe(true);
		expect(manifest.zenoneLinks.map((l) => l.name)).toContain('@zenone/pi-state');
	});

	it('扩展源码里 import 的每个 @zenone/* 都在 zenoneLinks 内（闭包完整）', () => {
		const linked = new Set(manifest.zenoneLinks.map((l) => l.name));
		const specifier = /['"](@zenone\/[a-z0-9][a-z0-9._-]*)['"]/g;
		const missing = new Set<string>();
		for (const ext of manifest.extensions) {
			if (!ext.source) continue;
			for (const file of walkSources(join(REPO_ROOT, ext.source))) {
				for (const m of readFileSync(file, 'utf8').matchAll(specifier)) {
					if (!linked.has(m[1]))
						missing.add(`${m[1]}（${file.replace(REPO_ROOT + '/', '')}）`);
				}
			}
		}
		expect([...missing]).toEqual([]);
	});

	it('library 条目不声明入口桥接，非 library 条目有源码', () => {
		for (const ext of manifest.extensions) {
			if (ext.library) {
				expect(ext.entry, `${ext.name} 是库，不该有入口`).toBeNull();
				expect(ext.needsBridge, `${ext.name} 是库，不该造桥接`).toBeFalsy();
			} else {
				expect(ext.source, `${ext.name} 缺 source`).toBeTruthy();
			}
		}
	});
});
