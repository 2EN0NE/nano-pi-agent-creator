/**
 * Model 层基础能力 — 供 preset 等扩展统一选择 provider/model。
 *
 * 复用 pi 内置 ModelSelectorComponent（与已删除的 mode-switcher 同源）：
 * - 组件内部主动 refresh 模型目录（避免手动读 getAvailable() 时快照可能为空）
 * - 自带搜索过滤
 * - 处理 scopedModels（作用域模型）
 *
 * 对外通过 `(globalThis as any).__modelApi` 暴露，与 tools.ts 的 __toolsApi、
 * skills.ts 的 __skillsApi 对齐：挂 globalThis 而非 pi 对象（避免 Proxy/freeze）。
 */
import {
	ModelSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('preset-model');

export interface ModelSelection {
	provider: string;
	modelId: string;
}

/**
 * 打开内置模型选择器（带搜索），返回选中的 provider/model 对。
 * 取消返回 undefined。
 */
export async function pickModel(
	ctx: ExtensionContext,
	current?: { provider?: string; modelId?: string },
): Promise<ModelSelection | undefined> {
	if (!ctx.hasUI) return undefined;

	const currentModel: Model<any> | undefined =
		current?.provider && current?.modelId
			? (ctx.modelRegistry.find(current.provider, current.modelId) as Model<any>)
			: (ctx.model as Model<any> | undefined);

	// 作用域模型：仅展示当前 scope 允许的模型；无 scoping 时为空（全部可用）。
	// SAFETY: 与 mode-switcher 同口径，ModelSelectorComponent 只读 scopedModels.length。
	const scopedModels = (ctx.scopedModels ?? []) as Array<{
		model: Model<any>;
		thinkingLevel: string;
	}>;

	return ctx.ui.custom<ModelSelection | undefined>(
		(tui, _theme, _keybindings, done) => {
			// 注意：pi 运行时 bundle 的 ModelSelectorComponent 构造签名是
			// (tui, currentModel, modelRuntime, scopedModels, onSelect, onCancel, ...)，
			// 没有 settingsManager 参数（.d.ts 声明滞后，勿按声明传参，否则 modelRuntime 错位）。
			// 且扩展只能拿到 ModelRegistry facade（缺 getAvailableSnapshot/getModel），
			// 用最小适配器桥接：getAvailableSnapshot→getAvailable、getModel→find。
			// 脆弱契约：此构造签名按 pi ^0.84.x 验证，属未公开内部 API。下方 Proxy 做运行时防御——
			// pi 升级若给 ModelSelectorComponent 新增 modelRuntime 方法，立即抛可读错误（而非模糊的 TypeError）。
			// 最小适配器：只实现 ModelSelectorComponent 实际调用的 4 个 ModelRuntime 方法，
			// 其余属性经 Proxy 的 get 陷阱在访问时抛可读错误（而非模糊 TypeError）。
			// SAFETY: 目标对象 cast 为 ModelRuntime —— Proxy 返回类型即 ModelRuntime，
			// 使构造调用经受真实参数位置/数量校验；未实现的属性由下方 get 陷阱兜底抛错。
			const modelRuntimeAdapter = new Proxy(
				{
					getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
					getModel: (provider: string, id: string) =>
						ctx.modelRegistry.find(provider, id),
					refresh: (opts?: unknown) => ctx.modelRegistry.refresh(opts as never),
					getError: () => ctx.modelRegistry.getError(),
				} as unknown as ModelRuntime,
				{
					get(target, prop) {
						if (typeof prop === 'string' && prop !== 'then' && !(prop in target)) {
							throw new Error(
								`preset-model: ModelSelectorComponent 调用了未适配的 modelRuntime.${prop}（pi 版本契约变更，本适配器按 pi ^0.84.x 验证）`,
							);
						}
						return Reflect.get(target, prop);
					},
				},
			);

			const selector = new ModelSelectorComponent(
				tui,
				currentModel,
				modelRuntimeAdapter,
				scopedModels,
				(model: Model<any>) => {
					done({ provider: model.provider, modelId: model.id });
				},
				() => done(undefined),
			);
			return selector;
		},
		{ overlay: true },
	);
}

/**
 * 供 preset 等扩展通过 `(globalThis as any).__modelApi` 调用。
 */
export function registerModelApi(): void {
	(globalThis as { __modelApi?: { pickModel: typeof pickModel } }).__modelApi = {
		pickModel,
	};
}

export default function modelExtension(_pi: ExtensionAPI): void {
	registerModelApi();
	log.info('__modelApi registered');
}
