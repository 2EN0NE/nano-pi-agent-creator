// org — agent-manifest 解析与校验（ticket 01）
// 约定：agent 目录根放 `pi.agent.json`（轻量元数据入口），身份正文仍用 AGENTS.md。
// 缺失/非法 → 降级：name=目录 basename、role=member（目录仍可加入 org，只是无自述）。
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AgentManifest, AgentRole } from './types.js';
import { readJson } from './util.js';

export const MANIFEST_FILE = 'pi.agent.json';

/** 目录 basename 作为默认名；对非法名降级为目录 hash 尾缀 */
function fallbackName(dir: string): string {
	const base = path.basename(dir) || 'agent';
	const safe = base.replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 64);
	return safe || `agent_${Math.abs(hashOf(dir)) % 100000}`;
}

function hashOf(value: string): number {
	let h = 0;
	for (let i = 0; i < value.length; i++) {
		h = (h * 31 + value.charCodeAt(i)) | 0;
	}
	return h;
}

/** 宽松校验单个 manifest（不抛错，非法字段丢弃） */
export function normalizeManifest(raw: unknown, dir: string): AgentManifest {
	const obj =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const fallback = fallbackName(dir);
	const name =
		typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 64) : fallback;
	const role: AgentRole = obj.role === 'chief' ? 'chief' : 'member';
	const manifest: AgentManifest = {
		name,
		role,
		label: typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : name,
	};
	if (typeof obj.description === 'string' && obj.description.trim()) {
		manifest.description = obj.description.trim();
	}
	if (Array.isArray(obj.tools) && obj.tools.every((t) => typeof t === 'string')) {
		manifest.tools = (obj.tools as string[]).slice(0, 50);
	}
	if (obj.sandbox && typeof obj.sandbox === 'object') {
		// SAFETY: 仅透传声明性配置，org 不解释其内容
		manifest.sandbox = obj.sandbox as Record<string, unknown>;
	}
	if (typeof obj.memory === 'string') manifest.memory = obj.memory;
	if (typeof obj.chief === 'string' && obj.chief.trim()) manifest.chief = obj.chief.trim();
	return manifest;
}

/** 读目录的 agent manifest（缺失/解析失败返回 null） */
export async function loadManifest(dir: string): Promise<AgentManifest | null> {
	const file = path.join(dir, MANIFEST_FILE);
	const raw = await readJson<unknown>(file);
	if (raw === null) return null;
	try {
		return normalizeManifest(raw, dir);
	} catch {
		return null;
	}
}

/** 目录是否具备 manifest 文件（文件系统级判断，不含降级） */
export async function hasManifestFile(dir: string): Promise<boolean> {
	try {
		await fs.access(path.join(dir, MANIFEST_FILE));
		return true;
	} catch {
		return false;
	}
}
