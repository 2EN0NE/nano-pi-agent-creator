/**
 * Preset Extension
 *
 * Allows defining named presets that configure model, thinking level, tools,
 * and system prompt instructions. Presets are defined in JSON config files
 * and can be activated via CLI flag, /preset command, or Ctrl+Shift+U to cycle.
 *
 * Config files (merged, project takes precedence, using @zenone/pi-config standard):
 * - ~/.pi/agent/extensions-data/preset/config.json (user global)
 * - <cwd>/.pi/extensions-data/preset/config.json (project-local)
 *
 * Example config.json:
 * ```json
 * {
 *   "plan": {
 *     "provider": "openai-codex",
 *     "model": "gpt-5.2-codex",
 *     ...
 *   },
 *   "implement": {
 *     "provider": "anthropic",
 *     ...
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi --preset plan` - start with plan preset
 * - `/preset` - show selector to switch presets mid-session
 * - `/preset implement` - switch to implement preset directly
 * - `Ctrl+Shift+U` - cycle through presets
 *
 * CLI flags always override preset values.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { Container, Key, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';
import { readJsonFile, resolveConfigPaths } from '@zenone/pi-config';

const log = createLogger('preset');

// Preset configuration
interface Preset {
	/** Provider name (e.g., "anthropic", "openai") */
	provider?: string;
	/** Model ID (e.g., "claude-sonnet-4-5") */
	model?: string;
	/** Thinking level */
	thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	/** Tools to enable (replaces default set) */
	tools?: string[];
	/** Instructions to append to system prompt */
	instructions?: string;
}

interface PresetsConfig {
	[name: string]: Preset;
}

/**
 * Load presets from config files.
 * Project-local presets override global presets with the same name.
 * Uses @zenone/pi-config standard paths.
 */
function loadPresets(cwd: string): PresetsConfig {
	const paths = resolveConfigPaths('preset', { cwd });

	let globalPresets: PresetsConfig = {};
	let projectPresets: PresetsConfig = {};

	// Load global presets
	const globalRaw = readJsonFile(paths.userFile);
	if (globalRaw !== null) {
		globalPresets = globalRaw as PresetsConfig;
	}

	// Load project presets
	const projectRaw = readJsonFile(paths.projectFile);
	if (projectRaw !== null) {
		projectPresets = projectRaw as PresetsConfig;
	}

	// Merge (project overrides global)
	return { ...globalPresets, ...projectPresets };
}

interface OriginalState {
	model: Model<Api> | undefined;
	thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	tools: string[];
}

export default function presetExtension(pi: ExtensionAPI) {
	let presets: PresetsConfig = {};
	let activePresetName: string | undefined;
	let activePreset: Preset | undefined;
	let originalState: OriginalState | undefined;

	/**
	 * 工具变更委托：优先尝试 tools.ts 的 replaceTools API，不存在则退化到
	 * pi.setActiveTools() 直接操作。
	 *
	 * 解耦设计：preset.ts 不 import tools.ts，通过 `(globalThis as any).__toolsApi`
	 * 鸭子类型调用。若 tools.ts 未加载，`__toolsApi` 不存在，走 fallback。
	 *
	 * @param toolNames - 要启用的工具名列表
	 */
	function applyToolsToPi(toolNames: string[]) {
		// 从 globalThis 而非 pi 上读 __toolsApi（避免 pi 对象 Proxy / freeze）
		const api = (globalThis as any).__toolsApi;
		if (api?.replaceTools) {
			api.replaceTools(toolNames);
		} else {
			// Fallback: tools.ts 未加载，直接操作 pi 内置活性列表
			pi.setActiveTools(toolNames);
		}
	}

	// Register --preset CLI flag
	pi.registerFlag('preset', {
		description: 'Preset configuration to use',
		type: 'string',
	});

	/**
	 * Apply a preset configuration.
	 */
	async function applyPreset(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): Promise<boolean> {
		// Snapshot state before the first preset is applied (i.e. only when transitioning from no-preset)
		if (activePresetName === undefined) {
			originalState = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
				tools: pi.getActiveTools(),
			};
		}

		// Apply model if specified
		if (preset.provider && preset.model) {
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (model) {
				const success = await pi.setModel(model);
				if (!success) {
					ctx.ui.notify(
						`Preset "${name}": No API key for ${preset.provider}/${preset.model}`,
						'warning',
					);
				}
			} else {
				ctx.ui.notify(
					`Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
					'warning',
				);
			}
		}

		// Apply thinking level if specified
		if (preset.thinkingLevel) {
			pi.setThinkingLevel(preset.thinkingLevel);
		}

		// Apply tools if specified
		if (preset.tools && preset.tools.length > 0) {
			const allToolNames = pi.getAllTools().map((t) => t.name);
			const validTools = preset.tools.filter((t) => allToolNames.includes(t));
			const invalidTools = preset.tools.filter((t) => !allToolNames.includes(t));

			if (invalidTools.length > 0) {
				ctx.ui.notify(
					`Preset "${name}": Unknown tools: ${invalidTools.join(', ')}`,
					'warning',
				);
			}

			if (validTools.length > 0) {
				applyToolsToPi(validTools);
			}
		}

		// Store active preset for system prompt injection
		activePresetName = name;
		activePreset = preset;

		return true;
	}

	/**
	 * Build description string for a preset.
	 */
	function buildPresetDescription(preset: Preset): string {
		const parts: string[] = [];

		if (preset.provider && preset.model) {
			parts.push(`${preset.provider}/${preset.model}`);
		}
		if (preset.thinkingLevel) {
			parts.push(`thinking:${preset.thinkingLevel}`);
		}
		if (preset.tools) {
			parts.push(`tools:${preset.tools.join(',')}`);
		}
		if (preset.instructions) {
			const truncated =
				preset.instructions.length > 30
					? `${preset.instructions.slice(0, 27)}...`
					: preset.instructions;
			parts.push(`"${truncated}"`);
		}

		return parts.join(' | ');
	}

	/**
	 * Show preset selector UI using custom SelectList component.
	 */
	async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
		const presetNames = Object.keys(presets);

		if (presetNames.length === 0) {
			ctx.ui.notify(
				'No presets defined. Add presets to extensions-data/preset/config.json',
				'warning',
			);
			return;
		}

		// Build select items with descriptions
		const items: SelectItem[] = presetNames.map((name) => {
			const preset = presets[name];
			const isActive = name === activePresetName;
			return {
				value: name,
				label: isActive ? `${name} (active)` : name,
				description: buildPresetDescription(preset),
			};
		});

		// Add "None" option to clear preset
		items.push({
			value: '(none)',
			label: '(none)',
			description: 'Clear active preset, restore defaults',
		});

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

			// Header
			container.addChild(new Text(theme.fg('accent', theme.bold('Select Preset'))));

			// SelectList with themed styling
			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg('accent', text),
				selectedText: (text) => theme.fg('accent', text),
				description: (text) => theme.fg('muted', text),
				scrollInfo: (text) => theme.fg('dim', text),
				noMatch: (text) => theme.fg('warning', text),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);

			// Footer hint
			container.addChild(
				new Text(theme.fg('dim', '↑↓ navigate • enter select • esc cancel')),
			);

			container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!result) return;

		if (result === '(none)') {
			// Clear preset and restore original state
			activePresetName = undefined;
			activePreset = undefined;
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
				applyToolsToPi(originalState.tools);
			} else {
				applyToolsToPi(['read', 'bash', 'edit', 'write']);
			}
			ctx.ui.notify('Preset cleared, defaults restored', 'info');
			updateStatus(ctx);
			return;
		}

		const preset = presets[result];
		if (preset) {
			await applyPreset(result, preset, ctx);
			ctx.ui.notify(`Preset "${result}" activated`, 'info');
			updateStatus(ctx);
		}
	}

	/**
	 * Update status indicator.
	 */
	function updateStatus(ctx: ExtensionContext) {
		if (activePresetName) {
			ctx.ui.setStatus('preset', ctx.ui.theme.fg('accent', `preset:${activePresetName}`));
		} else {
			ctx.ui.setStatus('preset', undefined);
		}
	}

	function getPresetOrder(): string[] {
		return Object.keys(presets).sort();
	}

	async function cyclePreset(ctx: ExtensionContext): Promise<void> {
		const presetNames = getPresetOrder();
		if (presetNames.length === 0) {
			ctx.ui.notify(
				'No presets defined. Add presets to extensions-data/preset/config.json',
				'warning',
			);
			return;
		}

		const cycleList = ['(none)', ...presetNames];
		const currentName = activePresetName ?? '(none)';
		const currentIndex = cycleList.indexOf(currentName);
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleList.length;
		const nextName = cycleList[nextIndex];

		if (nextName === '(none)') {
			activePresetName = undefined;
			activePreset = undefined;
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
				applyToolsToPi(originalState.tools);
			} else {
				applyToolsToPi(['read', 'bash', 'edit', 'write']);
			}
			ctx.ui.notify('Preset cleared, defaults restored', 'info');
			updateStatus(ctx);
			return;
		}

		const preset = presets[nextName];
		if (!preset) return;

		await applyPreset(nextName, preset, ctx);
		ctx.ui.notify(`Preset "${nextName}" activated`, 'info');
		updateStatus(ctx);
	}

	log.debug('registerShortcut');
	pi.registerShortcut(Key.ctrlShift('u'), {
		description: 'Cycle presets',
		handler: async (ctx) => {
			await cyclePreset(ctx);
		},
	});

	// Register /preset command
	log.debug('registerCommand: preset');
	pi.registerCommand('preset', {
		description: 'Switch preset configuration',
		handler: async (args, ctx) => {
			// If preset name provided, apply directly
			if (args?.trim()) {
				const name = args.trim();
				const preset = presets[name];

				if (!preset) {
					const available = Object.keys(presets).join(', ') || '(none defined)';
					ctx.ui.notify(`Unknown preset "${name}". Available: ${available}`, 'error');
					return;
				}

				await applyPreset(name, preset, ctx);
				ctx.ui.notify(`Preset "${name}" activated`, 'info');
				updateStatus(ctx);
				return;
			}

			// Otherwise show selector
			await showPresetSelector(ctx);
		},
	});

	// Inject preset instructions into system prompt
	pi.on('before_agent_start', async (event) => {
		log.debug('event: before_agent_start');
		if (activePreset?.instructions) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${activePreset.instructions}`,
			};
		}
	});

	// Initialize on session start
	pi.on('session_start', async (_event, ctx) => {
		log.debug('event: session_start');
		// Load presets from config files
		presets = loadPresets(ctx.cwd);

		// Check for --preset flag
		const presetFlag = pi.getFlag('preset');
		if (typeof presetFlag === 'string' && presetFlag) {
			const preset = presets[presetFlag];
			if (preset) {
				await applyPreset(presetFlag, preset, ctx);
				ctx.ui.notify(`Preset "${presetFlag}" activated`, 'info');
			} else {
				const available = Object.keys(presets).join(', ') || '(none defined)';
				ctx.ui.notify(`Unknown preset "${presetFlag}". Available: ${available}`, 'warning');
			}
		}

		// Restore preset from session state
		const entries = ctx.sessionManager.getEntries();
		const presetEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === 'custom' && e.customType === 'preset-state',
			)
			.pop() as { data?: { name: string } } | undefined;

		if (presetEntry?.data?.name && !presetFlag) {
			const preset = presets[presetEntry.data.name];
			if (preset) {
				activePresetName = presetEntry.data.name;
				activePreset = preset;
				// Re-apply preset tools so mode stays consistent.
				// User /tools changes in-session are respected;
				// preset re-applies only on session restart.
				if (preset.tools && preset.tools.length > 0) {
					const valid = preset.tools.filter((t) =>
						pi
							.getAllTools()
							.map((tt) => tt.name)
							.includes(t),
					);
					if (valid.length > 0) {
						applyToolsToPi(valid);
						log.debug('preset restored — tools re-applied', {
							preset: presetEntry.data.name,
							tools: valid,
						});
					}
				}
			}
		}

		updateStatus(ctx);
	});

	// Persist preset state
	pi.on('turn_start', async () => {
		log.debug('event: turn_start');
		if (activePresetName) {
			pi.appendEntry('preset-state', { name: activePresetName });
		}
	});
}
