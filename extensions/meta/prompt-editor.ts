/**
 * Prompt Editor — 检查和控制 Pi 最终发送给模型的 prompt 组装过程。
 *
 * 功能：
 *   /prompt               → 打开 prompt 组装检查面板
 *   Ctrl+Shift+P           → 同上
 *
 * 面板功能：
 *   - 树状展示 prompt 各组件的加载来源和顺序
 *   - 预览最终拼接结果
 *   - 切换每个组件是否启用
 *   - 编辑组件内容（临时，仅本次会话有效）
 *
 * Prompt 组装顺序（按最终拼接位置从上到下）：
 *   1. System Prompt   — ~/.pi/agent/SYSTEM.md → .pi/SYSTEM.md（项目覆盖全局）
 *   2. Append Prompts  — ~/.pi/agent/APPEND_SYSTEM.md → .pi/APPEND_SYSTEM.md
 *   3. Context Files   — ~/.pi/agent/AGENTS.md 然后 CWD 逐级向上
 *   4. Tool Snippets   — 每个活跃 tool 的一行摘要
 *   5. Tool Guidelines — 工具使用指南
 *   6. Skills          — 加载的技能说明
 *   7. Date + CWD      — 日期和工作目录
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	BuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import { parseKey, truncateToWidth } from '@earendil-works/pi-tui';
import { bottomBorder, topBorder } from '../../src/tui/helpers.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('prompt-editor');

// =============================================================================
// Override State (session-local)
// =============================================================================

interface ComponentOverride {
	/** If false, this component is excluded from the prompt. */
	enabled: boolean;
	/** If set, overrides the component's content. */
	content?: string;
}

interface OverrideState {
	/** Keyed by component type + path */
	components: Map<string, ComponentOverride>;
}

const overrides: OverrideState = {
	components: new Map(),
};

function overrideKey(type: string, path: string): string {
	return `${type}:${path}`;
}

// =============================================================================
// Component Discovery
// =============================================================================

interface PromptComponent {
	type:
		| 'system_prompt'
		| 'append_prompt'
		| 'context_file'
		| 'tool_snippet'
		| 'tool_guideline'
		| 'skill'
		| 'footer';
	label: string;
	/** Source path (for files) or identifier */
	source: string;
	/** Current content */
	content: string;
	/** Can be toggled on/off */
	toggleable: boolean;
	/** Can be edited */
	editable: boolean;
	/** Order in final prompt (lower = earlier) */
	order: number;
}

/**
 * Parse the system prompt options into a list of discoverable components.
 * Uses before_agent_start's systemPromptOptions to identify sources.
 */
function discoverComponents(options: BuildSystemPromptOptions, cwd: string): PromptComponent[] {
	const components: PromptComponent[] = [];

	// 1. System Prompt
	const systemPromptSource = detectSystemPromptSource(cwd);
	components.push({
		type: 'system_prompt',
		label: '系统提示词',
		source: systemPromptSource,
		content: options.customPrompt ?? '(内置默认)',
		toggleable: true,
		editable: true,
		order: 1,
	});

	// 2. Append Prompts — we don't get them individually, just the merged string
	if (options.appendSystemPrompt) {
		const appendSource = detectAppendPromptSource(cwd);
		components.push({
			type: 'append_prompt',
			label: '追加提示词',
			source: appendSource,
			content: options.appendSystemPrompt,
			toggleable: true,
			editable: true,
			order: 2,
		});
	}

	// 3. Context Files (AGENTS.md etc.)
	if (options.contextFiles) {
		for (const cf of options.contextFiles) {
			components.push({
				type: 'context_file',
				label: `上下文: ${shortPath(cf.path)}`,
				source: cf.path,
				content: cf.content,
				toggleable: true,
				editable: true,
				order: 3,
			});
		}
	}

	// 4. Tool Snippets & Guidelines (merged — we treat them as one group)
	if (options.toolSnippets) {
		const snippetText = Object.entries(options.toolSnippets)
			.map(([name, snippet]) => `  - ${name}: ${snippet}`)
			.join('\n');
		if (snippetText) {
			components.push({
				type: 'tool_snippet',
				label: '工具片段',
				source: '(当前工具)',
				content: `可用工具:\n${snippetText}`,
				toggleable: true,
				editable: true,
				order: 4,
			});
		}
	}

	if (options.promptGuidelines && options.promptGuidelines.length > 0) {
		components.push({
			type: 'tool_guideline',
			label: '工具指南',
			source: '(当前工具)',
			content: options.promptGuidelines.join('\n'),
			toggleable: true,
			editable: true,
			order: 5,
		});
	}

	// 5. Skills
	if (options.skills && options.skills.length > 0) {
		for (const skill of options.skills) {
			components.push({
				type: 'skill',
				label: `技能: ${skill.name ?? '未命名'}`,
				source: skill.name ?? 'unknown',
				content: skill.description ?? '',
				toggleable: true,
				editable: true,
				order: 6,
			});
		}
	}

	// 6. Footer (date + cwd)
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	components.push({
		type: 'footer',
		label: '日期与工作目录',
		source: '(自动)',
		content: `当前日期: ${date}\n当前工作目录: ${cwd}`,
		toggleable: false, // always present
		editable: false,
		order: 99,
	});

	log.info('Discovered prompt components', {
		count: components.length,
		types: components.map((c) => c.type),
	});
	return components;
}

function shortPath(p: string): string {
	const home = process.env.HOME ?? '/home';
	if (p.startsWith(home)) return '~' + p.slice(home.length);
	return p;
}

function detectSystemPromptSource(cwd: string): string {
	const home = process.env.HOME ?? '/home';
	// Order: project .pi/SYSTEM.md > global ~/.pi/agent/SYSTEM.md > built-in
	const projectPath = `${cwd}/.pi/SYSTEM.md`;
	const globalPath = `${home}/.pi/agent/SYSTEM.md`;
	try {
		const fs = require('node:fs');
		if (fs.existsSync(projectPath)) return projectPath;
		if (fs.existsSync(globalPath)) return globalPath;
	} catch {}
	return '(built-in default)';
}

function detectAppendPromptSource(cwd: string): string {
	const home = process.env.HOME ?? '/home';
	const projectPath = `${cwd}/.pi/APPEND_SYSTEM.md`;
	const globalPath = `${home}/.pi/agent/APPEND_SYSTEM.md`;
	try {
		const fs = require('node:fs');
		if (fs.existsSync(projectPath)) return projectPath;
		if (fs.existsSync(globalPath)) return globalPath;
	} catch {}
	return '(inline / extension)';
}

// =============================================================================
// Prompt Rebuilding
// =============================================================================

/**
 * Rebuild the system prompt from components with overrides applied.
 */
function rebuildPrompt(components: PromptComponent[]): string {
	const parts: string[] = [];

	for (const comp of components) {
		const key = overrideKey(comp.type, comp.source);
		const ov = overrides.components.get(key);

		if (ov && !ov.enabled) continue;
		const content = ov?.content ?? comp.content;

		if (content) {
			parts.push(content);
		}
	}

	const prompt = parts.join('\n\n');
	log.info('Rebuilt prompt with overrides', {
		componentCount: components.length,
		partCount: parts.length,
		promptLength: prompt.length,
	});
	return prompt;
}

// =============================================================================
// TUI Panel
// =============================================================================

interface PanelState {
	components: PromptComponent[];
	cursorIndex: number;
	/** First visible component index (viewport scroll). */
	scrollOffset: number;
	/** Max components visible in the list at once. */
	maxVisible: number;
	showPreview: boolean;
	needsRedraw: boolean;
}

export async function showPromptPanel(ctx: ExtensionContext, options: BuildSystemPromptOptions) {
	if (!ctx.hasUI) return;

	const components = discoverComponents(options, ctx.cwd);
	log.debug('Opening prompt panel', { componentCount: components.length });
	const MAX_VISIBLE = 8;

	// 跨面板重开持久的状态：编辑后重开时保留选中项 / 滚动位置 / 预览状态
	const state: PanelState = {
		components,
		cursorIndex: 0,
		scrollOffset: 0,
		maxVisible: MAX_VISIBLE,
		showPreview: false,
		needsRedraw: true,
	};

	// 非悬浮设计（不使用 overlay）：面板放 editorContainer（内嵌，与普通 custom 组件一致）。
	// 编辑流程 = 关面板（done）→ 顺序调用 ctx.ui.editor（不嵌套）→ 重开面板。
	// 与 review.ts / custom-compaction 的编辑模式一致，editorContainer 无嵌套冲突。
	while (true) {
		const result = await ctx.ui.custom<{ action: 'edit'; index: number } | undefined>(
			(tui, theme, _keybindings, done) => {
				const dim = (text: string) => theme.fg('dim', text);
				const accent = (text: string) => theme.fg('accent', text);

				const typeIcons: Record<string, string> = {
					system_prompt: 'SYS',
					append_prompt: 'APP',
					context_file: 'FIL',
					tool_snippet: 'SNP',
					tool_guideline: 'GDL',
					skill: 'SKL',
					footer: 'FTR',
				};

				function getComponentLines(width: number): string[] {
					const lines: string[] = [];
					lines.push(theme.bold(topBorder('── Prompt Assembly ', width)));
					lines.push('');

					const totalItems = state.components.length;
					const start = state.scrollOffset;
					const end = Math.min(totalItems, start + state.maxVisible);

					// Scroll indicator: more above
					if (start > 0) {
						const hidden = start;
						lines.push(dim('  ↑ 上方还有 ' + hidden + ' 个组件'));
					}

					// Render visible components
					for (let i = start; i < end; i++) {
						const comp = state.components[i]!;
						const key = overrideKey(comp.type, comp.source);
						const ov = overrides.components.get(key);
						const isEnabled = ov ? ov.enabled : true;
						const isEdited = ov?.content !== undefined;
						const isSelected = i === state.cursorIndex;

						const icon = typeIcons[comp.type] ?? '   ';
						const statusIcon = isEnabled ? '[x]' : '[ ]';
						const editMark = isEdited ? ' *' : '';
						const cursor = isSelected ? '>' : ' ';
						const indexLabel = dim((i + 1).toString().padStart(2) + ' ');

						const line =
							indexLabel +
							cursor +
							' ' +
							icon +
							' ' +
							statusIcon +
							' ' +
							comp.label +
							editMark;
						lines.push(isSelected ? accent(theme.bold(line)) : line);
					}

					// Scroll indicator: more below
					if (end < totalItems) {
						const hidden = totalItems - end;
						lines.push(dim('  ↓ 下方还有 ' + hidden + ' 个组件'));
					}

					lines.push('');

					// Selected item details (fixed position below list)
					if (state.cursorIndex >= 0 && state.cursorIndex < totalItems) {
						const sel = state.components[state.cursorIndex]!;
						lines.push(dim(topBorder('── 详情 ', width)));
						lines.push(dim('  来源: ' + shortPath(sel.source)));
						const preview = sel.content.slice(0, 100).replace(/\n/g, ' \\n ');
						lines.push(dim('  ' + preview + (sel.content.length > 100 ? '…' : '')));
						lines.push('');
					}

					if (state.showPreview) {
						lines.push(dim(topBorder('── 预览 ', width)));
						const enabledCount = state.components.filter((c) => {
							const k = overrideKey(c.type, c.source);
							const ov = overrides.components.get(k);
							return ov ? ov.enabled : true;
						}).length;
						lines.push(
							dim('  共 ' + totalItems + ' 个组件，启用 ' + enabledCount + ' 个'),
						);
					} else {
						lines.push(dim(bottomBorder(width)));
						lines.push(dim(' ↑↓ 移动  Space 开关  e 编辑  p 预览  q 退出'));
						const enabledCount = state.components.filter((c) => {
							const k = overrideKey(c.type, c.source);
							const ov = overrides.components.get(k);
							return ov ? ov.enabled : true;
						}).length;
						lines.push(
							dim(
								' 已启用 ' +
									enabledCount +
									'/' +
									totalItems +
									'（显示 ' +
									(start + 1) +
									'-' +
									end +
									'）',
							),
						);
					}

					return lines;
				}

				function updatePromptEffect() {
					// Overrides are applied on next before_agent_start via the event handler.
					log.debug('Prompt overrides updated', {
						overrideCount: overrides.components.size,
						enabledCount: state.components.filter((c) => {
							const k = overrideKey(c.type, c.source);
							const ov = overrides.components.get(k);
							return ov ? ov.enabled : true;
						}).length,
					});
				}

				async function toggleComponent(index: number) {
					const comp = state.components[index];
					if (!comp || !comp.toggleable) return;
					const key = overrideKey(comp.type, comp.source);
					const existing = overrides.components.get(key);

					if (existing) {
						existing.enabled = !existing.enabled;
						log.info('Toggled component', {
							type: comp.type,
							source: comp.source,
							enabled: existing.enabled,
						});
					} else {
						overrides.components.set(key, { enabled: false });
						log.info('Disabled component', { type: comp.type, source: comp.source });
					}
					updatePromptEffect();
				}

				const component = {
					name: 'prompt-editor-panel',
					// Focusable：显式声明可聚焦，确保 TUI 的 setFocus(component) 稳定生效
					focused: false,
					focus() {
						this.focused = true;
					},
					unfocus() {
						this.focused = false;
					},
					render(width: number): string[] {
						return getComponentLines(width).map((line) => truncateToWidth(line, width));
					},
					invalidate() {
						state.needsRedraw = true;
					},
					handleInput(data: string): void {
						if (state.needsRedraw) {
							state.needsRedraw = false;
							tui.requestRender();
						}

						// 统一按键解析：兼容各终端的序列差异（普通模式 \x1b[B、应用模式
						// \x1bOB / \x1bOA 等全部归一到 "down"/"up"），与 SelectList 等
						// pi-tui 组件一致（其他 custom 面板方向键正常的原因）。
						const key = parseKey(data) ?? data;

						switch (key) {
							case 'q':
							case 'escape':
							case '\x1b':
								log.debug('Closing prompt panel');
								done(undefined);
								return;

							case 'j':
							case 'down':
							case 'ArrowDown':
							case '\x1b[B':
								if (state.cursorIndex < state.components.length - 1) {
									state.cursorIndex++;
									// Auto-scroll: keep cursor visible
									if (
										state.cursorIndex >=
										state.scrollOffset + state.maxVisible
									) {
										state.scrollOffset =
											state.cursorIndex - state.maxVisible + 1;
									}
									tui.requestRender();
								}
								return;

							case 'k':
							case 'up':
							case 'ArrowUp':
							case '\x1b[A':
								if (state.cursorIndex > 0) {
									state.cursorIndex--;
									// Auto-scroll: keep cursor visible
									if (state.cursorIndex < state.scrollOffset) {
										state.scrollOffset = state.cursorIndex;
									}
									tui.requestRender();
								}
								return;

							case ' ':
							case 'space':
								toggleComponent(state.cursorIndex);
								tui.requestRender();
								return;

							case 'e':
								// 非悬浮：编辑时先关闭面板（done），外层顺序调用编辑器后重开面板
								if (state.components[state.cursorIndex]?.editable) {
									done({ action: 'edit', index: state.cursorIndex });
								}
								return;

							case 'p':
								state.showPreview = !state.showPreview;
								tui.requestRender();
								return;

							default:
								// Unrecognized keys are ignored
								return;
						}
					},
				};

				return component;
			},
		);

		if (!result) break; // q / escape → 退出

		// 编辑组件（此时面板已关闭，editorContainer 可安全使用，无嵌套）
		const comp = state.components[result.index];
		if (!comp || !comp.editable) continue;

		const key = overrideKey(comp.type, comp.source);
		const existing = overrides.components.get(key);
		const currentContent = existing?.content ?? comp.content;

		log.debug('Opening editor for component', {
			type: comp.type,
			source: comp.source,
			contentLength: currentContent.length,
		});
		const newContent = await ctx.ui.editor(`编辑: ${comp.label}`, currentContent);
		if (newContent === undefined) {
			log.debug('Component edit cancelled', { type: comp.type, source: comp.source });
		} else {
			if (existing) {
				existing.content = newContent;
			} else {
				overrides.components.set(key, { enabled: true, content: newContent });
			}
			log.info('Component edited', {
				type: comp.type,
				source: comp.source,
				newLength: newContent.length,
			});
		}
		// 循环继续 → 重新打开面板（cursorIndex / scrollOffset 保留）
	}
}

// =============================================================================
// Extension Export
// =============================================================================

export default function (pi: ExtensionAPI) {
	log.info('Extension loaded');

	pi.registerCommand('prompt', {
		description: '检查和控制 prompt 组装',
		handler: async (_args, ctx) => {
			const options = ctx.getSystemPromptOptions?.();
			if (!options) {
				if (ctx.hasUI) {
					ctx.ui.notify('System prompt options not available', 'warning');
				}
				return;
			}
			await showPromptPanel(ctx, options);
		},
	});

	async function handleOpenPromptPanel(ctx: any): Promise<void> {
		const cmdCtx = ctx as ExtensionCommandContext;
		const options = cmdCtx.getSystemPromptOptions?.();
		if (!options) {
			if (ctx.hasUI) {
				ctx.ui.notify('System prompt options not available', 'warning');
			}
			return;
		}
		await showPromptPanel(cmdCtx, options);
	}
	// session_start 时注册（消除加载顺序竞险：hub 在所有扩展工厂函数执行后才挂载）
	pi.on('session_start', () => {
		const shortcutHub = (globalThis as any).__shortcutsApi;
		if (shortcutHub?.register) {
			shortcutHub.register({
				name: 'prompt-editor',
				keys: ['e'],
				description: '打开 prompt 组装面板',
				handler: handleOpenPromptPanel,
			});
		} else {
			pi.registerShortcut('ctrl+shift+p', {
				description: '打开 prompt 组装面板',
				handler: handleOpenPromptPanel,
			});
		}
	});

	// Log system prompt structure at session start (for debugging)
	pi.on('session_start', async (_event, ctx) => {
		const cmdCtx = ctx as ExtensionCommandContext;
		const options = cmdCtx.getSystemPromptOptions?.();
		if (options) {
			const components = discoverComponents(options, ctx.cwd);
			log.info('Session started — prompt components', {
				count: components.length,
				components: components.map((c) => ({
					type: c.type,
					source: c.source,
					contentLength: c.content.length,
					toggleable: c.toggleable,
				})),
				systemPromptLength: ctx.getSystemPrompt().length,
			});
		}
	});

	// Intercept before_agent_start to apply overrides
	pi.on('before_agent_start', async (event) => {
		if (overrides.components.size === 0) return;

		const options = event.systemPromptOptions;
		const components = discoverComponents(options, options.cwd);

		// Check if any component has a meaningful override
		let hasChanges = false;
		for (const comp of components) {
			const key = overrideKey(comp.type, comp.source);
			const ov = overrides.components.get(key);
			if (ov && (ov.enabled === false || ov.content !== undefined)) {
				hasChanges = true;
				break;
			}
		}

		if (!hasChanges) return;

		const newPrompt = rebuildPrompt(components);
		log.info('Applying prompt overrides', {
			overrideCount: overrides.components.size,
			originalLength: event.systemPrompt.length,
			newLength: newPrompt.length,
		});
		return { systemPrompt: newPrompt };
	});
}
