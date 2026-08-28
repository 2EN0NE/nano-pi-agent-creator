/**
 * Git Merge and Resolve
 *
 * Keeps the working branch up to date with its upstream tracking ref.
 * After each agent turn, fetches and rebases (or merges). Clean rebases
 * complete silently. When conflicts arise, the working tree is left dirty
 * and the agent receives a follow-up message listing each conflict block
 * with file, line range, and ours/theirs sections so it can resolve them.
 *
 * /git-merge-and-resolve  command — TUI control panel for config.
 *   - enabled / disabled
 *   - strategy: rebase (default, linear history) or merge
 *   - notifications on / off
 *   - widget on / off
 *
 * Config persisted to project-level JSON (with user-level fallback)
 * following the permission-gate config pattern.
 */
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Container, SelectList, Text, type SelectItem } from '@earendil-works/pi-tui';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { TitleBar } from '../../../src/tui/helpers.js';
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { type GitMergeConfig, getDefaultConfig, loadConfig, saveConfig } from './config.js';

const log = createLogger('git-merge-and-resolve');

// ============================================================================
// Module-level state
// ============================================================================

let _config: GitMergeConfig = getDefaultConfig();
/** Cached upstream tracking ref for widget display */
let _upstreamRef = '';
/** TUI menu cursor position (persist across while-loop iterations) */
let _menuSelectedIndex = 0;

// ============================================================================
// Conflict detection
// ============================================================================

interface ConflictBlock {
	file: string;
	startLine: number;
	separatorLine: number;
	endLine: number;
}

/** Parse conflict markers from working tree files with unmerged paths. */
async function findConflicts(pi: ExtensionAPI, cwd: string): Promise<ConflictBlock[]> {
	const { stdout, code } = await pi.exec('git', ['diff', '--name-only', '--diff-filter=U']);
	if (code !== 0 || !stdout.trim()) return [];

	const blocks: ConflictBlock[] = [];
	for (const file of stdout.trim().split('\n')) {
		try {
			const rl = createInterface({ input: createReadStream(join(cwd, file), 'utf-8') });
			let lineNo = 0;
			let blockStart: number | undefined;
			let separatorLine: number | undefined;
			for await (const line of rl) {
				lineNo++;
				if (line.startsWith('<<<<<<<')) {
					blockStart = lineNo;
					separatorLine = undefined;
				} else if (line.startsWith('=======') && blockStart !== undefined) {
					separatorLine = lineNo;
				} else if (
					line.startsWith('>>>>>>>') &&
					blockStart !== undefined &&
					separatorLine !== undefined
				) {
					blocks.push({ file, startLine: blockStart, separatorLine, endLine: lineNo });
					blockStart = undefined;
					separatorLine = undefined;
				}
			}
		} catch {
			// skip unreadable files
		}
	}
	return blocks;
}

function formatRange(start: number, end: number): string {
	if (start > end) return 'empty';
	if (start === end) return `${start}`;
	return `${start}-${end}`;
}

function formatConflicts(
	ref: string,
	blocks: ConflictBlock[],
	strategy: 'merge' | 'rebase',
): string {
	const verb = strategy === 'rebase' ? 'Rebased' : 'Merged';
	const lines = [`${verb} ${ref} with conflicts:`, ''];
	for (const b of blocks) {
		const ours = formatRange(b.startLine + 1, b.separatorLine - 1);
		const theirs = formatRange(b.separatorLine + 1, b.endLine - 1);
		lines.push(`  ${b.file}:${b.startLine}-${b.endLine} (ours ${ours}, theirs ${theirs})`);
	}
	lines.push('', 'Resolve these conflicts.');
	return lines.join('\n');
}

// ============================================================================
// Widget helpers
// ============================================================================

function buildWidgetText(): string {
	const ref = _upstreamRef || '?';
	const strat = _config.strategy;
	const inProgress = _inOperation;

	if (!_config.enabled) return `|git-${strat}:off`;

	if (inProgress) {
		return `|git-${strat}:${strat} ${ref}`;
	}

	return `|git-${strat}:${ref}`;
}

let _inOperation = false;

function updateWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
	if (!_config.showWidget || !ctx.hasUI) {
		ctx.ui.setStatus('git-merge-and-resolve', '');
		return;
	}

	const text = buildWidgetText();
	const th = ctx.ui.theme;
	const colored = _config.enabled ? th.fg('accent', text) : th.fg('dim', text);
	ctx.ui.setStatus('git-merge-and-resolve', colored);
}

// ============================================================================
// /git-merge-and-resolve  command
// ============================================================================

async function handleCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	_menuSelectedIndex = 0;

	if (!ctx.hasUI) {
		// Print mode: output config as text
		const lines = [
			'Git Merge and Resolve Configuration:',
			`  Enabled: ${_config.enabled}`,
			`  Strategy: ${_config.strategy}`,
			`  Notifications: ${_config.notifications}`,
			`  Show Widget: ${_config.showWidget}`,
			`  Upstream: ${_upstreamRef || '(none)'}`,
		];
		ctx.ui.notify(lines.join('\n'), 'info');
		return;
	}

	await showMainMenu(ctx);
}

async function showMainMenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const onOffLabel = (val: boolean) => (val ? '[开]' : '[关]');

		const items: SelectItem[] = [
			{
				value: '__toggle_enabled',
				label: `自动同步  ${onOffLabel(_config.enabled)}`,
				description: _config.enabled
					? `已启用 — agent_end 时 fetch 并 ${_config.strategy}`
					: '已禁用 — 无自动操作',
			},
			{
				value: '__toggle_strategy',
				label: `策略  [${_config.strategy.toUpperCase()}]`,
				description:
					_config.strategy === 'rebase'
						? 'Rebase — 线性历史，无额外合并提交'
						: 'Merge — 保留分支拓扑与合并提交',
			},
			{
				value: '__toggle_notifications',
				label: `通知  ${onOffLabel(_config.notifications)}`,
				description: _config.notifications ? '冲突/合并信息发送到会话' : '静默 — 无消息',
			},
			{
				value: '__toggle_widget',
				label: `状态组件  ${onOffLabel(_config.showWidget)}`,
				description: _config.showWidget ? '显示在 TUI 底部' : '隐藏',
			},
		];

		const selected = await makeSelection(
			ctx,
			'Git Merge and Resolve 控制面板',
			items,
			'up/down 导航, enter 开关, esc 关闭',
		);

		if (!selected) {
			ctx.ui.notify('Git Merge and Resolve 已关闭', 'info');
			return;
		}

		switch (selected) {
			case '__toggle_enabled':
				_config.enabled = !_config.enabled;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`自动同步 ${_config.enabled ? '已启用' : '已禁用'}`, 'info');
				updateWidget(ctx);
				break;

			case '__toggle_strategy':
				_config.strategy = _config.strategy === 'rebase' ? 'merge' : 'rebase';
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`策略已设为 ${_config.strategy}`, 'info');
				updateWidget(ctx);
				break;

			case '__toggle_notifications':
				_config.notifications = !_config.notifications;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`通知 ${_config.notifications ? '已启用' : '已禁用'}`, 'info');
				break;

			case '__toggle_widget':
				_config.showWidget = !_config.showWidget;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`状态组件 ${_config.showWidget ? '已显示' : '已隐藏'}`, 'info');
				updateWidget(ctx);
				break;
		}
	}
}

/**
 * Helper: create a TUI select list and return the chosen value.
 */
async function makeSelection(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	footer: string,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new TitleBar(title, (s: string) => theme.fg('accent', theme.bold(s))));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t) => theme.fg('accent', t),
			selectedText: (t) => theme.fg('accent', t),
			description: (t) => theme.fg('muted', t),
			scrollInfo: (t) => theme.fg('dim', t),
			noMatch: (t) => theme.fg('warning', t),
		});

		// Restore cursor position from previous iteration
		selectList.setSelectedIndex(_menuSelectedIndex);

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		// Track selection changes for next while-loop iteration
		selectList.onSelectionChange = (item) => {
			const idx = items.findIndex((i) => i.value === item.value);
			if (idx >= 0) _menuSelectedIndex = idx;
		};

		container.addChild(selectList);
		container.addChild(new Text(theme.fg('dim', footer), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ============================================================================
// Extension factory
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.on('session_start', async (_event, ctx) => {
		_config = loadConfig(ctx.cwd);
		_upstreamRef = '';

		log.info(
			'Config loaded: enabled=%s, strategy=%s, notifications=%s, showWidget=%s',
			_config.enabled,
			_config.strategy,
			_config.notifications,
			_config.showWidget,
		);

		_inOperation = false;

		// Probe upstream ref for widget
		const { stdout: upstream, code: uc } = await pi.exec('git', [
			'rev-parse',
			'--abbrev-ref',
			'--symbolic-full-name',
			'@{u}',
		]);
		if (uc === 0) {
			_upstreamRef = upstream.trim();
		}

		// Probe active operation (merge or rebase in progress)
		const isMerge = await pi.exec('git', ['rev-parse', 'MERGE_HEAD']);
		const isRebase = await pi.exec('git', ['rev-parse', 'REBASE_HEAD']);
		_inOperation = isMerge.code === 0 || isRebase.code === 0;

		updateWidget(ctx);
	});

	// Register /git-merge-and-resolve command
	pi.registerCommand('git-merge-and-resolve', {
		description: '打开 Git Merge and Resolve 控制面板',
		handler: handleCommand,
	});

	// Main logic: auto merge/rebase on agent_end
	pi.on('agent_end', async (_event, ctx) => {
		log.debug('event: agent_end');

		if (!_config.enabled) {
			log.debug('Auto merge disabled, skipping');
			return;
		}

		const { code: revParseCode } = await pi.exec('git', ['rev-parse', '--git-dir']);
		if (revParseCode !== 0) return;

		const strat = _config.strategy;

		// Detect if an operation is already in progress
		const { code: mergeHeadCode } = await pi.exec('git', ['rev-parse', 'MERGE_HEAD']);
		const { code: rebaseHeadCode } = await pi.exec('git', ['rev-parse', 'REBASE_HEAD']);
		_inOperation = mergeHeadCode === 0 || rebaseHeadCode === 0;

		if (!_inOperation) {
			// Only attempt a new operation if the working tree is clean
			const { stdout: status } = await pi.exec('git', ['status', '--porcelain']);
			if (status.trim()) return;

			const { stdout: upstream, code: upstreamCode } = await pi.exec('git', [
				'rev-parse',
				'--abbrev-ref',
				'--symbolic-full-name',
				'@{u}',
			]);
			if (upstreamCode !== 0) return;

			const ref = upstream.trim();
			_upstreamRef = ref;
			const remote = ref.split('/')[0];

			const verb = strat === 'rebase' ? 'fetching & rebasing' : 'fetching & merging';
			if (_config.notifications) {
				ctx.ui.notify(`git-merge-and-resolve: ${verb}: ${remote} ${ref}`, 'info');
			}

			const { code: fetchCode, stderr: fetchErr } = await pi.exec('git', ['fetch', remote]);
			if (fetchCode !== 0) {
				if (_config.notifications) {
					ctx.ui.notify(
						`git-merge-and-resolve: fetch failed: ${fetchErr.trim()}`,
						'warning',
					);
				}
				return;
			}

			log.debug('Running git %s %s', strat, ref);
			const opCode = await pi.exec('git', [strat, ref]);
			if (opCode.code === 0) {
				_inOperation = false;
				updateWidget(ctx);
				return;
			}
		}

		// Either we just started an operation with conflicts, or one was already in progress
		_inOperation = true;
		updateWidget(ctx);

		const conflicts = await findConflicts(pi, ctx.cwd);
		if (conflicts.length === 0) return;

		if (_config.notifications) {
			pi.sendUserMessage(formatConflicts(_upstreamRef || 'upstream', conflicts, strat), {
				deliverAs: 'followUp',
			});
		}
	});
}
