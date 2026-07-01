import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("logger-test");

export default function (pi: ExtensionAPI) {
	log.info("logger-test 扩展已加载");

	pi.registerTool({
		name: "logger-test",
		description: "测试 pi-logger 是否正常工作",
		parameters: {
			type: "object",
			properties: {
				message: {
					type: "string",
					description: "要记录的消息内容",
				},
			},
			required: [],
		},
		execute(toolCallId, params) {
			const msg = (params as { message?: string }).message || "默认测试消息";

			log.trace("trace 级别: %s", msg);
			log.debug("debug 级别: %s", msg);
			log.info("info 级别: %s", msg);
			log.warn("warn 级别: %s", msg);
			log.error("error 级别: %s", msg);
			log.info("附加结构化数据", { toolCallId, message: msg, timestamp: Date.now() });

			return `已记录 6 条日志 (trace/debug/info/warn/error + 结构化数据) — 消息: "${msg}"`;
		},
	});
}
