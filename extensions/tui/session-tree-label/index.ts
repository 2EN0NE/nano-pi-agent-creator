/**
 * session-tree-label — 标签标记插件
 *
 * 命令：/label g (或 /label good)  → GOOD
 *       /label b (或 /label bad)   → BAD
 *       /label                    → 查看当前标签
 *
 * 快捷键：alt+. → 激活标签模式，显示提示，按 g/b 标记
 *
 * 标签写入会话 JSONL，/tree 中可视化展示，也可在 /tree 中编辑。
 *
 * 配置见同目录 config.json。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey } from '@earendil-works/pi-tui';
import { createLogger } from '@zenone/pi-logger';
import { resolveConfigPaths, readJsonFile } from '@zenone/pi-config';

const log = createLogger('session-tree-label');

// ── Types ──────────────────────────────────────────────────────────────────

interface LabelConfig {
	/** 快捷键字母 (如 "g") */
	key: string;
	/** 标签值 (如 "GOOD") */
	label: string;
	/** 命令别名 (如 ["good", "g"]) */
	aliases?: string[];
	/** 人类可读描述 */
	description?: string;
}

interface PluginConfig {
	/** 激活标签模式的快捷键 (如 "alt+.") */
	leaderKey: string;
	/** 标签映射表 */
	labels: LabelConfig[];
	/** 超时毫秒数 */
	timeout: number;
}

// ── 默认配置 ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PluginConfig = {
	leaderKey: 'alt+.',
	labels: [
		{
			key: 'g',
			label: 'GOOD',
			aliases: ['good', 'g'],
			description: '回答质量好',
		},
		{
			key: 'b',
			label: 'BAD',
			aliases: ['bad', 'b'],
			description: '回答质量差',
		},
	],
	timeout: 2000,
};

// ── 配置加载（使用 @zenone/pi-config 标准路径） ─────────────────

let _cachedConfig: PluginConfig | null = null;

function loadConfig(): PluginConfig {
	if (_cachedConfig) return _cachedConfig;

	const paths = resolveConfigPaths('session-tree-label');
	let merged: PluginConfig = { ...DEFAULT_CONFIG };

	// 用户级
	const userRaw = readJsonFile(paths.userFile);
	if (userRaw !== null) {
		merged = { ...merged, ...(userRaw as Partial<PluginConfig>) };
	}

	// 项目级（最高优先级）
	const projectRaw = readJsonFile(paths.projectFile);
	if (projectRaw !== null) {
		merged = { ...merged, ...(projectRaw as Partial<PluginConfig>) };
	}

	_cachedConfig = merged;
	return merged;
}

function reloadConfig(): void {
	_cachedConfig = null;
	loadConfig();
	const config = _cachedConfig!;
	log.info('Config reloaded', { leaderKey: config.leaderKey, labels: buildHint(config.labels) });
}

// ── 安全通知 ──────────────────────────────────────────────────────────────

function safeNotify(ctx: ExtensionContext, msg: string, type?: 'info' | 'warning' | 'error'): void {
	if (ctx.hasUI) {
		ctx.ui.notify(msg, type);
	}
	log.info('[notify] %s %s', type ?? 'info', msg);
}

// ── 安全类型访问 SessionManager write 方法 ──────────────────────────

/**
 * 调用 SessionManager.appendLabelChange，带运行时守卫。
 * ctx.sessionManager 类型为 ReadonlySessionManager（缺少 write 方法），
 * 但运行时对象是完整的 SessionManager。用显式守卫确保方法存在。
 */
function safeAppendLabelChange(ctx: ExtensionContext, targetId: string, label: string): void {
	const sm = ctx.sessionManager as Record<string, unknown>;
	if (typeof sm.appendLabelChange !== 'function') {
		throw new Error(
			'sessionManager.appendLabelChange is not available — ' +
				'this pi version may not support label entries',
		);
	}
	(sm.appendLabelChange as (targetId: string, label: string | undefined) => string)(
		targetId,
		label,
	);
}

// ── 应用标签 ──────────────────────────────────────────────────────────────

/**
 * 从当前叶子节点向上找最近的 message 类型节点，然后应用标签。
 * 避免标签打到 custom/compaction 等其他扩展的条目上。
 */
function applyLabelToLeaf(ctx: ExtensionContext, labelCfg: LabelConfig): boolean {
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) {
		safeNotify(ctx, '没有可标记的节点', 'warning');
		return false;
	}

	// 获取分支路径（root → leaf），从后往前找最新的 message 类型节点
	const branch = ctx.sessionManager.getBranch();
	let targetId = leafId;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === 'message') {
			const msg = entry.message as { role?: string };
			if (msg.role === 'user' || msg.role === 'assistant') {
				targetId = entry.id;
				break;
			}
		}
	}

	try {
		safeAppendLabelChange(ctx, targetId, labelCfg.label);
		safeNotify(ctx, `✓ ${labelCfg.label}`, 'info');
		log.info('Label applied', { targetId, label: labelCfg.label });
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		safeNotify(ctx, `标签应用失败: ${msg}`, 'error');
		log.error('Failed to apply label', { err: msg, targetId });
		return false;
	}
}

// ── 构建提示文字 ──────────────────────────────────────────────────────────

function buildHint(labels: LabelConfig[]): string {
	return labels.map((l) => `${l.key}=${l.label}`).join(' ');
}

// ── 扩展入口 ──────────────────────────────────────────────────────────────

export default function sessionTreeLabel(pi: ExtensionAPI): void {
	const config = loadConfig();
	log.info('session-tree-label initialized', {
		leaderKey: config.leaderKey,
		hint: buildHint(config.labels),
	});

	// ═══════════════════════════════════════════════════
	//  /label 命令
	// ═══════════════════════════════════════════════════
	pi.registerCommand('label', {
		description: `标记节点: /label <${config.labels.map((l) => l.aliases?.join('|')).join('|')}|status|reload>`,
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args?.trim().toLowerCase();

			// /label 或 /label status → 查看状态
			if (!trimmed || trimmed === 'status') {
				const leafId = ctx.sessionManager.getLeafId();
				if (!leafId) {
					safeNotify(ctx, '没有可标记的节点', 'info');
					return;
				}
				const existing = ctx.sessionManager.getLabel(leafId);
				safeNotify(ctx, existing ? `当前标签: ${existing}` : '当前节点无标签', 'info');
				return;
			}

			// /label reload → 重载配置
			if (trimmed === 'reload') {
				try {
					reloadConfig();
					const fresh = loadConfig();
					safeNotify(ctx, `配置已重载 (${buildHint(fresh.labels)})`, 'info');
				} catch (err) {
					safeNotify(ctx, `重载失败: ${err}`, 'error');
				}
				return;
			}

			// 匹配标签
			for (const lc of config.labels) {
				if (lc.key === trimmed || lc.aliases?.includes(trimmed)) {
					applyLabelToLeaf(ctx, lc);
					return;
				}
			}

			safeNotify(
				ctx,
				`未知标签「${trimmed}」。可用: ${config.labels.map((l) => `${l.key}(${l.label})`).join(' ')}`,
				'warning',
			);
		},
	});

	// ═══════════════════════════════════════════════════
	//  快捷键：ctrl+g → 激活标签模式
	//  使用 registerShortcut（不拦截普通 Esc/tree）
	// ═══════════════════════════════════════════════════
	pi.registerShortcut(config.leaderKey as Parameters<typeof pi.registerShortcut>[0], {
		description: `标签模式: ${buildHint(config.labels)}`,
		handler: async (ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;

			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) return;

			// 显示已有标签和提示
			const existing = ctx.sessionManager.getLabel(leafId);
			const hint = buildHint(config.labels);
			if (existing) {
				ctx.ui.notify(`当前: ${existing} | ${hint}`, 'info');
			} else {
				ctx.ui.notify(`无标签 | ${hint}`, 'info');
			}
			ctx.ui.setStatus('session-tree-label', ctx.ui.theme.fg('dim', `| ${hint}`));

			let cleaned = false;
			const clean = () => {
				if (cleaned) return;
				cleaned = true;
				clearTimeout(timer);
				ctx.ui.setStatus('session-tree-label', undefined);
				unsub();
			};

			const timer = setTimeout(() => {
				clean();
			}, config.timeout);

			const unsub = ctx.ui.onTerminalInput((data: string) => {
				// Esc / Ctrl+C → 取消
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
					clean();
					return { consume: true };
				}

				// 匹配标签
				for (const lc of config.labels) {
					if (matchesKey(data, lc.key as Parameters<typeof matchesKey>[1])) {
						applyLabelToLeaf(ctx, lc);
						clean();
						return { consume: true };
					}
				}

				// 不匹配的键 → 消耗但不退出（防止误输入）
				return { consume: true };
			});
		},
	});
}
