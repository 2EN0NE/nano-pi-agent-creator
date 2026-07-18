/**
 * TUI 测试运行器 — 基于 node-pty + PI_TUI_WRITE_LOG
 *
 * 核心思路：
 * 1. 用 node-pty 创建 PTY，spawn pi -a（无需依赖 `script` 命令）
 * 2. 设置 PI_TUI_WRITE_LOG 环境变量 → pi 会将所有 stdout 写入（含瞬态通知）
 * 3. 发送命令后，从 write-log 中搜索断言文本
 * 4. 跨平台（macOS/Linux/Windows）
 *
 * 使用方式（Vitest）：
 * ```typescript
 * import { TuiRunner } from '../helpers/tui-runner.js';
 *
 * const tui = new TuiRunner({ extensions: ['worktree', 'pi-logger'] });
 * await tui.start();
 * await tui.send('/worktree list');
 * await tui.assertContains('No worktrees found');
 * await tui.stop();
 * ```
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import stripAnsi from 'strip-ansi';
import { spawn, type IPty } from 'node-pty';
import { createSandbox, destroySandbox, resolvePiBin } from './sandbox.js';

export interface TuiRunnerOptions {
	/** 逗号分隔的扩展依赖列表（如 "pi-logger,worktree"） */
	extensions?: string;
	/** PTY 列数（默认 80） */
	columns?: number;
	/** PTY 行数（默认 24） */
	rows?: number;
	/** 命令处理等待时间 ms（默认 2000） */
	commandDelay?: number;
	/** 启动超时 ms（默认 10000） */
	startTimeout?: number;
}

interface Snapshot {
	label: string;
	raw: string;
	text: string;
}

export class TuiRunner {
	private pty: IPty | null = null;
	private options: Required<TuiRunnerOptions>;
	private sandbox: string = '';
	private writeLogPath: string = '';
	private rawOutput: string = '';
	private snapshots: Snapshot[] = [];
	private started = false;

	constructor(opts: TuiRunnerOptions = {}) {
		this.options = {
			extensions: opts.extensions || '',
			columns: opts.columns ?? 80,
			rows: opts.rows ?? 24,
			commandDelay: opts.commandDelay ?? 500,
			startTimeout: opts.startTimeout ?? 10000,
		};
	}

	/**
	 * 启动 TUI 沙箱并等待 pi 就绪
	 */
	async start(): Promise<void> {
		// 1. 创建隔离沙箱
		this.sandbox = createSandbox({
			extensions: this.options.extensions
				? this.options.extensions
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean)
				: [],
		});

		// 2. 设置 PI_TUI_WRITE_LOG 路径
		this.writeLogPath = path.join(this.sandbox, 'tui-write.log');

		// 3. 设置 HOME 为隔离沙箱的 home
		const isolatedHome = path.join(this.sandbox, 'home');

		// 4. 创建 PTY 并启动 pi（使用 resolvePiBin 获取完整路径避免 posix_spawnp 找不到）
		const piBin = resolvePiBin();
		this.pty = spawn(piBin, ['-a'], {
			name: 'xterm-256color',
			cols: this.options.columns,
			rows: this.options.rows,
			cwd: this.sandbox,
			env: {
				...process.env,
				HOME: isolatedHome,
				CI: 'true',
				PI_TUI_WRITE_LOG: this.writeLogPath,
				// 固定终端大小防止 resize 事件干扰
				COLUMNS: String(this.options.columns),
				LINES: String(this.options.rows),
			} as { [key: string]: string },
		});

		// 5. 收集 PTY 输出
		this.pty.onData((data: string) => {
			this.rawOutput += data;
		});

		// 6. 在沙箱中创建 git 仓库供 worktree 扩展使用
		this.createGitRepo();

		// 7. 等待 pi 就绪（TUI 状态栏出现）
		await this.waitForReady();
		this.started = true;
	}

	/**
	 * 在沙箱中初始化 git 仓库（供 worktree 扩展使用）
	 *
	 * worktree 扩展使用 discoverRepos() 查找仓库，逻辑是：
	 * 1. findHubRoot(cwd): 向上查找含 AGENTS.md / hub.config.ts 的目录
	 * 2. 如果找到 hub root，扫描其直接子目录中带 .git 的作为 repos
	 * 3. 如果没找到 hub root，检查 cwd 本身是否 git repo
	 *
	 * 因此要创建：sandbox/AGENTS.md 作为 hub root，sandbox/test-repo/ 作为 git repo
	 */
	private createGitRepo(): void {
		try {
			// 创建 AGENTS.md 使 sandbox 成为 hub root
			fs.writeFileSync(path.join(this.sandbox, 'AGENTS.md'), '# test hub\n');

			// 创建 test-repo 作为 hub root 的 git 子仓库
			const repoDir = path.join(this.sandbox, 'test-repo');
			fs.mkdirSync(repoDir, { recursive: true });
			execSync('git init --initial-branch main -q', { cwd: repoDir, timeout: 5000 });
			fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
			execSync('git add README.md', { cwd: repoDir, timeout: 5000 });
			execSync('git commit -m init -q', {
				cwd: repoDir,
				timeout: 5000,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: 'test',
					GIT_AUTHOR_EMAIL: 'test@test',
					GIT_COMMITTER_NAME: 'test',
					GIT_COMMITTER_EMAIL: 'test@test',
				},
			});
		} catch {
			// Git init 失败不阻止测试继续
		}
	}

	/**
	 * 等待 TUI 就绪（检测状态栏分隔符或模型名）
	 */
	private async waitForReady(): Promise<void> {
		const deadline = Date.now() + this.options.startTimeout;
		const readyPatterns = [
			/\[\d+\.\d+%/, // token 比例: [0.0%/128k
			/mock-model-1/, // mock-llm 模型名
			/\(auto\)/, // auto 模式
		];

		while (Date.now() < deadline) {
			// 检查 write-log（包含所有 TUI 输出）
			const log = this.readWriteLog();
			for (const pattern of readyPatterns) {
				if (pattern.test(log)) {
					return; // 就绪
				}
			}
			await this.sleep(100);
		}

		throw new Error(
			`TUI did not become ready within ${this.options.startTimeout}ms.\n` +
				`Last PTY output (1000 chars): ${this.rawOutput.slice(-1000)}`,
		);
	}

	/**
	 * 发送文本到 PTY（自动追加回车 \r 模拟 Enter 键）
	 * 注意：TUI raw mode 下 Enter 键发送 \r（CR），非 \n（LF）
	 */
	async send(text: string): Promise<void> {
		if (!this.pty || !this.started) {
			throw new Error('TUI not started. Call start() first.');
		}
		this.pty.write(text + '\r');
		await this.sleep(this.options.commandDelay);
	}

	/**
	 * 发送原始按键序列（不追加换行）
	 */
	async sendRaw(data: string): Promise<void> {
		if (!this.pty || !this.started) {
			throw new Error('TUI not started. Call start() first.');
		}
		this.pty.write(data);
		await this.sleep(this.options.commandDelay);
	}

	/**
	 * 当前保存快照
	 */
	snapshot(label: string): Snapshot {
		const raw = this.readWriteLog();
		const text = stripAnsi(raw);
		const snap: Snapshot = { label, raw, text };
		this.snapshots.push(snap);
		return snap;
	}

	/**
	 * 等待 write-log 中出现指定关键字（最多等 timeoutMs）
	 */
	async waitForOutput(keyword: string, timeoutMs = 6000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const log = this.readWriteLog();
			const text = stripAnsi(log);
			if (text.includes(keyword)) return text;
			await this.sleep(200);
		}
		const text = stripAnsi(this.readWriteLog());
		throw new Error(
			`Timed out waiting for output: "${keyword}"\n` +
				`Actual (last 800 chars): "${text.slice(-800)}"`,
		);
	}

	/**
	 * 断言 write-log 中的纯文本包含指定关键字（带等待，最多 6s）
	 */
	async assertContains(keyword: string): Promise<void> {
		await this.waitForOutput(keyword);
	}

	/**
	 * 断言 write-log 中的纯文本匹配正则（带等待，最多 6s）
	 */
	async assertMatches(pattern: RegExp): Promise<void> {
		const deadline = Date.now() + 6000;
		while (Date.now() < deadline) {
			const log = this.readWriteLog();
			const text = stripAnsi(log);
			if (pattern.test(text)) return;
			await this.sleep(200);
		}
		const text = stripAnsi(this.readWriteLog());
		throw new Error(
			`Timed out waiting for pattern: ${pattern}\n` +
				`Actual (last 800 chars): "${text.slice(-800)}"`,
		);
	}

	/**
	 * 获取写入日志的纯文本内容
	 */
	getText(): string {
		return stripAnsi(this.readWriteLog());
	}

	/**
	 * 获取写入日志的原始 ANSI 内容
	 */
	getRaw(): string {
		return this.readWriteLog();
	}

	/**
	 * 获取所有保存的快照
	 */
	getSnapshots(): Snapshot[] {
		return [...this.snapshots];
	}

	/**
	 * 关闭 PTY 并清理沙箱
	 */
	async stop(): Promise<void> {
		this.started = false;
		if (this.pty) {
			try {
				this.pty.write('\x03'); // Ctrl+C
				await this.sleep(200);
				this.pty.write('exit\n');
				await this.sleep(200);
				this.pty.kill();
			} catch {
				// 忽略清理错误
			}
			this.pty = null;
		}
		if (this.sandbox) {
			try {
				destroySandbox(this.sandbox);
			} catch {
				// ENOTEMPTY 时重试一次
				try {
					fs.rmSync(this.sandbox, {
						recursive: true,
						force: true,
						maxRetries: 3,
						retryDelay: 200,
					});
				} catch {
					// 忽略清理错误
				}
			}
			this.sandbox = '';
		}
		// 清理 write-log
		if (this.writeLogPath && fs.existsSync(this.writeLogPath)) {
			try {
				fs.unlinkSync(this.writeLogPath);
			} catch {
				// ignore
			}
		}
	}

	private readWriteLog(): string {
		try {
			return fs.readFileSync(this.writeLogPath, 'utf-8');
		} catch {
			return '';
		}
	}

	private async sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * 使用 TUI runner 的便捷测试包装（适合 Vitest）
 * 自动处理 start/stop/cleanup
 */
export async function withTui(
	opts: TuiRunnerOptions,
	fn: (tui: TuiRunner) => Promise<void>,
): Promise<void> {
	const tui = new TuiRunner(opts);
	try {
		await tui.start();
		await fn(tui);
	} finally {
		await tui.stop();
	}
}
