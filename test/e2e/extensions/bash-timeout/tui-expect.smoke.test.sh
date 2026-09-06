#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# bash-timeout — expect TUI 测试
#
# 验证默认超时兜底在真实 Pi 进程（TUI 模式）里生效：
#   mock-llm 注入 `sleep 30` 的 bash 工具调用 → agent 执行 bash 工具 →
#   bash-timeout 的 tool_call 钩子注入项目级 config 的 2s 超时 →
#   2 秒后 bash 工具报 "Command timed out"。
#
# 为什么必须 TUI 模式：print 模式（--no-session）下 mock-llm 的 tool call
# 不触发 bash 工具执行（MOCK_LLM_TOOL_CALLS 只在 TUI 模式验证过，见
# pi-session-tree / pi-lab 的 tui-expect 测试）。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "bash-timeout extension (expect TUI mode)"

test_it "expect: default timeout kills a long-running command" <<'TEST'
  # 项目级 config 在 expect 里 exec 写入（pi 的 cwd = expect 的 cwd = 沙箱根），
  # bash-timeout 的 store 懒加载，首次 tool_call 时才读 config，时序安全。
  MOCK_LLM_TOOL_CALLS=1 MOCK_LLM_BASH_COMMAND="sleep 30" tui_expect_test "bash-timeout" '
    exec sh -c {mkdir -p .pi/extensions-data/bash-timeout && echo "{\"defaultTimeoutSeconds\": 2}" > .pi/extensions-data/bash-timeout/config.json}
    send "hi\r"
    sleep 12
  ' 25

  tui_assert_contains "timed out" "bash command should be killed by default timeout"
  tui_cleanup
TEST
