/**
 * Diff 生成工具
 *
 * 从 multi-edit.ts 提取，统一 diff 输出格式。
 */

import * as Diff from 'diff';

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split('\n');
		if (raw[raw.length - 1] === '') {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, ' ');
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange =
				i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				const showAtStart = lastWasChange ? contextLines : 0;
				const showAtEnd = nextPartIsChange ? contextLines : 0;

				if (raw.length <= showAtStart + showAtEnd) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					for (let j = 0; j < showAtStart; j++) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
						output.push(` ${lineNum} ${raw[j]}`);
						oldLineNum++;
						newLineNum++;
					}

					const skipped = raw.length - showAtStart - showAtEnd;
					if (skipped > 0) {
						output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);
						oldLineNum += skipped;
						newLineNum += skipped;
					}

					for (let j = raw.length - showAtEnd; j < raw.length; j++) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ');
						output.push(` ${lineNum} ${raw[j]}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join('\n'), firstChangedLine };
}
