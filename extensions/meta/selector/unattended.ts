/**
 * 远端豁免模式（`--unattended-confirm`，ADR-0068）
 *
 * 三态：off（无许可）/ licensed-idle（有许可未生效）/ armed（通道占用中）。
 * 许可只能由启动 flag 授予；生效由通道 `arm(owner)` 占用（引用计数），可随时撤销。
 *
 * 对外两种用法：
 *   1. 同仓库消费者 `import { isArmed, isAttended } from '@zenone/pi-selector'`；
 *   2. 其它仓库（如 wechatbot）读弱桥接 `globalThis.__confirmGateApi`。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('unattended');

/** 启动 flag：授予「本机允许远端豁免」 */
export const UNATTENDED_FLAG = 'unattended-confirm';
/** 状态栏 key（文本以 `|` 开头，见 TUI 设计约定） */
export const UNATTENDED_STATUS_KEY = 'unattended';

export type UnattendedMode = 'off' | 'licensed-idle' | 'armed';

export interface ConfirmGateStatus {
	license: boolean;
	armed: boolean;
	owners: string[];
	/** owner → 占用次数（确认页要显示「x2」这类计数；与 owners 同源） */
	counts: Record<string, number>;
	mode: UnattendedMode;
}

/** 通道无关的弱桥接接口（与 ADR-0028 同形） */
export interface ConfirmGateApi {
	hasLicense(): boolean;
	isArmed(): boolean;
	owners(): string[];
	/** 引用计数占用；无许可时返回 `undefined`（fail-soft，不抛错） */
	arm(owner: string, opts?: ArmOptions): (() => void) | undefined;
	status(): ConfirmGateStatus;
}

interface GateState {
	license: boolean;
	/**
	 * 每个 owner 的占用次数（不是集合）。
	 *
	 * 同一通道重复 `arm()`（重连而旧连接未及 `disarm()`）必须各自有凭据：若只是集合，
	 * 先断开的那个连接一次 `disarm()` 就会把仍在连接中的通道一起打回 `licensed-idle`，
	 * 远端操作重新挂起在 TUI 上——而这正是本特性要消灭的故障。
	 */
	owners: Map<string, number>;
	/**
	 * 通道自带的中文展示名（ADR-0068 D8）。**id 才是仲裁键**——引用计数、日志、接口都用 id；
	 * 这里只影响界面显示，缺省时按内置映射或原样 id 兜底。
	 */
	labels: Map<string, string>;
	/** 最近一次 session_start 的 ctx，仅用于刷状态栏 */
	ctx?: ExtensionContext;
	/** 注册 flag 的 pi 实例：`arm()` 时会回读许可（消除 session_start 处理器的加载顺序依赖） */
	pi?: ExtensionAPI;
}

const STATE_KEY = '__piUnattendedState';

/**
 * 状态挂在 `globalThis` 而非模块闭包：部署形态可能让「扩展入口」与
 * `node_modules/@zenone/pi-selector` 解析到**不同 realpath**（复制而非软链，e2e 沙箱即如此），
 * 模块级状态会分裂成两份 → `arm()` 之后 `isArmed()` 仍为 false，模式静默失效。
 */
function gateState(): GateState {
	// SAFETY: 该 globalThis 槽位由本模块唯一读写，形状由 GateState 约束；跨模块实例共享是有意为之
	const holder = globalThis as unknown as Record<string, GateState | undefined>;
	holder[STATE_KEY] ??= {
		license: false,
		owners: new Map<string, number>(),
		labels: new Map<string, string>(),
	};
	return holder[STATE_KEY] as GateState;
}

function currentMode(): UnattendedMode {
	const s = gateState();
	if (!s.license) return 'off';
	return s.owners.size > 0 ? 'armed' : 'licensed-idle';
}

/** 当前是否生效（armed） */
export function isArmed(): boolean {
	const s = gateState();
	return s.license && s.owners.size > 0;
}

/** 本机是否授予了许可（启动 flag）。回读而非只信缓存：channel 可能早于 selector 的 session_start 查询 */
export function hasLicense(): boolean {
	return refreshLicense(gateState());
}

/**
 * 在场判定：「有没有人可能回答这个对话框」。
 *
 * `ctx.hasUI` 只表示「有 UI 对象」——TUI 与 RPC 模式都为 true，无法表达「无人应答」。
 * 形参刻意只要求 `{ hasUI }` 的结构类型：调用方传 `ExtensionContext` 即可，测试可传最小桩。
 */
export function isAttended(ctx: { hasUI: boolean }): boolean {
	return ctx.hasUI && !isArmed();
}

/**
 * 回读许可：`getFlag` 只有 argv 解析完才可靠，而 argv 解析发生在扩展**加载之后**——
 * 因此工厂期那次读取拿不到真值。任何 channel 都可能在**早于 selector 的 session_start**
 * 里 arm()（handler 按加载顺序执行，pi 不排序），若只信缓存的工厂期值，arm() 会被误拒。
 */
function refreshLicense(s: GateState): boolean {
	if (s.pi) s.license = s.pi.getFlag(UNATTENDED_FLAG) === true;
	return s.license;
}

/** 占用者 id → 中文展示名。id 是仲裁键（引用计数/日志/接口），这里只用于界面。 */
const OWNER_LABELS: Record<string, string> = {
	manual: '本机手动',
	'e2e-channel': '测试通道',
};

/** 占用者显示名：显式 label > 内置映射 > 原样 id（括注未登记，绝不隐藏） */
export function ownerLabel(owner: string): string {
	return gateState().labels.get(owner) ?? OWNER_LABELS[owner] ?? `${owner}（未登记）`;
}

export interface ArmOptions {
	/** 界面展示名（仅用于豁免运维面板）。缺省走内置映射或原样 id */
	label?: string;
}

/** 占用豁免（引用计数）。无许可 → `undefined`。返回幂等的解除函数。 */
export function arm(owner: string, opts?: ArmOptions): (() => void) | undefined {
	const s = gateState();
	if (!refreshLicense(s)) {
		log.warn('arm(%s) 被拒绝：未授权（启动命令未带 --%s）', owner, UNATTENDED_FLAG);
		return undefined;
	}
	if (opts?.label) s.labels.set(owner, opts.label);
	const before = currentMode();
	s.owners.set(owner, (s.owners.get(owner) ?? 0) + 1);
	log.info('arm(owner=%s) mode=%s→%s', owner, before, currentMode());
	refreshStatus();
	// 每个 arm() 只释放自己那一次占用：同一 owner 可能是多个连接 / 多次占用
	let released = false;
	return () => {
		if (released) return;
		released = true;
		disarm(owner);
	};
}

/** 释放一次占用（幂等：无占用时 no-op）。 */
export function disarm(owner: string): void {
	const s = gateState();
	const before = currentMode();
	const count = s.owners.get(owner) ?? 0;
	if (count <= 0) return;
	if (count === 1) s.owners.delete(owner);
	else s.owners.set(owner, count - 1);
	log.info('disarm(owner=%s) mode=%s→%s', owner, before, currentMode());
	refreshStatus();
}

/**
 * 释放**所有**占用（含通道），返回被清掉的 owner 列表。
 *
 * 人工恢复确认的入口之一（另一个是 `/unattended` 面板的「解除豁免」）：通道崩溃未及
 * `disarm()` 时，逐个 owner 撤一次仍可能残留计数（同一 owner 多次 `arm()`），
 * 所以这里直接清空。
 */
function disarmAll(): string[] {
	const s = gateState();
	const cleared = [...s.owners.keys()];
	if (cleared.length === 0) return cleared;
	const before = currentMode();
	s.owners.clear();
	log.info(
		'disarmAll(owners=%s) mode=%s→%s',
		cleared.join(',') || '(none)',
		before,
		currentMode(),
	);
	refreshStatus();
	return cleared;
}

/** 状态快照（供命令 / 通道回执展示）。 */
export function unattendedStatus(): ConfirmGateStatus {
	const s = gateState();
	return {
		license: refreshLicense(s),
		armed: isArmed(),
		owners: [...s.owners.keys()],
		counts: Object.fromEntries(s.owners),
		mode: currentMode(),
	};
}

/**
 * 面板 / 非 TUI 文本共用的动作说明（ADR-0068 D8 约束 3：文案单一来源）。
 * 每项 `lines` 是 2–4 行短句，直接进底部信息栏，不首屏全铺。
 */
export interface UnattendedActionCopy {
	label: string;
	lines: string[];
}

export const UNATTENDED_ACTIONS = {
	disarm: {
		label: '解除豁免',
		lines: [
			'撤销全部占用（含通道残留），立即恢复人工确认。',
			'通道仍连接时，其下次 arm() 会重新生效。',
			'已跳过的动作不会补弹（不可逆），只能查日志。',
		],
	},
	scope: {
		label: '影响与边界',
		lines: [
			'无人应答时，可询问拦截不弹框，按各自声明的默认值处置；未声明的按取消。',
			'硬拦截（protected-paths / secret-firewall / sandbox）不受影响，直接拒绝。',
			'不落盘：/reload 与 /new 都不解除，只有进程退出或本面板解除。',
			'豁免仅限当前工作目录内的文件系统目标；日志见 .pi/logs/unattended_*.log',
		],
	},
	close: {
		label: '关闭',
		lines: ['只关闭本面板，不改任何状态。等效按 Esc。'],
	},
} as const satisfies Record<string, UnattendedActionCopy>;

/** 非 TUI 输出首行：与旧版逐字一致，外部 grep 不受影响 */
export function statusHeadline(s: ConfirmGateStatus): string {
	return `远端豁免：${s.mode}（license=${s.license}，owners=${s.owners.join(',') || '(none)'}）`;
}

/** 非 TUI 输出追加行：说明影响面与生命周期（面板里同一份文案） */
export function statusDetailLines(s: ConfirmGateStatus): string[] {
	if (s.mode === 'off') {
		return [
			`未授权：启动命令需加 --${UNATTENDED_FLAG}（先同步扩展再改启动命令）。`,
			...UNATTENDED_ACTIONS.scope.lines,
		];
	}
	return [...UNATTENDED_ACTIONS.scope.lines];
}

/** 非 TUI 完整状态文本：首行保留旧单行格式，后面追加影响面说明 */
function formatStatusText(): string {
	const s = unattendedStatus();
	return [statusHeadline(s), ...statusDetailLines(s)].join('\n');
}

function refreshStatus(): void {
	const s = gateState();
	try {
		// `hasUI` 判定也必须进 try：pi 1.4 的 invalidate 会让旧 ctx 的属性访问本身就可能抛，
		// 放在 try 外就漏掉了本次要修的场景（arm() 把状态栏刷新失败当成 arm 失败）。
		const ctx = s.ctx;
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(UNATTENDED_STATUS_KEY, isArmed() ? '| unattended' : undefined);
	} catch (err) {
		// 会话替换后旧 ctx 立即失效（pi 1.4 起 `AgentSession.dispose()` 会 invalidate runner）。
		// 通道的 `session_start` 可能早于本扩展的（handler 顺序不定），此时 `arm()` 会拿着旧 ctx
		// 刷新状态——若让异常冒泡，通道会把「arm 成功」误判成连接失败。丢弃缓存，等下个 session_start 重绑。
		// 留痕而不能只吞掉：其它原因导致的 setStatus 失败同样会静默丢弃 ctx（状态栏停更到下次会话）。
		log.warn('refreshStatus 失败，丢弃缓存的 ctx：%s', String(err));
		s.ctx = undefined;
	}
}

/** 跳过一个对话框时留痕：采用了声明式默认值（warn 级：跳过人工确认属需事后回看的事件） */
export function logSkipWithDefault(kind: string, title: string, value: unknown): void {
	log.warn('skip-with-default kind=%s title=%s default=%s', kind, title, String(value));
}

/** 跳过一个对话框时留痕：未声明默认值 → 按取消（fail-closed） */
export function logSkipNoDefault(kind: string, title: string): void {
	log.warn('skip-no-default kind=%s title=%s (treated as cancel)', kind, title);
}

function installBridge(): void {
	// SAFETY: 桥接对象由本模块唯一写入，形状由 ConfirmGateApi 约束
	(globalThis as unknown as { __confirmGateApi?: ConfirmGateApi }).__confirmGateApi = {
		hasLicense,
		isArmed,
		owners: () => [...gateState().owners.keys()],
		arm,
		status: unattendedStatus,
	};
}

/**
 * 注册 flag / session 钩子 / `/unattended` 命令。由 selector 扩展入口调用一次。
 *
 * **flag 只有这里注册**——pi 遇到未注册的 `--flag` 会直接退出（ADR-0051 D8）。
 */
export function initUnattended(pi: ExtensionAPI): void {
	pi.registerFlag(UNATTENDED_FLAG, {
		description: '允许远端通道在无人值守时豁免确认（ADR-0068）',
		type: 'boolean',
		default: false,
	});

	// 记下 pi 实例供 arm() 回读许可（见 refreshLicense）：这里是唯一能拿到 pi 的地方
	gateState().pi = pi;
	gateState().license = pi.getFlag(UNATTENDED_FLAG) === true;

	// 桥接在**工厂期**就挂上：通道插件的 session_start 可能早于本扩展的（handler 按加载顺序
	// 执行、pi 不排序），若等 session_start 才装，通道读 `__confirmGateApi` 会拿到 undefined →
	// 按 ADR-0068 D4「接口不存在 → 不 arm」静默放弃 → 远端操作照旧挂 TUI。桥不依赖 ctx，可提前装。
	installBridge();

	pi.on('session_start', (_event, ctx) => {
		const s = gateState();
		s.ctx = ctx;
		s.license = pi.getFlag(UNATTENDED_FLAG) === true;
		refreshStatus();
		const status = unattendedStatus();
		log.info(
			'unattended session_start mode=%s license=%s owners=%s',
			status.mode,
			status.license,
			status.owners.join(',') || '(none)',
		);
	});

	pi.registerCommand('unattended', {
		description: '远端豁免模式：无参打开运维面板；status | arm | disarm',
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? '';
			// 判据必须是 mode，不是 hasUI：RPC 下 hasUI 为 true，但 `ui.custom` 是空实现
			// （ADR-0068 D8 约束 2）。
			const isTui = ctx.mode === 'tui';

			if (sub === '') {
				if (!isTui) {
					ctx.ui.notify(formatStatusText(), 'info');
					return;
				}
				// 直调 custom，**不经 showSelect**：armed 时 selector 的闸门会把 showSelect
				// 直接跳过（未声明 unattendedDefault → 取消），恰好在最需要救援时打不开。
				const { UnattendedPanel } = await import('./unattended-panel.js');
				await ctx.ui.custom<undefined>(
					(tui, theme, _kb, done) =>
						new UnattendedPanel({
							theme,
							deps: {
								status: unattendedStatus,
								disarmAll,
								// 面板寿命可能跨会话替换：pi 1.4 起旧 ctx 被 invalidate 后任何访问都抛
								//（同 refreshStatus 的成因）。覆盖层通常已随会话销毁，这里兜底留痕，
								// 不把异常抛进输入处理链——此时 disarmAll 已生效，状态是对的。
								notify: (message, level) => {
									try {
										ctx.ui.notify(message, level);
									} catch (err) {
										log.warn('面板通知失败（ctx 可能已失效）：%s', String(err));
									}
								},
							},
							onChange: () => tui.requestRender(),
							onClose: () => done(undefined),
						}),
				);
				return;
			}

			if (sub === 'arm') {
				// 无许可时纯只读：不能让下面的幂等清理改动任何计数
				if (!hasLicense()) {
					ctx.ui.notify(
						`未授权：启动命令需加 --${UNATTENDED_FLAG}（先同步扩展再改启动命令）`,
						'warning',
					);
					return;
				}
				// 幂等：先释放 manual 的既有计数（重复 `/unattended arm`、或 `/reload` 前的遗留），
				// 否则面板与确认页会显示「本机手动 x2」「合计 N 个计数」，读起来像有多个占用者。
				for (let left = unattendedStatus().counts['manual'] ?? 0; left > 0; left--) {
					disarm('manual');
				}
				arm('manual');
				ctx.ui.notify(
					isTui
						? '远端豁免已生效（owner=manual）· 输入 /unattended 查看详情'
						: '远端豁免已生效（owner=manual）',
					'info',
				);
				return;
			}

			if (sub === 'disarm') {
				// 清**所有** owner，不只 manual：通道（如 wechat）崩溃未及 disarm 时，
				// 只撤 manual 会「提示已解除但实际仍 armed」——这是手动恢复确认的入口之一
				//（另一处是 `/unattended` 面板的「解除豁免」）。
				const cleared = disarmAll();
				ctx.ui.notify(
					cleared.length > 0
						? `远端豁免已解除（${cleared.join(',')}）`
						: '远端豁免当前未生效，无需解除',
					'info',
				);
				return;
			}

			if (sub !== 'status') {
				ctx.ui.notify('用法：/unattended（运维面板）| status | arm | disarm', 'warning');
				return;
			}

			ctx.ui.notify(
				isTui
					? `${statusHeadline(unattendedStatus())} · 输入 /unattended 查看详情`
					: formatStatusText(),
				'info',
			);
		},
	});
}
