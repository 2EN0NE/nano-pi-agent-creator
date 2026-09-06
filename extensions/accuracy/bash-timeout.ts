/**
 * bash-timeout — 为 bash 工具注入默认超时（macOS 无 GNU timeout 的兜底）
 *
 * macOS 自带的 /bin/bash 没有 GNU coreutils 的 `timeout` 命令，且 Pi 内置
 * bash 工具的 timeout 参数无默认值——agent 不显式传就会无限等待。
 * 本扩展在 tool_call 钩子里，为 agent 调用的 `bash` 工具补一个默认超时，
 * 防止命令无限挂起。
 *
 * 语义（见 ADR-0025）：
 *   - 仅在 agent 未显式指定 timeout 时注入默认值（兜底，而非上限）；
 *   - 仅作用于 tool_call（agent 的 bash 工具），不碰 user_bash；
 *   - 默认 300 秒，经 @zenone/pi-config 双层可配置（defaultTimeoutSeconds）。
 *
 * 采用 tool_call 钩子（与 uv.ts 同构）而非 createBashTool 替换 operations，
 * 以避免与 sandbox 等已接管 bash operations 的扩展冲突。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createConfigStore } from '@zenone/pi-config';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('bash-timeout');

interface BashTimeoutConfig {
	defaultTimeoutSeconds: number;
}

const DEFAULTS: BashTimeoutConfig = {
	defaultTimeoutSeconds: 300,
};

/**
 * 注入默认超时。返回是否发生了注入。
 *
 * 仅当 input.timeout 为空（undefined/null）且默认值 > 0 时注入；
 * agent 显式传的 timeout（含 0）一律尊重，不覆盖。
 */
export function applyDefaultTimeout(
	input: { timeout?: number | null },
	defaultTimeoutSeconds: number,
): boolean {
	if (input.timeout != null) return false;
	if (!(defaultTimeoutSeconds > 0)) return false;
	input.timeout = defaultTimeoutSeconds;
	return true;
}

export default function (pi: ExtensionAPI) {
	const store = createConfigStore<BashTimeoutConfig>({
		pluginName: 'bash-timeout',
		defaults: DEFAULTS,
	});

	pi.on('tool_call', (event) => {
		if (event.toolName !== 'bash') return;

		const input = event.input as { command?: string; timeout?: number | null };
		const config = store.get();

		if (applyDefaultTimeout(input, config.defaultTimeoutSeconds)) {
			log.debug('injected default bash timeout', {
				defaultTimeoutSeconds: config.defaultTimeoutSeconds,
			});
		}
	});
}
