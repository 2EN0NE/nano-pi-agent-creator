/**
 * pi-worktree v2 — 基于 git worktree 的隔离开发管理插件（硬约束版）
 *
 * 核心变化：切换 worktree = ctx.switchSession() 实质切换 cwd。
 * 不再注入 prompt 软约束。路径推导从 cwd 即得。
 *
 * ── 快速开始 ──
 *   /worktree            打开交互切换面板
 *   /worktree create     创建 worktree（--name 指定名字，缺省自动分配恒星名）
 *   /worktree use <name> 切换到已有 worktree
 *   /worktree use main   切回主仓库
 *   /worktree delete     删除 worktree
 *   /worktree list       列出所有 worktree
 *   /worktree merge      合并 worktree 分支到 main
 *   /worktree rebase     Rebase worktree 分支到 main
 *   /worktree clean      清理已合并的 worktree
 *   /worktree shell      在 worktree 目录打开终端
 *   /worktree widget     切换 widget 可见性
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { getRepoRoot, isWorktreeCwd, getNameFromCwd } from './lib/paths.js';
import { getManagedWorktrees } from './lib/paths.js';
import { handleWorktreeCommand, setWorktreePi } from './lib/handlers.js';
import { initPrefs } from './state.js';
import { autoApproveProjectTrust } from './lib/session.js';

const log = createLogger('pi-worktree');

export default function worktreeExtension(pi: ExtensionAPI): void {
	setWorktreePi(pi);

	// ── 生命周期 ──

	pi.on('session_start', (_e, ctx) => {
		initPrefs();

		const repoRoot = getRepoRoot(ctx.cwd);
		if (!repoRoot) {
			log.debug('not in a git repo, skipping');
			return;
		}

		// from cwd 推导身份
		const currentName = isWorktreeCwd(ctx.cwd, repoRoot)
			? getNameFromCwd(ctx.cwd, repoRoot)
			: null;

		// 启动提醒：有 worktree 但不在 worktree 内
		if (currentName === null) {
			const wts = getManagedWorktrees(repoRoot);
			if (wts.length > 0) {
				log.info('found managed worktrees from main', { count: wts.length });
				ctx.ui.notify(`Found ${wts.length} worktree(s). Use /worktree to switch.`, 'info');
			}
		}
	});

	// ── project_trust 自动批准 worktree 路径 ──
	// 注：project_trust 事件不在 ExtensionAPI 的公开类型中，故使用 as any
	// handler 必须返回 ProjectTrustEventResult（{ trusted, remember }），
	// 旧版调用 ctx.setTrusted() 的写法在 pi 0.84 下报错（无该方法且返回
	// undefined 导致 emitProjectTrustEvent 读 .trusted 崩溃）。
	(pi as any).on('project_trust', async (event: any, _ctx: any) => {
		if (!event || !event.cwd) return { trusted: 'undecided' as const };
		const cwd = event.cwd;
		// 尝试找主仓库：从 candidate cwd 往上找
		const repoRoot = getRepoRoot(cwd);
		if (!repoRoot) return { trusted: 'undecided' as const };

		if (autoApproveProjectTrust(repoRoot, cwd)) {
			log.info('auto-trusting worktree path', { cwd });
			return { trusted: 'yes' as const, remember: true };
		}
		return { trusted: 'undecided' as const };
	});

	// ── 命令 ──

	pi.registerCommand('worktree', {
		description: 'Manage git worktrees. Use /worktree for interactive panel.',
		handler: async (args, ctx) => {
			await handleWorktreeCommand(args, ctx);
		},
	});
}
