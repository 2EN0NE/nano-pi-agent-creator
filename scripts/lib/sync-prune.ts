/**
 * sync-prune.ts — sync 工具的受管资产剪枝与配置重置（ADR-0037）
 *
 * 纯逻辑 / 渲染部分从 sync-to-local-pi.ts 抽出，供 vitest 直接单测
 * （sync-to-local-pi.ts 底部会执行 main()，无法被安全 import）。
 *
 * 术语见 CONTEXT.md「本地同步（sync 工具）」：受管资产 / 第三方资产 /
 * 有效集合 / 严格剪枝 / 保护名单。
 */

import { existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';

// ── 删除候选分类（Ticket 01） ──────────────────────────────────

export interface DeletionClassification {
	/** 受管资产：名字 ∈ 源清单 → profile 模式默认剪枝对象 */
	managed: string[];
	/** 第三方资产：名字 ∉ 源清单 → 仅 --purge 删除 */
	thirdParty: string[];
}

/**
 * 把「目标中存在、但不在有效集合、也不在保护名单」的资产，按是否属于本仓库
 * 源清单（受管）分成两类。纯函数，无副作用。
 */
export function classifyDeletionCandidates(
	targetExisting: string[],
	effectiveNames: Set<string>,
	sourceInventory: Set<string>,
	protectedNames: Set<string> | undefined,
): DeletionClassification {
	const managed: string[] = [];
	const thirdParty: string[] = [];
	for (const item of targetExisting) {
		if (effectiveNames.has(item)) continue; // 本次同步会覆盖，不是删除候选
		if (protectedNames?.has(item)) continue; // 保护名单 → 永不删除
		if (sourceInventory.has(item)) managed.push(item);
		else thirdParty.push(item);
	}
	managed.sort();
	thirdParty.sort();
	return { managed, thirdParty };
}

export interface DeletionDecision {
	toDelete: string[];
	toKeep: string[];
}

/**
 * 删除决策（纯函数）：
 *   purge=true            → 全量镜像：受管 + 第三方都删
 *   inline 且无 purge     → 不删（内联模式保持增量拷贝现状）
 *   profile 默认（无 purge）→ 严格剪枝：仅删受管
 */
export function computeDeletionDecision(
	managed: string[],
	thirdParty: string[],
	purge: boolean,
	inline: boolean,
): DeletionDecision {
	if (purge) return { toDelete: [...managed, ...thirdParty], toKeep: [] };
	if (inline) return { toDelete: [], toKeep: [...managed, ...thirdParty] };
	return { toDelete: managed, toKeep: thirdParty };
}

// ── 形态冲突残留（同名单文件 vs 目录） ──────────────────────────

export interface FormConflict {
	name: string;
	/** 精确删除路径（文件或目录） */
	path: string;
	sourceIsDir: boolean;
	targetIsDir: boolean;
}

/**
 * 找出目标 extensions 目录中「名字在源清单、但形态与源不一致」的残留。
 *
 * 例：源里 review 是目录扩展（extensions/verification/review/），目标里残留了
 * 旧版单文件 review.ts → 两者同名，pi 自动发现会各加载一次导致 review:1/review:2。
 * 该 .ts 文件就是形态冲突残留，应删除（名字虽在有效集合，但形态已过时）。
 *
 * 纯函数：只读目标目录，返回带精确路径的冲突列表。
 */
export function findExtensionFormConflicts(
	targetExtensionsDir: string,
	sourceForm: Map<string, boolean>, // name -> isDirectory（源形态）
): FormConflict[] {
	if (!existsSync(targetExtensionsDir)) return [];
	const out: FormConflict[] = [];
	const entries = readdirSync(targetExtensionsDir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const fullPath = join(targetExtensionsDir, entry.name);

		if (entry.isFile() && entry.name.endsWith('.ts')) {
			const name = entry.name.slice(0, -3);
			if (sourceForm.get(name) === true) {
				out.push({ name, path: fullPath, sourceIsDir: true, targetIsDir: false });
			}
		} else if (entry.isDirectory() && existsSync(join(fullPath, 'index.ts'))) {
			const name = entry.name;
			if (sourceForm.get(name) === false) {
				out.push({ name, path: fullPath, sourceIsDir: false, targetIsDir: true });
			}
		}
	}
	return out;
}

// ── 配置重置候选收集（Ticket 02） ──────────────────────────────

export interface ConfigResetCandidate {
	plugin: string;
	reason: 'deleted' | 'updated';
	configPath: string;
}

/**
 * 收集「被删除 / 被更新、且目标下已保存过 pi-config profile」的插件。
 * 只返回 extensions-data/<plugin>/config.json 实际存在的项（无 profile 可重置的
 * 插件自然不进列表）。纯读操作，无副作用。
 */
export function collectConfigResetCandidates(
	targetDir: string,
	removedExtensions: string[],
	updatedExtensions: string[],
): ConfigResetCandidate[] {
	const seen = new Set<string>();
	const out: ConfigResetCandidate[] = [];
	const entries: Array<[string, 'deleted' | 'updated']> = [
		...removedExtensions.map((p): [string, 'deleted'] => [p, 'deleted']),
		...updatedExtensions.map((p): [string, 'updated'] => [p, 'updated']),
	];
	for (const [plugin, reason] of entries) {
		if (seen.has(plugin)) continue;
		seen.add(plugin);
		const configPath = join(targetDir, 'extensions-data', plugin, 'config.json');
		if (existsSync(configPath)) {
			out.push({ plugin, reason, configPath });
		}
	}
	return out;
}

// ── 交互式多选（raw mode） ─────────────────────────────────────

/**
 * 纯渲染：给定选项 / 光标 / 选中集，产出终端多选列表文本（供 vitest 断言）。
 * 不使用双宽 emoji（字符白名单约定）。
 */
export function renderMultiSelect(
	title: string,
	items: string[],
	cursor: number,
	selected: Set<number>,
	width = 58,
): string {
	const rule = '─'.repeat(width);
	const lines: string[] = [title, rule];
	for (let i = 0; i < items.length; i++) {
		const mark = selected.has(i) ? '[x]' : '[ ]';
		const cursorMark = i === cursor ? '>' : ' ';
		lines.push(`${cursorMark} ${mark} ${items[i]}`);
	}
	lines.push(rule);
	lines.push('Space=切换  a=全选/全不选  Enter=确认  Ctrl+C=全保留');
	return lines.join('\n');
}

/**
 * 交互式多选。非 TTY（CI / husky / e2e / 管道）或空选项 → 返回空选中集（全保留）。
 * 勾选 = 重置 profile（删 config.json）。
 *
 * 键位：↑/↓ 移动、Space 切换、a 全选/全不选、Enter 确认、Ctrl+C 中止 = 全保留。
 */
export function interactiveMultiSelect(title: string, items: string[]): Promise<Set<number>> {
	if (items.length === 0 || !process.stdin.isTTY || !process.stdout.isTTY) {
		if (items.length > 0) {
			// 非 TTY（CI / husky / e2e / 管道）→ 全保留，不阻塞挂起
			console.warn(
				`  ⚠️  Non-interactive environment — keeping all config profiles (${items.length} item(s)).`,
			);
		}
		return Promise.resolve(new Set());
	}

	return new Promise((resolve) => {
		const selected = new Set<number>();
		let cursor = 0;
		let renderedLines = 0;

		readline.emitKeypressEvents(process.stdin);
		process.stdin.setRawMode(true);
		process.stdin.resume();

		const render = () => {
			if (renderedLines > 0) {
				process.stdout.write(`\x1b[${renderedLines}A\x1b[J`);
			}
			const text = renderMultiSelect(title, items, cursor, selected);
			process.stdout.write(text + '\n');
			renderedLines = text.split('\n').length;
		};

		const onKeypress = (_str: string | undefined, key: readline.Key) => {
			if (key.ctrl && key.name === 'c') {
				cleanup();
				resolve(new Set()); // 中止 = 全保留
				return;
			}
			switch (key.name) {
				case 'up':
					cursor = (cursor - 1 + items.length) % items.length;
					break;
				case 'down':
					cursor = (cursor + 1) % items.length;
					break;
				case 'space':
					if (selected.has(cursor)) selected.delete(cursor);
					else selected.add(cursor);
					break;
				case 'a':
					if (selected.size === items.length) selected.clear();
					else for (let i = 0; i < items.length; i++) selected.add(i);
					break;
				case 'return':
				case 'enter':
					cleanup();
					resolve(selected);
					return;
				default:
					return; // 未识别键不重绘
			}
			render();
		};

		const cleanup = () => {
			process.stdin.setRawMode(false);
			process.stdin.pause();
			process.stdin.removeListener('keypress', onKeypress);
		};

		process.stdin.on('keypress', onKeypress);
		render();
	});
}

/**
 * 应用配置重置：删除勾选项的 config.json（保留同目录 <sessionId>.json session 文件）。
 * 返回实际被重置的插件名列表。
 */
export function resetConfigProfiles(
	candidates: ConfigResetCandidate[],
	selected: Set<number>,
	log: (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void,
): string[] {
	const reset: string[] = [];
	candidates.forEach((c, i) => {
		if (!selected.has(i)) return;
		try {
			if (existsSync(c.configPath)) {
				rmSync(c.configPath, { force: true });
			}
			reset.push(c.plugin);
			log(
				'WARN',
				`[CONFIG RESET] ${c.plugin} (${c.reason}) → defaults (deleted ${c.configPath})`,
			);
		} catch (err) {
			log('ERROR', `Failed to reset config for ${c.plugin}: ${err}`);
		}
	});
	return reset;
}
