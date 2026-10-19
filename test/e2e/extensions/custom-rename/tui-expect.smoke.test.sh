#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# custom-rename — expect TUI 交互测试
# 验证 /auto-rename 打开 TUI 配置面板（SettingsList），Enter 切换开关并落盘。
#
# 断言策略（防假绿）：
#   - 面板打开：输出可见「auto-rename 设置」+「自动重命名」行（case 001）
#   - 开关落盘（case 002）：CI 模式预置「关 + mock 模型」配置（preset-home/），
#     Enter 后读沙箱 HOME 的 extensions-data config 断言 enabled=true——
#     以真实落盘为准，不依赖瞬时渲染帧（旧版仅断言输出含「开」，回滚瞬时帧即可假绿）
#
# 注：模型校验分支（canEnable）与 config 落盘细节由 headless 单测
# （custom-rename-ui.test.ts / custom-rename-pure.test.ts）覆盖。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "custom-rename (expect TUI mode)"

test_it "expect: /auto-rename opens TUI settings panel" <<'TEST'
  tui_expect_test "custom-rename" '
    send "/auto-rename\r"
    sleep 2
  ' 25

  if tui_output_contains "$TUI_OUTPUT_FILE" "auto-rename 设置"; then
    echo "PASS: settings panel opened"
  else
    echo "FAIL: settings panel not shown"
    exit 1
  fi
  if tui_output_contains "$TUI_OUTPUT_FILE" "自动重命名"; then
    echo "PASS: enabled row visible"
  else
    echo "FAIL: enabled row not visible"
    exit 1
  fi
  tui_cleanup
TEST

test_it "expect: Enter toggles auto-rename and persists enabled=true" <<'TEST'
  # CI 模式：mock-llm/mock-model-1 注入注册表。预置「关 + mock 模型」配置后，
  # Enter 应通过模型校验（canEnable）并把 enabled=true 落盘到沙箱用户级 config。
  #
  # 断言时机（关键）：必须在 Enter 后、测试收尾的 /quit 之前读文件——面板仍持有焦点时，
  # 模板收尾的 "/quit\r" 末尾 \r 会被面板当作再一次 Enter，把开关切回「关」。
  # 因此在 expect 内直接读 config 并输出标记，bash 侧断言标记。
  #
  # 非 CI 沙箱无模型注册表（开关无法通过校验），仅验证面板可开、pi 存活。
  if [[ "${CI:-false}" == "true" ]]; then
    tui_expect_test "custom-rename" '
      send "/auto-rename\r"
      # 条件等待面板真正渲染（而非裸 sleep）：裸 sleep 会把未读输出留在 pty 缓冲里，
      # 且面板挂载耗时不稳定，实测 Enter 会在挂载前被吞（pi 1.3.0 起更明显）。
      # 模式用面板标题而非命令回显（回显里也有 "/auto-rename"，会误判就绪）。
      wait_for {auto-rename 设置}
      sleep 0.5
      # 默认选中第 1 项「自动重命名」（预置为 关），Enter 切换 → 开并落盘
      send "\r"
      # 轮询到落盘（最多 5s），不依赖固定 sleep 与写盘时序
      set cfgfile $env(HOME)/.pi/agent/extensions-data/custom-rename/config.json
      set saved 0
      for {set i 0} {$i < 25} {incr i} {
        sleep 0.2
        if {[file exists $cfgfile]} {
          set fd [open $cfgfile r]
          set content [read $fd]
          close $fd
          if {[string match "*\"enabled\": true*" $content]} { set saved 1; break }
        }
      }
      # 结果写文件而非 send_user 打印：TUI 重绘会把 stdout 上的标记文本覆盖/截断
      # （实测日志里剩下 "offENAME_TOGGLE_SAVED"，首字符被面板擦掉 → 断言假红）。
      set rf [open $env(HOME)/toggle-result.txt w]
      puts $rf [expr {$saved ? "saved" : "not_saved"}]
      close $rf
    ' 30 80 "" "$ROOT_DIR/test/e2e/extensions/custom-rename/preset-home"
  else
    tui_expect_test "custom-rename" '
      send "/auto-rename\r"
      sleep 2
    ' 30
  fi

  local F=0
  # exit code 0 或 124（非退出命令超时）均视为 pi 正常存活路径
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: pi exit code $TUI_EXIT_CODE (expected)"
  else
    echo "FAIL: unexpected exit code $TUI_EXIT_CODE"
    F=$((F + 1))
  fi

  # 核心断言：Enter 后开关真实落盘。结果由 expect 写文件（屏幕文本会被 TUI 重绘覆盖），
  # 断言语义仍是「读真实 config」，不是 UI 瞬时帧。
  if [[ "${CI:-false}" == "true" ]]; then
    local result_file="$TUI_TEST_HOME/home/toggle-result.txt"
    if [[ -f "$result_file" ]] && [[ "$(cat "$result_file")" == "saved" ]]; then
      echo "PASS: enabled=true persisted to sandbox config"
    else
      echo "FAIL: enabled=true not persisted after Enter"
      echo "(expect result: $(cat "$result_file" 2>/dev/null || echo 'missing') — 开关被拦或 Enter 未落到面板)"
      F=$((F + 1))
    fi
  fi
  tui_cleanup
  exit $F
TEST
