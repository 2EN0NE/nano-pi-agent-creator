import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createShortcutsConfig } from '../../../extensions/meta/pi-shortcuts/config.ts';

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
	tmpHome = resolve(tmpdir(), `pi-shortcuts-home-${randomUUID()}`);
	tmpCwd = resolve(tmpdir(), `pi-shortcuts-cwd-${randomUUID()}`);
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
});

afterEach(() => {
	rmSync(tmpHome, { recursive: true, force: true });
	rmSync(tmpCwd, { recursive: true, force: true });
});

function writeUserConfig(obj: object): void {
	const dir = join(tmpHome, '.pi', 'agent', 'extensions-data', 'pi-shortcuts');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'config.json'), JSON.stringify(obj));
}

function writeProjectConfig(obj: object): void {
	const dir = join(tmpCwd, '.pi', 'extensions-data', 'pi-shortcuts');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'config.json'), JSON.stringify(obj));
}

describe('pi-shortcuts config — 双层合并', () => {
	it('无 config 时返回默认值', () => {
		const store = createShortcutsConfig({ cwd: tmpCwd, homeDir: tmpHome });
		expect(store.get()).toEqual({
			prefixKey: 'alt+.',
			paletteOnPrefix: true,
			remap: [],
		});
	});

	it('用户级覆盖默认，未覆盖字段保留默认', () => {
		writeUserConfig({ prefixKey: 'alt+.' });
		const store = createShortcutsConfig({ cwd: tmpCwd, homeDir: tmpHome });
		expect(store.get().prefixKey).toBe('alt+.');
		expect(store.get().paletteOnPrefix).toBe(true);
	});

	it('项目级覆盖用户级', () => {
		writeUserConfig({ prefixKey: 'alt+.' });
		writeProjectConfig({ prefixKey: 'ctrl+shift+space', paletteOnPrefix: false });
		const store = createShortcutsConfig({ cwd: tmpCwd, homeDir: tmpHome });
		expect(store.get()).toEqual({
			prefixKey: 'ctrl+shift+space',
			paletteOnPrefix: false,
			remap: [],
		});
	});

	it('remap 双层合并：项目级数组替换用户级', () => {
		writeUserConfig({ remap: [{ name: 'files', from: ['f', 'o'], to: ['x', 'o'] }] });
		writeProjectConfig({ remap: [{ name: 'continue', from: ['c'], to: ['k'] }] });
		const store = createShortcutsConfig({ cwd: tmpCwd, homeDir: tmpHome });
		expect(store.get().remap).toEqual([{ name: 'continue', from: ['c'], to: ['k'] }]);
	});
});
