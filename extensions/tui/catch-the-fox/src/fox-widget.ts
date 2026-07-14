import { createLogger } from "@zenone/pi-logger";
import {
	ANIMS,
	FOX_WIDTH,
	PALETTE,
	scaleGrid,
	type FoxState,
	type RGB,
} from "./fox-art.js";
import { FoxRunMotion, renderRunGrid } from "./fox-run-motion.js";

const log = createLogger("catch-the-fox:fox-widget");

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const fg = ([r, g, b]: RGB) => `${ESC}38;2;${r};${g};${b}m`;
const bg = ([r, g, b]: RGB) => `${ESC}48;2;${r};${g};${b}m`;

export function gridToAnsi(
	grid: string[],
	maximumWidth = Number.POSITIVE_INFINITY,
): string[] {
	const lines: string[] = [];
	for (let row = 0; row < grid.length; row += 2) {
		const top = grid[row];
		const bottom = grid[row + 1] ?? ".".repeat(top.length);
		const width = Math.min(
			top.length,
			Number.isFinite(maximumWidth)
				? Math.max(0, Math.floor(maximumWidth))
				: top.length,
		);
		let line = "";
		for (let column = 0; column < width; column++) {
			const topColor = top[column] === "." ? null : PALETTE[top[column]];
			const bottomColor =
				bottom[column] === "." ? null : PALETTE[bottom[column]];
			if (!topColor && !bottomColor) {
				line += `${RESET} `;
			} else if (topColor && bottomColor) {
				line += `${fg(topColor)}${bg(bottomColor)}▀`;
			} else if (topColor) {
				line += `${RESET}${fg(topColor)}▀`;
			} else {
				line += `${RESET}${fg(bottomColor as RGB)}▄`;
			}
		}
		lines.push(`${line}${RESET}`);
	}
	return lines;
}

function isBlankRow(row: string): boolean {
	return /^\.*$/.test(row);
}

function trimLeadingBlankRows(grids: string[][]): string[][] {
	let blankRows = Infinity;
	for (const grid of grids) {
		let count = 0;
		while (count < grid.length && isBlankRow(grid[count])) count += 1;
		blankRows = Math.min(blankRows, count);
	}
	if (!Number.isFinite(blankRows) || blankRows <= 0) return grids;
	const evenBlankRows = blankRows - (blankRows % 2);
	if (evenBlankRows <= 0) return grids;
	return grids.map((grid) => grid.slice(evenBlankRows));
}

const TRIMMED_GRIDS = Object.fromEntries(
	Object.entries(ANIMS).map(([state, animation]) => [
		state,
		trimLeadingBlankRows(animation.grids),
	]),
) as Record<FoxState, string[][]>;

export class FoxWidget {
	private animationTimer: ReturnType<typeof setInterval> | null = null;
	private frameIndex = 0;
	private hidden = false;
	/** Horizontal offset (cols from left) preserved across state changes. */
	private offset = 0;
	private runMotion = new FoxRunMotion();
	private state: FoxState = "sleep";
	private terminalWidth = FOX_WIDTH;
	private transitionTimer: ReturnType<typeof setTimeout> | null = null;
	private ui: any = null;
	private widgetRegistered = false;
	private widgetTui: any = null;

	constructor(
		private readonly reducedMotion: boolean,
		public scale = 1,
	) {}

	/** Update scale at runtime and trigger re-render. */
	setScale(scale: number): void {
		this.scale = Math.min(1, Math.max(0.1, scale));
		this.render();
	}

	setUI(nextUI: any): void {
		if (this.ui === nextUI) return;
		this.clearWidget();
		this.ui = nextUI;
		this.render();
	}

	setState(nextState: FoxState): void {
		const enteringRun = nextState === "run" && this.state !== "run";
		const leavingRun = this.state === "run" && nextState !== "run";
		this.clearTimers();
		// Preserve horizontal position when leaving run
		if (leavingRun) this.offset = this.runMotion.currentOffset;
		this.state = nextState;
		this.frameIndex = 0;
		if (enteringRun) {
			this.runMotion = new FoxRunMotion(this.offset);
		}
		this.render();
		if (this.hidden) return;

		if (!this.reducedMotion) {
			this.animationTimer = setInterval(() => {
				this.frameIndex += 1;
				if (this.state === "run") {
					this.runMotion.advance(
						this.terminalWidth,
						Math.ceil(FOX_WIDTH * this.scale),
					);
				}
				this.render();
			}, ANIMS[this.state].intervalMs);
			this.animationTimer.unref?.();
		}

		const transition = ANIMS[this.state].once;
		if (transition) {
			this.transitionTimer = setTimeout(
				() => this.setState(transition.then),
				transition.durationMs,
			);
			this.transitionTimer.unref?.();
		}
	}

	completeTurn(): void {
		this.setState("jump");
		this.transitionTimer = setTimeout(() => this.setState("caught"), 1400);
		this.transitionTimer.unref?.();
	}

	hide(): void {
		this.hidden = true;
		this.clearTimers();
		this.render();
	}

	show(): void {
		this.showState(this.state);
	}

	showState(nextState: FoxState): void {
		this.hidden = false;
		this.setState(nextState);
	}

	shutdown(): void {
		this.clearTimers();
		this.clearWidget();
		this.ui = null;
	}

	private clearTimers(): void {
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = null;
		}
		if (this.transitionTimer) {
			clearTimeout(this.transitionTimer);
			this.transitionTimer = null;
		}
	}

	private renderLines = (width: number): string[] => {
		this.terminalWidth = Math.max(0, Math.floor(width));
		const grids = TRIMMED_GRIDS[this.state];
		let grid = grids[this.frameIndex % grids.length];

		// Compute scaled fox width once; used by both run-motion bounds and offset clamping
		const scaledFoxWidth = Math.ceil(FOX_WIDTH * this.scale);

		if (this.state === "run") {
			const placement = this.runMotion.snapshot(
				this.terminalWidth,
				scaledFoxWidth,
			);
			grid = renderRunGrid(grid, placement);
			this.offset = placement.offset;
		}
		// Apply pixel downscale before ANSI conversion
		if (this.scale < 1) {
			grid = scaleGrid(grid, this.scale);
		}
		// Clamp offset so fox doesn't go off-screen
		const maxOffset = Math.max(0, this.terminalWidth - scaledFoxWidth);
		const actualOffset = Math.min(this.offset, maxOffset);

		const frame = gridToAnsi(grid, this.terminalWidth - actualOffset);
		const padding = " ".repeat(actualOffset);
		const label = ` ${ANIMS[this.state].label}`.slice(0, this.terminalWidth);
		return [label, ...frame.map((line) => `${padding}${line}`)];
	};

	private clearWidget(): void {
		if (!this.ui || !this.widgetRegistered) return;
		try {
			this.ui.setWidget("catch-the-fox", undefined);
		} catch (err) {
			log.error("clearWidget: failed to clear widget", err);
		}
		this.widgetRegistered = false;
		this.widgetTui = null;
	}

	private render(): void {
		if (!this.ui) return;
		if (this.hidden) {
			this.clearWidget();
			return;
		}
		if (!this.widgetRegistered) {
			try {
				this.ui.setWidget("catch-the-fox", (tui: any) => {
					this.widgetTui = tui;
					return {
						render: this.renderLines,
						invalidate: () => {
							this.widgetRegistered = false;
							this.widgetTui = null;
						},
					};
				});
				this.widgetRegistered = true;
			} catch (err) {
				log.error("render: failed to register widget", err);
			}
			return;
		}
		try {
			if (this.widgetTui?.requestRender) this.widgetTui.requestRender();
			else this.ui.requestRender?.();
		} catch (err) {
			log.error("render: requestRender failed", err);
		}
	}
}
