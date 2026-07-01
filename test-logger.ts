import { createLogger } from "@zenone/pi-logger";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const log = createLogger("test");

export default function factory(): ExtensionAPI {
	return {
		name: "test-logger",
		hooks: {
			async onActivate(ctx): Promise<void> {
				log.info("测试消息: pi-logger 加载成功");
			},
		},
	};
}
