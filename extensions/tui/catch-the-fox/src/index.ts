import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANIMS, type FoxState } from "./fox-art.js";
import { FoxWidget } from "./fox-widget.js";

export { gridToAnsi } from "./fox-widget.js";

function stateForTool(toolName: string): FoxState {
	const normalizedToolName = toolName.toLowerCase();
	if (/(read|grep|glob|find|search|ffgrep|list)/.test(normalizedToolName)) {
		return "sniff";
	}
	if (/(edit|write|patch|replace)/.test(normalizedToolName)) {
		return "dig";
	}
	if (/(bash|shell|exec|fetch|web|browser|curl)/.test(normalizedToolName)) {
		return "run";
	}
	return "sniff";
}

export default function catchTheFoxExtension(pi: ExtensionAPI): void {
	pi.registerFlag("fox-reduced-motion", {
		description: "保持狐狸静止，不播放连续动画",
		type: "boolean",
		default: false,
	});

	const fox = new FoxWidget(pi.getFlag("fox-reduced-motion") === true);
	let errorStreak = 0;

	pi.on("session_start", async (_event, context) => {
		fox.setUI(context.ui);
		fox.setState("sleep");
	});

	pi.on("agent_start", async (_event, context) => {
		fox.setUI(context.ui);
		errorStreak = 0;
		fox.setState("sniff");
	});

	pi.on("tool_execution_start", async (event: any, context: any) => {
		fox.setUI(context.ui);
		fox.setState(stateForTool(event.toolName ?? ""));
	});

	pi.on("tool_result", async (event: any, context: any) => {
		fox.setUI(context.ui);
		if (event.isError) {
			errorStreak += 1;
			fox.setState(errorStreak >= 3 ? "sad" : "error");
		} else {
			errorStreak = 0;
		}
	});

	pi.on("agent_end", async (_event, context) => {
		fox.setUI(context.ui);
		if (errorStreak >= 3) {
			fox.setState("sad");
			return;
		}
		fox.completeTurn();
	});

	pi.on("session_shutdown", async () => {
		fox.shutdown();
	});

	pi.registerCommand("fox", {
		description:
			"控制狐狸: /fox <sleep|sniff|dig|run|jump|caught|error|sad|hide|show>",
		handler: async (args, context) => {
			if (!context.hasUI) {
				context.ui.notify("/fox 需要交互模式", "error");
				return;
			}
			fox.setUI(context.ui);
			const requestedState = (args ?? "").trim().toLowerCase();
			if (requestedState === "hide") {
				fox.hide();
				context.ui.notify("狐狸已隐藏 (/fox show 重新显示)", "info");
				return;
			}
			if (requestedState === "show") {
				fox.show();
				context.ui.notify("狐狸回来了！", "info");
				return;
			}
			if (requestedState && requestedState in ANIMS) {
				fox.showState(requestedState as FoxState);
				return;
			}
			context.ui.notify(
				`状态列表: ${Object.keys(ANIMS).join(", ")} · hide · show`,
				"info",
			);
		},
	});
}
