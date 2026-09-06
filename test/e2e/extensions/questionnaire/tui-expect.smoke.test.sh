#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# questionnaire — expect TUI 测试（多选交互）
#
# 使用 mock-llm-questionnaire 触发模型调用 questionnaire 工具（multiSelect 问题），
# 验证多选 UI 渲染复选框、空格勾选多项、Enter 确认提交。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "questionnaire (expect TUI mode — multi-select)"

test_it "expect: multi-select toggles multiple options via space and submits" <<'TEST'
  tui_expect_test "mock-llm-questionnaire,questionnaire" '
    # 触发模型 → 模型调用 questionnaire 工具 → 问卷 UI 出现
    send "hi\r"
    # 等待多选复选框出现（[ ] 1.）
    expect {
      -re {\[ \] 1\.} { }
      timeout { exit 1 }
    }
    sleep 1
    # 空格勾选第 1 项
    send " "
    sleep 1
    # 下移并勾选第 2 项
    send "\033\[B"
    sleep 1
    send " "
    sleep 1
    # Enter 确认选择 → 进入提交页
    send "\r"
    sleep 1
    # 等待提交页出现
    expect {
      -re {按 Enter 提交} { }
      timeout { exit 1 }
    }
    sleep 1
    # 显式 Enter 提交（不再依赖框架收尾 /quit 的尾随 Enter）
    send "\r"
    sleep 2
  ' 20

  # 断言提交链路真实跑通（Thanks 是问卷提交后 mock 的第二响应，仅在 submit 后出现）
  tui_assert_contains "Thanks, answer received." "问卷提交后模型返回确认"
  # 工具结果包含两个选中项（[OK] q1: 前缀仅在提交后的工具结果中出现，提交页回显无此前缀）
  tui_assert_contains "[OK] q1: 1. 选项 A, 2. 选项 B" "工具结果包含两个选中项"
  tui_cleanup
TEST

test_it "expect: 多选勾选后改用「输入其他」，自定义文本成为唯一答案且复选框残留被清除" <<'TEST'
  tui_expect_test "mock-llm-questionnaire,questionnaire" '
    # 触发问卷
    send "hi\r"
    expect {
      -re {\[ \] 1\.} { }
      timeout { exit 1 }
    }
    sleep 1
    # 空格勾选第 1 项
    send " "
    sleep 1
    # 下移到第 2 项并勾选
    send "\033\[B"
    sleep 1
    send " "
    sleep 1
    # 继续下移到末尾的"输入其他。"行（A/B/C/other 共 4 行，当前在第 2 行）
    send "\033\[B"
    sleep 1
    send "\033\[B"
    sleep 1
    # Enter 进入自定义输入
    send "\r"
    sleep 1
    # 键入自定义文本并提交（ASCII，避免 expect/PTY 编码不确定性）
    send "custom-text-answer\r"
    sleep 1
    # 自定义提交后应已进入提交页
    expect {
      -re {按 Enter 提交} { }
      timeout { exit 1 }
    }
    sleep 1
    # ← 返回问题页：勾选集合应已被清空，选项 A 应显示 [ ] 而非 [x]
    send "\x1b\[D"
    sleep 1
    expect {
      -re {\[ \] 1\. 选项 A} { }
      timeout { exit 1 }
    }
    # 再前进到提交页并提交
    send "\x1b\[C"
    sleep 1
    send "\r"
    sleep 2
  ' 25

  # 自定义文本是该问题的唯一答案（wasCustom 路径），而非勾选项
  tui_assert_contains "[OK] q1: (wrote) custom-text-answer" "自定义文本成为唯一答案"
  # 回访问题页的复选框清空已在 expect 脚本内做屏幕级断言（匹配 [ ] 1. 选项 A）。
  # 不能在此用 tui_assert_not_contains "[x]" 检查全量输出——勾选阶段本就产生过 [x]。
  # 答案不应以选项格式（1. 选项 A…）回显
  tui_assert_not_contains "[OK] q1: 1. 选项 A" "自定义答案不应包含勾选项"
  tui_cleanup
TEST

test_it "expect: Esc 取消问卷 → terminate 收尾，不再触发后续模型调用（无孤儿 tool 消息）" <<'TEST'
  tui_expect_test "mock-llm-questionnaire,questionnaire" '
    # 触发问卷
    send "hi\r"
    expect {
      -re {\[ \] 1\.} { }
      timeout { exit 1 }
    }
    sleep 1
    # 在问题页直接 Esc → 取消整份问卷（submit(true)）
    send "\x1b"
    sleep 4
  ' 20

  # terminate 生效时取消后不再有第二轮模型调用（mock 的第二响应 Thanks 不应出现）；
  # 若取消未 terminate，agent 会追加孤儿 tool 消息继续调用 → 该断言失败即捕获回归
  tui_assert_not_contains "Thanks, answer received." "取消后不应触发后续模型调用（terminate 收尾）"
  # 400 类孤儿 tool 消息错误不应出现在输出中
  tui_assert_not_contains "tool_calls" "取消收尾不应产生孤儿 tool 消息错误"
  tui_cleanup
TEST
