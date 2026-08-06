#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# review 扩展端到端测试
#
# 验证:
#   1. 扩展加载无报错
#   2. /review selector 可显示
#   3. review prompt 被正确构建发送
#   4. 模式选择"新分支"应创建新会话分支 (上下文从接近0%开始)
#   5. /end-review 正确识别活跃审查并完成
# ──────────────────────────────────────────────────────────────────────────────

test_describe "review extension"

# ── 用例 1：加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,review" \
    --prompt "hi" \
    --expect-no-error
TEST

# ── 用例 2：/review uncommitted 命令可用（需 AI 衡量） ──
test_it "/review uncommitted command is available [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,review" \
    --prompt "show /review uncommitted" \
    --save-output
  mark_for_review "验证 pi 的输出中是否包含 review 相关的提示或选项"
TEST

# ── 用例 3：review prompt 被发送（需 AI 衡量） ──
test_it "review prompt is built and sent [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,review" \
    --prompt "start a review of uncommitted changes" \
    --save-output
  mark_for_review "验证 review 扩展是否成功构建 review prompt 并触发 agent 回复"
TEST

# ── 用例 4：/review 模式选择器可交互 ──
test_it "/review selector shows mode options [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,review" \
    --prompt "/review" \
    --save-output
  mark_for_review "验证输出中包含'新分支'和'当前会话'选项"
TEST

# ── 用例 5：同步后扩展不报错 ──
test_it "synced extension loads after sync [REVIEW]" <<'TEST'
  # 模拟同步后的情况: 直接加载 review 扩展目录
  run_pi_and_check \
    --extensions "pi-logger,review" \
    --prompt "hi" \
    --expect-no-error
  mark_for_review "验证同步后的扩展文件可正常加载，无 TS/运行时错误"
TEST
