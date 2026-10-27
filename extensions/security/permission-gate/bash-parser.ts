/**
 * permission-gate — tree-sitter bash 解析器（T2）
 *
 * 用 tree-sitter-bash（WASM）精确解析 bash 命令，产出「命令 × 目标路径 × 读写方向」
 * 的结构化表示，供危险分级判定使用，并作为未来智能自适应算法的语料。
 *
 * 设计要点：
 *   - WASM 异步加载，需在 before_agent_start 时调用 warmBashParser() 预热；
 *     预热成功后 getWarmBashParser() 同步返回 parser（parse 是纯函数，线程安全）。
 *   - 预热失败（WASM init 异常）→ parser 保持 cold，parseBashCommand 降级返回
 *     { ok: false }，调用方回退到 whole-string matching。
 *
 * 本模块不依赖 pi 扩展 API，可在任何 Node 环境下使用（vitest 可直接测）。
 */

import { createRequire } from 'node:module';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('permission-gate/bash-parser');

// ============================================================================
// Types
// ============================================================================

/**
 * 重定向：operator 是 > >> < << 等，direction 从 operator 推断。
 *
 * **不含 fd 复制**（`2>&1` / `>&2` / `>&-`）：那不是文件目标，见 `extractRedirect`。
 */
export interface BashRedirect {
	operator: string;
	target: string;
	direction: 'read' | 'write';
}

/** 单条命令（复合命令会拆成多条） */
export interface BashCommand {
	/** 主命令名（rm / cat / sudo / chmod …），复合命令里每个子命令各一条 */
	commandName: string;
	/** 全部参数（含 flag、路径、普通参数） */
	arguments: string[];
	/** 参数里识别出的路径（含 / 或 ~ 或 --key=/path 的 value） */
	pathArguments: string[];
	/** 该命令关联的重定向 */
	redirects: BashRedirect[];
	/**
	 * 参数位上**无法归属**的节点原文（`$VAR` / `${VAR}` / `$(cmd)` / `` `cmd` `` /
	 * `a$b` / `FOO=1` / `{a,b}` / `>(cat)` …）。
	 *
	 * 这些节点不是 `word`，不进 `arguments`；但它们的展开结果是真实的命令行参数。
	 * 单独列出来，是为了让调用方把「解析器没提取到」与「命令里没有」区分开——
	 * 前者必须按「不可静态解析」处理（fail-closed），否则 `rm -rf ./x $DANGER`
	 * 会被误判成「目标只有 `./x`」。
	 */
	unresolved: string[];
}

export interface BashParseResult {
	/** 解析是否成功；false 表示 parser 未预热（fallback 到 whole-string） */
	ok: boolean;
	commands: BashCommand[];
	/**
	 * 依附在**复合体**（subshell / group / pipeline / list）上的写重定向原文。
	 *
	 * `(rm -rf x) > /tmp/out` 的写目标在 `subshell` 上，不属于任何一条命令的目标清单，
	 * 因此无法归属；调用方必须按「不可静态解析」处理（fail-closed），否则越界写会整条漏掉。
	 */
	unattributedRedirects: string[];
	raw: string;
}

// ============================================================================
// web-tree-sitter 最小类型子集（避免调用方直接 import web-tree-sitter）
// ============================================================================

interface TSNode {
	readonly type: string;
	readonly text: string;
	readonly childCount: number;
	readonly isNamed: boolean;
	child(index: number): TSNode | null;
}

interface TSParser {
	parse(input: string): { rootNode: TSNode; delete(): void } | null;
	delete(): void;
}

// ============================================================================
// WASM 初始化与预热
// ============================================================================

let warmedParser: TSParser | null = null;
let warming: Promise<TSParser> | null = null;

async function initParser(): Promise<TSParser> {
	const { Parser, Language } = await import('web-tree-sitter');
	const req = createRequire(import.meta.url);
	const treeSitterWasm = req.resolve('web-tree-sitter/web-tree-sitter.wasm');
	await Parser.init({ locateFile: () => treeSitterWasm });

	const parser = new Parser();
	const bashWasm = req.resolve('tree-sitter-bash/tree-sitter-bash.wasm');
	const bash = await Language.load(bashWasm);
	parser.setLanguage(bash);
	return parser as TSParser;
}

/**
 * 预热 tree-sitter parser（before_agent_start 时调用）。
 * 幂等 + 尽力而为：init 失败时吞掉异常，parser 保持 cold，调用方降级。
 */
export async function warmBashParser(): Promise<void> {
	if (warmedParser) return;
	if (!warming) {
		warming = initParser()
			.then((p) => {
				warmedParser = p;
				return p;
			})
			.catch((err) => {
				log.warn(
					'tree-sitter warm-up failed, falling back to whole-string matching: %s',
					String(err),
				);
				warming = null;
				throw err;
			});
	}
	try {
		await warming;
	} catch {
		// 吞掉，保持 cold
	}
}

/** 预热后的 parser，未预热时返回 null（调用方必须降级） */
export function getWarmBashParser(): TSParser | null {
	return warmedParser;
}

/** 测试专用：清空预热缓存，隔离 cold/warm 场景 */
export function resetWarmBashParser(): void {
	warmedParser = null;
	warming = null;
}

// ============================================================================
// AST 遍历与提取
// ============================================================================

// 只列读操作符：direction 默认按写处理（未知 / `>&` / `<>` 等一律写，fail-closed）
const READ_OPERATORS = new Set(['<', '<<', '<<<', '<&']);

/** 树中的词类节点（word/string/raw_string/number）——参数、重定向目标、命令名候选 */
const WORD_TYPES = new Set(['word', 'string', 'raw_string', 'number']);

/**
 * 剥离文本中的 shell 引号字符（" '）。
 * tree-sitter 的 string/raw_string 节点 text 含包围引号，word 内嵌引号段也不拆出；
 * 分级层按归一化后的文本做路径前缀/后缀匹配——不剥离会导致 `cat "/etc/passwd"` 这类
 * 加引号命令逃逸 credential/systemDir 判定（fail-open）。混合/内嵌引号也一并归一化：
 * 匹配宁可误报不可漏报（fail-closed）。变量展开（$HOME/…）文本保留，由分级层做 home 归一化。
 */
function stripShellQuotes(text: string): string {
	return text.replace(/["']/g, '');
}

/**
 * fd 复制操作符：`2>&1` / `>&2` / `0<&3` / `>&-`。
 *
 * bash 里这两个操作符的目标是**数字 fd**（或 `-` 关闭）时只复制/关闭描述符，不打开任何文件；
 * 只有目标是别的词（`cmd >& /tmp/out`）才等价于 `&>` 写文件。误当写目标有两处后果：
 * 判定层把不存在的相对路径 `1`/`2` 当成 cwd 内写目标（审计 `targets` 出现虚假路径），
 * 分级层则凭空得到 `write=true`。故 extractRedirect 对 fd 目标返回 null。
 */
const FD_DUP_OPERATORS = new Set(['>&', '<&']);
/** `>&-` / `<&-`（关闭描述符）：tree-sitter 把 `-` 并进 operator，没有 target */
const FD_CLOSE_OPERATORS = new Set(['>&-', '<&-']);
const FD_TARGET = /^(?:\d+|-)$/;

function extractRedirect(node: TSNode): BashRedirect | null {
	let operator = '';
	let target = '';
	for (let i = 0; i < node.childCount; i++) {
		const c = node.child(i);
		if (!c) continue;
		if (!c.isNamed && !operator) {
			operator = c.text.trim();
		} else if (!target && c.type !== 'file_descriptor' && WORD_TYPES.has(c.type)) {
			// 引号目标节点类型是 string/raw_string（非 word），此前被漏掉 → 目标为空 → 写敏感路径分级失效
			target = stripShellQuotes(c.text);
		}
	}
	// fd 复制 / 关闭（`2>&1` / `>&-`）：不是文件目标，不能进 redirects
	// （否则 `1` / `2` 会被当成相对路径目标，`>&-` 会变成空目标写重定向）
	if (FD_CLOSE_OPERATORS.has(operator)) return null;
	if (FD_DUP_OPERATORS.has(operator) && FD_TARGET.test(target)) return null;
	const direction: 'read' | 'write' = READ_OPERATORS.has(operator) ? 'read' : 'write';
	return { operator, target, direction };
}

/** 判断文本是否"像路径"：含 / 或 ~ 开头，或 --key=/path 的 value 含 / */
function isPathLike(text: string): boolean {
	if (text.includes('/')) return true;
	if (text.startsWith('~')) return true;
	const eq = text.indexOf('=');
	if (eq > 0 && text.slice(eq + 1).includes('/')) return true;
	return false;
}

/** 从参数文本提取路径：--key=/path → /path；否则原样 */
function extractPath(text: string): string {
	const eq = text.indexOf('=');
	// 只有 --key=value 形式（flag 携带路径值）才拆出 value
	if (text.startsWith('--') && eq > 0) return text.slice(eq + 1);
	return text;
}

function firstWordText(commandNameNode: TSNode): string {
	for (let i = 0; i < commandNameNode.childCount; i++) {
		const c = commandNameNode.child(i);
		if (c && c.type === 'word') return c.text;
	}
	return stripShellQuotes(commandNameNode.text.trim());
}

function extractCommand(node: TSNode, redirects: BashRedirect[]): BashCommand {
	let commandName = '';
	const args: string[] = [];
	const pathArgs: string[] = [];
	const unresolved: string[] = [];

	for (let i = 0; i < node.childCount; i++) {
		const c = node.child(i);
		if (!c) continue;
		if (c.type === 'command_name') {
			commandName = firstWordText(c);
		} else if (WORD_TYPES.has(c.type)) {
			const text = c.text;
			args.push(text);
			// 路径参数按去除 shell 引号后的文本提取，保持引号命令与裸命令分级一致（fail-open 修复）
			const clean = stripShellQuotes(text);
			if (isPathLike(clean)) pathArgs.push(extractPath(clean));
		} else if (c.isNamed) {
			// 参数位上的展开 / 替换 / 赋值 / 拼接：展开结果是真实参数，但文本无法静态判定。
			// 不丢：交给调用方按「不可解析」处理（见 BashCommand.unresolved）
			unresolved.push(c.text);
		}
	}

	return { commandName, arguments: args, pathArguments: pathArgs, redirects, unresolved };
}

/** 子节点里除重定向外的命名节点（复合体重定向的归属判定用） */
function nonRedirectChildren(node: TSNode): TSNode[] {
	const body: TSNode[] = [];
	for (let i = 0; i < node.childCount; i++) {
		const c = node.child(i);
		if (c && c.isNamed && c.type !== 'file_redirect') body.push(c);
	}
	return body;
}

/** 递归遍历，收集所有 command；遇到 command 时关联其 redirected_statement 父节点的重定向 */
function collectCommands(
	node: TSNode,
	parent: TSNode | null,
	out: BashCommand[],
	unattributedRedirects: string[],
): void {
	if (node.type === 'command') {
		const redirects: BashRedirect[] = [];
		if (parent && parent.type === 'redirected_statement') {
			for (let i = 0; i < parent.childCount; i++) {
				const c = parent.child(i);
				if (!c || c.type !== 'file_redirect') continue;
				const rd = extractRedirect(c);
				if (rd) redirects.push(rd);
			}
		}
		out.push(extractCommand(node, redirects));
		return; // 不深入 command 内部（嵌套 subshell 第一版不处理）
	}
	if (node.type === 'file_redirect') return; // 已在 command 提取时处理

	// 复合体（subshell / compound_statement / pipeline / list）自带的重定向：
	// `(rm -rf x) > /tmp/out` 的写目标挂在 subshell 上，无法归属到任何一条命令 → 记下来，
	// 否则「解析结果里没有越界写目标」会被误读成「没有越界写」
	if (node.type === 'redirected_statement') {
		const body = nonRedirectChildren(node);
		const bodyIsSingleCommand = body.length === 1 && body[0].type === 'command';
		if (!bodyIsSingleCommand) {
			for (let i = 0; i < node.childCount; i++) {
				const c = node.child(i);
				if (!c || c.type !== 'file_redirect') continue;
				// fd 复制不是写目标（extractRedirect 返回 null），不能算「无法归属的越界写」
				if (extractRedirect(c)?.direction === 'write') unattributedRedirects.push(c.text);
			}
		}
	}

	for (let i = 0; i < node.childCount; i++) {
		const c = node.child(i);
		if (c) collectCommands(c, node, out, unattributedRedirects);
	}
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 解析一条 bash 命令，产出结构化表示。
 *
 * parser 未预热时返回 { ok: false, commands: [], raw }——调用方必须降级到
 * whole-string matching（与 pi-permission-system 的 fallback 语义一致）。
 */
export function parseBashCommand(command: string): BashParseResult {
	const parser = getWarmBashParser();
	if (!parser) {
		return { ok: false, commands: [], unattributedRedirects: [], raw: command };
	}

	const tree = parser.parse(command);
	if (!tree) {
		return { ok: false, commands: [], unattributedRedirects: [], raw: command };
	}

	try {
		const commands: BashCommand[] = [];
		const unattributedRedirects: string[] = [];
		collectCommands(tree.rootNode, null, commands, unattributedRedirects);
		return { ok: true, commands, unattributedRedirects, raw: command };
	} finally {
		tree.delete();
	}
}
