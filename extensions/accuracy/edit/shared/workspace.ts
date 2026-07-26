/**
 * Workspace 接口与实现 — 支持真实文件系统和虚拟文件系统
 */

import { constants } from 'node:fs';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface Workspace {
	readText: (absolutePath: string) => Promise<string>;
	writeText: (absolutePath: string, content: string) => Promise<void>;
	deleteFile: (absolutePath: string) => Promise<void>;
	exists: (absolutePath: string) => Promise<boolean>;
	checkWriteAccess: (absolutePath: string) => Promise<void>;
}

export function createRealWorkspace(): Workspace {
	return {
		readText: (absolutePath) => readFile(absolutePath, 'utf-8'),
		writeText: (absolutePath, content) => writeFile(absolutePath, content, 'utf-8'),
		deleteFile: (absolutePath) => unlink(absolutePath),
		exists: async (absolutePath) => {
			try {
				await access(absolutePath, constants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		checkWriteAccess: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
	};
}

export function createVirtualWorkspace(cwd: string): Workspace {
	const state = new Map<string, string | null>();

	async function ensureLoaded(absolutePath: string): Promise<void> {
		if (state.has(absolutePath)) return;
		try {
			const content = await readFile(absolutePath, 'utf-8');
			state.set(absolutePath, content);
		} catch {
			state.set(absolutePath, null);
		}
	}

	return {
		readText: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			const content = state.get(absolutePath);
			if (content === null || content === undefined) {
				throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, '')}`);
			}
			return content;
		},
		writeText: async (absolutePath, content) => {
			state.set(absolutePath, content);
		},
		deleteFile: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			if (state.get(absolutePath) === null) {
				throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, '')}`);
			}
			state.set(absolutePath, null);
		},
		exists: async (absolutePath) => {
			await ensureLoaded(absolutePath);
			return state.get(absolutePath) !== null;
		},
		checkWriteAccess: async () => {
			// No-op for virtual workspace
		},
	};
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function resolvePatchPath(cwd: string, filePath: string): string {
	const trimmed = filePath.trim();
	if (!trimmed) {
		throw new Error('Patch path cannot be empty');
	}
	return trimmed.startsWith('/') ? resolve(trimmed) : resolve(cwd, trimmed);
}

export function ensureTrailingNewline(content: string): string {
	return content.endsWith('\n') ? content : `${content}\n`;
}

export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize('NFKC')
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

export function isAbsolute(p: string): boolean {
	return p.startsWith('/');
}
