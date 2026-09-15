/**
 * permission-gate — 提升确认卡片（Ticket 07 / ADR-0060 补充）
 *
 * 覆盖层组件：说明「为什么它没能自动放行」+ 证据 + 台阶选择 + 出处条件勾选。
 * 遵循 ADR-0023 纯横线范式（无角无竖线）、无 emoji、每行 `truncateToWidth` 兜底。
 *
 * 键盘：`↑↓`/`k j` 选台阶 · `Space` 切换「仅限本会话创建的路径」 · `e` 展开证据 ·
 *       `Enter` 采纳 · `d` 忽略 · `Esc` 取消
 *
 * 台阶顶层是「目标根」不是「路径类别」——因此**不需要任何分类学**，
 * 认不出目标根时就不提供第 ③ 级（由调用方按 `promotionLevels` 传入）。
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { bottomBorder, topBorder, type ThemeColors } from '../../../src/tui/helpers.js';
import type { PromotionCandidate } from './promotion.js';
import type { PromotionLevel } from './promotion-adopt.js';

const LEVEL_LABEL: Record<PromotionLevel, string> = {
	leaf: '具体路径',
	parent: '父目录',
	root: '目标根',
};

export type PromotionCardResult =
	| { action: 'adopt'; level: PromotionLevel; requireProvenance: boolean }
	| { action: 'ignore' }
	| { action: 'cancel' };

export class PromotionCard implements Component {
	private cursor = 0;
	/** 默认勾选（ADR-0060 补充：这是范围扩大后唯一的护栏） */
	private requireProvenance = true;
	private showEvidence = false;

	constructor(
		private readonly candidate: PromotionCandidate,
		private readonly levels: Array<{ level: PromotionLevel; path: string }>,
		private readonly colors: ThemeColors,
		private readonly done: (result: PromotionCardResult) => void,
	) {}

	get hasProvenanceCondition(): boolean {
		return this.requireProvenance;
	}

	/** pi-tui Component 接口要求；本卡片的渲染不缓存内部状态，无操作 */
	invalidate(): void {}

	handleInput(data: string): void {
		switch (data) {
			case '\x1b[A':
			case 'k':
				this.cursor = Math.max(0, this.cursor - 1);
				return;
			case '\x1b[B':
			case 'j':
				this.cursor = Math.min(this.levels.length - 1, this.cursor + 1);
				return;
			case ' ':
				this.requireProvenance = !this.requireProvenance;
				return;
			case 'e':
				this.showEvidence = !this.showEvidence;
				return;
			case '\r':
			case '\n': {
				const level = this.levels[this.cursor];
				if (level) {
					this.done({
						action: 'adopt',
						level: level.level,
						requireProvenance: this.requireProvenance,
					});
				}
				return;
			}
			case 'd':
				this.done({ action: 'ignore' });
				return;
			case '\x1b':
			case 'q':
				this.done({ action: 'cancel' });
				return;
		}
	}

	render(width: number): string[] {
		const c = this.colors;
		const boxWidth = Math.min(Math.max(20, width - 4), 100);
		const contentW = Math.max(0, boxWidth - 4);
		const boxLine = (content: string): string => '  ' + truncateToWidth(content, contentW);
		const pad = (line: string): string =>
			line + ' '.repeat(Math.max(0, width - visibleWidth(line)));

		const e = this.candidate.evidence;
		const lines: string[] = [];

		lines.push(pad(c.dim(topBorder('── 提升建议 ', boxWidth))));
		lines.push(
			pad(
				boxLine(
					`${c.bold(this.candidate.tool)} 已被你人工放行 ${e.sessionManual} 次，但从未自动放行`,
				),
			),
		);
		lines.push(pad(boxLine(c.dim(`目标：${this.candidate.dir}`))));
		lines.push(pad('  ' + c.dim(bottomBorder(contentW))));

		lines.push(pad(boxLine(c.bold('把信任范围提到哪一级？'))));
		this.levels.forEach((l, i) => {
			const marker = i === this.cursor ? c.cyan('>') : ' ';
			const isDefault = i === 0 ? c.dim('（默认）') : '';
			lines.push(pad(boxLine(`${marker} ${isDefault}${LEVEL_LABEL[l.level]}：${l.path}`)));
		});

		const box = this.requireProvenance ? c.green('[x]') : '[ ]';
		const warn = this.requireProvenance ? '' : c.yellow(' ← 放宽：将允许删任何目标');
		lines.push(pad(boxLine(`${box} 仅限本会话创建的路径${warn}`)));

		if (this.showEvidence) {
			lines.push(
				pad(boxLine(c.dim(`本会话：人工 ${e.sessionManual} / 自动 ${e.sessionAuto}`))),
			);
			lines.push(
				pad(
					boxLine(
						c.dim(
							`历史：${e.historyDirectories} 目录 / ${e.historySessions} 会话 / ${e.userDenials} 次用户拒绝`,
						),
					),
				),
			);
			lines.push(
				pad(
					boxLine(
						c.dim(`计数键：${this.candidate.key}（维度 ${this.candidate.dimension}）`),
					),
				),
			);
		} else {
			lines.push(pad(boxLine(c.dim('e 展开证据（本会话次数 / 历史范围 / 拒绝记录）'))));
		}

		lines.push(pad(c.dim(bottomBorder(boxWidth))));
		lines.push(
			pad(boxLine(c.dim('Enter 采纳  Space 切换条件  ↑↓ 选台阶  e 证据  d 忽略  Esc 取消'))),
		);

		// 安全网：任何一行都不得超出终端宽度（AGENTS.md）
		return lines.map((l) => truncateToWidth(l, width));
	}
}
