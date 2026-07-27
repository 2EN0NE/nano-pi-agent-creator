import { createConfigStore, loadLayeredConfig } from '@zenone/pi-config';
import type { ConfigStore } from '@zenone/pi-config';
import { DEFAULT_PLUGIN_CONFIG, PLUGIN_NAME, type TodoPluginConfig } from './types.js';

let store: ConfigStore<TodoPluginConfig> | null = null;

export function getConfigStore(): ConfigStore<TodoPluginConfig> {
	if (!store) {
		store = createConfigStore<TodoPluginConfig>({
			pluginName: PLUGIN_NAME,
			defaults: DEFAULT_PLUGIN_CONFIG,
		});
	}
	return store;
}

/** One-shot load without cache. */
export function loadConfig(): TodoPluginConfig {
	const result = loadLayeredConfig<TodoPluginConfig>({
		pluginName: PLUGIN_NAME,
		defaults: DEFAULT_PLUGIN_CONFIG,
	});
	return result.config ?? DEFAULT_PLUGIN_CONFIG;
}

export function getConfig(): TodoPluginConfig {
	return getConfigStore().get();
}

export function saveConfig(config: Partial<TodoPluginConfig>): void {
	const store = getConfigStore();
	const merged = { ...store.get(), ...config };
	store.save(merged, 'user');
}

export function updateConfig(key: keyof TodoPluginConfig, value: unknown): void {
	const store = getConfigStore();
	const current = { ...store.get() };
	const dict = current as unknown as Record<string, unknown>;
	dict[key] = value;
	store.save(dict as unknown as TodoPluginConfig, 'user');
}

export function reloadConfig(): void {
	getConfigStore().reload();
}
