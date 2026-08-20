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
	/** 使用 Mock LLM（自动包含 mock-llm 扩展，适用于需要触发 agent_start 的测试） */
	useMockLLM?: boolean;
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
			useMockLLM: opts.useMockLLM,
		} as Required<TuiRunnerOptions>;
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
			useMockLLM: this.options.useMockLLM,
		});

		// 2. 设置 PI_TUI_WRITE_LOG 路径
		this.writeLogPath = path.join(this.sandbox, 'tui-write.log');

		// 3. 设置 HOME 为隔离沙箱的 home
		const isolatedHome = path.join(this.sandbox, 'home');

		// 4. 在沙箱根目录创建 git 仓库供 worktree 扩展使用（必须先于 spawn，
		//    否则 worktree 的 session_start 会穿透到真实项目仓库）
		this.createGitRepo();

		// 5. 创建 PTY 并启动 pi（使用 resolvePiBin 获取完整路径避免 posix_spawnp 找不到）
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
				// 跳过 fd/rg 网络下载，消除「命令在启动完成前被吞」的竞态窗口（问题 A）
				PI_OFFLINE: '1',
				// 阻断 git 向上穿透 sandbox（问题 B 兜底，git init 失败时避免误操作真实仓库）
				GIT_CEILING_DIRECTORIES: this.sandbox,
				// 固定终端大小防止 resize 事件干扰
				COLUMNS: String(this.options.columns),
				LINES: String(this.options.rows),
			} as { [key: string]: string },
		});

		// 6. 收集 PTY 输出
		this.pty.onData((data: string) => {
			this.rawOutput += data;
		});

		// 7. 等待 pi 就绪（TUI 状态栏出现 + 命令处理器就绪）
		await this.waitForReady();
		this.started = true;
	}

	/**
	 * 在沙箱根目录初始化 git 仓库（供 worktree 扩展使用）。
	 *
	 * worktree 扩展的 getRepoRoot(cwd) 通过 `git rev-parse --git-common-dir`
	 * 从 cwd 向上查找 .git。必须让 sandbox 根目录本身成为 git 仓库，否则会向上
	 * 穿透到真实项目仓库（问题 B：sandbox 位于真实仓库的 .pi/tmp 内）。
	 */
	private createGitRepo(): void {
		try {
			// 创建 AGENTS.md 使 sandbox 成为 hub root（阻止 pi 的 hub 检测向上穿透）
			fs.writeFileSync(path.join(this.sandbox, 'AGENTS.md'), '# test hub\n');

			// 以 sandbox 根目录作为 git 仓库，使 getRepoRoot(sandbox) 命中沙箱本身
			execSync('git init --initial-branch main -q', { cwd: this.sandbox, timeout: 5000 });
			fs.writeFileSync(path.join(this.sandbox, 'README.md'), '# test\n');
			execSync('git add README.md', { cwd: this.sandbox, timeout: 5000 });
			execSync('git commit -m init -q', {
				cwd: this.sandbox,
				timeout: 5000,
			});
		} catch {
			// Git init 失败不阻止测试继续
		}
	}

	/**
	 * 等待 TUI 就绪。
	 *
	 * 分两阶段：
	 *   1. 等状态栏渲染（UI 已挂载）。
	 *   2. 等命令处理器就绪（setupEditorSubmitHandler）。
	 *
	 * pi 在启动早期把 editor.onSubmit 设为 handleStartupSubmit，此窗口内任何
	 * 提交都会被吞掉并显示 "Startup is still in progress"；直到 ensureTool(fd/rg)
	 * 完成后才替换为真正的处理器。状态栏信号在窗口早期就渲染，不能代表命令可处理，
	 * 因此用「空提交探测」确认处理器已就绪：空提交被吞则仍处启动窗口。
	 */
	private async waitForReady(): Promise<void> {
		const deadline = Date.now() + this.options.startTimeout;
		const readyPatterns = [
			/\[\d+\.\d+%/, // token 比例: [0.0%/128k
			/mock-model-1/, // mock-llm 模型名
			/\(auto\)/, // auto 模式
		];

		// 阶段 1：等状态栏渲染
		while (Date.now() < deadline) {
			if (readyPatterns.some((p) => p.test(this.readWriteLog()))) break;
			await this.sleep(100);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`TUI did not become ready within ${this.options.startTimeout}ms.\n` +
					`Last PTY output (1000 chars): ${this.rawOutput.slice(-1000)}`,
			);
		}

		// 阶段 2：等命令处理器就绪（空提交探测）
		while (Date.now() < deadline) {
			const marker = this.readWriteLog().length;
			this.pty!.write('\r'); // 空提交：真处理器直接返回，启动处理器会显示提示
			await this.sleep(250);
			const tail = stripAnsi(this.readWriteLog().slice(marker));
			if (!tail.includes('Startup is still in progress')) {
				return; // 命令处理器已就绪
			}
			await this.sleep(250);
		}

		throw new Error(
			`TUI command handler did not become ready within ${this.options.startTimeout}ms.\n` +
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
	 * 等待 PTY 原始输出中出现指定关键字（widget 内容等不在 write-log 的文本）
	 */
	async waitForPtyOutput(keyword: string, timeoutMs = 6000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const text = stripAnsi(this.rawOutput);
			if (text.includes(keyword)) return text;
			await this.sleep(200);
		}
		const text = stripAnsi(this.rawOutput);
		throw new Error(
			`Timed out waiting for PTY output: "${keyword}"\n` +
				`Actual (last 800 chars): "${text.slice(-800)}"`,
		);
	}

	/**
	 * 断言 PTY 原始输出中的纯文本包含指定关键字（带等待，最多 6s）
	 */
	async assertPtyContains(keyword: string): Promise<void> {
		await this.waitForPtyOutput(keyword);
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
	 * 获取沙箱根目录路径（用于读取日志文件等）
	 */
	getSandboxPath(): string {
		return this.sandbox;
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
