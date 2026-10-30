/**
 * e2e expect 脚本的「braced body 必须多行」门禁
 *
 * 背景（实测，expect 5.45 / Tcl 8.5 & 8.6 都一样）：`expect { ... }` 的 body 如果
 * **整段写在一行**，expect 会把它当成**单个 glob 模式**而不是 pattern/action 对：
 *
 *   expect { -re {DONE} { } timeout { exit 124 } }
 *   # expect -d 输出：match glob pattern " -re {DONE} { } timeout { exit 124 } "? no
 *
 * 后果是**双重静默**：① 模式永不匹配 → 用例的断言恒真；② `timeout { ... }` 动作永不
 * 执行 → 超时也不再判失败。唯一可见症状是该用例白等到当前 `timeout` 才继续（曾把
 * org 的三态用例从 3s 拖到 273s，也解释了历史上「TUI 用例莫名多等」的表象）。
 *
 * 同样写法的 `expect { eof { } timeout { exit 124 } }`、`expect { timeout { } }` 一并无
 * 效。本门禁把这套写法挡在 CI 之前，避免再一次以「全绿」形式丢掉断言。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const E2E_ROOT = join(REPO_ROOT, 'test', 'e2e');
const SCANNED_EXTENSIONS = ['.sh', '.exp'];

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (SCANNED_EXTENSIONS.some((ext) => full.endsWith(ext))) {
			out.push(full);
		}
	}
	return out;
}

/** 找到每个 `expect {` 的配对 `}`，返回 body 内是否含换行。 */
function findSingleLineBodies(text: string): Array<{ line: number; snippet: string }> {
	const hits: Array<{ line: number; snippet: string }> = [];
	const opener = /expect\s*\{/g;
	let match: RegExpExecArray | null;
	while ((match = opener.exec(text)) !== null) {
		const bodyStart = match.index + match[0].length;
		let depth = 1;
		let i = bodyStart;
		while (i < text.length && depth > 0) {
			if (text[i] === '{') depth += 1;
			else if (text[i] === '}') depth -= 1;
			i += 1;
		}
		if (depth !== 0) continue; // 括号不配对（多见于文档注释），交给 shell 语法检查
		const body = text.slice(bodyStart, i - 1);
		if (body.includes('\n')) continue;
		// 注释里的示例（`# expect { timeout { } }`）不算：只挡真实代码行
		const lineStart = text.lastIndexOf('\n', match.index) + 1;
		const lineText = text.slice(lineStart, text.indexOf('\n', match.index));
		if (lineText.trimStart().startsWith('#')) continue;
		hits.push({
			line: text.slice(0, match.index).split('\n').length,
			snippet: text.slice(match.index, i).trim(),
		});
	}
	return hits;
}

describe('e2e expect 脚本：braced body 必须多行', () => {
	it('test/e2e 下不存在单行 `expect { ... }` body（否则断言与超时都不生效）', () => {
		const offenders: string[] = [];
		for (const file of walk(E2E_ROOT)) {
			const text = readFileSync(file, 'utf8');
			for (const hit of findSingleLineBodies(text)) {
				offenders.push(
					`${relative(REPO_ROOT, file)}:${hit.line}\n    ${hit.snippet}\n` +
						'    → 改成多行：expect {\\n  <pattern> { <action> }\\n  timeout { <action> }\\n}',
				);
			}
		}
		expect(
			offenders,
			`发现 ${offenders.length} 处单行 expect body（会被当成单个 glob 模式，等于空断言）:\n${offenders.join('\n')}`,
		).toEqual([]);
	});

	it('自检：能识别单行 body、放过注释与多行 body', () => {
		expect(findSingleLineBodies('expect { -re {x} { } timeout { exit 1 } }\n')).toHaveLength(1);
		expect(
			findSingleLineBodies('expect {\n  -re {x} { }\n  timeout { exit 1 }\n}\n'),
		).toHaveLength(0);
		expect(findSingleLineBodies('# expect { timeout { } }\n')).toHaveLength(0);
	});
});

/**
 * 第二类同源坑：**未加引号的 heredoc body 里出现反引号**。
 *
 * `cat > f <<-EXPECT`（不带引号）会做命令替换，注释里写 `` `]10;?` `` 就会被 bash 当命令执行：
 * 用例日志灌满 `command not found`，严重时把后续行吞进命令替换里（实测把
 * `stage "pi-ready-raw"` 吞掉）。heredoc 里的注释一律用「」引号，别用反引号。
 */
function findHeredocBackticks(text: string): Array<{ line: number; snippet: string }> {
	const lines = text.split('\n');
	const hits: Array<{ line: number; snippet: string }> = [];
	const opener =
		/<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/;
	for (let i = 0; i < lines.length; i += 1) {
		const match = opener.exec(lines[i]);
		if (!match) continue;
		const quoted = Boolean(match[1] || match[2]);
		const delimiter = match[1] ?? match[2] ?? match[3];
		let j = i + 1;
		for (; j < lines.length && lines[j].trim() !== delimiter; j += 1) {
			if (!quoted && lines[j].includes('`')) {
				hits.push({ line: j + 1, snippet: lines[j].trim().slice(0, 100) });
			}
		}
		i = j;
	}
	return hits;
}

describe('e2e heredoc：未加引号的 heredoc body 里不得出现反引号', () => {
	it('test/e2e 下不存在 heredoc 反引号（会被 bash 当命令替换执行）', () => {
		const offenders: string[] = [];
		for (const file of walk(E2E_ROOT)) {
			for (const hit of findHeredocBackticks(readFileSync(file, 'utf8'))) {
				offenders.push(`${relative(REPO_ROOT, file)}:${hit.line}\n    ${hit.snippet}`);
			}
		}
		expect(
			offenders,
			`发现 ${offenders.length} 处 heredoc 内反引号:\n${offenders.join('\n')}`,
		).toEqual([]);
	});

	it('自检：能识别未加引号 heredoc 里的反引号，放过已加引号的 heredoc', () => {
		expect(findHeredocBackticks('cat > f <<-EOF\n\t# `x` 会被执行\nEOF\n')).toHaveLength(1);
		expect(findHeredocBackticks("cat > f <<-'EOF'\n\t# `x` 原样保留\nEOF\n")).toHaveLength(0);
	});
});
