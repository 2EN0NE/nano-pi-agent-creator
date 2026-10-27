/**
 * permission-gate — 远端豁免判定（ADR-0068 D2/D3）
 *
 * 纯函数：给定命令、cwd 与命中分类，判定该危险命令能否在无人值守时**自动放行**。
 *
 * 只放行一种情况：命令链全是**只解除链接**的文件操作（`rm` / `rmdir` / `unlink`），
 * 且静态解析出的目标**全部**落在 `cwd` 内的字面路径。其余一律不放行，并给出失败类别
 * （供 `UNATTENDED_REMEDY` 产出「怎样合理操作」文案）。
 *
 * 刻意保守：`shred` 这类**覆写内容**的命令不在名单内——硬链接与 cwd 外的文件共享 inode，
 * `realpath` 无法识别，`shred -u ./p` 会销毁 cwd 外原文件的数据；变量、通配符、`~user`、
 * `cd` 链、无文件目标、提权/凭证/系统目录命中同样不放行——
 * 这些场景无法证明「只作用于 cwd 内」，而远端模式下没有第二个人复核。
 *
 * 包含关系按**真实路径**判定（realpath），不是词法 `resolve`：cwd 内一个软链就能把
 * `rm -rf ./link/x` 指到 cwd 外，纯词法判定会把它当成 cwd 内目标放行。
 */

import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseBashCommand } from './bash-parser.js';
import type { UnattendedDenyReason } from './notes.js';
import type { TierHit } from './tiering.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('permission-gate:unattended-exempt');

/**
 * 允许出现在豁免命令链里的文件操作：只解除目录项，不改写任何已存在内容。
 *
 * 刻意不含 `shred`（覆写内容）：硬链接让 cwd 内的路径与 cwd 外的文件共享 inode，
 * `realpath` 看到的是界内路径，覆写却落在界外原文件上。
 */
const FILE_OPS = new Set(['rm', 'rmdir', 'unlink']);

/** 改变工作目录 → 相对目标的基准不可信，直接不放行 */
const DIR_CHANGE_OPS = new Set(['cd', 'pushd', 'popd']);

/**
 * 豁免依据的分类白名单（ADR-0068 D2）。
 *
 * 白名单之外（提权 / 凭证 / 系统目录 / 未来新增分类）一律不豁免——用白名单而非
 * 黑名单，新增分类默认落在「不豁免」一侧。
 */
const ALLOWED_REASON_KEYS = new Set(['destructive', 'pattern']);

/**
 * cwd 内**不可回滚**的内部目录：pi-rewind 快照显式剔除它们
 * （`pi-rewind/engine/repo-manager.ts` 的 `shouldPruneAutoExcludeScanDir` 按**目录名**判定，
 * 任意层级都剔除），删除既无快照可恢复，还会带走仓库历史（`.git`）或项目配置/待办（`.pi`）。
 *
 * 判据必须同样**按路径段**，不能只看顶层：`packages/sub/.git`（嵌套仓库 / 子模块）
 * 与 `sub/.pi` 一样没有快照，只比对 `<cwd>/.git` 会把它们当成普通 cwd 内目标放行。
 */
const PROTECTED_INTERNAL_DIRS = new Set(['.git', '.pi']);

/**
 * 子树扫描的条目上限：超过 = 「证明不出来」，按不放行处理（fail-closed）。
 *
 * 普通工作区远达不到该量级（本仓库 `node_modules` 约 2.2 万条目 / 126ms），
 * 上限只为防「大到扫不动」的树把一次判定拖成分钟级。
 */
const PROTECTED_SCAN_LIMIT = 200_000;

/**
 * 目标**子树内**是否藏着 `.git` / `.pi`。
 *
 * 只看目标路径段是不够的：`rm -rf packages` 会把 `packages/sub/.git` 一起带走，
 * 与直接删它后果完全相同（无快照、丢历史），必须一并拦。
 *
 * 只扫已存在的目录、不跟随符号链接（`Dirent.isDirectory()` 对链接为 false）。
 * 返回命中路径；`'limit'` 表示扫描不完或读不到（都属「无法证明子树干净」）。
 */
function findProtectedInSubtree(absDir: string): string | 'limit' | null {
	let visited = 0;
	const stack = [absDir];
	for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// 读不到子树（EACCES 等）→ 无法证明它不含 .git/.pi
			return 'limit';
		}
		for (const entry of entries) {
			if (++visited > PROTECTED_SCAN_LIMIT) return 'limit';
			if (!entry.isDirectory()) continue;
			if (PROTECTED_INTERNAL_DIRS.has(entry.name)) return join(dir, entry.name);
			stack.push(join(dir, entry.name));
		}
	}
	return null;
}

export interface ExemptVerdict {
	/** true = 可自动放行 */
	exempt: boolean;
	/** 不放行时的类别（exempt 为 true 时为空） */
	deny?: UnattendedDenyReason;
	/** 识别到的目标（原样，未解析） */
	targets: string[];
}

function expandHome(p: string): string {
	if (p === '~') return homedir();
	if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
	return p;
}

/**
 * 真实路径：对「最近存在的祖先」做 realpath，再把不存在的那几段拼回去。
 *
 * cwd 与目标两侧走同一条归一化——既处理 cwd 内软链（指到外面 → 判越界），
 * 也处理系统级软链（macOS `/tmp` → `/private/tmp`）与「目标尚未创建」的情形。
 * 目标本身是软链时取它指向的真实目录（保守：删软链本身也会被判越界）。
 */
function realPath(abs: string): string {
	const tail: string[] = [];
	let head = abs;
	for (;;) {
		try {
			const real = realpathSync.native(head);
			return tail.length > 0 ? resolve(real, ...tail) : real;
		} catch (err) {
			// 只有「不存在」才能逐段上溯；其余错误码（EACCES / ELOOP …）= 真实路径证明不出来，
			// 退回词法拼接会静默退化成 resolve 前缀比较（本模块刻意避免的路径）→ 抛出，由调用方 fail-closed
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
			const parent = dirname(head);
			if (parent === head) return abs;
			tail.unshift(basename(head));
			head = parent;
		}
	}
}

function isInsideCwd(abs: string, cwd: string): boolean {
	return abs === cwd || abs.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep);
}

/**
 * 变量 / 通配符 / 命令替换 / 花括号展开 / `~user` → 真实路径不可静态确定。
 *
 * 也拦引号与反斜杠：解析器给的是**原文**（`bash-parser` 只对 `pathArguments` / 重定向目标
 * 剥离引号），带引号的词会被 `resolve` 当成字面段（`".."` 不归一化、`"/etc"` 不识别为绝对路径），
 * 于是 `rm -rf ".."` / `rm -rf "/etc"` 会被误判成「cwd 内」。这类词一律按不可解析处理（fail-closed）：
 * 解析器不做完整的 shell 去引用，宁可拒绝。
 */
function isUnresolvable(p: string): boolean {
	// `~user` 由 shell 展开成另一个用户的家目录，本模块只认 `~` 与 `~/`
	if (p.startsWith('~') && p !== '~' && !p.startsWith('~/')) return true;
	return /["'\\$`*?[\]{}()]/.test(p);
}

/**
 * 判定一条危险命令能否在远端豁免模式下自动放行。
 *
 * @param command 完整命令文本
 * @param cwd pi 的启动工作目录（`ctx.cwd`）
 * @param hits 分级判定产出的命中明细（`TierAssessment.hits` 的扁平集合）
 */
export function judgeUnattended(
	command: string,
	cwd: string,
	hits: readonly TierHit[],
): ExemptVerdict {
	const deny = (deny: UnattendedDenyReason, targets: string[] = []): ExemptVerdict => ({
		exempt: false,
		deny,
		targets,
	});

	// 用户自加的拦截模式 = 本机额外声明的确认意图，远端模式不代答
	if (hits.some((h) => h.userPattern)) return deny('user-pattern');
	// 白名单之外的分类（提权 / 凭证 / 系统目录 / 未来新增）一律不豁免
	if (hits.some((h) => !ALLOWED_REASON_KEYS.has(h.reason))) return deny('privileged-hit');
	const parsed = parseBashCommand(command);
	// 解析器未预热（cold）或无法解析 → 不可判定，按不放行处理
	if (!parsed.ok || parsed.commands.length === 0) return deny('unparsed');

	// 复合体（subshell / group / pipeline）上的写重定向无法归属到任何一条命令的目标清单
	// → 无法证明「只写 cwd 内」，不放行（见 BashParseResult.unattributedRedirects）
	if (parsed.unattributedRedirects.length > 0) {
		return deny('unresolvable-target', parsed.unattributedRedirects);
	}

	const targets: string[] = [];
	for (const sub of parsed.commands) {
		// 只认**裸命令名**：`./rm`、`/tmp/x/unlink` 是 cwd 内/外的任意可执行文件，
		// 把它们当 coreutils 会让「参数都在 cwd 内」的判定去放行一段不受约束的代码。
		if (sub.commandName.includes('/')) return deny('path-qualified-op');
		const name = sub.commandName;
		if (DIR_CHANGE_OPS.has(name)) return deny('cd-in-chain');
		if (!FILE_OPS.has(name)) return deny('non-file-op');

		// 参数位上的展开 / 替换 / 赋值（`$VAR`、`$(cmd)`、`FOO=1` …）：解析器提取不到可信
		// 目标，但 shell 会把它们展开成真实参数 → 一律按不可解析处理（fail-closed）。
		// 必须在下面的「无目标」判定之前：否则 `rm -rf ./x $DANGER` 会被读成「目标只有 ./x」。
		if (sub.unresolved.length > 0) return deny('unresolvable-target', targets);

		// 写重定向目标同样是「写入目标」：越界或不可解析一律不放行（ADR-0068 D2）
		for (const rd of sub.redirects) {
			if (rd.direction !== 'write') continue;
			// `/dev/null` 是丢弃输出的标准出口，不是「作用域外的写目标」
			if (rd.target === '/dev/null') continue;
			// 空目标 = 解析器认不出目标（`> $(cmd)` / `2> $LOG` 等非 word 节点）：
			// 不能当成「就是 cwd 本身」，否则拒绝原因会误导成 cwd-root
			if (rd.target === '') return deny('unresolvable-target', targets);
			if (isUnresolvable(rd.target)) return deny('unresolvable-target', targets);
			targets.push(rd.target);
		}
		const args = sub.arguments.filter((a) => !a.startsWith('-'));
		if (args.length === 0) return deny('no-target');
		for (const a of args) {
			if (isUnresolvable(a)) return deny('unresolvable-target', targets);
			targets.push(a);
		}
	}

	// 两侧都按真实路径比较：cwd 内软链指向外面时，词法前缀会误判为「cwd 内」。
	// realPath 遇到非「不存在」错误会抛出 → 真实路径证明不出来即不放行（fail-closed）
	try {
		const base = realPath(resolve(cwd));
		for (const t of targets) {
			const real = realPath(resolve(base, expandHome(t)));
			if (!isInsideCwd(real, base)) return deny('outside-cwd', targets);
			// cwd 本身不是「cwd 内目标」：`rm -rf .` 会连带删掉 .git 与全部子目录
			if (real === base) return deny('cwd-root', targets);
			// .git / .pi（**任意层级**）不在 pi-rewind 快照内 → 删了不可回滚，且带走历史/配置。
			// 按路径段判定：`sub/.git` 与顶层 `.git` 一样无快照（pi-rewind 按目录名剔除）
			if (
				relative(base, real)
					.split(sep)
					.some((seg) => PROTECTED_INTERNAL_DIRS.has(seg))
			) {
				return deny('protected-internal', targets);
			}
			// 目标本身是目录时还要看**子树**：`rm -rf packages` 会连带删掉 `packages/sub/.git`，
			// 与直接删它后果相同（无快照、丢历史），只看目标路径段会漏掉这条
			if (statSync(real, { throwIfNoEntry: false })?.isDirectory()) {
				const nested = findProtectedInSubtree(real);
				if (nested === 'limit') {
					log.warn('目标子树过大/不可读，无法证明不含 .git/.pi，按不豁免处理：%s', real);
					return deny('unresolvable-target', targets);
				}
				if (nested) {
					log.warn('目标子树含不可回滚的 %s，按不豁免处理：%s', nested, real);
					return deny('protected-internal', targets);
				}
			}
		}
	} catch (err) {
		log.warn('realpath 无法证明真实路径，按不豁免处理：%s', (err as Error).message);
		return deny('unresolvable-target', targets);
	}

	return { exempt: true, targets };
}
