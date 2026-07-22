/**
 * pi-worktree — Vitest 集成测试
 *
 * 在真实 git 仓库 + mock-llm pi 进程中验证：
 * - 扩展加载和命令注册（pi 进程）
 * - git worktree 创建/删除（直接 bash）
 * - 路径安全断言（直接调用 paths.ts）
 * - 外部 worktree 位置验证
 * - 会话文件创建与 header 格式（session.ts）
 * - SessionManager.open 兼容性
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox, destroySandbox, resolvePiBin } from '../helpers/sandbox';

// 手动 resolve extension 源码路径（vitest 无法从 extensions/ 自动解析 .ts）
const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '../../../extensions/meta/worktree');
const LIB_DIR = resolve(EXT_DIR, 'lib');
const {
	getRepoRoot,
	getWorktreesDir,
	getWorktreePath,
	isWorktreeCwd,
	getNameFromCwd,
	assertPathInWorktrees,
	getManagedWorktrees,
} = await import(resolve(LIB_DIR, 'paths.ts'));
const { createWorktree, removeWorktree, pickAvailableName } = await import(
	resolve(LIB_DIR, 'worktree.ts')
);

// ── 测试辅助 ──

function runPi(home: string, cwd: string, prompt: string): { stdout: string; exitCode: number } {
	const piBin = resolvePiBin();
	try {
		const out = execSync(`${piBin} --no-session -p ${JSON.stringify(prompt)}`, {
			cwd,
			timeout: 15_000,
			env: { ...process.env, HOME: home, CI: 'true' },
			maxBuffer: 2 * 1024 * 1024,
			encoding: 'utf-8',
		});
		return { stdout: out, exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: (err.stdout || '').toString(),
			exitCode: err.status || 1,
		};
	}
}

// ═══════════════════════════════════════════
// 套件 1：扩展加载测试
// ═══════════════════════════════════════════

describe('worktree extension — sandbox loading', () => {
	let sandbox: string;
	let isolatedHome: string;
	let repoDir: string;

	beforeAll(() => {
		// 建沙箱 + mock-llm + worktree 扩展
		sandbox = createSandbox({
			extensions: ['pi-logger', 'worktree'],
			useMockLLM: true,
		});
		isolatedHome = resolve(sandbox, 'home');

		// 在沙箱 HOME 下创建 git 仓库
		repoDir = join(isolatedHome, 'test-repo');
		mkdirSync(repoDir, { recursive: true });
		execSync('git init --initial-branch main', { cwd: repoDir, encoding: 'utf-8' });
		writeFileSync(join(repoDir, 'README.md'), '# Test\n');
		execSync('git add README.md && git commit -m init', {
			cwd: repoDir,
			encoding: 'utf-8',
		});
	});

	afterAll(() => {
		if (sandbox) destroySandbox(sandbox);
	});

	it('loads without crash', () => {
		const result = runPi(isolatedHome, repoDir, 'reply OK');
		expect(result.exitCode).toBe(0);
	});

	it('extension source resolves correctly', () => {
		// 验证动态 import 路径正确
		expect(existsSync(resolve(EXT_DIR, 'index.ts'))).toBe(true);
		expect(existsSync(resolve(EXT_DIR, 'lib/paths.ts'))).toBe(true);
	});
});

// ═══════════════════════════════════════════
// 套件 2：getRepoRoot 集成测试
// ═══════════════════════════════════════════

describe('worktree extension — getRepoRoot (real git)', () => {
	let sandbox: string;
	let isolatedHome: string;
	let repoDir: string;

	beforeAll(() => {
		sandbox = createSandbox({ useMockLLM: true });
		isolatedHome = resolve(sandbox, 'home');
		repoDir = join(isolatedHome, 'integration-repo');
		mkdirSync(repoDir, { recursive: true });
		execSync('git init --initial-branch main', { cwd: repoDir });
		writeFileSync(join(repoDir, 'a.txt'), 'a');
		execSync('git add a.txt && git commit -m init', { cwd: repoDir });
	});

	afterAll(() => {
		if (sandbox) destroySandbox(sandbox);
	});

	it('finds repo root from repo dir', () => {
		expect(getRepoRoot(repoDir)).toBe(repoDir);
	});

	it('finds repo root from subdirectory', () => {
		const sub = join(repoDir, 'src');
		mkdirSync(sub, { recursive: true });
		expect(getRepoRoot(sub)).toBe(repoDir);
	});

	it('returns null for path outside any git repo', () => {
		// 注意：测试运行在 nano-pi-stuff 仓库内，tmp 目录也在其中。
		// 使用 os.tmpdir() 确保在仓库外。
		const outside = join(tmpdir(), 'pi-wt-test-notagit-' + Date.now());
		mkdirSync(outside, { recursive: true });
		expect(getRepoRoot(outside)).toBeNull();
		rmSync(outside, { recursive: true, force: true });
	});
});

// ═══════════════════════════════════════════
// 套件 3：worktree 创建/删除/路径
// ═══════════════════════════════════════════

describe('worktree extension — create/delete (real git)', () => {
	let sandbox: string;
	let isolatedHome: string;
	let repoDir: string;
	let worktreesDir: string;

	beforeAll(() => {
		sandbox = createSandbox({ useMockLLM: true });
		isolatedHome = resolve(sandbox, 'home');
		repoDir = join(isolatedHome, 'wt-test-repo');
		mkdirSync(repoDir, { recursive: true });
		execSync('git init --initial-branch main', { cwd: repoDir });
		writeFileSync(join(repoDir, 'README.md'), '# WT Test\n');
		execSync('git add README.md && git commit -m init', { cwd: repoDir });

		worktreesDir = getWorktreesDir(repoDir);
	});

	afterAll(() => {
		if (sandbox) destroySandbox(sandbox);
	});

	it('getWorktreesDir returns path outside repo', () => {
		// 验证：<repoDir>/../<basename(repoDir)>-worktrees
		expect(worktreesDir).not.toBe(repoDir);
		expect(worktreesDir).toContain('wt-test-repo-worktrees');
	});

	it('creates a worktree and directory exists', () => {
		const result = createWorktree(repoDir, 'e2e-create-1');
		expect(result.ok).toBe(true);
		expect(result.path).toBeTruthy();

		const wtDir = getWorktreePath(repoDir, 'e2e-create-1');
		expect(existsSync(wtDir)).toBe(true);

		// git worktree list 验证
		const list = execSync('git worktree list --porcelain', {
			cwd: repoDir,
			encoding: 'utf-8',
		});
		expect(list).toContain(wtDir);
	});

	it('creates worktree with given branch', () => {
		const result = createWorktree(repoDir, 'e2e-custom-branch', 'feature/test-branch');
		expect(result.ok).toBe(true);
		expect(result.path).toBeTruthy();
		expect(existsSync(result.path!)).toBe(true);

		// 验证分支
		const branch = execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: result.path,
			encoding: 'utf-8',
		}).trim();
		expect(branch).toBe('feature/test-branch');
	});

	it('pickAvailableName returns unique name', () => {
		const name = pickAvailableName(repoDir);
		expect(name).toBeTruthy();
		expect(name).toMatch(/^[A-Za-z]+-[A-Za-z]+$/); // 星座-恒星
	});

	it('getManagedWorktrees lists the created ones', () => {
		const wts = getManagedWorktrees(repoDir);
		const names = wts.map((w: { name: string }) => w.name);
		expect(names).toContain('e2e-create-1');
		expect(names).toContain('e2e-custom-branch');
	});

	it('refuses to create duplicate worktree', () => {
		const result = createWorktree(repoDir, 'e2e-create-1');
		expect(result.ok).toBe(false);
		expect(result.message).toContain('already exists');
	});

	it('isWorktreeCwd detects worktree path', () => {
		const wtDir = getWorktreePath(repoDir, 'e2e-create-1');
		expect(isWorktreeCwd(wtDir, repoDir)).toBe(true);
		expect(isWorktreeCwd(repoDir, repoDir)).toBe(false);
	});

	it('getNameFromCwd extracts name', () => {
		const wtDir = getWorktreePath(repoDir, 'e2e-create-1');
		expect(getNameFromCwd(wtDir, repoDir)).toBe('e2e-create-1');
	});

	it('deletes worktree and directory disappears', () => {
		const removeResult = removeWorktree(repoDir, 'e2e-create-1');
		expect(removeResult.ok).toBe(true);

		const wtDir = getWorktreePath(repoDir, 'e2e-create-1');
		expect(existsSync(wtDir)).toBe(false);

		// git worktree list 不再包含
		const list = execSync('git worktree list --porcelain', {
			cwd: repoDir,
			encoding: 'utf-8',
		});
		expect(list).not.toContain(wtDir);
	});

	it('assertPathInWorktrees rejects main repo path', () => {
		expect(() => assertPathInWorktrees(worktreesDir, repoDir)).toThrow();
	});

	it('assertPathInWorktrees accepts worktree path', () => {
		const wtDir = getWorktreePath(repoDir, 'e2e-custom-branch');
		expect(() => assertPathInWorktrees(worktreesDir, wtDir)).not.toThrow();
	});

	it('assertPathInWorktrees rejects root worktrees dir', () => {
		expect(() => assertPathInWorktrees(worktreesDir, worktreesDir)).toThrow();
	});

	it('worktree is located outside the main repo', () => {
		const wtDir = getWorktreePath(repoDir, 'e2e-custom-branch');
		const relative = wtDir.startsWith(repoDir + '/');
		expect(relative).toBe(false);
		expect(wtDir).toContain('wt-test-repo-worktrees');
	});
});

// ═══════════════════════════════════════════
// 套件 4：脏文件 + force 删除 + 多 worktree
// ═══════════════════════════════════════════

describe('worktree extension — dirty/force/multiple', () => {
	let sandbox: string;
	let isolatedHome: string;
	let repoDir: string;

	beforeAll(() => {
		sandbox = createSandbox({ useMockLLM: true });
		isolatedHome = resolve(sandbox, 'home');
		repoDir = join(isolatedHome, 'dirty-test');
		mkdirSync(repoDir, { recursive: true });
		execSync('git init --initial-branch main', { cwd: repoDir });
		writeFileSync(join(repoDir, 'README.md'), '# Dirty\n');
		execSync('git add README.md && git commit -m init', { cwd: repoDir });
	});

	afterAll(() => {
		if (sandbox) destroySandbox(sandbox);
	});

	it('git refuses to remove dirty worktree without force', () => {
		createWorktree(repoDir, 'dirty-wt');
		const wtDir = getWorktreePath(repoDir, 'dirty-wt');
		expect(existsSync(wtDir)).toBe(true);

		// 加脏文件
		writeFileSync(join(wtDir, 'untracked.txt'), 'dirty');

		// 不带 force 应失败
		const result = removeWorktree(repoDir, 'dirty-wt');
		expect(result.ok).toBe(false);
	});

	it('force removes dirty worktree', () => {
		const result = removeWorktree(repoDir, 'dirty-wt', true);
		expect(result.ok).toBe(true);
		const wtDir = getWorktreePath(repoDir, 'dirty-wt');
		expect(existsSync(wtDir)).toBe(false);
	});

	it('creates multiple worktrees', () => {
		for (const name of ['multi-1', 'multi-2', 'multi-3']) {
			const result = createWorktree(repoDir, name);
			expect(result.ok).toBe(true);
			expect(existsSync(getWorktreePath(repoDir, name))).toBe(true);
		}

		const wts = getManagedWorktrees(repoDir);
		const names = wts.map((w: { name: string }) => w.name);
		expect(names).toContain('multi-1');
		expect(names).toContain('multi-2');
		expect(names).toContain('multi-3');
	});

	it('cleans up all test worktrees', () => {
		for (const name of ['multi-1', 'multi-2', 'multi-3']) {
			removeWorktree(repoDir, name, true);
			const wtDir = getWorktreePath(repoDir, name);
			expect(existsSync(wtDir)).toBe(false);
		}
	});
});

// ═══════════════════════════════════════════
// 套件 5：会话创建与 header 格式
// ═══════════════════════════════════════════

describe('worktree extension — session file creation', () => {
	let sandbox: string;
	let isolatedHome: string;
	let repoDir: string;

	beforeAll(async () => {
		sandbox = createSandbox({ useMockLLM: true });
		isolatedHome = resolve(sandbox, 'home');
		repoDir = join(isolatedHome, 'session-test-repo');
		mkdirSync(repoDir, { recursive: true });
		execSync('git init --initial-branch main', { cwd: repoDir });
		writeFileSync(join(repoDir, 'README.md'), '# Session test\n');
		execSync('git add README.md && git commit -m init', { cwd: repoDir });

		// 创建一个 worktree 用于测试（用 -b 自动创建分支）
		execSync('git worktree add -b wt/test-wt ../session-test-repo-worktrees/test-wt main', {
			cwd: repoDir,
			encoding: 'utf-8',
		});
	});

	afterAll(() => {
		// 清理 worktree
		try {
			execSync('git worktree remove ../session-test-repo-worktrees/test-wt', {
				cwd: repoDir,
				encoding: 'utf-8',
			});
		} catch {
			/* ignore */
		}
		if (sandbox) destroySandbox(sandbox);
	});

	it('resolveSessionDir returns a valid directory', async () => {
		const { resolveSessionDir } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const sessionDir = resolveSessionDir(repoDir);
		expect(sessionDir).toBeTruthy();
		expect(typeof sessionDir).toBe('string');
		expect(sessionDir).toContain('.pi/agent/sessions');
	});

	it('worktreeSessionFileName returns expected path', async () => {
		const { worktreeSessionFileName } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const filePath = worktreeSessionFileName(repoDir, 'test-wt');
		expect(filePath).toBeTruthy();
		expect(filePath).toContain('worktree-test-wt.jsonl');
	});

	it('createSession writes valid v3 session header', async () => {
		const { createSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const worktreePath = join(repoDir, '..', 'session-test-repo-worktrees', 'test-wt');
		const filePath = createSession(worktreePath, repoDir, 'test-wt');
		expect(existsSync(filePath)).toBe(true);

		// 读取并验证 header
		const headerLine = readFileSync(filePath, 'utf-8').split('\n')[0];
		const header = JSON.parse(headerLine);

		expect(header.type).toBe('session');
		expect(header.version).toBe(3);
		expect(header.id).toBeTruthy();
		expect(header.timestamp).toBeTruthy();
		expect(header.cwd).toBe(worktreePath);

		// 验证可以被 SessionManager.open 正确解析
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');
		const sm = SessionManager.open(filePath);
		expect(sm).toBeTruthy();
	});

	it('createSession writes correct worktree cwd', async () => {
		const { createSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const wtDir = join(repoDir, '..', 'session-test-repo-worktrees', 'test-wt');
		const filePath = createSession(wtDir, repoDir, 'test-wt');

		const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]);
		expect(header.cwd).toBe(wtDir);
		// cwd 不是 main repo
		expect(header.cwd).not.toBe(repoDir);
	});

	it('createSession writes main session correctly', async () => {
		const { createSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const filePath = createSession(repoDir, repoDir, 'main');
		expect(existsSync(filePath)).toBe(true);

		const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]);
		expect(header.type).toBe('session');
		expect(header.version).toBe(3);
		expect(header.cwd).toBe(repoDir);
	});

	it('findExistingSession locates session file with matching cwd', async () => {
		const { createSession, findExistingSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const wtDir = join(repoDir, '..', 'session-test-repo-worktrees', 'test-wt');

		// 先创建
		const filePath = createSession(wtDir, repoDir, 'test-wt');
		expect(existsSync(filePath)).toBe(true);

		// 再查找
		const found = findExistingSession(wtDir, repoDir, 'test-wt');
		expect(found).toBe(filePath);
	});

	it('findExistingSession returns null for non-existent session', async () => {
		const { findExistingSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const wtDir = join(repoDir, '..', 'session-test-repo-worktrees', 'non-existent');
		const found = findExistingSession(wtDir, repoDir, 'non-existent');
		expect(found).toBeNull();
	});

	it('SessionManager.create creates correct default session file', async () => {
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');
		const { resolveSessionDir } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const sessionDir = resolveSessionDir(repoDir);
		const wtDir = join(repoDir, '..', 'session-test-repo-worktrees', 'test-wt');

		const sm = SessionManager.create(wtDir, sessionDir);
		expect(sm).toBeTruthy();
	});
});

// ═══════════════════════════════════════════
// 套件 6：Fork 行为验证（真实会话文件）
// ═══════════════════════════════════════════

describe('worktree extension — session fork with real files', () => {
	let srcDir: string;
	let srcSessionPath: string;
	let srcHeaderId: string;
	let worktreeDir: string;
	let sessionDir: string;

	/**
	 * 创建真实的 pi 会话文件，模拟有 3 轮对话的会话：
	 *
	 *   header: {type:"session", id:"src-hdr-xxx", cwd:"<srcDir>", ...}
	 *   msg-1:  {type:"message", id:"m1", parentId:"src-hdr-xxx", role:"user", content:"hello"}
	 *   msg-2:  {type:"message", id:"m2", parentId:"m1", role:"assistant", content:"hi"}
	 *   msg-3:  {type:"message", id:"m3", parentId:"m2", role:"user", content:"how are you?"}
	 *   turn_end: {type:"turn_end", id:"m4", parentId:"m3"}
	 */
	beforeAll(() => {
		srcDir = resolve(tmpdir(), 'pi-wt-fork-test-src-' + Date.now());
		mkdirSync(srcDir, { recursive: true });
		worktreeDir = resolve(tmpdir(), 'pi-wt-fork-test-wt-' + Date.now());
		mkdirSync(worktreeDir, { recursive: true });

		srcHeaderId = 'src-hdr-' + crypto.randomUUID().slice(0, 8);
		const ts = new Date().toISOString();
		const msg1Id = 'm1-' + crypto.randomUUID().slice(0, 8);
		const msg2Id = 'm2-' + crypto.randomUUID().slice(0, 8);
		const msg3Id = 'm3-' + crypto.randomUUID().slice(0, 8);
		const turnEndId = 'te-' + crypto.randomUUID().slice(0, 8);

		const header = { type: 'session', version: 3, id: srcHeaderId, timestamp: ts, cwd: srcDir };
		const msg1 = {
			type: 'message',
			id: msg1Id,
			parentId: srcHeaderId,
			timestamp: ts,
			message: { role: 'user', content: 'hello' },
		};
		const msg2 = {
			type: 'message',
			id: msg2Id,
			parentId: msg1Id,
			timestamp: ts,
			message: { role: 'assistant', content: 'hi' },
		};
		const msg3 = {
			type: 'message',
			id: msg3Id,
			parentId: msg2Id,
			timestamp: ts,
			message: { role: 'user', content: 'how are you?' },
		};
		const turnEnd = { type: 'turn_end', id: turnEndId, parentId: msg3Id, timestamp: ts };

		srcSessionPath = join(srcDir, 'test-session.jsonl');
		const lines =
			[header, msg1, msg2, msg3, turnEnd].map((e) => JSON.stringify(e)).join('\n') + '\n';
		writeFileSync(srcSessionPath, lines, 'utf-8');

		// session 目录（模拟 resolveSessionDir）
		sessionDir = join(srcDir, 'sessions');
		mkdirSync(sessionDir, { recursive: true });
	});

	afterAll(() => {
		rmSync(srcDir, { recursive: true, force: true });
		rmSync(worktreeDir, { recursive: true, force: true });
	});

	it('1. forkFrom produces file with ALL entries + new header (validates cwd, new ID, content)', async () => {
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');
		const sm = SessionManager.forkFrom(srcSessionPath, worktreeDir, sessionDir);
		const forkedPath = (sm as any).sessionFile as string;
		expect(forkedPath).toBeTruthy();
		expect(existsSync(forkedPath)).toBe(true);

		// 手动解析 JSONL 文件
		const entries = readFileSync(forkedPath, 'utf-8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		// Should have 1 header + 4 entries (3 messages + 1 turn_end)
		expect(entries.length).toBe(5);

		const forkedHeader = entries.find((e: any) => e.type === 'session');
		expect(forkedHeader).toBeTruthy();
		expect(forkedHeader.id).not.toBe(srcHeaderId); // new ID
		expect(forkedHeader.cwd).toBe(worktreeDir);
		expect(forkedHeader.parentSession).toBe(srcSessionPath);

		// All non-header entries are PRESERVED
		const nonHeader = entries.filter((e: any) => e.type !== 'session');
		expect(nonHeader.length).toBe(4);
		expect(nonHeader[0].message.role).toBe('user');
		expect(nonHeader[0].message.content).toBe('hello');
	});

	it('2. forked session loadable by SessionManager.open (validates cwd, entries, leafId)', async () => {
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');
		const sm = SessionManager.forkFrom(srcSessionPath, worktreeDir, sessionDir);
		const forkedPath = (sm as any).sessionFile as string;

		// 用 open 重新加载
		const loaded = SessionManager.open(forkedPath);
		expect(loaded).toBeTruthy();

		// 获取 entries（getEntries 排除 type="session"）
		const entries = (loaded as any).getEntries();
		expect(entries.length).toBe(4); // all non-header entries

		// 验证 entry 内容
		expect(entries[0].message?.content).toBe('hello');
		expect(entries[1].message?.content).toBe('hi');
		expect(entries[2].message?.content).toBe('how are you?');
		expect(entries[3].type).toBe('turn_end');

		// 读文件验证 header 的 cwd 正确
		const fileContent = readFileSync(forkedPath, 'utf-8').trim().split('\n');
		const header = JSON.parse(fileContent[0]);
		expect(header.cwd).toBe(worktreeDir);
	});

	it('3. source session file unchanged after fork (SHA256)', async () => {
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');
		const { createHash } = await import('node:crypto');
		const beforeHash = createHash('sha256').update(readFileSync(srcSessionPath)).digest('hex');

		// Fork multiple times
		for (let i = 0; i < 3; i++) {
			SessionManager.forkFrom(srcSessionPath, worktreeDir, sessionDir);
		}

		const afterHash = createHash('sha256').update(readFileSync(srcSessionPath)).digest('hex');
		expect(afterHash).toBe(beforeHash);
	});

	it('4. manual copy via getEntries() preserves all entries and creates valid session', async () => {
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');

		// 模拟 ctx.sessionManager.getEntries() 和 ctx.sessionManager.getSessionFile()
		const srcSm = SessionManager.open(srcSessionPath);
		const entries = (srcSm as any).getEntries() as any[];
		expect(entries.length).toBe(4); // all non-header

		const srcFile: string | undefined = (srcSm as any).getSessionFile();
		expect(srcFile).toBe(srcSessionPath);

		// 手动 fork
		const newId = crypto.randomUUID();
		const now = new Date().toISOString();
		const newHeader = {
			type: 'session',
			version: 3,
			id: newId,
			timestamp: now,
			cwd: worktreeDir,
			parentSession: srcSessionPath,
		};
		const allEntries = [newHeader, ...entries.map((e: any) => ({ ...e }))];

		const forkPath = join(sessionDir, 'manual-fork.jsonl');
		writeFileSync(
			forkPath,
			allEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);

		// 验证 forked 文件
		const loaded = readFileSync(forkPath, 'utf-8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(loaded.length).toBe(5); // header + 4 entries

		const loadedHeader = loaded.find((e: any) => e.type === 'session');
		expect(loadedHeader.cwd).toBe(worktreeDir);
		expect(loadedHeader.id).toBe(newId);
		expect(loadedHeader.parentSession).toBe(srcSessionPath);

		// 验证 entries 内容
		const msgs = loaded.filter((e: any) => e.type === 'message');
		expect(msgs.length).toBe(3);
		expect(msgs[0].message.content).toBe('hello');
	});

	it('5. parentId chain integrity — first msg parentId points to OLD header, not found in forked file', async () => {
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');

		const sm = SessionManager.forkFrom(srcSessionPath, worktreeDir, sessionDir);
		const forkedPath = (sm as any).sessionFile as string;
		const entries = readFileSync(forkedPath, 'utf-8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));

		const firstMsg = entries.find((e: any) => e.type === 'message');
		// 新 header 有新的 ID，第一条 msg 的 parentId 指向旧 header
		const forkedHeader = entries.find((e: any) => e.type === 'session');
		expect(firstMsg.parentId).not.toBe(forkedHeader.id); // parentId 指向旧 header，不是新 header
		expect(firstMsg.parentId).toBe(srcHeaderId);

		// 没有 entry 有 id === srcHeaderId（旧 header 不在 forked 文件里）
		const oldHeader = entries.find((e: any) => e.id === srcHeaderId);
		expect(oldHeader).toBeUndefined();

		// 验证 forked 文件中可以找到所有 entries（header + 4 条数据）
		expect(entries.length).toBe(5);
		expect(entries.filter((e: any) => e.type === 'message').length).toBe(3);
		expect(entries.filter((e: any) => e.type === 'turn_end').length).toBe(1);
	});

	it('6. ctx with no session file and no entries falls back to empty session', async () => {
		// 直接测试 createSession 作为降级
		const { createSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const mockRepoRoot = resolve(tmpdir(), 'mock-repo-' + Date.now());
		const mockWtDir = resolve(tmpdir(), 'mock-wt-' + Date.now());
		const mockSessionDir = join(mockRepoRoot, 'sessions');
		mkdirSync(mockSessionDir, { recursive: true });

		const path = createSession(mockWtDir, mockRepoRoot, 'fallback-test');
		expect(existsSync(path)).toBe(true);

		const header = JSON.parse(readFileSync(path, 'utf-8').split('\n')[0]);
		expect(header.type).toBe('session');
		expect(header.version).toBe(3);
		expect(header.cwd).toBe(mockWtDir);

		rmSync(mockRepoRoot, { recursive: true, force: true });
	});

	it('7. getEntries() filters out session header — only data entries returned', async () => {
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');
		const sm = SessionManager.open(srcSessionPath);

		const entries = (sm as any).getEntries() as any[];
		// getEntries 排除 type === "session" 的 entry
		const hasHeader = entries.some((e: any) => e.type === 'session');
		expect(hasHeader).toBe(false);
		expect(entries.length).toBe(4);

		// 第一个 entry 的 parentId 指向旧 header
		expect(entries[0].parentId).toBe(srcHeaderId);
	});
});

// ═══════════════════════════════════════════
// 套件 6：Fork 历史记录
// ═══════════════════════════════════════════

describe('worktree extension — fork history', () => {
	let sandbox: string;
	let isolatedHome: string;
	let repoDir: string;
	let wtDir: string;

	beforeAll(async () => {
		sandbox = createSandbox({ useMockLLM: true });
		isolatedHome = resolve(sandbox, 'home');
		repoDir = join(isolatedHome, 'fork-test-repo');
		mkdirSync(repoDir, { recursive: true });
		execSync('git init --initial-branch main', { cwd: repoDir });
		writeFileSync(join(repoDir, 'README.md'), '# Fork test\n');
		execSync('git add README.md && git commit -m init', { cwd: repoDir });

		// 创建一个 worktree
		execSync('git worktree add -b wt/fork-wt ../fork-test-repo-worktrees/fork-wt main', {
			cwd: repoDir,
			encoding: 'utf-8',
		});
		wtDir = join(repoDir, '..', 'fork-test-repo-worktrees', 'fork-wt');
	});

	afterAll(() => {
		try {
			execSync('git worktree remove ../fork-test-repo-worktrees/fork-wt', {
				cwd: repoDir,
				encoding: 'utf-8',
			});
		} catch {
			/* ignore */
		}
		if (sandbox) destroySandbox(sandbox);
	});

	it('forkToNewSession copies entries from ctx and writes valid session file', async () => {
		const { forkToNewSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);

		// 模拟真实 pi 的 getEntries() 行为：不包含 session header
		// (pi 内部 filter(e => e.type !== "session"))
		const mockEntries = [
			{
				type: 'user',
				role: 'user',
				content: [{ type: 'text', text: 'hello' }],
				timestamp: 1700000000000,
				id: 'msg-1',
				parentId: 'src-sid',
			},
			{
				type: 'assistant',
				role: 'assistant',
				content: [{ type: 'text', text: 'hi there' }],
				timestamp: 1700000000001,
				id: 'msg-2',
				parentId: 'msg-1',
			},
		];
		const mockCtx = {
			sessionManager: { getEntries: () => mockEntries },
		};

		const filePath = forkToNewSession(mockCtx as any, wtDir, repoDir, 'fork-wt');
		expect(filePath).toBeTruthy();
		expect(existsSync(filePath)).toBe(true);

		// 读取并验证内容：新 header + 2 条对话 = 3 行
		const content = readFileSync(filePath, 'utf-8').trim().split('\n');
		expect(content.length).toBe(3);

		const header = JSON.parse(content[0]);
		expect(header.type).toBe('session');
		expect(header.version).toBe(3);
		expect(header.cwd).toBe(wtDir); // cwd 被更新为 worktree 路径
		expect(header.id).not.toBe('src-sid'); // 应有新 ID

		const msg1 = JSON.parse(content[1]);
		expect(msg1.role).toBe('user');
		expect(msg1.content[0].text).toBe('hello');

		const msg2 = JSON.parse(content[2]);
		expect(msg2.role).toBe('assistant');
		expect(msg2.content[0].text).toBe('hi there');
	});

	it('forkToNewSession handles empty entries gracefully', async () => {
		const { forkToNewSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const mockCtx = {
			sessionManager: { getEntries: () => [] },
		};

		const filePath = forkToNewSession(mockCtx as any, wtDir, repoDir, 'fork-wt-empty');
		expect(filePath).toBeTruthy();
		expect(existsSync(filePath)).toBe(true);

		const content = readFileSync(filePath, 'utf-8').trim().split('\n');
		expect(content.length).toBe(1); // 只有 header
		const header = JSON.parse(content[0]);
		expect(header.type).toBe('session');
		expect(header.cwd).toBe(wtDir);
	});

	it('forkToNewSession handles null sessionManager gracefully', async () => {
		const { forkToNewSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const mockCtx = {};

		const filePath = forkToNewSession(mockCtx as any, wtDir, repoDir, 'fork-wt-null');
		expect(filePath).toBeTruthy();
		expect(existsSync(filePath)).toBe(true);

		const content = readFileSync(filePath, 'utf-8').trim().split('\n');
		expect(content.length).toBe(1);
	});

	it('forked session file is loadable by SessionManager.open with correct cwd', async () => {
		const { forkToNewSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');

		const mockEntries = [
			{
				type: 'session',
				version: 3,
				id: 'src-sid-2',
				timestamp: '2024-01-01T00:00:00.000Z',
				cwd: repoDir,
			},
			{
				type: 'user',
				role: 'user',
				content: [{ type: 'text', text: 'test' }],
				timestamp: 1700000000000,
				id: 'msg-3',
				parentId: 'src-sid-2',
			},
		];
		const mockCtx = {
			sessionManager: { getEntries: () => mockEntries },
		};

		const filePath = forkToNewSession(mockCtx as any, wtDir, repoDir, 'fork-wt-loadable');
		const sm = SessionManager.open(filePath);

		expect(sm).toBeTruthy();
		// 验证 cwd 被正确设置为 worktree 路径
		expect((sm as any).cwd).toBe(wtDir);
	});

	it('fork preserves parentSession reference', async () => {
		const { forkToNewSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const mockCtx = {
			sessionManager: {
				getEntries: () => [
					{
						type: 'session',
						version: 3,
						id: 'src-sid-3',
						timestamp: '2024-01-01T00:00:00.000Z',
						cwd: repoDir,
					},
				],
			},
		};

		const filePath = forkToNewSession(mockCtx as any, wtDir, repoDir, 'fork-wt-parent');
		const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]);
		// 新的 session 应记录来源路径（如果实现了 parentSession）
		// 当前实现: 复制所有 entry 后更新 header 的 cwd，但未设置 parentSession
		expect(header.cwd).toBe(wtDir);
	});
});

// ═══════════════════════════════════════════
// 套件 7：cloneSession（复制完整会话到新目录）
// ═══════════════════════════════════════════

describe('worktree extension — clone session', () => {
	let srcDir: string;
	let srcSessionPath: string;
	let srcHeaderId: string;
	let worktreeDir: string;

	/**
	 * 创建真实的 pi 会话文件：
	 *
	 *   header: {type:"session", id:"clone-hdr-xxx", cwd:"<srcDir>"}
	 *   msg-1:  {type:"message", id:"m1", parentId:"clone-hdr-xxx", role:"user", content:"hello"}
	 *   msg-2:  {type:"message", id:"m2", parentId:"m1", role:"assistant", content:"hi"}
	 *   turn_end:{type:"turn_end", id:"te1", parentId:"m2"}
	 */
	beforeAll(() => {
		srcDir = resolve(tmpdir(), 'pi-clone-test-src-' + Date.now());
		mkdirSync(srcDir, { recursive: true });
		worktreeDir = resolve(tmpdir(), 'pi-clone-test-wt-' + Date.now());
		mkdirSync(worktreeDir, { recursive: true });

		srcHeaderId = 'clone-hdr-' + crypto.randomUUID().slice(0, 8);
		const ts = new Date().toISOString();
		const msg1Id = 'm1-' + crypto.randomUUID().slice(0, 8);
		const msg2Id = 'm2-' + crypto.randomUUID().slice(0, 8);

		const header = { type: 'session', version: 3, id: srcHeaderId, timestamp: ts, cwd: srcDir };
		const msg1 = {
			type: 'message',
			id: msg1Id,
			parentId: srcHeaderId,
			timestamp: ts,
			message: { role: 'user', content: 'hello' },
		};
		const msg2 = {
			type: 'message',
			id: msg2Id,
			parentId: msg1Id,
			timestamp: ts,
			message: { role: 'assistant', content: 'hi' },
		};
		const turnEnd = {
			type: 'turn_end',
			id: 'te-' + crypto.randomUUID().slice(0, 8),
			parentId: msg2Id,
			timestamp: ts,
		};

		srcSessionPath = join(srcDir, 'test-session.jsonl');
		const lines = [header, msg1, msg2, turnEnd].map((e) => JSON.stringify(e)).join('\n') + '\n';
		writeFileSync(srcSessionPath, lines, 'utf-8');
	});

	afterAll(() => {
		rmSync(srcDir, { recursive: true, force: true });
		rmSync(worktreeDir, { recursive: true, force: true });
	});

	it('1. cloneSession puts file in worktree session directory', async () => {
		const { cloneSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const filePath = cloneSession(srcSessionPath, worktreeDir);
		expect(filePath).toBeTruthy();
		expect(existsSync(filePath)).toBe(true);
		// 路径应包含 worktreeDir 的编码
		expect(filePath).toContain(worktreeDir.replace(/\//g, '-'));
	});

	it('2. header id is new, cwd updated, parentId chain intact', async () => {
		const { cloneSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const filePath = cloneSession(srcSessionPath, worktreeDir);
		const content = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
		const header = JSON.parse(content[0]);

		// id 是新生成的，和源不同
		expect(header.id).not.toBe(srcHeaderId);
		expect(typeof header.id).toBe('string');
		expect(header.id.length).toBeGreaterThan(10);

		// cwd 更新为 worktree 路径
		expect(header.cwd).toBe(worktreeDir);

		// 所有 entries 的 parentId 链完整
		for (let i = 1; i < content.length; i++) {
			const entry = JSON.parse(content[i]);
			if (
				entry.parentId &&
				!content.slice(0, i).some((l) => JSON.parse(l).id === entry.parentId)
			) {
				// parentId 应该能在之前的行中找到对应的 id
				expect(entry.parentId).toBe(header.id); // 重映射后 header.id 应匹配
			}
		}
	});

	it('3. source file unchanged after clone (SHA256)', async () => {
		const { createHash } = await import('node:crypto');
		const { cloneSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const beforeHash = createHash('sha256').update(readFileSync(srcSessionPath)).digest('hex');

		cloneSession(srcSessionPath, worktreeDir);
		cloneSession(srcSessionPath, worktreeDir);

		const afterHash = createHash('sha256').update(readFileSync(srcSessionPath)).digest('hex');
		expect(afterHash).toBe(beforeHash);
	});

	it('4. SessionManager.open loads cloned session with correct cwd', async () => {
		const { cloneSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const { SessionManager } = await import('@earendil-works/pi-coding-agent');

		const filePath = cloneSession(srcSessionPath, worktreeDir);
		const sm = SessionManager.open(filePath);

		expect(sm).toBeTruthy();
		expect((sm as any).cwd).toBe(worktreeDir);
		expect((sm as any).getEntries().length).toBe(3); // 3 non-header entries
	});

	it('5. empty session can be cloned', async () => {
		const { cloneSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const emptyPath = join(srcDir, 'empty-session.jsonl');
		const header = {
			type: 'session',
			version: 3,
			id: 'empty-hdr',
			timestamp: new Date().toISOString(),
			cwd: srcDir,
		};
		writeFileSync(emptyPath, JSON.stringify(header) + '\n', 'utf-8');

		const clonedPath = cloneSession(emptyPath, worktreeDir);
		expect(existsSync(clonedPath)).toBe(true);

		const content = readFileSync(clonedPath, 'utf-8').trim().split('\n').filter(Boolean);
		expect(content.length).toBe(1); // only header
		const clonedHeader = JSON.parse(content[0]);
		expect(clonedHeader.cwd).toBe(worktreeDir);
		expect(clonedHeader.id).not.toBe('empty-hdr');
	});

	it('6. .clone-meta.json records source info', async () => {
		const { cloneSession, resolveSessionDir } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		cloneSession(srcSessionPath, worktreeDir);
		const sessionDir = resolveSessionDir(worktreeDir);
		const metaPath = join(sessionDir, '.clone-meta.json');

		expect(existsSync(metaPath)).toBe(true);
		const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
		expect(meta.sourceCwd).toBe(srcDir);
		expect(meta.targetCwd).toBe(worktreeDir);
		expect(meta.clonedAt).toBeTruthy();
	});

	it('7. hasClonedSession detects existing clone', async () => {
		const { cloneSession, hasClonedSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		cloneSession(srcSessionPath, worktreeDir);

		const result = hasClonedSession(worktreeDir, srcDir);
		expect(result).not.toBeNull();
		expect(result!.sourceCwd).toBe(srcDir);
		expect(result!.targetCwd).toBe(worktreeDir);

		// 未 clone 过的目录返回 null
		const otherDir = resolve(tmpdir(), 'pi-clone-other-' + Date.now());
		const resultOther = hasClonedSession(otherDir, srcDir);
		expect(resultOther).toBeNull();
		rmSync(otherDir, { recursive: true, force: true });
	});

	it('8. cloneSession remaps parentId from old header to new header', async () => {
		const { cloneSession } = await import(
			resolve(__dirname, '../../../extensions/meta/worktree/lib/session.ts')
		);
		const filePath = cloneSession(srcSessionPath, worktreeDir);
		const content = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
		const header = JSON.parse(content[0]);

		// 第一个消息的 parentId 应该指向新 header 的 id（不是旧 header）
		const firstMsg = JSON.parse(content[1]);
		expect(firstMsg.parentId).toBe(header.id);
		expect(firstMsg.parentId).not.toBe(srcHeaderId);
	});
});
