/**
 * @zenone/pi-lab 公共 API
 *
 * 消费方插件从这里导入类型和工厂函数。
 *
 * 用法（方案 B — 强依赖）：
 *   import { getExperimentManager } from '@zenone/pi-lab';
 *   const mgr = getExperimentManager();
 *   const exp = mgr.registerStrongExperiment({ name: 'my-exp', ... });
 *
 * 用法（方案 A — 弱依赖，通过 globalThis.__labApi 桥接）：
 *   const mgr = (globalThis as any).__labApi?.getExperimentManager?.();
 *   const exp = mgr?.registerWeakExperiment({ name: 'my-exp', ... });
 */

import { ExperimentManager as _ExperimentManager } from './core/experiment-manager.js';
import { getExperimentManager as _getExperimentManager } from './core/manager.js';

export const ExperimentManager = _ExperimentManager;
export const getExperimentManager = _getExperimentManager;
export type {
	ArmDef,
	ArmState,
	BanditStrategy,
	ConflictEvent,
	ContextKeyFn,
	ExperimentAPI,
	ExperimentDef,
	Outcome,
	RegistrationSource,
} from './types.js';
