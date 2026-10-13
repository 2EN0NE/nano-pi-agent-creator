#!/bin/sh
# ──────────────────────────────────────────────────────────────────────────────
# e2e pi 配置根 guard（ADR-0045 D6 修订）
#
# run-e2e.sh 把一个名为 `pi` 的符号链接指向本文件并前置到 PATH，于是**所有**在
# 测试用例里发起的 `pi` 调用都先经过这里：
#
#   HOME 仍等于真实 home（或为空 = 用 `env -u HOME` 绕过）→ 注入隔离配置根
#   HOME 已被用例换到沙箱                                  → 原样透传（不动）
#
# 为什么要这个：历史上 e2e 靠「每模块跑完删掉全部 extensions-data/*/config.json、
# 结尾再从备份恢复」来防止用例污染真实配置——一旦该轮被 Ctrl-C / 超时 kill / CI 取消，
# 恢复不执行，用户的插件配置就整批消失（实测 1119 轮里 81 轮中断）。本 guard 把
# 「没显式隔离 HOME 的调用」重定向到隔离目录，从根上让真实配置不可被写。
#
# 真实 pi / 真实 HOME 的来源（按序解析，**不要求**调用方继承 runner 环境）：
#   ① 环境变量 E2E_REAL_PI / E2E_REAL_HOME（run-e2e.sh 直接导出）
#   ② guard 根下的文件 `real-pi` / `real-home`（run-e2e.sh 落盘）
#   ③ guard 根自身由 `$0` 推导（本文件是 `<guard_root>/bin/pi` 的符号链接）
# ②③ 的存在是因为 pi 也可能在**不继承 runner 环境**的进程里被拉起：org 用 tmux 唤醒
# 成员时，tmux session 用的是 **tmux server 的环境快照**（只显式注入 PATH/HOME/ORG_ROOT），
# 拿不到任何 E2E_* 变量。只认环境变量会让这类调用直接失败（回归）。
#
# 另一路依赖：
#   E2E_MODULE_AGENT_DIR 当前测试文件的隔离 agent 目录（仅注入分支需要）
#
# 退出码/输出与原 pi 一致（exec 替换自身，不引入中间父进程，PTY 语义不变）。
# ──────────────────────────────────────────────────────────────────────────────

E2E_GUARD_ROOT="${E2E_GUARD_ROOT:-}"
if [ -z "$E2E_GUARD_ROOT" ]; then
	E2E_GUARD_ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || E2E_GUARD_ROOT=""
fi

# 读首行；文件不存在/读不到则输出空
read_line() {
	[ -n "$1" ] && [ -f "$1" ] || return 0
	head -n 1 "$1" 2>/dev/null || true
}

E2E_REAL_PI="${E2E_REAL_PI:-$(read_line "${E2E_GUARD_ROOT:+$E2E_GUARD_ROOT/real-pi}")}"
E2E_REAL_HOME="${E2E_REAL_HOME:-$(read_line "${E2E_GUARD_ROOT:+$E2E_GUARD_ROOT/real-home}")}"

if [ -z "$E2E_REAL_PI" ]; then
	echo "pi-home-guard: 无法确定真实 pi：E2E_REAL_PI 未设置，且 ${E2E_GUARD_ROOT:-<guard_root>}/real-pi 不可读" >&2
	exit 127
fi
if [ -z "$E2E_REAL_HOME" ]; then
	echo "pi-home-guard: 无法确定真实 HOME：E2E_REAL_HOME 未设置，且 ${E2E_GUARD_ROOT:-<guard_root>}/real-home 不可读" >&2
	exit 127
fi

# 比较前去尾斜杠：`HOME="$HOME/"`（或其他等价写法）不能被判成「已在沙箱」而直通真实 pi
# ——那会把真实配置写掉，只剩运行级哨兵事后报警。
strip_slash() {
	v="$1"
	while [ "${v%/}" != "$v" ]; do v="${v%/}"; done
	printf '%s\n' "$v"
}
HOME_NORM="$(strip_slash "${HOME:-}")"
REAL_HOME_NORM="$(strip_slash "$E2E_REAL_HOME")"

# 调用方已显式指定配置根（PI_CODING_AGENT_DIR）→ 视为已隔离，不覆盖它的选择。
if [ -z "${PI_CODING_AGENT_DIR:-}" ] && { [ -z "${HOME:-}" ] || [ "$HOME_NORM" = "$REAL_HOME_NORM" ]; }; then
	E2E_MODULE_AGENT_DIR="${E2E_MODULE_AGENT_DIR:?pi-home-guard: E2E_MODULE_AGENT_DIR 未设置（未隔离的 pi 调用需要它）}"
	PI_CODING_AGENT_DIR="$E2E_MODULE_AGENT_DIR"
	export PI_CODING_AGENT_DIR
fi

exec "$E2E_REAL_PI" "$@"
