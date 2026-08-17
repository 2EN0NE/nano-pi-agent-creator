/**
 * Settings panel for /custom-compaction-setting command.
 *
 * 交互流程（answer 范式自定义边框组件 + 原生编辑对话框）：
 * 1. 主面板（SettingsComponent main）：配置信息 + profile 列表 + 实验状态
 * 2. Enter 选中 profile > 字段面板（fields）：字段列表 + 当前值
 * 3. Enter 选中字段 > 原生对话框（ctx.ui.input/select/editor/confirm）编辑
 * 4. 修改即时保存到当前活跃层（user/project/session），只更新目标层该 profile
 */

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
	type CompactionProfile,
	type TriggerType,
	type MechanismType,
	TRIGGER_LABELS,
	MECHANISM_LABELS,
	describeTrigger,
	describeMechanism,
	validateTriggerThreshold,
	resolveTriggerThresholdAfterTypeChange,
	DEFAULT_AUTO_CONTINUE_MESSAGE,
	toModelSpec,
} from './types.js';
import {
	loadConfig,
	reloadConfig,
	getActiveConfigPath,
	getConfigLabel,
	getActiveProfile,
	getEffectiveProfile,
	getActiveScope,
	setActiveProfile,
	updateProfileFields,
	type SaveScope,
} from './config.js';
import { getLabStatus } from './lab.js';
import {
	SettingsComponent,
	type SettingsPanelData,
	type SettingsUIAction,
	type ProfileView,
	type ProfileFieldView,
} from './settings-ui.js';
import { getAllAdapters } from './mechanisms/index.js';

// ── Profile 字段编辑器（原生对话框） ────────────────────────────

interface ProfileField {
	key: string;
	label: string;
	readValue: (p: CompactionProfile) => string;
	edit: (ctx: ExtensionCommandContext, p: CompactionProfile) => Promise<boolean>;
}

const PROFILE_FIELDS: ProfileField[] = [
	{
		key: 'name',
		label: '名称',
		readValue: (p) => p.name,
		edit: async (ctx, p) => {
			const val = await ctx.ui.input('Profile 名称', p.name);
			if (val === undefined) return false;
			if (val.trim()) p.name = val.trim();
			return true;
		},
	},
	{
		key: 'model',
		label: '摘要模型',
		readValue: (p) => (p.model === 'current' ? '当前（Pi 的活动模型）' : p.model),
		edit: async (ctx, p) => {
			// Build list of available models (only those with configured API keys)
			const available = ctx.modelRegistry.getAvailable();
			const modelOptions = [
				`当前（使用 Pi 的活动模型）${p.model === 'current' ? ' [X]' : ''}`,
			];
			// Track model labels for reliable reverse-lookup
			const modelLabelToSpec = new Map<string, string>();
			for (const m of available) {
				const spec = `${m.provider}/${m.id}`;
				const label = `  ${spec}`;
				modelLabelToSpec.set(label, spec);
				modelOptions.push(`${label}${p.model === spec ? ' [X]' : ''}`);
			}

			const choice = await ctx.ui.select('选择摘要模型', modelOptions);
			if (choice === undefined) return false;
			if (choice.startsWith('当前')) {
				p.model = 'current';
			} else {
				// Look up by exact label match (no regex parsing needed)
				const trimmed = choice.replace(/ [X]$/, '');
				const spec = modelLabelToSpec.get(trimmed);
				if (spec) {
					p.model = spec as 'current' | `${string}/${string}`;
				}
				// If not found by label, fall back to nothing (keep current value)
			}
			return true;
		},
	},
	{
		key: 'matchModel',
		label: '匹配模型',
		readValue: (p) => p.matchModel || '(任意模型 - 通用兜底)',
		edit: async (ctx, p) => {
			// Build list of suggested model patterns
			const available = ctx.modelRegistry.getAvailable();
			const seen = new Set<string>();
			const suggestions: string[] = ['(清除 - 匹配任意模型)'];

			for (const m of available) {
				// Provider-level pattern
				const providerPat = `${m.provider}/`;
				if (!seen.has(providerPat)) {
					seen.add(providerPat);
					suggestions.push(providerPat);
				}
				// Full spec
				const fullSpec = `${m.provider}/${m.id}`;
				if (!seen.has(fullSpec)) {
					seen.add(fullSpec);
					suggestions.push(fullSpec);
				}
			}

			// Mark current value
			const currentVal = p.matchModel || '(任意)';
			const suggestionOptions = suggestions.map((s) => {
				const label = s === '(清除 - 匹配任意模型)' ? '任意模型（通用）' : s;
				const isCurrent =
					s === '(清除 - 匹配任意模型)' ? !p.matchModel : s === p.matchModel;
				return `${isCurrent ? '[X] ' : '  '}${label}`;
			});
			suggestionOptions.push('---', '自定义输入...');

			const choice = await ctx.ui.select(
				'选择匹配模型（当前: ' +
					currentVal +
					'）\n当前模型匹配该模式时此 profile 自动激活。',
				suggestionOptions,
			);
			if (choice === undefined) return false;

			if (choice === '---') return false;

			if (choice === '自定义输入...') {
				const val = await ctx.ui.input(
					'模型匹配模式（如 "openai/gpt-4o"、"openai/"，留空匹配任意模型）:',
					p.matchModel || '',
				);
				if (val === undefined) return false;
				p.matchModel = val.trim() || undefined;
				return true;
			}

			if (choice.includes('任意模型')) {
				p.matchModel = undefined;
				return true;
			}

			// Extract the pattern from the choice
			for (const s of suggestions) {
				if (choice.includes(s)) {
					p.matchModel = s === '(清除 - 匹配任意模型)' ? undefined : s;
					return true;
				}
			}
			return false;
		},
	},
	{
		key: 'triggerType',
		label: '触发类型',
		readValue: (p) => {
			if (!p.trigger?.type) return '(未配置)';
			return TRIGGER_LABELS[p.trigger.type] || p.trigger.type;
		},
		edit: async (ctx, p) => {
			// Ensure trigger object exists (defensive - migration should handle this)
			if (!p.trigger) p.trigger = { type: 'context_percent', threshold: 20 };
			const options = (['context_percent', 'fixed', 'reserve'] as const).map((t) => {
				const label = TRIGGER_LABELS[t];
				const desc = describeTrigger({
					type: t,
					threshold: t === 'context_percent' ? 20 : t === 'fixed' ? 200000 : 10000,
				});
				const checked = t === p.trigger.type ? ' [X]' : '';
				return `${label}${checked} - ${desc}`;
			});
			const choice = await ctx.ui.select('选择触发类型', options);
			if (choice === undefined) return false;

			for (const t of ['context_percent', 'fixed', 'reserve'] as const) {
				if (choice.startsWith(TRIGGER_LABELS[t])) {
					const oldThreshold = p.trigger.threshold;
					p.trigger.type = t;
					// 尽量保留旧阈值；仅当旧值在新类型下非法时重置为默认并提示
					const { threshold, reset } = resolveTriggerThresholdAfterTypeChange(
						t,
						oldThreshold,
					);
					p.trigger.threshold = threshold;
					if (reset) {
						ctx.ui.notify(
							`阈值已重置为 ${TRIGGER_LABELS[t]} 默认值（原值 ${oldThreshold} 不合法）`,
							'info',
						);
					}
					return true;
				}
			}
			return false;
		},
	},
	{
		key: 'threshold',
		label: '触发阈值',
		readValue: (p) => {
			const t = p.trigger;
			if (!t?.type) return '(未配置)';
			switch (t.type) {
				case 'context_percent':
					return `${t.threshold}%`;
				case 'fixed':
					return `${t.threshold.toLocaleString()} tokens`;
				case 'reserve':
					return `保留 ${t.threshold.toLocaleString()} tokens`;
			}
		},
		edit: async (ctx, p) => {
			if (!p.trigger) p.trigger = { type: 'context_percent', threshold: 20 };
			const hints: Record<TriggerType, string> = {
				context_percent: '上下文窗口百分比（1-99）',
				fixed: '绝对 Token 数（至少 1,000）',
				reserve: '保持空闲的最小 Token 数（至少 100）',
			};
			const val = await ctx.ui.input(hints[p.trigger.type], String(p.trigger.threshold));
			if (val === undefined) return false;
			const n = parseInt(val, 10);
			if (isNaN(n)) {
				ctx.ui.notify('无效的数字', 'warning');
				return false;
			}
			const err = validateTriggerThreshold(p.trigger.type, n);
			if (err) {
				ctx.ui.notify(err, 'warning');
				return false;
			}
			p.trigger.threshold = n;
			return true;
		},
	},
	{
		key: 'mechanismType',
		label: '压缩机制',
		readValue: (p) => {
			if (!p.mechanism) return '(未配置)';
			return describeMechanism(p.mechanism);
		},
		edit: async (ctx, p) => {
			if (!p.mechanism) p.mechanism = { type: 'summarize' };
			const mechTypes: MechanismType[] = ['summarize', 'pass_through', 'adapter'];
			const baseOptions = mechTypes.map((t) => {
				const label = MECHANISM_LABELS[t];
				const checked = t === p.mechanism.type ? ' [X]' : '';
				return `${label}${checked}`;
			});
			const choice = await ctx.ui.select('选择压缩机制', baseOptions);
			if (choice === undefined) return false;

			for (const t of mechTypes) {
				if (choice.startsWith(MECHANISM_LABELS[t])) {
					p.mechanism.type = t;
					if (t === 'adapter') {
						const adapters = getAllAdapters();
						if (adapters.length > 0) {
							const adpOptions = adapters.map((a) =>
								a.id === p.mechanism.adapterId
									? `[X] ${a.name} - ${a.description}`
									: `  ${a.name} - ${a.description}`,
							);
							const adpChoice = await ctx.ui.select('选择适配器', adpOptions);
							if (adpChoice) {
								for (const a of adapters) {
									if (adpChoice.includes(a.name)) {
										p.mechanism.adapterId = a.id;
										break;
									}
								}
							}
						} else {
							ctx.ui.notify('未注册适配器。请安装兼容的压缩扩展。', 'warning');
						}
					} else {
						p.mechanism.adapterId = undefined;
					}
					return true;
				}
			}
			return false;
		},
	},
	{
		key: 'prompt',
		label: '自定义提示词',
		readValue: (p) =>
			p.prompt ? p.prompt.slice(0, 60) + (p.prompt.length > 60 ? '…' : '') : '(默认)',
		edit: async (ctx, p) => {
			const val = await ctx.ui.editor('自定义压缩提示词（留空使用默认）', p.prompt);
			if (val === undefined) return false;
			p.prompt = val.trim();
			return true;
		},
	},
	{
		key: 'autoContinue',
		label: '自动继续',
		readValue: (p) => (p.autoContinue ? '是' : '否'),
		edit: async (ctx, p) => {
			const val = await ctx.ui.confirm(
				'压缩完成后自动继续？',
				`当前: ${p.autoContinue ? '是' : '否'}`,
			);
			if (val === undefined) return false;
			p.autoContinue = val;
			return true;
		},
	},
	{
		key: 'autoContinueMessage',
		label: '继续消息',
		readValue: (p) => (p.autoContinue ? `"${p.autoContinueMessage}"` : '(未启用)'),
		edit: async (ctx, p) => {
			const val = await ctx.ui.input(
				'自动继续消息',
				p.autoContinueMessage || DEFAULT_AUTO_CONTINUE_MESSAGE,
			);
			if (val === undefined) return false;
			p.autoContinueMessage = val.trim() || DEFAULT_AUTO_CONTINUE_MESSAGE;
			return true;
		},
	},
];

// ── 数据组装 ────────────────────────────────────────────────────

/** 构造面板数据快照（SettingsComponent 纯渲染输入） */
async function buildPanelData(ctx: ExtensionCommandContext): Promise<SettingsPanelData> {
	const config = loadConfig();
	const activePath = getActiveConfigPath();
	const configLabel = getConfigLabel();
	const scope: SaveScope = getActiveScope();

	const modelSpec = toModelSpec(ctx.model);
	const effectiveProfile = getEffectiveProfile(modelSpec);
	const activeProfile = getActiveProfile();

	const profiles: ProfileView[] = Object.entries(config.profiles).map(([id, p]) => ({
		id,
		name: p.name,
		active: id === activeProfile?.id,
		description: safeDescribe(p),
		fields: PROFILE_FIELDS.map((f): ProfileFieldView => ({
			key: f.key,
			label: f.label,
			value: f.readValue(p),
		})),
	}));

	const lab = await getLabStatus();

	return {
		configLabel,
		activePath,
		saveScope: scope,
		modelLine: modelSpec
			? `当前模型: ${modelSpec} > Profile: ${effectiveProfile?.name ?? '(无)'}`
			: '当前模型: (未知)',
		profiles,
		lab: {
			active: lab.active,
			experiments: lab.experiments.map((e) => ({
				key: e.key,
				name: e.name,
				currentArm: e.currentArm,
				totalCalls: e.totalCalls,
			})),
		},
	};
}

/** Safely describe a profile - handles partial/incomplete profiles */
function safeDescribe(p: CompactionProfile): string {
	const parts: string[] = [];
	if (p.matchModel) parts.push(`匹配: ${p.matchModel}`);
	parts.push(`模型: ${p.model === 'current' ? '当前' : p.model}`);
	if (p.trigger) {
		parts.push(`触发: ${describeTrigger(p.trigger)}`);
	} else {
		parts.push('触发: (未配置 - 编辑 profile 设置)');
	}
	if (p.mechanism) {
		parts.push(`机制: ${describeMechanism(p.mechanism)}`);
	} else {
		parts.push('机制: (未配置 - 编辑 profile 设置)');
	}
	parts.push(`自动继续: ${p.autoContinue ? '是' : '否'}`);
	return parts.join(' | ');
}

// ── 字段编辑（原生对话框） ──────────────────────────────────────

/** UI 字段 key → CompactionProfile 顶层字段（triggerType/threshold 都映射到 trigger，mechanismType 映射到 mechanism） */
const FIELD_TO_PROFILE_KEY: Record<string, keyof CompactionProfile> = {
	name: 'name',
	model: 'model',
	matchModel: 'matchModel',
	triggerType: 'trigger',
	threshold: 'trigger',
	mechanismType: 'mechanism',
	prompt: 'prompt',
	autoContinue: 'autoContinue',
	autoContinueMessage: 'autoContinueMessage',
};

/**
 * 计算编辑前后变化的顶层字段（浅比较；trigger/mechanism 作为整体参与比较）。
 * 只返回变化的字段，供 updateProfileFields 做目标层差异写入——
 * 避免把合并视图中的完整 profile（含低层字段值）固化到活跃高层。
 */
function diffProfileFields(
	before: CompactionProfile,
	after: CompactionProfile,
): Partial<CompactionProfile> {
	const diff: Record<string, unknown> = {};
	for (const f of PROFILE_FIELDS) {
		const key = FIELD_TO_PROFILE_KEY[f.key];
		if (key === 'trigger' || key === 'mechanism') {
			// 复合字段：子字段级比较，只输出变化的子字段。
			// 否则整个 trigger/mechanism（含合并视图继承的低层字段值）
			// 会被 updateProfileFields 固化到活跃层，遮蔽低层配置。
			const b = (before[key] ?? {}) as unknown as Record<string, unknown>;
			const a = (after[key] ?? {}) as unknown as Record<string, unknown>;
			const subDiff: Record<string, unknown> = {};
			for (const sk of Object.keys(a)) {
				if (JSON.stringify(b[sk]) !== JSON.stringify(a[sk])) subDiff[sk] = a[sk];
			}
			if (Object.keys(subDiff).length > 0) diff[key] = subDiff;
		} else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
			diff[key] = after[key];
		}
	}
	return diff as Partial<CompactionProfile>;
}

/** 编辑单个字段：原生对话框 → 差异写入活跃层 → 激活 profile */
async function editFieldViaDialog(
	ctx: ExtensionCommandContext,
	profileId: string,
	fieldKey: string,
	scope: SaveScope,
): Promise<void> {
	const config = loadConfig();
	const profile = config.profiles[profileId];
	if (!profile) {
		ctx.ui.notify('Profile 不存在', 'warning');
		return;
	}

	const field = PROFILE_FIELDS.find((f) => f.key === fieldKey);
	if (!field) {
		ctx.ui.notify(`未知字段: ${fieldKey}`, 'warning');
		return;
	}

	// 深拷贝（编辑前后各一份），编辑后只把变化的字段写入目标层
	// （避免直接改 config 缓存对象，也避免整 profile 固化到目标层）
	let before: CompactionProfile;
	let workingProfile: CompactionProfile;
	try {
		before = JSON.parse(JSON.stringify(profile));
		workingProfile = JSON.parse(JSON.stringify(profile));
	} catch {
		ctx.ui.notify('克隆 profile 失败', 'error');
		return;
	}

	const changed = await field.edit(ctx, workingProfile);
	if (!changed) return;

	const diff = diffProfileFields(before, workingProfile);
	if (Object.keys(diff).length === 0) return;

	const ok = updateProfileFields(profileId, diff, scope);
	if (ok) {
		ctx.ui.notify(`"${field.label}" 已保存到 ${scope} 层`, 'info');
		// 编辑成功 → 激活该 profile（仅当尚未激活）
		const cur = getActiveProfile();
		if (!cur || cur.id !== profileId) {
			setActiveProfile(profileId, scope);
		}
	} else {
		ctx.ui.notify(`"${field.label}" 保存失败`, 'error');
	}
}

// ── 主面板 ──────────────────────────────────────────────────────

/**
 * Open the custom-compaction settings panel.
 * 循环：主面板 → 字段面板 → 原生编辑 → 返回主面板（数据刷新）。
 */
export async function openSettingsPanel(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		reloadConfig();
		const data = await buildPanelData(ctx);

		// 主面板
		const action = await ctx.ui.custom<SettingsUIAction>(
			(_tui, _theme, _kb, done) => new SettingsComponent(data, done, 'main'),
		);
		if (!action || action.type === 'close') break;

		if (action.type === 'edit-profile') {
			// 字段面板
			const fieldAction = await ctx.ui.custom<SettingsUIAction>(
				(_tui, _theme, _kb, done) =>
					new SettingsComponent(data, done, 'fields', action.profileId),
			);
			if (!fieldAction || fieldAction.type === 'close') continue; // 返回主面板

			if (fieldAction.type === 'edit-field') {
				await editFieldViaDialog(
					ctx,
					fieldAction.profileId,
					fieldAction.fieldKey,
					data.saveScope,
				);
			}
		}
	}
}
