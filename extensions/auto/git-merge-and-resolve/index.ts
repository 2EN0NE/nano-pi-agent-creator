/**
 * Git Merge and Resolve
 *
 * Keeps the working branch up to date with its upstream tracking ref.
 * After each agent turn, fetches and merges. Clean merges complete
 * silently. When conflicts arise, the working tree is left dirty and
 * the agent receives a follow-up message listing each conflict block
 * with file, line range, and ours/theirs sections so it can resolve them.
 *
 * /git-merge-and-resolve  command — TUI control panel for config.
 *   - enabled / disabled
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

function formatConflicts(ref: string, blocks: ConflictBlock[]): string {
	const lines = [`Merged ${ref} with conflicts:`, ''];
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
	const status = _config.enabled ? 'on' : 'off';
	const ref = _upstreamRef || '?';

	if (!_config.enabled) return `[git-merge:off]`;

	// Check if in a merge
	const hasMergeHead = _inMergeHead;
	if (hasMergeHead) {
		return `[git-merge:merge ${ref}]`;
	}

	return `[git-merge:${ref}]`;
}

let _inMergeHead = false;

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
		const onOffLabel = (val: boolean) => (val ? '[ON]' : '[OFF]');

		const items: SelectItem[] = [
			{
				value: '__toggle_enabled',
				label: `Auto Merge  ${onOffLabel(_config.enabled)}`,
				description: _config.enabled
					? 'Enabled — fetch & merge on agent_end'
					: 'Disabled — no automatic action',
			},
			{
				value: '__toggle_notifications',
				label: `Notifications  ${onOffLabel(_config.notifications)}`,
				description: _config.notifications
					? 'Conflict/merge info sent to conversation'
					: 'Silent — no messages',
			},
			{
				value: '__toggle_widget',
				label: `Status Widget  ${onOffLabel(_config.showWidget)}`,
				description: _config.showWidget ? 'Shown at bottom of TUI' : 'Hidden',
			},
		];

		const selected = await makeSelection(
			ctx,
			'Git Merge and Resolve Control Panel',
			items,
			'up/down navigate, enter toggle, esc close',
		);

		if (!selected) {
			ctx.ui.notify('Git Merge and Resolve closed', 'info');
			return;
		}

		switch (selected) {
			case '__toggle_enabled':
				_config.enabled = !_config.enabled;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`Auto merge ${_config.enabled ? 'enabled' : 'disabled'}`, 'info');
				updateWidget(ctx);
				break;

			case '__toggle_notifications':
				_config.notifications = !_config.notifications;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(
					`Notifications ${_config.notifications ? 'enabled' : 'disabled'}`,
					'info',
				);
				break;

			case '__toggle_widget':
				_config.showWidget = !_config.showWidget;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`Status widget ${_config.showWidget ? 'shown' : 'hidden'}`, 'info');
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
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		container.addChild(new Text(theme.fg('accent', theme.bold(title)), 1, 0));

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
			'Config loaded: enabled=%s, notifications=%s, showWidget=%s',
			_config.enabled,
			_config.notifications,
			_config.showWidget,
		);

		_inMergeHead = false;

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

		// Probe MERGE_HEAD
		const { code: mhCode } = await pi.exec('git', ['rev-parse', 'MERGE_HEAD']);
		_inMergeHead = mhCode === 0;

		updateWidget(ctx);
	});

	// Register /git-merge-and-resolve command
	pi.registerCommand('git-merge-and-resolve', {
		description: 'Open Git Merge and Resolve control panel',
		handler: handleCommand,
	});

	// Main logic: auto merge on agent_end
	pi.on('agent_end', async (_event, ctx) => {
		log.debug('event: agent_end');

		if (!_config.enabled) {
			log.debug('Auto merge disabled, skipping');
			return;
		}

		const { code: revParseCode } = await pi.exec('git', ['rev-parse', '--git-dir']);
		if (revParseCode !== 0) return;

		let ref = 'MERGE_HEAD';

		// If not already in a merge, attempt one
		const { code: mergeHeadCode } = await pi.exec('git', ['rev-parse', 'MERGE_HEAD']);
		_inMergeHead = mergeHeadCode === 0;

		if (!_inMergeHead) {
			// Only attempt a new merge if the working tree is clean
			const { stdout: status } = await pi.exec('git', ['status', '--porcelain']);
			if (status.trim()) return;

			const { stdout: upstream, code: upstreamCode } = await pi.exec('git', [
				'rev-parse',
				'--abbrev-ref',
				'--symbolic-full-name',
				'@{u}',
			]);
			if (upstreamCode !== 0) return;

			ref = upstream.trim();
			_upstreamRef = ref;
			const remote = ref.split('/')[0];

			if (_config.notifications) {
				ctx.ui.notify(`git-merge-and-resolve: fetching ${remote}, merging ${ref}`, 'info');
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

			// ⚠ No --no-ff: fast-forward when possible, merge only when needed
			const { code: mergeCode } = await pi.exec('git', ['merge', ref]);
			if (mergeCode === 0) {
				// clean merge — update widget and return
				_inMergeHead = false;
				updateWidget(ctx);
				return;
			}
		}

		// Either we just merged with conflicts, or we were already in an unfinished merge
		_inMergeHead = true;
		updateWidget(ctx);

		const conflicts = await findConflicts(pi, ctx.cwd);
		if (conflicts.length === 0) return;

		if (_config.notifications) {
			pi.sendUserMessage(formatConflicts(ref, conflicts), { deliverAs: 'followUp' });
		}
	});
}
