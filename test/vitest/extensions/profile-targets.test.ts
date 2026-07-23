/**
 * profile-targets — 单元测试
 *
 * 验证从 sync-profiles.yaml / .pi-sync-config.json 中解析扩展所属目标目录的逻辑。
 * 作为 extension-dev-final-sync 的独立模块，用于替代内置的 resolveSyncTargets 逻辑。
 */
import { describe, it, expect } from 'vitest';

// ── 纯函数：解析 YAML/JSON 配置，返回 extName → targets 映射 ─────────

interface ProfileEntry {
	target: string;
	extensions: string[] | '*';
	exclude?: Record<string, string[]>;
}

type ProfileMap = Record<string, ProfileEntry>;

/**
 * 根据 profile 配置，确定指定扩展名应同步到的目标根目录列表。
 *
 * 策略：
 * 1. 扩展出现在某个 profile 的 extensions 列表中（或 profiles 用 *）→ 加入该 profile 的 target
 * 2. 扩展出现在 exclude 列表中 → 从目标列表中移除
 * 3. 如果没有任何 profile 匹配 → 返回默认 [projectCwd + '/.pi/extensions']（由调用方处理）
 */

interface YamlProfilesConfig {
	profiles?: Record<
		string,
		{
			description?: string;
			target: string;
			extensions: string[] | '*';
			exclude?: Record<string, string[]>;
		}
	>;
}

/** 已知的关键字（不是 profile 名） */
const KNOWN_FIELD_KEYS = new Set([
	'description',
	'target',
	'extensions',
	'skills',
	'themes',
	'prompts',
	'exclude',
	'npmBuild',
]);

/** 简易 YAML 解析器（仅支持本工具需要的键值对格式，无需 js-yaml 依赖） */
function parseSimpleYaml(raw: string): YamlProfilesConfig | null {
	try {
		// 尝试 JSON 解析（兼容 .json 格式）
		return JSON.parse(raw);
	} catch {
		// YAML 解析路径
	}

	const result = { profiles: {} } as Required<YamlProfilesConfig>;
	const profiles = result.profiles;
	const lines = raw.split('\n');

	let currentProfile: string | null = null;
	let currentSection: string | null = null;
	let inExclude = false;
	let excludeType: string | null = null;

	/** 去除行中的 # 注释（支持行尾注释） */
	function stripComment(line: string): string {
		const commentIdx = line.indexOf(' #');
		return commentIdx >= 0 ? line.slice(0, commentIdx) : line;
	}

	/** 去除引号包裹 */
	function stripQuotes(s: string): string {
		return s.replace(/^['"]|['"]$/g, '').trim();
	}

	for (const rawLine of lines) {
		const line = stripComment(rawLine.trim());
		if (!line || line.startsWith('#')) continue;

		// 跳过根级 profiles: 关键字
		if (line === 'profiles:') continue;

		// profile 名检测：以 : 结尾，缩进级在 profiles 之下，不是已知关键字
		const profileName = (() => {
			const m = line.match(/^(\S+):$/);
			if (!m || m[1] === 'profiles') return null;
			if (KNOWN_FIELD_KEYS.has(m[1])) return null;
			return m[1];
		})();
		if (profileName && !line.startsWith('-')) {
			currentProfile = profileName;
			currentSection = null;
			inExclude = false;
			excludeType = null;
			profiles[currentProfile] = { target: '', extensions: [] };
			continue;
		}

		// 子 section（如 exclude: 下的 extensions:）— 先于 fieldMatch，
		// 否则 exclude 内的 extensions: 会被 fieldMatch 吃掉
		const subFieldMatch = line.match(/^(\S+):\s*$/);
		if (
			subFieldMatch &&
			currentProfile &&
			currentSection === 'exclude' &&
			KNOWN_FIELD_KEYS.has(subFieldMatch[1])
		) {
			excludeType = subFieldMatch[1];
			inExclude = true;
			continue;
		}

		// 字段名：target: value 或 extensions: 等
		const fieldMatch = line.match(/^(\S+):\s*(.*)$/);
		if (fieldMatch && currentProfile) {
			const key = fieldMatch[1];
			const val = fieldMatch[2].trim();
			const profile = profiles[currentProfile];

			// 仅处理已知关键字，跳过其他未知的 : 结尾行
			if (!KNOWN_FIELD_KEYS.has(key)) continue;

			if (key === 'target' && val) {
				profile.target = stripQuotes(val);
				continue;
			}

			if (
				(key === 'extensions' ||
					key === 'skills' ||
					key === 'themes' ||
					key === 'prompts') &&
				!val
			) {
				currentSection = key;
				inExclude = false;
				continue;
			}

			if (key === 'exclude' && !val) {
				currentSection = 'exclude';
				inExclude = false;
				continue;
			}

			// inline 值（如 extensions: '*' 或 extensions: ['a', 'b']）
			if (
				(key === 'extensions' ||
					key === 'skills' ||
					key === 'themes' ||
					key === 'prompts') &&
				val
			) {
				if (val === "'*'" || val === '"*"' || val === '*') {
					profile.extensions = '*';
				} else if (val.startsWith('[') || val.startsWith('- ')) {
					const list = parseListLine(val);
					if (list.length > 0) {
						profile.extensions = list;
					}
				}
			}
			continue;
		}

		//（subFieldMatch 已在前面的 exclude 分支中处理）

		// 列表项：- name
		const listItemMatch = line.match(/^-\s*(.+)$/);
		if (listItemMatch && currentProfile) {
			const name = stripQuotes(listItemMatch[1]);

			if (
				currentSection === 'extensions' ||
				currentSection === 'skills' ||
				currentSection === 'themes' ||
				currentSection === 'prompts'
			) {
				const profile = profiles[currentProfile];
				if (Array.isArray(profile.extensions)) {
					profile.extensions.push(name);
				}
			} else if (inExclude && excludeType) {
				if (!profiles[currentProfile].exclude) {
					profiles[currentProfile].exclude = {};
				}
				if (!profiles[currentProfile].exclude![excludeType]) {
					profiles[currentProfile].exclude![excludeType] = [];
				}
				profiles[currentProfile].exclude![excludeType].push(name);
			}
		}
	}

	// 清理没有 target 的空 profile
	for (const key of Object.keys(profiles)) {
		if (!profiles[key].target) {
			delete profiles[key];
		}
	}

	return Object.keys(profiles).length > 0 ? (result as YamlProfilesConfig) : null;
}

/** 解析内联列表 (['a', 'b'] 或 - a\n - b) */
function parseListLine(line: string): string[] {
	const results: string[] = [];

	// [List] 格式
	if (line.startsWith('[') && line.endsWith(']')) {
		const inner = line.slice(1, -1);
		for (const item of inner.split(',')) {
			const trimmed = item.trim().replace(/^['"]|['"]$/g, '');
			if (trimmed) results.push(trimmed);
		}
	}

	return results;
}

/**
 * 根据 extName 解析目标根目录列表
 *
 * @param extName - 扩展名
 * @param profiles - 从配置解析的 profile 映射
 * @returns 目标根目录列表 + 标签，null 表示无匹配
 */
function resolveFromProfiles(
	extName: string,
	profiles: ProfileMap,
): { roots: string[]; label: string } | null {
	const matchedTargets = new Set<string>();

	for (const [, entry] of Object.entries(profiles)) {
		// 检查 exclude.extensions 排除列表
		const excludeList: string[] = [];
		if (entry.exclude?.extensions) excludeList.push(...entry.exclude.extensions);
		if (excludeList.includes(extName)) continue;

		// 检查是否匹配该 profile
		if (entry.extensions === '*') {
			matchedTargets.add(entry.target);
		} else if (Array.isArray(entry.extensions) && entry.extensions.includes(extName)) {
			matchedTargets.add(entry.target);
		}
	}

	if (matchedTargets.size > 0) {
		const roots = [...matchedTargets].sort();
		const label = roots
			.map((r) => {
				if (r.includes('.pi/agent')) return '用户级 (~/.pi/agent/extensions/)';
				if (r.includes('.pi')) return '项目级 (.pi/extensions/)';
				return r;
			})
			.join('、');
		return { roots, label };
	}

	return null; // 无匹配，由调用方 fallback
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe('parseSimpleYaml', () => {
	const USER_TARGET = '~/.pi/agent';
	const PROJ_TARGET = './.pi';

	it('解析完整 YAML 配置', () => {
		const yaml = [
			'profiles:',
			'  user-install:',
			'    target: ~/.pi/agent',
			'    extensions:',
			'      - selector',
			'      - pi-logger',
			'  project:',
			'    target: ./.pi',
			'    extensions: "*"',
		].join('\n');

		const config = parseSimpleYaml(yaml);
		expect(config).not.toBeNull();
		const p = config! as Required<YamlProfilesConfig>;
		expect(p.profiles['user-install'].target).toBe(USER_TARGET);
		expect(p.profiles['user-install'].extensions).toEqual(['selector', 'pi-logger']);
		expect(p.profiles['project'].target).toBe(PROJ_TARGET);
		expect(p.profiles['project'].extensions).toBe('*');
	});

	it('跳过没有 target 的 profile', () => {
		const yaml = ['profiles:', '  empty:', '    extensions:', '      - foo'].join('\n');

		const config = parseSimpleYaml(yaml);
		expect(config).toBeNull();
	});

	it('解析带 exclude 的配置', () => {
		const yaml = [
			'profiles:',
			'  project:',
			'    target: ./.pi',
			'    extensions: "*"',
			'    exclude:',
			'      extensions:',
			'        - selector',
			'        - pi-logger',
		].join('\n');

		const config = parseSimpleYaml(yaml);
		expect(config).not.toBeNull();
		const p = (config! as Required<YamlProfilesConfig>).profiles['project'];
		expect(p.exclude).toBeDefined();
		expect(p.exclude!.extensions).toContain('selector');
		expect(p.exclude!.extensions).toContain('pi-logger');
	});

	it('忽略注释行', () => {
		const yaml = [
			'profiles:',
			'  test:',
			'    target: ./.pi  # 目标目录',
			'    extensions:',
			'      - foo # 注释在行尾',
		].join('\n');

		const config = parseSimpleYaml(yaml);
		expect(config).not.toBeNull();
		const p = config! as Required<YamlProfilesConfig>;
		expect(p.profiles['test'].target).toBe('./.pi');
		expect(p.profiles['test'].extensions).toContain('foo');
	});

	it('支持 JSON 格式作为备选', () => {
		const json = JSON.stringify({
			profiles: {
				proj: {
					target: './.pi',
					extensions: '*',
				},
			},
		});

		const config = parseSimpleYaml(json);
		expect(config).not.toBeNull();
		const p = config! as Required<YamlProfilesConfig>;
		expect(p.profiles['proj'].target).toBe('./.pi');
		expect(p.profiles['proj'].extensions).toBe('*');
	});

	it('空配置返回 null', () => {
		expect(parseSimpleYaml('')).toBeNull();
		expect(parseSimpleYaml('# only a comment')).toBeNull();
		expect(parseSimpleYaml('\n\n  \n')).toBeNull();
	});
});

describe('resolveFromProfiles', () => {
	it('返回扩展所属 profile 的 target', () => {
		const profiles: ProfileMap = {
			user: { target: '~/.pi/agent', extensions: ['my-ext'] },
		};
		const result = resolveFromProfiles('my-ext', profiles);
		expect(result).not.toBeNull();
		expect(result!.roots).toContain('~/.pi/agent');
	});

	it('通配符 * 匹配所有扩展', () => {
		const profiles: ProfileMap = {
			project: { target: './.pi', extensions: '*' },
		};
		const result = resolveFromProfiles('any-ext', profiles);
		expect(result).not.toBeNull();
		expect(result!.roots).toContain('./.pi');
	});

	it('扩展同时出现在多个 profile 时返回所有目标', () => {
		const profiles: ProfileMap = {
			user: { target: '~/.pi/agent', extensions: ['shared-ext'] },
			project: { target: './.pi', extensions: ['shared-ext'] },
		};
		const result = resolveFromProfiles('shared-ext', profiles);
		expect(result).not.toBeNull();
		expect(result!.roots).toContain('~/.pi/agent');
		expect(result!.roots).toContain('./.pi');
	});

	it('排除在 exclude.extensions 中的扩展不返回该 profile 的目标', () => {
		const profiles: ProfileMap = {
			project: {
				target: './.pi',
				extensions: '*',
				exclude: { extensions: ['excluded-ext'] },
			},
		};
		const result1 = resolveFromProfiles('excluded-ext', profiles);
		expect(result1).toBeNull();

		// 但其他扩展仍匹配
		const result2 = resolveFromProfiles('normal-ext', profiles);
		expect(result2).not.toBeNull();
		expect(result2!.roots).toContain('./.pi');
	});

	it('不在任何 profile 中的扩展返回 null（由调用方 fallback）', () => {
		const profiles: ProfileMap = {
			user: { target: '~/.pi/agent', extensions: ['known-ext'] },
		};
		const result = resolveFromProfiles('unknown-ext', profiles);
		expect(result).toBeNull();
	});
});
