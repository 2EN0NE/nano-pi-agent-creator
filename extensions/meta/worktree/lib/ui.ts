/**
 * pi-worktree — TUI 组件
 */
import { createLogger } from '@zenone/pi-logger';
import { basename } from 'node:path';
import { activeWorktree, activeWorktreePaths, widgetHidden, worktreeMode } from '../state.js';
import type { WorktreeInfo } from '../types.js';

const log = createLogger('pi-worktree');

// ── 注册状态栏 Widget（单行，输入框下方）──

export function registerWidget(ctx: any, widgetRegistered: { v: boolean }): void {
	if (!worktreeMode || widgetHidden) {
		if (widgetRegistered.v) {
			ctx.ui.setWidget('pi-worktree', undefined);
			widgetRegistered.v = false;
			log.debug('widget removed');
		}
		return;
	}
	// WORKAROUND: pi-tui may cache the factory result for a widget name and not
	// re-invoke it when only the factory reference changes (the old render closure
	// would keep reading stale activeWorktree). Remove-then-re-add forces re-creation.
	// TODO: revisit after pi-tui fixes factory caching (or if setWidget already
	//       re-invokes the factory — test can be removed).
	ctx.ui.setWidget('pi-worktree', undefined);
	ctx.ui.setWidget(
		'pi-worktree',
		(_tui: any, theme: any) => ({
			render(_width: number): string[] {
				const label = activeWorktree
					? theme.fg('accent', activeWorktree)
					: theme.fg('dim', '(none)');
				return [` ${theme.fg('accent', '\u2442')} worktree: ${label}`];
			},
			invalidate(): void {
				widgetRegistered.v = false;
			},
		}),
		{ placement: 'belowEditor' },
	);
	widgetRegistered.v = true;
	log.debug('widget set', { active: activeWorktree || '(none)' });
}

// ── 边框辅助 ──

function stripAnsi(s: string): string {
	return s.replace(/\x1B\[[0-9;]*m/g, '');
}

/**
 * 终端显示宽度（列数）——只用于 padding 计算，不影响盒宽。
 * 粗略但足够处理工作台面板中的 CJK/emoji。
 */
function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0)!;
		if (cp > 0xffff) {
			w += 2;
		} else if (
			(cp >= 0x1100 && cp <= 0x115f) ||
			(cp >= 0x2329 && cp <= 0x232a) ||
			(cp >= 0x2e80 && cp <= 0xa4cf) ||
			(cp >= 0xa960 && cp <= 0xa97c) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe10 && cp <= 0xfe19) ||
			(cp >= 0xfe30 && cp <= 0xfe6f) ||
			(cp >= 0xff01 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f64f) ||
			(cp >= 0x1f680 && cp <= 0x1f9ff)
		) {
			w += 2;
		} else {
			w += 1;
		}
	}
	return w;
}

/**
 * 渲染边框盒子——盒宽由 overlay 可用宽度固定，不随内容变化。
 * displayWidth 仅用于每行内部 padding 让内容对齐。
 */
function renderBox(theme: any, lines: string[], _w: number, leftPad?: number): string[] {
	const LEFT_PAD = leftPad ?? Math.min(20, Math.max(0, Math.floor(_w * 0.15)));
	// 固定内宽（-7 = 6 边框开销 + 1 安全余量）
	const innerW = Math.max(_w - LEFT_PAD - 7, 10);

	const B = 'border';
	const top = theme.fg(
		B,
		' '.repeat(LEFT_PAD) + '\u250C' + '\u2500'.repeat(innerW + 4) + '\u2510',
	);
	const bot = theme.fg(
		B,
		' '.repeat(LEFT_PAD) + '\u2514' + '\u2500'.repeat(innerW + 4) + '\u2518',
	);

	const content = lines.map((l) => {
		const plainW = displayWidth(stripAnsi(l));
		const need = innerW - plainW;
		return (
			' '.repeat(LEFT_PAD) +
			theme.fg(B, '\u2502') +
			'  ' +
			l +
			(need > 0 ? ' '.repeat(need) : '') +
			'  ' +
			theme.fg(B, '\u2502')
		);
	});

	return [top, ...content, bot];
}

// 保持向下兼容
function wrapWithBorders(theme: any, lines: string[], _w: number): string[] {
	return renderBox(theme, lines, _w);
}

// ── 主交互面板：/worktree（无参数）──

export async function showWorktreeTui(
	ctx: any,
	worktrees: WorktreeInfo[],
	_repos: string[],
	hasError: string,
): Promise<{ action: string; payload?: string }> {
	return (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<{
		action: string;
		payload?: string;
	}>(
		(_tui: any, theme: any, _keybindings: any, done: (v: any) => void) => {
			const actions: Array<{ key: string; label: string; desc: string }> = [];

			// 根据上下文构建动态操作列表
			if (hasError) {
				actions.push({ key: 'quit', label: 'Quit', desc: '退出帮助页面' });
			} else {
				if (!activeWorktree && worktreeMode) {
					actions.push({ key: 'create', label: 'Create', desc: '创建新 worktree' });
				}
				if (activeWorktree) {
					actions.push({ key: 'stop', label: 'Stop', desc: '停用当前 worktree' });
				}
				if (worktrees.length > 0 && worktreeMode) {
					actions.push({ key: 'use', label: 'Switch', desc: '切换到已有 worktree' });
				}
				actions.push({ key: 'list', label: 'List', desc: '列出所有 worktree' });
				if (!activeWorktree) {
					actions.push({
						key: 'mode',
						label: `Mode: ${worktreeMode ? 'ON' : 'OFF'}`,
						desc: '切换 worktree 模式',
					});
				}
				actions.push({
					key: 'widget',
					label: `Widget: ${widgetHidden ? 'HIDE' : 'SHOW'}`,
					desc: widgetHidden ? '显示状态 widget' : '隐藏状态 widget',
				});
				if (worktrees.length > 0 || activeWorktree) {
					actions.push({
						key: 'merge',
						label: 'Merge',
						desc: '合并 worktree 分支到 main',
					});
				}
				actions.push({ key: 'delete', label: 'Delete', desc: '删除 worktree' });
				actions.push({ key: 'help', label: 'Help', desc: '查看完整用法' });
				actions.push({ key: 'quit', label: 'Quit', desc: '退出' });
			}

			let cursor = 0;

			return {
				render(_w: number): string[] {
					const body: string[] = [];

					// ── header ──
					const statusDot = worktreeMode
						? theme.fg('success', '\u25CF')
						: theme.fg('dim', '\u25CB');
					body.push(theme.bold(`\u{1F30C} pi-worktree ${statusDot}`));

					if (hasError) {
						body.push('');
						body.push(theme.fg('error', '\u26A0 ' + hasError));
						body.push('');
						body.push(theme.fg('dim', '  请确保在 git 仓库目录中运行 pi。'));
						body.push('');
						body.push(theme.fg('dim', '  [Enter] quit  [esc] exit'));
						return wrapWithBorders(theme, body, _w);
					}

					// ── 状态栏 ──
					const onLabel = theme.fg('success', 'ON');
					const offLabel = theme.fg('dim', 'OFF');
					const modeLabel = worktreeMode ? onLabel : offLabel;
					const activeLabel = activeWorktree
						? theme.fg('accent', activeWorktree)
						: theme.fg('dim', '(none)');
					body.push('');
					body.push(` Mode: ${modeLabel}   Active: ${activeLabel}`);
					if (activeWorktree && activeWorktreePaths.size > 0) {
						for (const [repo, p] of activeWorktreePaths) {
							body.push(
								` ${theme.fg('dim', '\u2514\u2192 ' + repo)} ${theme.fg('dim', basename(p))}`,
							);
						}
					}

					// ── worktree 列表 ──
					if (worktrees.length > 0) {
						body.push('');
						body.push(theme.fg('dim', ` Worktree\u65E5\u5FD7 (${worktrees.length}):`));
						for (const wt of worktrees.slice(0, 8)) {
							const isActive = activeWorktree === wt.name;
							const marker = isActive ? theme.fg('success', '\u25CF') : '\u25CB';
							const namePart = isActive ? theme.fg('accent', wt.name) : wt.name;
							const tag = isActive ? theme.fg('success', ' active') : '';
							body.push(
								` ${marker} ${namePart} ${theme.fg('dim', '\u2192 ' + wt.branch)}${tag}`,
							);
						}
						if (worktrees.length > 8) {
							body.push(
								` ${theme.fg('dim', `\u2026 +${worktrees.length - 8} more`)}`,
							);
						}
					} else if (worktreeMode && !activeWorktree) {
						body.push('');
						body.push(
							theme.fg('dim', ' No worktrees yet \u2014 press Enter on Create'),
						);
					}

					// ── 操作按钮 ──
					body.push('');
					const cols = 3;
					for (let i = 0; i < actions.length; i += cols) {
						const row: string[] = [];
						for (let j = 0; j < cols; j++) {
							const idx = i + j;
							if (idx >= actions.length) break;
							const a = actions[idx];
							const prefix = idx === cursor ? theme.fg('accent', '\u276F ') : '  ';
							const label = idx === cursor ? theme.fg('accent', a.label) : a.label;
							row.push(`${prefix}${label}`);
						}
						body.push(row.join('   '));
					}

					// ── 操作描述 + 快捷键提示 ──
					body.push('');
					if (actions[cursor]) {
						body.push(theme.fg('dim', ` ${actions[cursor].desc}`));
					}
					body.push(
						theme.fg('dim', ' [\u2191\u2193] navigate  [Enter] select  [esc] exit'),
					);

					return wrapWithBorders(theme, body, _w);
				},

				handleInput(data: string): void {
					const visibleCount = actions.length;
					if (data === '\x1B[A') {
						cursor = (cursor - 1 + visibleCount) % visibleCount;
						_tui.requestRender();
					} else if (data === '\x1B[B') {
						cursor = (cursor + 1) % visibleCount;
						_tui.requestRender();
					} else if (data === '\r' || data === '\n') {
						const act = actions[cursor];
						if (!act) return;
						done({ action: act.key, payload: '' });
					} else if (data === '\x1B' || data === '\x03') {
						done({ action: 'quit', payload: '' });
					}
				},

				invalidate(): void {},
			};
		},
		{ overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '90%' } },
	);
}

// ── worktree 切换选择器 ──

export async function pickWorktree(ctx: any, worktrees: WorktreeInfo[]): Promise<string | null> {
	if (!ctx.hasUI || worktrees.length === 0) return null;
	const picked = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<string | null>(
		(_tui: any, theme: any, _keybindings: any, done: (v: string | null) => void) => {
			let cursor = 0;
			const items = worktrees.filter((w) => w.name !== activeWorktree);
			if (items.length === 0) {
				// No other worktrees available to merge
				ctx.ui.notify('No other worktrees available to merge', 'warning');
				done(null);
				return { render: () => [], handleInput: () => {}, invalidate: () => {} };
			}
			return {
				render(_w: number): string[] {
					const lines: string[] = [];
					lines.push(theme.bold(' Switch to worktree:'));
					lines.push('');
					for (let i = 0; i < items.length; i++) {
						const arrow = i === cursor ? theme.fg('accent', '\u276F ') : '  ';
						const name =
							i === cursor ? theme.fg('accent', items[i].name) : items[i].name;
						lines.push(
							`${arrow}${name}  ${theme.fg('dim', '\u2192 ' + items[i].branch)}`,
						);
					}
					lines.push('');
					lines.push(theme.fg('dim', ' [Enter] switch  [esc] cancel'));
					return lines;
				},
				handleInput(data: string): void {
					if (data === '\x1B[A') {
						cursor = Math.max(0, cursor - 1);
						_tui.requestRender();
					} else if (data === '\x1B[B') {
						cursor = Math.min(items.length - 1, cursor + 1);
						_tui.requestRender();
					} else if (data === '\r' || data === '\n') {
						done(items[cursor]?.name || null);
					} else if (data === '\x1B' || data === '\x03') {
						done(null);
					}
				},
				invalidate(): void {},
			};
		},
		{ overlay: true, overlayOptions: { anchor: 'center', width: '70%', maxHeight: '80%' } },
	);
	return picked;
}

// ── worktree 删除选择器 ──

export async function pickDeleteWorktree(
	ctx: any,
	worktrees: WorktreeInfo[],
): Promise<string | null> {
	if (!ctx.hasUI || worktrees.length === 0) return null;
	const picked = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<string | null>(
		(_tui: any, theme: any, _keybindings: any, done: (v: string | null) => void) => {
			let cursor = 0;
			return {
				render(_w: number): string[] {
					const lines: string[] = [];
					lines.push(theme.bold(theme.fg('error', ' \u26A0 Delete worktree:')));
					lines.push('');
					for (let i = 0; i < worktrees.length; i++) {
						const arrow = i === cursor ? theme.fg('accent', '\u276F ') : '  ';
						const name =
							i === cursor ? theme.fg('error', worktrees[i].name) : worktrees[i].name;
						lines.push(
							`${arrow}${name}  ${theme.fg('dim', '\u2192 ' + worktrees[i].branch)}`,
						);
					}
					lines.push('');
					lines.push(theme.fg('dim', ' [Enter] delete  [esc] cancel'));
					return lines;
				},
				handleInput(data: string): void {
					if (data === '\x1B[A') {
						cursor = Math.max(0, cursor - 1);
						_tui.requestRender();
					} else if (data === '\x1B[B') {
						cursor = Math.min(worktrees.length - 1, cursor + 1);
						_tui.requestRender();
					} else if (data === '\r' || data === '\n') {
						done(worktrees[cursor]?.name || null);
					} else if (data === '\x1B' || data === '\x03') {
						done(null);
					}
				},
				invalidate(): void {},
			};
		},
		{ overlay: true, overlayOptions: { anchor: 'center', width: '70%', maxHeight: '80%' } },
	);
	return picked;
}

// ── 删除确认对话框 ──

export async function confirmDelete(ctx: any, name: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	try {
		const confirmed = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<boolean>(
			(_tui: any, theme: any, _keybindings: any, done: (v: boolean) => void) => ({
				render(_w: number): string[] {
					const lines = [
						theme.bold(theme.fg('error', ` Delete worktree "${name}"?`)),
						'',
						`  ${theme.fg('accent', '\u25CF')} Yes, delete it ${theme.fg('dim', '(y)')}`,
						`  \u25CB Cancel ${theme.fg('dim', '(n/esc)')}`,
						'',
						theme.fg('dim', ' This removes the worktree directory and its branch.'),
					];
					return renderBox(theme, lines, _w, 0);
				},
				handleInput(data: string): void {
					if (data === 'y' || data === 'Y' || data === '\r') {
						done(true);
						return;
					}
					if (data === 'n' || data === 'N' || data === '\x1B' || data === '\x03') {
						done(false);
						return;
					}
				},
				invalidate(): void {},
			}),
			{ overlay: true, overlayOptions: { anchor: 'center', width: '60%' } },
		);
		return confirmed ?? true;
	} catch {
		log.error('confirmMerge TUI overlay failed; defaulting to cancel');
		return false;
	}
}

// ── 强制删除确认（有未提交/未跟踪文件） ──

export async function confirmForceDelete(ctx: any, name: string, repo: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	try {
		// 收集当前的修改状态
		let dirtyPreview = '';
		try {
			const { execSync } = await import('node:child_process');
			const stat = execSync(
				`cd "${repo}" && git diff --stat && echo "---SEP---" && git diff --cached --stat && echo "---SEP---" && git ls-files --others --exclude-standard | wc -l`,
				{ encoding: 'utf-8', maxBuffer: 16 * 1024 },
			);
			const parts = stat.split('---SEP---');
			const changes = parts[0]?.trim() || '';
			const staged = parts[1]?.trim() || '';
			const untracked = parts[2]?.trim() || '0';
			dirtyPreview = [changes, staged, `${untracked} untracked file(s)`]
				.filter(Boolean)
				.join('\n');
		} catch {
			dirtyPreview = '(unable to read git status)';
		}

		const confirmed = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<boolean>(
			(_tui: any, theme: any, _keybindings: any, done: (v: boolean) => void) => ({
				render(_w: number): string[] {
					const lines: string[] = [];
					lines.push(theme.bold(theme.fg('error', ` \u26A0 Force delete "${name}"?`)));
					lines.push('');
					lines.push(theme.fg('warning', ' Worktree has uncommitted changes:'));
					lines.push('');
					dirtyPreview
						.split('\n')
						.slice(0, 8)
						.forEach((l) => lines.push(`   ${theme.fg('dim', l)}`));
					lines.push('');
					lines.push(
						`  ${theme.fg('error', '\u25CF')} Yes, force delete ${theme.fg('dim', '(y)')}`,
					);
					lines.push(`  \u25CB Cancel ${theme.fg('dim', '(n/esc)')}`);
					lines.push('');
					lines.push(theme.fg('dim', ' The worktree directory will be removed.'));
					return renderBox(theme, lines, _w, 0);
				},
				handleInput(data: string): void {
					if (data === 'y' || data === 'Y' || data === '\r') {
						done(true);
						return;
					}
					if (data === 'n' || data === 'N' || data === '\x1B' || data === '\x03') {
						done(false);
						return;
					}
				},
				invalidate(): void {},
			}),
			{ overlay: true, overlayOptions: { anchor: 'center', width: '70%' } },
		);
		return confirmed ?? false;
	} catch {
		return false;
	}
}
// ── 创建时名字输入 ──

export async function promptWorktreeName(ctx: any): Promise<string | null> {
	if (!ctx.hasUI) return null;
	try {
		const name = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<string | null>(
			(_tui: any, theme: any, _keybindings: any, done: (v: string | null) => void) => {
				let input = '';
				return {
					render(_w: number): string[] {
						const cursor = input.length > 0 ? '' : theme.fg('dim', '');
						return [
							theme.bold(' Worktree name:'),
							'',
							` ${theme.fg('accent', '\u276F')} ${input}${cursor}${theme.fg('dim', input.length === 0 ? 'type a name (enter=confirm, esc=cancel)' : '')}`,
							'',
							theme.fg('dim', ' Lowercase, no spaces. Leave empty for auto-name.'),
						];
					},
					handleInput(data: string): void {
						if (data === '\r' || data === '\n') {
							// 空输入 → 返回 '' 表示自动生成；有输入 → 返回名称
							done(input.trim());
							return;
						}
						if (data === '\x1B' || data === '\x03') {
							done(null);
							return;
						}
						if (data === '\x7F' || data === '\b') {
							input = input.slice(0, -1);
							_tui.requestRender();
						} else if (data.length === 1 && data >= ' ') {
							input += data;
							_tui.requestRender();
						}
					},
					invalidate(): void {},
				};
			},
			{ overlay: true, overlayOptions: { anchor: 'center', width: '60%', maxHeight: '50%' } },
		);
		return name;
	} catch {
		return null;
	}
}

// ── 创建时 dirty repo 确认 ──

export async function confirmDirtyStart(
	ctx: any,
	repoName: string,
	dirtyFiles: string[],
): Promise<boolean> {
	log.info('dirty repo check', { repoName, dirtyCount: dirtyFiles.length });
	if (!ctx.hasUI) return true; // no UI = proceed
	try {
		const confirmed = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<boolean>(
			(_tui: any, theme: any, _keybindings: any, done: (v: boolean) => void) => ({
				render(_w: number): string[] {
					const lines: string[] = [];
					lines.push(
						theme.bold(
							theme.fg('warning', ` \u26A0 ${repoName} has uncommitted changes:`),
						),
					);
					lines.push('');
					dirtyFiles.slice(0, 12).forEach((f) => {
						const flag = f.slice(0, 2);
						const file = f.slice(3);
						const color = flag.includes('M') ? 'warning' : 'dim';
						lines.push(`   ${theme.fg(color, flag)} ${theme.fg('dim', file)}`);
					});
					if (dirtyFiles.length > 12) {
						lines.push(`   ${theme.fg('dim', `... +${dirtyFiles.length - 12} more`)}`);
					}
					lines.push('');
					lines.push(
						theme.fg(
							'dim',
							' Creating from a dirty working tree copies these changes into the worktree.',
						),
					);
					lines.push(
						theme.fg(
							'dim',
							' Consider committing or stashing first to start from a clean branch.',
						),
					);
					lines.push('');
					lines.push(
						`  ${theme.fg('error', '\u25CF')} Create anyway ${theme.fg('dim', '(y)')}`,
					);
					lines.push(`  \u25CB Cancel ${theme.fg('dim', '(n/esc)')}`);
					return renderBox(theme, lines, _w, 0);
				},
				handleInput(data: string): void {
					if (data === 'y' || data === 'Y' || data === '\r') {
						done(true);
						return;
					}
					if (data === 'n' || data === 'N' || data === '\x1B' || data === '\x03') {
						done(false);
						return;
					}
				},
				invalidate(): void {},
			}),
			{ overlay: true, overlayOptions: { anchor: 'center', width: '70%' } },
		);
		return confirmed ?? false;
	} catch {
		log.error('confirmMerge TUI overlay failed; defaulting to cancel');
		return false;
	}
}

// ── Merge 源 worktree 选择器 ──

export async function pickMergeSource(ctx: any, worktrees: WorktreeInfo[]): Promise<string | null> {
	if (!ctx.hasUI || worktrees.length === 0) return null;
	const picked = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<string | null>(
		(_tui: any, theme: any, _keybindings: any, done: (v: string | null) => void) => {
			let cursor = 0;
			const items = worktrees.filter((w) => w.name !== activeWorktree);
			if (items.length === 0) {
				// No other worktrees available to merge
				ctx.ui.notify('No other worktrees available to merge', 'warning');
				done(null);
				return { render: () => [], handleInput: () => {}, invalidate: () => {} };
			}
			return {
				render(_w: number): string[] {
					const lines: string[] = [];
					lines.push(theme.bold(' Select source worktree to merge:'));
					lines.push('');
					for (let i = 0; i < items.length; i++) {
						const arrow = i === cursor ? theme.fg('accent', '\u276F ') : '  ';
						const name =
							i === cursor ? theme.fg('accent', items[i].name) : items[i].name;
						lines.push(
							arrow + name + '  ' + theme.fg('dim', '\u2192 ' + items[i].branch),
						);
					}
					lines.push('');
					lines.push(theme.fg('dim', ' [Enter] confirm  [esc] cancel'));
					return lines;
				},
				handleInput(data: string): void {
					if (data === '\x1B[A') {
						cursor = Math.max(0, cursor - 1);
						_tui.requestRender();
					} else if (data === '\x1B[B') {
						cursor = Math.min(items.length - 1, cursor + 1);
						_tui.requestRender();
					} else if (data === '\r' || data === '\n') {
						done(items[cursor]?.name || null);
					} else if (data === '\x1B' || data === '\x03') {
						done(null);
					}
				},
				invalidate(): void {},
			};
		},
		{ overlay: true, overlayOptions: { anchor: 'center', width: '70%', maxHeight: '80%' } },
	);
	return picked;
}

// ── Merge 确认对话框 ──

export async function confirmMerge(
	ctx: any,
	worktreeName: string,
	sourceBranch: string,
	targetBranch: string,
): Promise<boolean> {
	if (!ctx.hasUI) return true;
	try {
		const confirmed = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<boolean>(
			(_tui: any, theme: any, _keybindings: any, done: (v: boolean) => void) => ({
				render(_w: number): string[] {
					const lines: string[] = [];
					lines.push(theme.bold(' Merge worktree branch:'));
					lines.push('');
					lines.push(
						'  ' +
							theme.fg('accent', '\u25CF') +
							' Source: ' +
							theme.fg('accent', sourceBranch) +
							'  ' +
							theme.fg('dim', '(' + worktreeName + ')'),
					);
					lines.push('  ' + theme.fg('dim', '\u2514\u2192 Target: ') + targetBranch);
					lines.push('');
					lines.push(
						'  ' +
							theme.fg('accent', '\u25CF') +
							' Yes, merge ' +
							theme.fg('dim', '(y)'),
					);
					lines.push('  \u25CB Cancel ' + theme.fg('dim', '(n/esc)'));
					lines.push('');
					lines.push(
						theme.fg('dim', ' The merge will be performed in the repo directory.'),
					);
					return renderBox(theme, lines, _w, 0);
				},
				handleInput(data: string): void {
					if (data === 'y' || data === 'Y' || data === '\r') {
						done(true);
						return;
					}
					if (data === 'n' || data === 'N' || data === '\x1B' || data === '\x03') {
						done(false);
						return;
					}
				},
				invalidate(): void {},
			}),
			{ overlay: true, overlayOptions: { anchor: 'center', width: '60%' } },
		);
		return confirmed ?? true;
	} catch {
		log.error('confirmMerge TUI overlay failed; defaulting to cancel');
		return false;
	}
}
