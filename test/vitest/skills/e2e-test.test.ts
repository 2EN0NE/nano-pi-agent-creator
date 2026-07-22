/**
 * e2e-test skill — Vitest 自举测试
 *
 * 验证 e2e-test 技能的基础设施完整性。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT_DIR } from '../helpers/sandbox.js';

describe('e2e-test skill', () => {
	it('skill directory has SKILL.md', () => {
		const skillMd = resolve(ROOT_DIR, '.pi/skills/e2e-test/SKILL.md');
		expect(existsSync(skillMd)).toBe(true);
	});

	it('run-e2e.sh is executable', () => {
		const runner = resolve(ROOT_DIR, 'test/scripts/run-e2e.sh');
		expect(() => accessSync(runner, constants.X_OK)).not.toThrow();
	});

	it('test infrastructure directories exist', () => {
		const dirs = ['test/extensions', 'test/skills', 'test/scripts', 'test/results'];
		for (const dir of dirs) {
			expect(existsSync(resolve(ROOT_DIR, dir))).toBe(true);
		}
	});

	it('run-e2e.sh --help prints usage', async () => {
		const execAsync = promisify(exec);
		const { stdout } = await execAsync('bash test/scripts/run-e2e.sh --help', {
			cwd: ROOT_DIR,
		});
		expect(stdout).toContain('Usage');
	});
});
