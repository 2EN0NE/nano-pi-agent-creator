import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { execSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('ci-watch');

const MAX_ATTEMPTS = 3;
const DEFAULT_POLL_MIN_MS = 30_000;
const DEFAULT_POLL_MAX_MS = 60_000;
const DEFAULT_POLL_STEP_MS = 15_000;

interface CiCheckResult {
	status: 'pass' | 'fail' | 'pending' | 'error';
	failedRuns: string[];
	logs: string;
}

interface PollConfig {
	minMs: number;
	maxMs: number;
	stepMs: number;
}

function nextPollDelay(current: number, config: PollConfig): number {
	const next = current + config.stepMs;
	if (next > config.maxMs) return config.minMs;
	return next;
}

function runGh(args: string, cwd: string): string {
	return execSync(`gh ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
}

/** Validate that a branch name contains only safe characters for shell interpolation. */
function isValidBranch(branch: string): boolean {
	return /^[a-zA-Z0-9_\-./]+$/.test(branch);
}

function getCiStatus(prNumber: string, cwd: string): CiCheckResult {
	try {
		const output = runGh(`pr checks ${prNumber} --json name,state,bucket`, cwd);
		const checks = JSON.parse(output) as Array<{ name: string; state: string; bucket: string }>;

		const pending = checks.some((c) => c.bucket === 'pending');
		if (pending) return { status: 'pending', failedRuns: [], logs: '' };

		const failed = checks.filter((c) => c.bucket === 'fail');
		if (failed.length === 0) return { status: 'pass', failedRuns: [], logs: '' };

		return { status: 'fail', failedRuns: failed.map((f) => f.name), logs: '' };
	} catch (e) {
		return { status: 'error', failedRuns: [], logs: String(e) };
	}
}

function getFailedLogs(prNumber: string, cwd: string): string {
	try {
		const branchOutput = runGh(`pr view ${prNumber} --json headRefName -q .headRefName`, cwd);
		const runListOutput = runGh(
			`run list --branch ${branchOutput} --limit 5 --json databaseId,status,conclusion`,
			cwd,
		);
		const runs = JSON.parse(runListOutput) as Array<{
			databaseId: number;
			status: string;
			conclusion: string;
		}>;
		const failedRun = runs.find((r) => r.conclusion === 'failure');

		if (!failedRun) return 'No failed run found in recent history.';

		const logs = runGh(`run view ${failedRun.databaseId} --log-failed`, cwd);
		const truncated = logs.split('\n').slice(-100).join('\n');
		return truncated;
	} catch (e) {
		return `Error fetching logs: ${String(e)}`;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
	let pollConfig: PollConfig = {
		minMs: DEFAULT_POLL_MIN_MS,
		maxMs: DEFAULT_POLL_MAX_MS,
		stepMs: DEFAULT_POLL_STEP_MS,
	};

	let autoMode = true;

	let ghChecked = false;

	pi.on('session_start', async (_event, ctx) => {
		if (ghChecked) return;
		ghChecked = true;
		try {
			execSync('command -v gh', { encoding: 'utf-8', stdio: 'pipe' });
		} catch {
			ctx.ui.notify(
				'⚠️ ci-watch: gh CLI not found. CI monitoring requires GitHub CLI. Install with: brew install gh / apt install gh',
				'error',
			);
		}
	});

	pi.on('tool_result', async (event, ctx) => {
		if (!autoMode) return;
		if (event.toolName !== 'bash') return;

		const content = event.content;
		if (!Array.isArray(content)) return;

		const text = content
			.map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
			.join('');

		// Detect successful push to GitHub
		if (!/To github\.com/.test(text)) return;
		log.debug('GitHub push detected in bash output');

		// Extract branch name from push output using multiple patterns
		let branch: string | null = null;

		// Pattern 1: "branch 'xxx' set up to track"
		const trackMatch = text.match(/branch '([^']+)' set up to track/);
		if (trackMatch) branch = trackMatch[1];

		// Pattern 2: "* [new branch] xxx -> yyy"
		if (!branch) {
			const newBranchMatch = text.match(/\*\s+\[new branch\]\s+(\S+)\s*->\s*\S+/);
			if (newBranchMatch) branch = newBranchMatch[1];
		}

		// Pattern 3: "abc123..def456  xxx -> yyy" (push to existing branch)
		if (!branch) {
			const existingMatch = text.match(/\S+\.\.\S+\s+(\S+)\s*->\s*\S+/);
			if (existingMatch) branch = existingMatch[1];
		}

		// Fallback: get current branch directly
		if (!branch) {
			try {
				branch = execSync('git branch --show-current', {
					cwd: ctx.cwd,
					encoding: 'utf-8',
					timeout: 5000,
				}).trim();
			} catch (gitErr) {
				log.debug('git branch --show-current fallback failed', { error: String(gitErr) });
			}
		}

		if (!branch) {
			log.debug('Could not determine branch from push output');
			return;
		}
		log.debug('Auto-watch detected branch', { branch });

		// Validate branch name to prevent shell injection in subsequent gh calls
		if (!isValidBranch(branch)) {
			log.warn('Branch name contains unsafe characters, skipping auto-watch', { branch });
			return;
		}

		try {
			const prOutput = runGh(
				`pr list --head ${branch} --json number -q .[0].number`,
				ctx.cwd,
			);
			if (prOutput) {
				log.debug('Found PR for branch', { branch, pr: prOutput });

				// Check if CI checks exist before triggering auto-watch
				let hasChecks = false;
				try {
					const checksOutput = runGh(`pr checks ${prOutput} --json name`, ctx.cwd);
					const checks = JSON.parse(checksOutput);
					if (Array.isArray(checks) && checks.length > 0) hasChecks = true;
				} catch (checksErr) {
					log.warn('Failed to check CI status, skipping auto-watch', {
						pr: prOutput,
						error: String(checksErr),
					});
					return;
				}

				if (!hasChecks) {
					log.debug('No CI checks on this PR, skipping auto-watch', { pr: prOutput });
					return;
				}

				log.info('Triggering CI auto-watch', { pr: prOutput, branch });
				pi.sendUserMessage(
					`CI auto-watch triggered. Monitor the CI for PR ${prOutput}. If it fails, read the error logs, fix the code, commit, push, and retry until CI passes (max 3 attempts).`,
					{ deliverAs: 'followUp' },
				);
			}
		} catch {
			log.debug('No PR found for branch (expected if branch has no PR yet)', { branch });
		}
	});

	pi.registerCommand('ci-auto', {
		description:
			'Toggle automatic CI watch after every push (default: ON). Usage: /ci-auto on|off',
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === 'on') {
				autoMode = true;
				ctx.ui.notify(
					'🔄 CI auto-watch: ON — Pi monitorará CI automaticamente após push',
					'info',
				);
			} else if (arg === 'off') {
				autoMode = false;
				ctx.ui.notify('⏹️ CI auto-watch: OFF', 'info');
			} else {
				ctx.ui.notify(
					`CI auto-watch: ${autoMode ? 'ON' : 'OFF'}. Use /ci-auto on|off`,
					'info',
				);
			}
		},
	});

	pi.registerCommand('ci-config', {
		description:
			'Configure CI watch poll intervals. Usage: /ci-config <min> <max> <step> (in seconds)',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify(
					`Current: min=${pollConfig.minMs / 1000}s, max=${pollConfig.maxMs / 1000}s, step=${pollConfig.stepMs / 1000}s`,
					'info',
				);
				return;
			}
			const parts = args.trim().split(/\s+/).map(Number);
			if (parts.length < 3 || parts.some(isNaN)) {
				ctx.ui.notify(
					'Usage: /ci-config <min> <max> <step> (in seconds). Ex: /ci-config 20 90 10',
					'error',
				);
				return;
			}
			pollConfig = {
				minMs: parts[0] * 1000,
				maxMs: parts[1] * 1000,
				stepMs: parts[2] * 1000,
			};
			ctx.ui.notify(`✅ CI poll: ${parts[0]}s → ${parts[1]}s (step ${parts[2]}s)`, 'info');
		},
	});
	pi.registerTool({
		name: 'ci_watch',
		label: 'CI Watch',
		description:
			'Monitor CI status for a GitHub PR. Waits for CI to complete, reports the result. If CI fails, returns the failed logs so you can fix the code and push again. Use this after opening a PR to ensure CI passes.',
		promptSnippet: 'Monitor PR CI status, wait for completion, return failed logs if any',
		promptGuidelines: [
			'Use ci_watch after pushing a branch or opening a PR when the user asks to monitor CI.',
			'After ci_watch reports a failure, read the logs, fix the issue, commit, push, then call ci_watch again (max 3 attempts).',
			'Do not call ci_watch proactively — only when the user explicitly asks to watch/monitor CI.',
		],
		parameters: Type.Object({
			pr: Type.String({ description: 'PR number or branch name to monitor' }),
			attempt: Type.Optional(
				Type.Number({ description: 'Current fix attempt (1-3). Omit for first check.' }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { pr } = params;
			const attempt = params.attempt ?? 1;

			if (attempt > MAX_ATTEMPTS) {
				return {
					content: [
						{
							type: 'text',
							text: `❌ CI still failing after ${MAX_ATTEMPTS} fix attempts. Manual intervention needed.`,
						},
					],
					details: { status: 'max_attempts_reached', pr, attempts: MAX_ATTEMPTS },
				};
			}

			onUpdate?.({
				content: [
					{
						type: 'text',
						text: `⏳ Watching CI for PR ${pr} (attempt ${attempt}/${MAX_ATTEMPTS})...`,
					},
				],
				details: {},
			});

			let elapsed = 0;
			let currentDelay = pollConfig.minMs;
			const maxWait = 10 * 60 * 1000;

			while (!signal?.aborted) {
				const result = getCiStatus(pr, ctx.cwd);

				if (result.status === 'error') {
					return {
						content: [{ type: 'text', text: `Error checking CI: ${result.logs}` }],
						details: { status: 'error', pr },
					};
				}

				if (result.status === 'pass') {
					return {
						content: [{ type: 'text', text: `✅ CI passed for PR ${pr}!` }],
						details: { status: 'pass', pr, attempt },
					};
				}

				if (result.status === 'fail') {
					const logs = getFailedLogs(pr, ctx.cwd);
					return {
						content: [
							{
								type: 'text',
								text: `❌ CI failed for PR ${pr} (attempt ${attempt}/${MAX_ATTEMPTS}).\n\nFailed checks: ${result.failedRuns.join(', ')}\n\n--- Failed logs (last 100 lines) ---\n${logs}\n\n---\nFix the issues, commit, push, then call ci_watch again with attempt=${attempt + 1}.`,
							},
						],
						details: { status: 'fail', pr, attempt, failedChecks: result.failedRuns },
					};
				}

				if (elapsed >= maxWait) {
					return {
						content: [
							{
								type: 'text',
								text: `⏰ CI still pending after 10 minutes for PR ${pr}. Check manually.`,
							},
						],
						details: { status: 'timeout', pr },
					};
				}

				await sleep(currentDelay);
				elapsed += currentDelay;
				currentDelay = nextPollDelay(currentDelay, pollConfig);
				onUpdate?.({
					content: [
						{
							type: 'text',
							text: `⏳ CI still running for PR ${pr}... (${Math.round(elapsed / 1000)}s elapsed, next check in ${currentDelay / 1000}s)`,
						},
					],
					details: {},
				});
			}

			return {
				content: [{ type: 'text', text: 'CI watch cancelled.' }],
				details: { status: 'cancelled', pr },
			};
		},
	});

	pi.registerTool({
		name: 'ci_notify',
		label: 'CI Notify',
		description:
			'Monitor CI status for a GitHub PR and notify when complete. Does NOT auto-fix — just watches and reports the final status. Use when you want to be notified when CI finishes.',
		promptSnippet: 'Watch PR CI and notify when done (no auto-fix)',
		promptGuidelines: [
			'Use ci_notify when the user wants to know when CI finishes but does NOT want auto-fix.',
			'Use ci_watch instead when the user wants auto-fix on failure.',
		],
		parameters: Type.Object({
			pr: Type.String({ description: 'PR number or branch name to monitor' }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { pr } = params;

			onUpdate?.({
				content: [{ type: 'text', text: `👀 Watching CI for PR ${pr}...` }],
				details: {},
			});

			let elapsed = 0;
			let currentDelay = pollConfig.minMs;
			const maxWait = 15 * 60 * 1000;

			while (!signal?.aborted) {
				const result = getCiStatus(pr, ctx.cwd);

				if (result.status === 'error') {
					return {
						content: [{ type: 'text', text: `Error checking CI: ${result.logs}` }],
						details: { status: 'error', pr },
					};
				}

				if (result.status === 'pass') {
					ctx.ui.notify(`✅ CI passed for PR ${pr}!`, 'info');
					return {
						content: [{ type: 'text', text: `✅ CI passed for PR ${pr}!` }],
						details: { status: 'pass', pr },
					};
				}

				if (result.status === 'fail') {
					const logs = getFailedLogs(pr, ctx.cwd);
					ctx.ui.notify(`❌ CI failed for PR ${pr}`, 'error');
					return {
						content: [
							{
								type: 'text',
								text: `❌ CI failed for PR ${pr}.\n\nFailed checks: ${result.failedRuns.join(', ')}\n\n--- Failed logs (last 100 lines) ---\n${logs}`,
							},
						],
						details: { status: 'fail', pr, failedChecks: result.failedRuns },
					};
				}

				if (elapsed >= maxWait) {
					return {
						content: [
							{
								type: 'text',
								text: `⏰ CI still pending after 15 minutes for PR ${pr}. Check manually.`,
							},
						],
						details: { status: 'timeout', pr },
					};
				}

				await sleep(currentDelay);
				elapsed += currentDelay;
				currentDelay = nextPollDelay(currentDelay, pollConfig);
				onUpdate?.({
					content: [
						{
							type: 'text',
							text: `👀 CI still running for PR ${pr}... (${Math.round(elapsed / 1000)}s elapsed, next check in ${currentDelay / 1000}s)`,
						},
					],
					details: {},
				});
			}

			return {
				content: [{ type: 'text', text: 'CI watch cancelled.' }],
				details: { status: 'cancelled', pr },
			};
		},
	});

	pi.registerCommand('ci-watch', {
		description: 'Monitor CI for a PR and auto-fix failures. Usage: /ci-watch <pr-number>',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('Usage: /ci-watch <pr-number>', 'error');
				return;
			}
			pi.sendUserMessage(
				`Monitor the CI for PR ${args.trim()}. If it fails, read the error logs, fix the code, commit, push, and retry until CI passes (max 3 attempts).`,
				{ deliverAs: 'followUp' },
			);
		},
	});

	pi.registerCommand('ci-notify', {
		description:
			'Watch CI for a PR and notify when done (no auto-fix). Usage: /ci-notify <pr-number>',
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify('Usage: /ci-notify <pr-number>', 'error');
				return;
			}
			pi.sendUserMessage(
				`Watch the CI for PR ${args.trim()} and notify me when it completes. Do not auto-fix anything.`,
				{ deliverAs: 'followUp' },
			);
		},
	});
}
