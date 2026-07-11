/**
 * Dirty Repo Guard Extension
 *
 * Prevents session changes when there are uncommitted git changes.
 * Useful to ensure work is committed before switching context.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { showSelect } from "@zenone/pi-selector";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("dirty-repo-guard");

async function checkDirtyRepo(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: string,
): Promise<{ cancel: boolean } | undefined> {
	// Check for uncommitted changes
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);

	if (code !== 0) {
		log.debug("Not a git repo (code=%s), allowing %s", code, action);
		return;
	}

	const hasChanges = stdout.trim().length > 0;
	log.debug("Git changes detected: %s, action=%s", hasChanges, action);
	if (!hasChanges) {
		return;
	}

	if (!ctx.hasUI) {
		log.warn("Blocking %s: dirty repo in non-interactive mode", action);
		return { cancel: true };
	}

	// Count changed files
	const changedFiles = stdout.trim().split("\n").filter(Boolean).length;

	log.info(
		"Prompting user: %d uncommitted file(s), action=%s",
		changedFiles,
		action,
	);
	const choice = await showSelect(
		ctx,
		`You have ${changedFiles} uncommitted file(s). ${action} anyway?`,
		[
			{ value: "proceed", label: "Yes, proceed anyway" },
			{ value: "cancel", label: "No, let me commit first" },
		],
	);

	if (choice?.value !== "proceed") {
		ctx.ui.notify("Commit your changes first", "warning");
		log.info(
			"User cancelled %s due to dirty repo (%d files)",
			action,
			changedFiles,
		);
		return { cancel: true };
	}
	log.info(
		"User proceeded with %s despite %d dirty files",
		action,
		changedFiles,
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_switch", async (event, ctx) => {
		const action = event.reason === "new" ? "new session" : "switch session";
		log.debug("session_before_switch: action=%s", action);
		return checkDirtyRepo(pi, ctx, action);
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		log.debug("session_before_fork");
		return checkDirtyRepo(pi, ctx, "fork");
	});
}
