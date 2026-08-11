/**
 * @zenone/pi-lab — namespace tests
 */
import { describe, it, expect } from 'vitest';
import { getExperimentManager } from '@zenone/pi-lab';

describe('namespace', () => {
	it('weak dep without namespace uses plain name', () => {
		const mgr = getExperimentManager();
		const exp = mgr.registerWeakExperiment({
			name: 'test-no-ns',
			contextKey: 'global',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});
		const info = exp.info();
		expect(info.name).toBe('test-no-ns');
	});

	it('weak dep with namespace prefixes name', () => {
		const mgr = getExperimentManager();
		const exp = mgr.registerWeakExperiment({
			name: 'routing-strategy',
			namespace: 'smart-context',
			contextKey: 'global',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});
		const info = exp.info();
		expect(info.name).toBe('smart-context::routing-strategy');
	});

	it('same name different namespace do not conflict', () => {
		const mgr = getExperimentManager();
		const exp1 = mgr.registerWeakExperiment({
			name: 'shared-name',
			namespace: 'plugin-a',
			contextKey: 'global',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});
		const exp2 = mgr.registerWeakExperiment({
			name: 'shared-name',
			namespace: 'plugin-b',
			contextKey: 'global',
			arms: [{ id: 'b', label: 'B' }],
			strategy: 'epsilon-greedy',
		});
		expect(exp1.info().name).toBe('plugin-a::shared-name');
		expect(exp2.info().name).toBe('plugin-b::shared-name');
		// Both should be accessible
		expect(mgr.getExperiment('plugin-a::shared-name')).toBeDefined();
		expect(mgr.getExperiment('plugin-b::shared-name')).toBeDefined();
	});
});
