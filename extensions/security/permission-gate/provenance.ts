/**
 * permission-gate — 路径出处账本（ADR-0025 第四轴 / ADR-0060）
 *
 * 回答一个问题：**这个目标路径是不是本会话的命令创建的？**
 *
 * 判定阶梯（由强到弱）：
 *   ① 命令内的字面路径片段（`$R/.pi/tmp/x`、`$PWD/.pi/tmp/y`）
 *   ② 命令内的变量绑定（`T=$(mktemp -d)` → 本会话创建的临时目录；
 *      `T="$R/.pi/tmp/z"` → 拼接出具体路径）
 *   ③ 会话级变量账本（跨命令：上一条命令里 `T=$(mktemp -d)`，下一条 `rm -rf "$T"`）
 *   ④ 不可判定 → 返回 `unknown`，调用方**失败即拒绝**（不猜）
 *
 * 两个关键设计：
 *
 * 1. **判定在表达式层面做，而不是在已解析的绝对路径上做。** `rm -rf "$T"` 里的 `$T`
 *    静态不可知（mktemp 的随机名），唯一能区分「我们自己的临时目录」与「/tmp 下
 *    别人的东西」的方式，就是判断这个目标是不是**从我们记录的变量**推出来的。
 * 2. **只看会改动文件系统的动词**（rm/mv/cp/mkdir/touch/tee/重定向…）的实参。
 *    否则 `cd /proj` 这类无害路径会被当成待判定目标，导致永远判不出来。
 *
 * 不新增持久化：账本在 `session_start` 时按 sessionId 从审计日志重建。
 * 未实现：mtime 兜底（ADR-0025 允许、仅限临时区根）——静态阶梯已覆盖实测 97%，
 * 且它要把文件系统 stat 放进判定热路径，暂不做。
 */

import { homedir, tmpdir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { isDenyDecision, type AuditEntry } from './audit-log.js';
import { splitCompoundCommand } from './records.js';

const log = createLogger('permission-gate:provenance');

/** 出处判定结果：yes=全部由本会话创建 / no=有目标明确不是 / unknown=不可判定 */
export type ProvenanceVerdict = 'yes' | 'no' | 'unknown';

/**
 * 变量值的**符号化**表示。
 * `mktemp -d` 的实际名字静态不可知，只能记「形状」而不能记值——
 * 这是这套判定能覆盖变量目标的关键。
 */
type VarValue =
	{ kind: 'path'; path: string } | { kind: 'fresh-temp'; root: string } | { kind: 'unknown' };

/** 会改动文件系统的动词：只有它们的实参才需要判定出处 */
const MUTATOR_VERBS = new Set([
	'rm',
	'rmdir',
	'unlink',
	'shred',
	'mv',
	'cp',
	'ln',
	'install',
	'truncate',
	'dd',
	'tee',
	'touch',
	'mkdir',
	'chmod',
	'chown',
	'rsync',
]);

/** 匿名临时条目上限（防止长会话无限增长；超出后丢弃最早的记录） */
const MAX_CREATED_PATHS = 5000;

/** `$(mktemp ...)` / 反引号形式 —— 一次创建，名字运行时才知道 */
const MKTEMP_RE = /\$\(\s*mktemp\b[^)]*\)|`[^`]*\bmktemp\b[^`]*`/;

/** 变量赋值（含 export 前缀）。值可以是引号串、命令替换 `$(...)`（整体）或裸串 */
const ASSIGN_RE =
	/(?:^|[;&|(\s])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\$\([^)]*\)|[^\s;&|)]*))/g;

/** 是否是一个赋值形式的 token（`T=x`）—— 它不是待判定目标 */
function isAssignmentToken(tok: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok);
}

/**
 * 提取命令中「会改动文件系统的实参」的**原始表达式**：mutator 动词的实参 + 重定向目标。
 *
 * 与 `judge` 的目标集完全一致，供 `matchScope` 判定含变量目标是否需要出处条件
 * （只读命令 `grep x "$f"` 不该因为含变量而被整体判为范围外）。
 */
export function extractMutationTargetArgs(command: string): string[] {
	const targets = new Set<string>();
	for (const unit of commandUnits(command)) {
		const tokens = tokenizeExpressions(unit);
		const verbIdx = tokens.findIndex((t) => !isAssignmentToken(t));
		const verb = verbIdx >= 0 ? tokens[verbIdx] : undefined;
		if (verb && MUTATOR_VERBS.has(verb)) {
			for (const t of tokens.slice(verbIdx + 1)) {
				if (!t.startsWith('-') && !isAssignmentToken(t)) targets.add(t);
			}
		}
	}
	for (const m of command.matchAll(/(?:^|[\s;&|])(?:\d?>>?|&>)\s*([^\s;&|]+)/g)) {
		const t = m[1];
		if (t && t !== '/dev/null' && !t.startsWith('&')) targets.add(t);
	}
	return [...targets];
}

/**
 * 路径边界：这些目录是「容器」而不是「我们创建的东西」。
 * `mkdir -p` 回溯登记时不会把这些自身写进账本，否则 `/tmp` 会命中一切。
 */
function boundaryRoots(cwd: string): string[] {
	return [
		'/',
		'/tmp',
		'/var',
		'/private/tmp',
		'/private/var',
		'/Users',
		homedir(),
		// 系统临时根（macOS: /var/folders/…/T）：容器而非「我们创建的东西」。
		// 不纳入会把整个 tmpdir 误登记成创建路径，使其中别人的目录被判为 yes（见 addCreated）。
		resolve(tmpdir()),
		resolve(cwd),
	];
}

/** token 化：去掉引号，且把 `$(...)` 内的空白视为 token 内部（命令替换是一个整体） */
export function tokenizeExpressions(input: string): string[] {
	const tokens: string[] = [];
	let cur = '';
	let quote: '"' | "'" | null = null;
	let paren = 0;

	const flush = () => {
		if (cur) tokens.push(cur);
		cur = '';
	};

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;

		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
			continue;
		}
		if (paren > 0) {
			if (ch === '(') paren++;
			else if (ch === ')') paren--;
			cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === '$' && input[i + 1] === '(') {
			paren = 1; // `$(...)` 是一个整体：从 1 开始计深度，并把 '(' 一并吞下
			cur += '$(';
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		cur += ch;
	}
	flush();
	return tokens;
}

/** 把命令拆成「单元」：先按 ; && || | 拆分，再按换行拆（脚本是一行行跑的） */
function commandUnits(command: string): string[] {
	return splitCompoundCommand(command).flatMap((s) => s.split('\n'));
}

export class ProvenanceLedger {
	/** 本会话创建的具体路径 */
	private readonly createdPaths = new Set<string>();
	/** 会话级变量账本（跨命令生效） */
	private readonly vars = new Map<string, VarValue>();

	/** 观测用：账本规模 */
	get size(): { createdPaths: number; vars: number } {
		return { createdPaths: this.createdPaths.size, vars: this.vars.size };
	}

	/**
	 * 解析一个表达式为符号化值。
	 * 变量引用从 `vars` 取；`$PWD` / `$(pwd)` 按 cwd 展开；其余命令替换视为不可判定。
	 */
	private resolveExpr(expr: string, cwd: string, vars: Map<string, VarValue>): VarValue {
		let e = expr.trim();
		if (!e) return { kind: 'unknown' };

		if (MKTEMP_RE.test(e)) return { kind: 'fresh-temp', root: tmpdir() };

		// $PWD / $(pwd) → cwd
		e = e.replace(/\$\(\s*pwd\s*\)/g, cwd).replace(/\$\{?PWD\}?/g, cwd);

		// 未处理的命令替换（$(ls ...) 等）：运行时才知道结果 → 不可判定
		if (/\$\(/.test(e) || /`/.test(e)) return { kind: 'unknown' };

		let unknownVar = false;
		let freshRoot: string | null = null;
		const substituted = e.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name: string) => {
			const v = vars.get(name);
			if (!v) {
				unknownVar = true;
				return '';
			}
			if (v.kind === 'path') return v.path;
			if (v.kind === 'fresh-temp') {
				freshRoot = v.root;
				return '';
			}
			unknownVar = true;
			return '';
		});

		// 由 mktemp 变量派生的路径（`"$T/sessions"`）仍是本会话创建的临时条目
		if (freshRoot) return { kind: 'fresh-temp', root: freshRoot };
		if (unknownVar || !substituted) return { kind: 'unknown' };

		const abs = isAbsolute(substituted) ? normalize(substituted) : resolve(cwd, substituted);
		return { kind: 'path', path: abs };
	}

	/** 命令内变量绑定 → 写入 `vars`（按出现顺序，后面的可引用前面的） */
	private bindVars(command: string, cwd: string, vars: Map<string, VarValue>): void {
		for (const m of command.matchAll(ASSIGN_RE)) {
			const name = m[1];
			if (!name) continue;
			const raw = m[2] ?? m[3] ?? m[4] ?? '';
			vars.set(name, this.resolveExpr(raw, cwd, vars));
		}
	}

	/** 当前命令的绑定叠加在会话账本之上（当前命令优先） */
	private localVarsFor(command: string, cwd: string): Map<string, VarValue> {
		const local = new Map(this.vars);
		this.bindVars(command, cwd, local);
		return local;
	}

	/**
	 * 扫描命令里的创建动作，返回可解析出的具体路径。**不改动账本**。
	 *
	 * 同一份扫描服务两处：`observe` 用它登记已发生的创建；`judge` 用它识别
	 * **本命令自身**的创建（`mkdir -p "$T" && … && rm -rf "$T"`——最典型的临时目录用法，
	 * 判定发生在执行之前，不能只靠已发生的账本）。
	 */
	private plannedPaths(command: string, cwd: string, vars: Map<string, VarValue>): string[] {
		const out: string[] = [];
		const push = (expr: string) => {
			const r = this.resolveExpr(expr, cwd, vars);
			if (r.kind === 'path') out.push(r.path);
		};

		for (const unit of commandUnits(command)) {
			const tokens = tokenizeExpressions(unit);
			const verbIdx = tokens.findIndex((t) => !isAssignmentToken(t));
			const verb = verbIdx >= 0 ? tokens[verbIdx] : undefined;

			if (verb === 'mkdir' || verb === 'touch' || verb === 'tee') {
				for (const t of tokens.slice(verbIdx + 1)) if (!t.startsWith('-')) push(t);
			} else if (verb === 'git' && tokens[verbIdx + 1] === 'clone') {
				const positional = tokens.slice(verbIdx + 2).filter((t) => !t.startsWith('-'));
				if (positional[1]) push(positional[1]);
			}
		}

		// 写重定向（`> f` / `>> f` / `2> f`）也创建目标文件
		for (const m of command.matchAll(/(?:^|[\s;&|])(?:\d?>>?|&>)\s*([^\s;&|]+)/g)) {
			const target = m[1];
			if (target && target !== '/dev/null' && !target.startsWith('&')) push(target);
		}
		return out;
	}

	/**
	 * 登记一个创建路径。
	 *
	 * **只登记命令里明确写出的路径本身，不回溯登记祖先目录**（ADR-0060）：
	 * 回溯会把**已存在的祖先**误登记成「本会话创建」——例如 `mkdir -p <tmpdir>/probe`
	 * 会连 `<tmpdir>` 一起登记，于是 `rm -rf <tmpdir>/别人的目录` 被判为 yes（误放行、不可逆）。
	 * 容器目录（/、/tmp、~、tmpdir() 等，见 boundaryRoots）本身一律不登记。
	 *
	 * 删除目标落在已登记路径**之内**仍成立（`judge` 的 isOurs 向上查找）。
	 */
	private addCreated(absPath: string, cwd: string): void {
		if (boundaryRoots(cwd).includes(absPath)) return;
		this.createdPaths.add(absPath);
		if (this.createdPaths.size > MAX_CREATED_PATHS) {
			const excess = this.createdPaths.size - MAX_CREATED_PATHS;
			let i = 0;
			for (const k of this.createdPaths) {
				if (i++ >= excess) break;
				this.createdPaths.delete(k);
			}
		}
	}

	/**
	 * 观察一条**已实际执行**的命令：更新变量账本与创建记录。
	 * 判定路径（tool_call）不应调用本方法——它只反映已经发生的事。
	 */
	observe(command: string, cwd: string): void {
		if (!command) return;
		this.bindVars(command, cwd, this.vars);
		for (const p of this.plannedPaths(command, cwd, this.vars)) this.addCreated(p, cwd);
	}

	/**
	 * 判定一条命令的目标是否由本会话创建。
	 *
	 * 只判定**会改动文件系统的动词的实参**与重定向目标（见模块头注释）：
	 * `cd /proj`、`ls /tmp` 这类无害路径不参与判定，否则永远判不出来。
	 *
	 * 注意：本方法**不改动**账本（判定发生在命令执行之前）。
	 */
	judge(command: string, cwd: string): ProvenanceVerdict {
		if (!command) return 'unknown';
		const vars = this.localVarsFor(command, cwd);

		const targets = new Set<string>(extractMutationTargetArgs(command));

		if (targets.size === 0) {
			log.debug('出处判定：命令无改动目标 → unknown（%s）', command.slice(0, 80));
			return 'unknown';
		}

		// 本命令自身的创建动作（阶梯①/②）
		const planned = new Set(this.plannedPaths(command, cwd, vars));
		const isOurs = (p: string): boolean => {
			let cur = p;
			for (;;) {
				if (planned.has(cur) || this.createdPaths.has(cur)) return true;
				const parent = resolve(cur, '..');
				if (parent === cur) return false;
				cur = parent;
			}
		};

		let sawUnknown = false;
		for (const expr of targets) {
			const r = this.resolveExpr(expr, cwd, vars);
			if (r.kind === 'fresh-temp') continue; // mktemp 出来的临时条目 = 本会话创建
			if (r.kind === 'unknown') {
				sawUnknown = true;
				continue;
			}
			if (!isOurs(r.path)) {
				log.debug('出处判定：%s 非本会话创建（%s）', r.path, command.slice(0, 80));
				return 'no';
			}
		}
		const verdict: ProvenanceVerdict = sawUnknown ? 'unknown' : 'yes';
		log.debug('出处判定：%s（%s）', verdict, command.slice(0, 80));
		return verdict;
	}

	/**
	 * 按会话 ID 从审计日志重建账本（`session_start` 时调用）。
	 *
	 * 只回放**实际执行过**的命令：被拒绝/被无界面拦截的命令没有改变文件系统，
	 * 回放它们会凭空产生「我创建过」的假象。
	 */
	rebuild(entries: AuditEntry[], sessionId: string, fallbackCwd: string): number {
		let replayed = 0;
		for (const e of entries) {
			if (e.sessionId !== sessionId) continue;
			if (isDenyDecision(e.decision)) continue;
			const cmd = e.originalCommand;
			if (!cmd) continue;
			this.observe(cmd, e.projectPath ?? fallbackCwd);
			replayed++;
		}
		log.info(
			'出处账本重建：回放 %d 条命令（session=%s, createdPaths=%d, vars=%d）',
			replayed,
			sessionId,
			this.createdPaths.size,
			this.vars.size,
		);
		return replayed;
	}
}

let ledger = new ProvenanceLedger();

/** 当前会话的出处账本 */
export function getProvenanceLedger(): ProvenanceLedger {
	return ledger;
}

/** 重置（新会话 / 测试） */
export function resetProvenanceLedger(): void {
	ledger = new ProvenanceLedger();
}
