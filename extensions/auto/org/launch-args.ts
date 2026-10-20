/**
 * 成员启动参数的**取值与拼装**（ADR-0051 D3）。
 *
 * 拼装恒为：`pi <prefixArgs> -a --session-control [--session-id <上次>] <launchArgs>`
 *
 * - 固定核（`-a`、`--session-control`、`--session-id`）**不进可编辑串、不校验**：
 *   `--session-control` 是"在岗可收发成员消息"的命脉（建不起 socket = 被唤起了却在岗不可达），
 *   不给一次误删的机会；
 * - `launchArgs` **纯追加**在固定核之后；空串/全空白 ⇒ 不加任何参数
 *   （字段缺失 `undefined` 同样不加——"没有的就没有"，ADR-0051 D2）；
 * - 按空白切分，支持**成对引号**（单/双，引号内保留空格）；引号不成对 ⇒ 由调用方报错，
 *   这里不猜、不截断（看板保存时拒绝并保留原值）。
 *
 * 本模块不依赖 pi 扩展 API，可在任何 Node 环境下单测。
 */

/** 固定启动项（顺序即拼装顺序；不可编辑、不校验） */
export const FIXED_WAKE_ARGS: readonly string[] = ['-a', '--session-control'];

export type SplitLaunchArgsResult = { ok: true; args: string[] } | { ok: false; error: string };

/**
 * 把启动参数字符串切成 argv 片段。空白分隔；`"…"` / `'…'` 内的空白保留、引号本身剔除。
 * 不支持转义（引号内不能再出现同类引号）——保持规则可一句话说清。
 */
export function splitLaunchArgs(raw: string): SplitLaunchArgsResult {
	const args: string[] = [];
	let cur = '';
	let opened: string | null = null; // 当前打开的引号字符
	let has = false; // cur 是否已含有内容（区分空引号 "" 与"无 token"）

	for (const ch of raw) {
		if (opened) {
			if (ch === opened) {
				opened = null;
				has = true;
			} else {
				cur += ch;
				has = true;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			opened = ch;
			has = true;
			continue;
		}
		if (/\s/.test(ch)) {
			// 空 token 不入参：`""` 这类空引号不产生一个空的 argv 片段
			// （与「空串 = 不带参数」同源，见 ADR-0051 D2/D3）
			if (has && cur !== '') {
				args.push(cur);
				cur = '';
				has = false;
			}
			continue;
		}
		cur += ch;
		has = true;
	}

	if (opened) {
		return { ok: false, error: `引号不成对（缺少收尾的 ${opened}）：${raw.trim()}` };
	}
	if (has && cur !== '') args.push(cur);
	return { ok: true, args };
}

export interface WakeArgsResult {
	/** 完整 argv（含 prefixArgs 与固定核） */
	args: string[];
	/** 启动参数无效而被忽略时的原因（调用方负责留痕；无效不影响唤醒本身） */
	droppedReason?: string;
}

/**
 * 拼装唤醒成员的完整 argv。
 *
 * `launchArgs` 无效（引号不成对）时**不阻断唤醒**：忽略追加项并回传原因，
 * 由调用方 warn 留痕——唤醒成员的固定核才是命脉，不该因为一条坏参数叫不醒人。
 */
export function buildWakeArgs(opts: {
	prefixArgs?: string[];
	sessionId?: string;
	launchArgs?: string;
}): WakeArgsResult {
	const args = [
		...(opts.prefixArgs ?? []),
		...FIXED_WAKE_ARGS,
		...(opts.sessionId ? ['--session-id', opts.sessionId] : []),
	];
	const raw = opts.launchArgs ?? '';
	if (raw.trim() === '') return { args };

	const split = splitLaunchArgs(raw);
	if (!split.ok) return { args, droppedReason: split.error };
	return { args: [...args, ...split.args] };
}
