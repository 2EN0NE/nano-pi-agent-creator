/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("permission-gate");

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [
		/\brm\s+(-rf?|--recursive)/i,
		/\bsudo\b/i,
		/\b(chmod|chown)\b.*777/i,
	];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") {
			log.debug("Ignoring non-bash tool: %s", event.toolName);
			return undefined;
		}

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));
		log.debug(
			"bash command checked: dangerous=%s, cmd=%s",
			isDangerous,
			command.slice(0, 80),
		);

		if (isDangerous) {
			if (!ctx.hasUI) {
				log.warn("Dangerous command blocked (no UI): %s", command.slice(0, 80));
				return {
					block: true,
					reason: "Dangerous command blocked (no UI for confirmation)",
				};
			}

			log.info(
				"Prompting user to allow dangerous command: %s",
				command.slice(0, 80),
			);
			const choice = await ctx.ui.select(
				`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`,
				["Yes", "No"],
			);

			if (choice !== "Yes") {
				log.info("User blocked dangerous command: %s", command.slice(0, 80));
				return { block: true, reason: "Blocked by user" };
			}
			log.info("User allowed dangerous command");
		}

		return undefined;
	});
}
