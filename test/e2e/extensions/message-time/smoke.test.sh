#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# message-time — 加载冒烟
# print 模式下验证扩展可加载、无异常。核心 UI 断言在
# tui-expect.smoke.test.sh（实时 + 回放两条链路 + 启动扩展清单）。
#
# 注：此扩展不在 print 模式做日志断言——pi-logger 的文件 appender 走异步
#     appendFile，而 mock 会话（pi -p "hi"）只有毫秒级就退出，日志写盘存在竞争，
#     断言会天然 flaky。扩展「确实被加载」由 TUI 用例的 [Extensions] 清单断言覆盖。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "message-time extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,message-time" \
    --prompt "hi" \
    --expect-no-error
  exit 0
TEST
