/**
 * Permission Gate Extension
 *
 * Intercepts dangerous bash commands (rm -rf, sudo, chmod 777, etc.)
 * and shows a confirmation dialog via the shared @zenone/pi-selector.
 *
 * When the user allows the command, supplementary context is prepended to the bash command.
 * When blocked, the decline info is included in the block reason.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showConfirm } from "@zenone/pi-selector";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("permission-gate");

/** First line of the command, truncated for supplementary message. */
function summarizeCommand(command: string): string {
	const firstLine = command.split("\n")[0].trim();
	return firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
}

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

		if (!isDangerous) return undefined;

		// ── No UI fallback ──────────────────────────────────────────────
		if (!ctx.hasUI) {
			log.warn("Dangerous command blocked (no UI): %s", command.slice(0, 80));
			return {
				block: true,
				reason: `Blocked – no UI to confirm dangerous command.\n\`${summarizeCommand(command)}\``,
			};
		}

		// ── Confirm via shared selector ────────────────────────────────
		const summary = summarizeCommand(command);
		const allowed = await showConfirm(ctx, "⚠️  Dangerous Command", command);

		// ── Supplementary info to LLM ──────────────────────────────────
		if (allowed) {
			log.info("User allowed dangerous command: %s", command.slice(0, 80));
			event.input.command = `echo "✓ User approved: ${summary.replace(/"/g, '\\"')}"\n${command}`;
			return undefined;
		}

		log.info("User blocked dangerous command: %s", command.slice(0, 80));
		return {
			block: true,
			reason: `🛑 User declined dangerous command.\n\`${summary}\``,
		};
	});
}
