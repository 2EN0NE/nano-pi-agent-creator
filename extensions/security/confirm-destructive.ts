/**
 * Confirm Destructive Actions Extension
 *
 * Prompts for confirmation before destructive session actions (clear, switch, branch).
 * Demonstrates how to cancel session events using the before_* events.
 */

import type {
	ExtensionAPI,
	SessionBeforeSwitchEvent,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { showConfirm, showSelect } from "@zenone/pi-selector";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("confirm-destructive");

export default function (pi: ExtensionAPI) {
	pi.on(
		"session_before_switch",
		async (event: SessionBeforeSwitchEvent, ctx) => {
			log.debug(
				"session_before_switch: reason=%s, hasUI=%s",
				event.reason,
				ctx.hasUI,
			);
			if (!ctx.hasUI) return;

			if (event.reason === "new") {
				log.info("Prompting user to confirm new session (clear)");
				const confirmed = await showConfirm(
					ctx,
					"Clear session?",
					"This will delete all messages in the current session.",
				);

				if (!confirmed) {
					ctx.ui.notify("Clear cancelled", "info");
					log.info("User cancelled clear session");
					return { cancel: true };
				}
				log.info("User confirmed clear session");
				return;
			}

			// reason === "resume" - check if there are unsaved changes (messages since last assistant response)
			const entries = ctx.sessionManager.getEntries();
			const hasUnsavedWork = entries.some(
				(e): e is SessionMessageEntry =>
					e.type === "message" && e.message.role === "user",
			);
			log.debug("reason=resume, hasUnsavedWork=%s", hasUnsavedWork);

			if (hasUnsavedWork) {
				log.info(
					"Unsaved work detected, prompting user for switch confirmation",
				);
				const confirmed = await showConfirm(
					ctx,
					"Switch session?",
					"You have messages in the current session. Switch anyway?",
				);

				if (!confirmed) {
					ctx.ui.notify("Switch cancelled", "info");
					log.info("User cancelled session switch due to unsaved work");
					return { cancel: true };
				}
				log.info("User confirmed session switch with unsaved work");
			}
		},
	);

	pi.on("session_before_fork", async (event, ctx) => {
		log.debug(
			"session_before_fork: entryId=%s, hasUI=%s",
			event.entryId?.slice(0, 8),
			ctx.hasUI,
		);
		if (!ctx.hasUI) return;

		const choice = await showSelect(
			ctx,
			`Fork from entry ${event.entryId.slice(0, 8)}?`,
			[
				{ value: "yes", label: "Yes, create fork" },
				{ value: "no", label: "No, stay in current session" },
			],
		);

		if (choice?.value !== "yes") {
			ctx.ui.notify("Fork cancelled", "info");
			log.info("User cancelled fork from entry %s", event.entryId.slice(0, 8));
			return { cancel: true };
		}
		log.info("User confirmed fork from entry %s", event.entryId.slice(0, 8));
	});
}
