/**
 * pi-tmux-status – Pi 主动通知 tmux 更新窗格边框颜色
 *
 * ── 职责边界 ──
 * 所有 tmux 状态的展示控制集中在此插件，其他扩展不直接操作 tmux。
 *
 * ── 控制范围 ──
 * 写 /tmp/pi-tmux-state/<pane_id> 状态文件，由 tmux-pane-title 脚本在
 * pane-border-format 的 #() 中读取，渲染为 #[bg=colour] 背景色：
 *
 *   🟢 绿色  colour82  = 空闲（等待用户输入）
 *   🟡 黄色  colour226 = 执行中（LLM 推理或工具调用）
 *   🔴 红色  colour196 = 对话框选择中（等待用户操作）
 *
 * 同时通过 tmux set window-status-style 同步更新底部窗口页签背景色。
 *
 * ── 事件驱动 ──
 * 此插件通过注册在 globalThis.__piOnDialogChange 上的回调监听
 * selector 扩展的对话框状态变化，实现事件驱动的联动：
 *
 *   selector showSelect()       ──→  __piOnDialogChange(true)   ──→ setState("red")
 *   selector dispose()           ──→  __piOnDialogChange(false)  ──→ setState(恢复前状态)
 *   pi turn_start                ──→  setState("yellow")
 *   pi agent_settled             ──→  setState("green")
 *
 * 不使用轮询、不通过 import 耦合、selector 不感知 tmux 概念。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = "/tmp/pi-tmux-state";

let currentState = "green";
let currentSessionId = "";
let tmuxPaneId: string | null = null;

function isInTmux(): boolean {
	return !!process.env.TMUX;
}

function stateFile(): string | null {
	return tmuxPaneId ? join(STATE_DIR, tmuxPaneId) : null;
}

function setState(state: string): void {
	if (!isInTmux() || !tmuxPaneId) return;
	if (state === currentState) return;
	currentState = state;
	const fp = stateFile();
	if (!fp) return;
	try {
		if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(fp, `${state}|${currentSessionId}`, "utf-8");
	} catch {
		/* 静默 */
	}

	// 同步更新底部窗口页签颜色
	updateWindowTab(state);
}

function cleanup() {
	const fp = stateFile();
	if (fp)
		try {
			unlinkSync(fp);
		} catch {
			/* 静默 */
		}
}

/** 更新底部窗口页签背景色（window 级，只影响当前窗口） */
function updateWindowTab(state: string): void {
	const tabBg =
		state === "yellow"
			? "colour226"
			: state === "red"
				? "colour196"
				: "colour82";
	try {
		execSync(`tmux set -w window-status-style "bg=${tabBg}"`, {
			stdio: "ignore",
			timeout: 300,
		});
		execSync(
			`tmux set -w window-status-current-style "bg=${tabBg},fg=colour232,bold"`,
			{ stdio: "ignore", timeout: 300 },
		);
	} catch {
		/* tmux 命令失败时静默 */
	}
}

export default function (pi: ExtensionAPI) {
	if (!isInTmux()) {
		console.warn("[pi-tmux-status] 不在 tmux 中，已跳过");
		return;
	}

	tmuxPaneId = process.env.TMUX_PANE ?? null;

	let stateBeforeDialog = "green";

	// 注册对话框事件回调（selector 通过此回调通知 dialog 状态变化）
	(globalThis as any).__piOnDialogChange = (isOpen: boolean) => {
		if (isOpen) {
			stateBeforeDialog = currentState;
			setState("red");
		} else {
			setState(stateBeforeDialog);
		}
	};

	// 初始状态：绿色
	setState("green");

	// session_start → 获取 session ID
	pi.on("session_start", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (sid) {
			currentSessionId = sid.slice(0, 12);
			setState(currentState);
		}
	});

	// 🟡 turn_start → 执行中
	pi.on("turn_start", async () => {
		setState("yellow");
	});

	// 🟢 agent_settled → 空闲
	pi.on("agent_settled", async () => {
		setState("green");
	});

	// 清理
	pi.on("session_shutdown", async () => {
		cleanup();
		delete (globalThis as any).__piOnDialogChange;
	});
}
