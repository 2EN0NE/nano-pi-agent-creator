/**
 * pi-lab 全局单例
 *
 * 独立模块避免循环依赖：
 *   api.ts → manager.ts (✓)
 *   index.ts → manager.ts (✓)
 *   api.ts ↛ index.ts (✓)
 */

import { ExperimentManager } from './experiment-manager.js';

const manager = new ExperimentManager();

export function getExperimentManager(): ExperimentManager {
	return manager;
}
