/**
 * File Trigger Extension
 *
 * Watches a trigger file and injects its contents into the conversation.
 * Useful for external systems to send messages to the agent.
 *
 * Usage:
 *   echo "Run the tests" > /tmp/agent-trigger.txt
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("file-trigger");

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const triggerFile = "/tmp/agent-trigger.txt";

		log.info("Starting file watch on %s", triggerFile);
		fs.watch(triggerFile, () => {
			try {
				const content = fs.readFileSync(triggerFile, "utf-8").trim();
				if (content) {
					log.info("Trigger file content detected: %s", content.slice(0, 100));
					pi.sendMessage(
						{
							customType: "file-trigger",
							content: `External trigger: ${content}`,
							display: true,
						},
						{ triggerTurn: true },
					);
					fs.writeFileSync(triggerFile, "");
					log.debug("Trigger file cleared");
				}
			} catch {
				log.debug("Trigger file not ready yet");
			}
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`Watching ${triggerFile}`, "info");
		}
		log.debug("File trigger initialized, watching %s", triggerFile);
	});
}
