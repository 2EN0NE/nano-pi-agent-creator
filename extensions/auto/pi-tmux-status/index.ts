/**
 * pi-tmux-status – Pi 主动通知 tmux 更新窗格边框颜色
 *
 * 原理：
 *   Pi 的扩展 API 提供精确的生命周期事件，扩展将状态写入临时文件
 *   `/tmp/pi-tmux-state/<pane_id>`，`tmux-pane-title` 脚本从
 *   该文件读取颜色并渲染到 pane 边框背景上。
 *
 *   状态文件以 pane_id 区分，因此不同 pane 可独立变色。
 *   状态文件格式：一行文本 `<state>|<sessionId>`（如 `waiting|sess_abc123`）
 *
 * 状态颜色：
 *   🟢 绿色 (colour82)  = 等待用户输入（空闲）— 默认
 *   🟡 黄色 (colour226) = 正在执行
 *   🔴 红色 (colour196) = 有选择对话框正在等待用户操作
 *
 * 对话框检测：
 *   通过 @zenone/pi-selector 的 isSelecting() 判断是否有对话框显示。
 *   每 500ms 检查一次，对话框出现时即时变红。
 *
 * 依赖：
 *   - @zenone/pi-selector 包（共享选择器）
 *   - 需要在 tmux 中运行（检测 $TMUX 环境变量）
 *   - state 文件由 tmux-pane-title 脚本消费
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSelecting } from "@zenone/pi-selector";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// 常量
// ============================================================
const STATE_DIR = "/tmp/pi-tmux-state";
const CLR_IDLE = "green";
const CLR_EXECUTING = "yellow";
const CLR_SELECTING = "red";

// ============================================================
// 状态管理
// ============================================================
let currentState: string = CLR_IDLE;
let currentSessionId: string = "";
let dialogCheckerTimer: ReturnType<typeof setInterval> | null = null;
let tmuxPaneId: string | null = null;

// ============================================================
// tmux 操作封装
// ============================================================
function isInTmux(): boolean {
	return !!process.env.TMUX;
}

/** state 文件内容：<state>|<sessionId> */
function formatStateContent(state: string): string {
	return `${state}|${currentSessionId || ""}`;
}

/**
 * 写入 per-pane 状态文件 + 更新窗口活跃边框颜色（兜底）
 * 状态文件由 tmux-pane-title 脚本读取，用 #[bg=colour] 渲染边框背景色（per-pane）
 * 窗口边框是全局兜底，确保即使脚本来不及刷新也有颜色变化
 */
function setBorderState(state: string): void {
	if (!isInTmux() || !tmuxPaneId) return;
	if (state === currentState) return;
	currentState = state;

	// 写 per-pane 状态文件
	const stateFile = join(STATE_DIR, tmuxPaneId);
	try {
		if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(stateFile, formatStateContent(state), "utf-8");
	} catch {
		// 静默忽略
	}

	// 设置窗口活跃边框颜色（全局兜底）
	const colorCode =
		state === CLR_EXECUTING
			? "colour226"
			: state === CLR_SELECTING
				? "colour196"
				: "colour82";
	try {
		execSync(
			`tmux set -w pane-active-border-style "fg=${colorCode},bold"`,
			{ stdio: "ignore", timeout: 500 },
		);
	} catch {
		// 静默忽略
	}
}

function cleanupStateFile(): void {
	if (!tmuxPaneId) return;
	try {
		unlinkSync(join(STATE_DIR, tmuxPaneId));
	} catch {
		// 静默忽略
	}
}

// ============================================================
// 对话框检测定时器
// ============================================================
function startDialogMonitor(): void {
	if (dialogCheckerTimer) return;
	dialogCheckerTimer = setInterval(() => {
		if (isSelecting()) {
			setBorderState(CLR_SELECTING);
		}
	}, 500);
}

function stopDialogMonitor(): void {
	if (dialogCheckerTimer) {
		clearInterval(dialogCheckerTimer);
		dialogCheckerTimer = null;
	}
}

// ============================================================
// 扩展入口
// ============================================================
export default function (pi: ExtensionAPI) {
	if (!isInTmux()) {
		console.warn("[pi-tmux-status] 未检测到 tmux 环境，边框颜色控制已跳过");
		return;
	}

	tmuxPaneId = process.env.TMUX_PANE ?? null;

	// 扩展启动时立即写入初始状态（绿色），防止 CPU 启发式误判
	setBorderState(CLR_IDLE);

	// 获取 session ID 并更新状态文件
	pi.on("session_start", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (sid) {
			currentSessionId = sid.slice(0, 12); // 取短 ID
			// 重新写入（带上 session ID）
			setBorderState(currentState);
		}
	});

	// 🟡 用户提交 prompt → Pi 开始工作
	pi.on("turn_start", async () => {
		stopDialogMonitor();
		setBorderState(CLR_EXECUTING);
	});

	// 🔴/🟢 Pi 完全空闲 → 检查是否有选择对话框
	pi.on("agent_settled", async () => {
		startDialogMonitor();
		if (isSelecting()) {
			setBorderState(CLR_SELECTING);
		} else {
			setBorderState(CLR_IDLE);
		}
	});

	// 会话关闭时清理
	pi.on("session_shutdown", async () => {
		stopDialogMonitor();
		cleanupStateFile();
	});
}
