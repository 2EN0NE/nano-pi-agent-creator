import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { truncateToWidth, visibleWidth, matchesKey, Key } from '@earendil-works/pi-tui';
import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import {
	configFilePath,
	isProviderConfigured,
	loadConfig,
	loadProjectMatchConfig,
	projectMatchConfigPath,
	readRawConfigFile,
	type CloudSessionsConfig,
} from './config.js';
import { Sync, type SyncResult } from './sync.js';
import {
	needsCwdFix,
	fixCwdMismatch,
	formatCwdDiff,
	detectCwdMismatch,
	readSessionCwd,
	type FixCwdResult,
} from './cwd-bridge.js';

const STATUS_KEY = 'cloud-sessions';

let activeSync: Promise<SyncResult | null> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

type Notify = (key: string, text: string | undefined) => void;
type NotifyUser = (text: string, level: 'info' | 'warning' | 'error') => void;

let lastSyncFailed = false;

function shortReason(error: unknown): string {
	const err = error instanceof Error ? error : new Error(String(error));
	const nodeCode = (err as NodeJS.ErrnoException).code;

	// System-level errors (stable, not locale-dependent)
	if (nodeCode === 'ENOENT') return 'git not found (is it installed?)';
	if (nodeCode === 'EACCES' || nodeCode === 'EPERM') return 'permission denied';

	// execFile errors carry status (exit code) and stderr
	const errAny = err as unknown as Record<string, unknown>;
	const stderr = errAny.stderr as string | undefined;
	const status = errAny.status as number | undefined;

	if (stderr) {
		const text = stderr.toLowerCase();
		if (
			text.includes('authentication failed') ||
			text.includes('403') ||
			text.includes('401')
		) {
			return 'auth failed (run `gh auth login`)';
		}
		if (text.includes('could not resolve host') || text.includes('timed out')) {
			return 'network unreachable';
		}
		if (text.includes('terminal prompts disabled')) {
			return 'credentials required (run `gh auth login`)';
		}
	}

	// Git exit codes (stable regardless of locale)
	if (typeof status === 'number') {
		if (status === 128) return 'git fatal error';
	}

	// Fallback: first line of message, truncated
	const firstLine = err.message.split('\n')[0]?.trim() ?? err.message;
	return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

function summarize(result: SyncResult): string {
	const parts: string[] = [];
	if (result.pushed.length) parts.push(`↑${result.pushed.length}`);
	if (result.pulled.length) parts.push(`↓${result.pulled.length}`);
	if (parts.length === 0) return 'up to date';
	return parts.join(' ');
}

async function runSync(
	setStatus: Notify,
	notifyUser?: NotifyUser,
	theme?: Theme,
): Promise<SyncResult | null> {
	if (activeSync) return activeSync;
	const cs = (text: string, color: Parameters<Theme['fg']>[0]) =>
		theme ? theme.fg(color, text) : text;
	activeSync = (async () => {
		try {
			const config = await loadConfig();
			if (!isProviderConfigured(config)) {
				setStatus(STATUS_KEY, cs('| sessions: not configured', 'dim'));
				return null;
			}
			setStatus(STATUS_KEY, cs(`| sessions: syncing (${config.provider})`, 'accent'));
			const sync = new Sync(config);
			const pm = await loadProjectMatchConfig();
			const result = await sync.run(pm);
			setStatus(
				STATUS_KEY,
				cs(`| sessions: ${config.provider} ${summarize(result)}`, 'accent'),
			);
			lastSyncFailed = false;
			return result;
		} catch (error) {
			const reason = shortReason(error);
			setStatus(STATUS_KEY, cs(`| sessions: sync error (${reason})`, 'warning'));
			if (!lastSyncFailed) {
				notifyUser?.(`cloud-sessions sync failed: ${reason}`, 'warning');
			}
			lastSyncFailed = true;
			throw error;
		} finally {
			activeSync = null;
		}
	})();
	return activeSync;
}

function scheduleSync(
	config: CloudSessionsConfig,
	setStatus: Notify,
	notifyUser?: NotifyUser,
	theme?: Theme,
): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		void runSync(setStatus, notifyUser, theme).catch(() => {});
	}, config.pushDebounceMs);
}

function startPolling(
	config: CloudSessionsConfig,
	setStatus: Notify,
	notifyUser?: NotifyUser,
	theme?: Theme,
): void {
	if (pollTimer) clearInterval(pollTimer);
	if (config.pollIntervalMs <= 0) return;
	pollTimer = setInterval(() => {
		void runSync(setStatus, notifyUser, theme).catch(() => {});
	}, config.pollIntervalMs);
	if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

function stopTimers(): void {
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

async function writeConfig(partial: Record<string, unknown>): Promise<void> {
	const current = await readRawConfigFile();
	const merged: Record<string, unknown> = { ...current, ...partial };
	if (partial.git || current.git) {
		merged.git = { ...(current.git as object), ...(partial.git as object) };
	}
	if (partial.icloud || current.icloud) {
		merged.icloud = {
			...(current.icloud as object),
			...(partial.icloud as object),
		};
	}
	await mkdir(dirname(configFilePath()), { recursive: true });
	await writeFile(configFilePath(), JSON.stringify(merged, null, 2));
}

/** Save project-match config to ~/.pi/agent/extensions-data/cloud-sessions/project-match.json */
async function writeProjectMatchConfig(pm: {
	suffixSegments: number;
	gitRemote: boolean;
}): Promise<void> {
	const path = projectMatchConfigPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(pm, null, 2));
}

export default function cloudSessions(pi: ExtensionAPI): void {
	pi.on('session_start', async (event, ctx) => {
		const config = await loadConfig();
		const th = ctx.ui.theme;
		const setStatus: Notify = (k, t) => {
			if (t === undefined) {
				ctx.ui.setStatus(k, t);
				return;
			}
			ctx.ui.setStatus(k, th.fg('accent', t));
		};
		const notifyUser: NotifyUser = (text, level) => ctx.ui.notify(text, level);

		if (!isProviderConfigured(config)) {
			ctx.ui.setStatus(STATUS_KEY, th.fg('dim', '| sessions: not configured'));
			return;
		}
		setStatus(STATUS_KEY, `| sessions: ${config.provider}`);

		if (config.pullOnStart && (event.reason === 'startup' || event.reason === 'reload')) {
			// Fire-and-forget: don't block session_start on network/git operations.
			// The sync runs in background; status widget updates via setStatus().
			// startup/reload both benefit from pulling latest remote sessions.
			runSync(setStatus, notifyUser, th).catch(() => {});
		}

		startPolling(config, setStatus, notifyUser, th);
	});

	pi.on('session_before_switch', async (_event, ctx) => {
		const config = await loadConfig();
		const th = ctx.ui.theme;
		if (!isProviderConfigured(config)) return;
		// Fire-and-forget: don't block session switch on sync.
		runSync(
			(k, t) => ctx.ui.setStatus(k, t),
			(text, level) => ctx.ui.notify(text, level),
			th,
		).catch(() => {});
	});

	// ── CWD bridge: cross-machine cwd mismatch ──
	// Intercept session resume BEFORE Pi's assertSessionCwdExists check.
	// When a session's original cwd doesn't exist locally, offer to fix it.
	// Fix strategy (best-effort):
	//   1. Symlink (originalCwd → currentCwd) — works when parent dir writable
	//   2. Rewrite session JSONL cwd field — universal fallback
	// After fixing, Pi's cwd check passes and /tree file references resolve
	// to the current working directory.
	//
	// This covers both /resume in TUI and pi -r (TUI mode session selection).
	pi.on('session_before_switch', async (event, ctx) => {
		if (event.reason !== 'resume' || !event.targetSessionFile) return;
		if (!ctx.hasUI) return;

		if (!needsCwdFix(event.targetSessionFile, ctx.cwd)) return;

		const originalCwd = readSessionCwd(event.targetSessionFile);
		if (!originalCwd) return;

		const diff = formatCwdDiff(originalCwd, ctx.cwd);
		const choice = await ctx.ui.select(diff, ['是 - 修复 cwd 并切换', '否 - 取消切换']);

		if (choice === '是 - 修复 cwd 并切换') {
			const result: FixCwdResult = fixCwdMismatch(
				originalCwd,
				ctx.cwd,
				event.targetSessionFile,
			);
			if (result.success) {
				if (result.symlinkAttempted && !result.symlinkSucceeded) {
					ctx.ui.notify(
						'软连接创建失败（父目录不可写），已自动改用内容覆盖修复',
						'warning',
					);
				}
				ctx.ui.notify('已修复 cwd，可正常切换与使用 /tree', 'info');
				// Don't cancel — Pi's assertSessionCwdExists will find the
				// correct path and proceed with the resume.
				return;
			}
			ctx.ui.notify('修复 cwd 失败，请手动处理', 'error');
			return { cancel: true };
		}

		// User chose not to fix — cancel the switch.
		ctx.ui.notify('已取消切换', 'info');
		return { cancel: true };
	});

	// ── Post-hoc cwd mismatch detection (session_start fallback) ──
	// Handles two cases:
	//   1. reason="resume" — fallback when session_before_switch wasn't
	//      triggered (e.g., edge cases in the /resume flow)
	//   2. reason="startup" — pi -r starts without session_before_switch;
	//      main.js's promptForMissingSessionCwd() shows an English prompt
	//      but does NOT fix the session file on disk. We detect the
	//      mismatch here and offer to fix the file so future sessions
	//      work without any prompt.
	// The session is already loaded but /tree and file resolution may be
	// broken because the original cwd doesn't exist. Offer to fix it now.
	pi.on('session_start', async (event, ctx) => {
		if (event.reason !== 'resume' && event.reason !== 'startup') return;
		if (!ctx.hasUI) return;

		const sessionFile = ctx.sessionManager.getSessionFile();
		const mismatch = detectCwdMismatch(sessionFile, ctx.cwd);
		if (!mismatch) return;

		const diff = formatCwdDiff(mismatch.originalCwd, ctx.cwd);
		const choice = await ctx.ui.select(`如需使用 /tree 和文件引用功能，请修复 cwd\n\n${diff}`, [
			'是 - 修复 cwd',
			'否 - 忽略',
		]);

		if (choice === '是 - 修复 cwd') {
			const result: FixCwdResult = fixCwdMismatch(
				mismatch.originalCwd,
				ctx.cwd,
				sessionFile!,
			);
			if (result.success) {
				if (result.symlinkAttempted && !result.symlinkSucceeded) {
					ctx.ui.notify('软连接创建失败，已自动改用 cwd 覆盖修复', 'warning');
				}
				ctx.ui.notify('已修复 cwd，后续 /tree 可正常使用', 'info');
			} else {
				ctx.ui.notify('修复 cwd 失败', 'error');
			}
		}
	});

	pi.on('turn_end', async (_event, ctx) => {
		const config = await loadConfig();
		const th = ctx.ui.theme;
		if (!config.autoPush || !isProviderConfigured(config)) return;
		scheduleSync(
			config,
			(k, t) => ctx.ui.setStatus(k, t),
			(text, level) => ctx.ui.notify(text, level),
			th,
		);
	});

	pi.on('session_shutdown', async (_event, ctx) => {
		stopTimers();
		const th = ctx.ui.theme;
		const config = await loadConfig();
		if (!config.autoPush || !isProviderConfigured(config)) return;
		// Fire-and-forget: don't block session_shutdown (/reload) on sync.
		runSync(
			(k, t) => ctx.ui.setStatus(k, t),
			(text, level) => ctx.ui.notify(text, level),
			th,
		).catch(() => {});
	});

	// ── Unified /cloud-sessions command ──
	pi.registerCommand('cloud-sessions', {
		description:
			'TUI panel for cloud sessions: sync, configure backend, view status, and edit settings',
		handler: async (_args, ctx) => {
			if (typeof (ctx as any).mode !== 'string' || (ctx as any).mode !== 'tui') {
				ctx.ui.notify('/cloud-sessions requires TUI mode.', 'warning');
				return;
			}

			// ── Setup helper (uses overlay UI) ──
			async function runSetup(cfg: CloudSessionsConfig): Promise<boolean> {
				const provider = await ctx.ui.select('Cloud sessions backend', ['git', 'icloud']);
				if (!provider) return false;

				if (provider === 'git') {
					const repo = await ctx.ui.input(
						'Private git repo URL',
						'git@github.com:you/pi-sessions.git',
					);
					if (!repo) {
						ctx.ui.notify('Setup cancelled: repo is required.', 'warning');
						return false;
					}
					const branch = (await ctx.ui.input('Branch', 'main')) || 'main';
					await writeConfig({ provider: 'git', git: { repo, branch } });
				} else {
					const dir =
						(await ctx.ui.input('iCloud sessions folder', cfg.icloud.dir)) ||
						cfg.icloud.dir;
					await writeConfig({ provider: 'icloud', icloud: { dir } });
				}

				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg('accent', `| sessions: ${provider}`));
				ctx.ui.notify('Cloud sessions configured.', 'info');
				return true;
			}

			// ── Settings panel helper ──
			async function runSettings(): Promise<void> {
				const cfg = await loadConfig();
				const currentPM = await loadProjectMatchConfig();

				const edited = {
					autoPush: cfg.autoPush,
					pullOnStart: cfg.pullOnStart,
					pollIntervalMs: cfg.pollIntervalMs,
					pushDebounceMs: cfg.pushDebounceMs,
					suffixSegments: currentPM.suffixSegments ?? 0,
					gitRemote: currentPM.gitRemote === true,
				};

				type FieldId =
					| 'autoPush'
					| 'pullOnStart'
					| 'pollIntervalMs'
					| 'pushDebounceMs'
					| 'suffixSegments'
					| 'gitRemote'
					| 'save'
					| 'cancel';
				const fields: { id: FieldId; label: string; hint: string }[] = [
					{
						id: 'autoPush',
						label: 'Auto push: {v}',
						hint: 'Automatically push sessions after each turn.',
					},
					{
						id: 'pullOnStart',
						label: 'Pull on start: {v}',
						hint: 'Pull from remote sessions when pi starts.',
					},
					{
						id: 'pollIntervalMs',
						label: 'Poll interval (ms): {v}',
						hint: 'How often to check for remote changes. 0 = disable polling.',
					},
					{
						id: 'pushDebounceMs',
						label: 'Push debounce (ms): {v}',
						hint: 'Delay in ms before pushing after a turn ends.',
					},
					{
						id: 'suffixSegments',
						label: 'Suffix segments: {v}',
						hint: 'Match projects by last N path segments. 0 = disabled.',
					},
					{
						id: 'gitRemote',
						label: 'Git remote match: {v}',
						hint: 'Match sessions by git remote URL via .project-map.json.',
					},
					{
						id: 'save',
						label: '[ Save ]',
						hint: 'Save all changes and close the panel.',
					},
					{
						id: 'cancel',
						label: '[ Cancel ]',
						hint: 'Discard changes and close the panel.',
					},
				];

				function labelFor(field: (typeof fields)[0]): string {
					const id = field.id;
					if (id === 'save' || id === 'cancel') return field.label;
					const val = (edited as Record<string, unknown>)[id];
					const display = typeof val === 'boolean' ? (val ? 'ON' : 'OFF') : String(val);
					return field.label.replace('{v}', display);
				}

				const numberFields = new Set<FieldId>([
					'pollIntervalMs',
					'pushDebounceMs',
					'suffixSegments',
				]);
				const toggleFields = new Set<FieldId>(['autoPush', 'pullOnStart', 'gitRemote']);

				async function saveAll() {
					await writeConfig({
						autoPush: edited.autoPush,
						pullOnStart: edited.pullOnStart,
						pollIntervalMs: edited.pollIntervalMs,
						pushDebounceMs: edited.pushDebounceMs,
					});
					await writeProjectMatchConfig({
						suffixSegments: edited.suffixSegments,
						gitRemote: edited.gitRemote,
					});
				}

				const providerLine =
					cfg.provider === 'git'
						? `Backend: git  [${cfg.git.repo || '(unset)'}]  branch: ${cfg.git.branch}`
						: `Backend: iCloud  [${cfg.icloud.dir}]`;
				const detailLines = [
					providerLine,
					`Machine: ${cfg.machineId}`,
					`Config: ${configFilePath()}`,
				];

				const MIN_HEIGHT = 16;
				let focusIndex = 0;
				let editingField: FieldId | null = null;
				let inputBuffer = '';
				let saved = false;
				let detailsExpanded = false;

				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
					const render = (width: number): string[] => {
						const lines: string[] = [];
						const cw = width;
						const add = (s: string) => lines.push(truncateToWidth(s, width));
						const padRight = (text: string, offset = 0): string => {
							const fill = Math.max(0, cw - offset - visibleWidth(text));
							return text + ' '.repeat(fill);
						};

						const sepLine = theme.fg('borderMuted', '─'.repeat(cw - 1));
						add(theme.fg('accent', 'Cloud Sessions Config'));
						add(sepLine);

						if (detailsExpanded) {
							for (const dl of detailLines) {
								add(theme.fg('dim', dl));
							}
							add(sepLine);
						}

						for (let i = 0; i < fields.length; i++) {
							const field = fields[i];
							const isFocused = i === focusIndex;
							const prefix = isFocused ? theme.fg('accent', '>') : ' ';
							const lblColor = isFocused ? 'text' : 'dim';

							if (editingField === field.id && numberFields.has(field.id)) {
								const base = `${field.label.split(':')[0]}:`;
								const display = inputBuffer || String((edited as any)[field.id]);
								const editContent = ` ${base} ${theme.bg('selectedBg', display + ' ')}`;
								add(`${prefix}${padRight(editContent, 1)}`);
							} else if (field.id === 'save' || field.id === 'cancel') {
								add(
									`${prefix}${padRight(` ${theme.fg(isFocused ? 'accent' : 'dim', field.label)}`, 1)}`,
								);
							} else {
								add(
									`${prefix}${padRight(` ${theme.fg(lblColor, labelFor(field))}`, 1)}`,
								);
							}
						}

						const focusedField = fields[focusIndex];
						add(sepLine);
						if (focusedField && editingField !== focusedField.id) {
							add(
								`${theme.fg('dim', '  ')}${padRight(theme.fg('muted', focusedField.hint), 2)}`,
							);
						} else if (editingField) {
							add(
								padRight(
									theme.fg(
										'muted',
										'Type digits, Enter to confirm, Esc to cancel.',
									),
								),
							);
						} else {
							add(
								theme.fg(
									'dim',
									padRight(
										'Up/Down navigate  Enter toggle/edit  Ctrl+Shift+O details  Esc close',
									),
								),
							);
							saved = false;
						}

						if (saved) {
							add(theme.fg('success', padRight('Saved.')));
						}

						const padCount = Math.max(0, MIN_HEIGHT - lines.length);
						for (let i = 0; i < padCount; i++) lines.push(' '.repeat(width));

						return lines;
					};

					function commitNumberEdit() {
						if (!editingField || !numberFields.has(editingField)) return;
						const raw = inputBuffer.trim();
						const current = (edited as any)[editingField] as number;
						const val = raw ? parseInt(raw, 10) : current;
						(edited as any)[editingField] = Number.isFinite(val) && val >= 0 ? val : 0;
						editingField = null;
						inputBuffer = '';
						tui.requestRender();
					}

					return {
						render,
						invalidate: () => {},
						handleInput: (data: string) => {
							const isEnter = data === '\r' || data === '\n';
							const isEsc = data === '\x1b';
							const isUp = data === '\x1b[A';
							const isDown = data === '\x1b[B';
							const isBackspace = data === '\x7f' || data === '\b';

							if (editingField) {
								if (isEnter) {
									commitNumberEdit();
									return;
								}
								if (isEsc) {
									editingField = null;
									inputBuffer = '';
									tui.requestRender();
									return;
								}
								if (isBackspace) {
									inputBuffer = inputBuffer.slice(0, -1);
									tui.requestRender();
									return;
								}
								if (/^[0-9]$/.test(data)) {
									inputBuffer += data;
									tui.requestRender();
								}
								return;
							}

							if (matchesKey(data, Key.ctrlShift('o'))) {
								detailsExpanded = !detailsExpanded;
								tui.requestRender();
								return;
							}

							if (isUp) {
								focusIndex = (focusIndex - 1 + fields.length) % fields.length;
								tui.requestRender();
								return;
							}
							if (isDown) {
								focusIndex = (focusIndex + 1) % fields.length;
								tui.requestRender();
								return;
							}

							const focused = fields[focusIndex];
							if (isEnter) {
								if (focused.id === 'save') {
									void (async () => {
										await saveAll();
										saved = true;
										tui.requestRender();
										setTimeout(() => done(), 600);
									})();
									return;
								}
								if (focused.id === 'cancel') {
									done();
									return;
								}
								if (numberFields.has(focused.id)) {
									editingField = focused.id;
									inputBuffer = '';
									tui.requestRender();
									return;
								}
								if (toggleFields.has(focused.id)) {
									(edited as any)[focused.id] = !(edited as any)[focused.id];
									tui.requestRender();
									return;
								}
								return;
							}
							if (isEsc) done();
						},
						dispose: () => {},
					};
				});
			}

			// ── Main TUI panel ──
			type MainAction = 'sync' | 'reconfigure' | 'settings' | 'close';

			async function showMainPanel(): Promise<MainAction> {
				const cfg = await loadConfig();
				const pm = await loadProjectMatchConfig();
				let lastResult: SyncResult | null = null;
				let syncRunning = false;

				// Compute one-line status heading
				function statusLine(): string {
					if (!isProviderConfigured(cfg)) return 'Not configured';
					if (syncRunning) return `Syncing (${cfg.provider})...`;
					if (lastResult) {
						const parts: string[] = [];
						if (lastResult.pushed.length)
							parts.push(`${lastResult.pushed.length} pushed`);
						if (lastResult.pulled.length)
							parts.push(`${lastResult.pulled.length} pulled`);
						if (lastResult.unchanged) parts.push(`${lastResult.unchanged} unchanged`);
						return parts.join(', ') || 'up to date';
					}
					return 'Idle';
				}

				const actionFields: { id: MainAction; label: string; hint: string }[] = [
					{
						id: 'sync',
						label: '[ Sync Now ]',
						hint: 'Sync sessions immediately (pull + push).',
					},
					{
						id: 'reconfigure',
						label: '[ Reconfigure Backend ]',
						hint: 'Change provider (git/icloud) or repo details.',
					},
					{
						id: 'settings',
						label: '[ Advanced Settings ]',
						hint: 'Edit auto-push, polling, project matching, and more.',
					},
					{ id: 'close', label: '[ Close ]', hint: 'Close the panel.' },
				];

				const configured = isProviderConfigured(cfg);
				const providerDesc = configured
					? cfg.provider === 'git'
						? `git  [${cfg.git.repo || '(unset)'}]  branch: ${cfg.git.branch}`
						: `icloud  [${cfg.icloud.dir}]`
					: '(none)';

				const summaryLine = configured
					? `Auto: ${cfg.autoPush ? 'ON' : 'OFF'}  |  Pull start: ${cfg.pullOnStart ? 'ON' : 'OFF'}  |  Poll: ${cfg.pollIntervalMs}ms  |  Debounce: ${cfg.pushDebounceMs}ms`
					: '';

				const pmLine = configured
					? `Match: ${(pm.suffixSegments ?? 0) > 0 ? `suffix=${pm.suffixSegments}` : 'suffix=0'}  |  gitRemote: ${pm.gitRemote ? 'ON' : 'OFF'}`
					: '';

				const MIN_HEIGHT = 14;
				let focusIndex = 1; // start on first action (skip provider line)

				return new Promise<MainAction>((resolve) => {
					ctx.ui.custom<void>((tui, theme, _kb, done) => {
						const render = (width: number): string[] => {
							const lines: string[] = [];
							const cw = width;
							const add = (s: string) => lines.push(truncateToWidth(s, width));
							const padRight = (text: string): string => {
								const fill = Math.max(0, cw - visibleWidth(text));
								return text + ' '.repeat(fill);
							};

							const sepLine = theme.fg('borderMuted', '─'.repeat(cw - 1));
							add(theme.fg('accent', 'Cloud Sessions'));
							add(sepLine);

							// ── Provider ──
							add(theme.fg('dim', `Provider: ${providerDesc}`));

							// ── Status ──
							const statusText = statusLine();
							const statusFg = syncRunning ? 'text' : lastResult ? 'success' : 'dim';
							add(theme.fg(statusFg, `Status: ${statusText}`));

							if (summaryLine) {
								add(theme.fg('muted', summaryLine));
							}
							if (pmLine) {
								add(theme.fg('muted', pmLine));
							}

							// ── Separator ──
							add(sepLine);

							// ── Action fields ──
							for (let i = 0; i < actionFields.length; i++) {
								const f = actionFields[i];
								const focused = i === focusIndex;
								const prefix = focused ? theme.fg('accent', '>') : ' ';
								const color = focused ? 'accent' : 'dim';
								add(`${prefix} ${padRight(theme.fg(color, f.label))}`);
							}

							// ── Separator + Hint area ──
							add(sepLine);
							const hint = actionFields[focusIndex]?.hint ?? '';
							add(theme.fg('muted', hint));

							// ── Footer help bar ──
							add(
								theme.fg(
									'dim',
									padRight('Up/Down navigate  Enter confirm  Esc close'),
								),
							);

							const padCount = Math.max(0, MIN_HEIGHT - lines.length);
							// 必须用空格而非空字符串，否则旧渲染内容无法清除导致残影
							for (let i = 0; i < padCount; i++) lines.push(' '.repeat(width));

							return lines;
						};

						return {
							render,
							invalidate: () => {},
							handleInput: async (data: string) => {
								if (data === '\x1b[A') {
									focusIndex =
										(focusIndex - 1 + actionFields.length) %
										actionFields.length;
									tui.requestRender();
									return;
								}
								if (data === '\x1b[B') {
									focusIndex = (focusIndex + 1) % actionFields.length;
									tui.requestRender();
									return;
								}
								if (data === '\x1b') {
									done();
									resolve('close');
									return;
								}

								if (data === '\r' || data === '\n') {
									const action = actionFields[focusIndex].id;

									if (action === 'close') {
										done();
										resolve('close');
										return;
									}

									if (action === 'reconfigure' || action === 'settings') {
										done();
										resolve(action);
										return;
									}

									if (action === 'sync') {
										if (syncRunning) return;
										syncRunning = true;
										tui.requestRender();
										try {
											const result = await runSync(
												(k, t) => ctx.ui.setStatus(k, t),
												(text, level) => ctx.ui.notify(text, level),
												ctx.ui.theme,
											);
											lastResult = result;
										} catch {
											// error already logged by runSync
										} finally {
											syncRunning = false;
											tui.requestRender();
										}
										return;
									}
								}
							},
							dispose: () => {},
						};
					});
				});
			}

			// ── Main loop: keep returning to the panel after sub-actions ──
			let firstRun = true;
			while (true) {
				const cfg = await loadConfig();

				if (!isProviderConfigured(cfg)) {
					if (!firstRun) {
						// Came back from reconfigure that resulted in no config
						ctx.ui.notify('Cloud sessions not configured.', 'warning');
						break;
					}
					const ok = await runSetup(cfg);
					if (!ok) break;
					firstRun = false;
					continue; // re-check, now configured
				}

				firstRun = false;
				const action = await showMainPanel();

				if (action === 'close') break;

				if (action === 'reconfigure') {
					const cfg2 = await loadConfig();
					const ok = await runSetup(cfg2);
					if (!ok) continue; // cancelled, back to main panel
					continue;
				}

				if (action === 'settings') {
					await runSettings();
					continue; // back to main panel
				}

				// 'sync' never reaches here (handled within panel)
				break;
			}
		},
	});
}
