/**
 * Auto-Stage on Exit Extension
 *
 * Records the git status snapshot when the session starts and stages files that
 * are changed by the time the session exits. This avoids auto-commits and
 * only stages paths that changed after the session began.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildStatusSnapshot, findChangedPaths } from "./auto-stage-on-exit-lib.js";

interface SnapshotEntry {
	path: string;
	status: string;
	hash?: string;
}

interface Snapshot {
	entries: SnapshotEntry[];
}

let baselineSnapshot: Snapshot | null = null;

async function captureSnapshot(pi: ExtensionAPI): Promise<Snapshot | null> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	if (code !== 0) {
		return null;
	}

	if (!stdout.trim()) {
		return { entries: [] };
	}

	return buildStatusSnapshot(stdout);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		baselineSnapshot = await captureSnapshot(pi);

		if (ctx.hasUI && baselineSnapshot && baselineSnapshot.entries.length > 0) {
			ctx.ui.notify(`Auto-stage ready: ${baselineSnapshot.entries.length} dirty path(s) tracked`, "info");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const currentSnapshot = await captureSnapshot(pi);
		if (!baselineSnapshot || !currentSnapshot) {
			baselineSnapshot = null;
			return;
		}

		const changedPaths = findChangedPaths(baselineSnapshot, currentSnapshot);
		if (changedPaths.length === 0) {
			baselineSnapshot = null;
			return;
		}

		const { code } = await pi.exec("git", ["add", "--", ...changedPaths]);
		if (code === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-staged ${changedPaths.length} file(s) on exit`, "info");
		} else if (ctx.hasUI) {
			ctx.ui.notify("Auto-stage failed to update the git index", "error");
		}

		baselineSnapshot = null;
	});
}
