#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# preset — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "preset extension (expect TUI mode)"

test_it "expect: /preset command triggers without crash" <<'TEST'
  tui_expect_test "pi-logger,preset" '
    send "/preset\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /preset TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /preset TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  padded=$(printf '%03d' "$CASE_INDEX")
  log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    ext_refs=$(grep -rl "preset" "$log_dir" 2>/dev/null || true)
    if [[ -n "$ext_refs" ]]; then
      echo "PASS: preset references found in logs: $ext_refs"
    else
      echo "WARN: No preset references in logs (background extension may not log)"
      ls "$log_dir" 2>/dev/null || true
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup 2>/dev/null || true
TEST

test_it "expect: loads preset in TUI mode without errors" <<'TEST'
  tui_expect_test "pi-logger,preset" '
    send "/preset\r"
    sleep 3
  ' 15

  if tui_output_contains "$TUI_OUTPUT_FILE" "Error"; then
    echo "FAIL: Found 'Error' in TUI output"
    exit 1
  fi
  echo "PASS: TUI output shows no errors"

  padded=$(printf '%03d' "$CASE_INDEX")
  log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null | head -5 || true)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files exist:"
      echo "$log_files"
    else
      echo "WARN: No log files found in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup 2>/dev/null || true
TEST

test_it "expect: /preset opens panel with scope markers [REVIEW]" <<'TEST'
  # 预置 user 级 config.json（含 plan preset），面板应显示 [全局] 来源标记
  local preset_home="$ROOT_DIR/.pi/tmp/preset-e2e-home-$$"
  mkdir -p "$preset_home/.pi/agent/extensions-data/preset"
  cat > "$preset_home/.pi/agent/extensions-data/preset/config.json" <<'JSON'
{ "plan": { "provider": "anthropic", "model": "claude-sonnet-4-5", "thinkingLevel": "high" } }
JSON

  tui_expect_test "pi-logger,preset" '
    send "/preset\r"
    sleep 3
  ' 15 80 "" "$preset_home"

  local F=0
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: pi exit code $TUI_EXIT_CODE"
  else
    echo "FAIL: unexpected exit code $TUI_EXIT_CODE"
    F=$((F + 1))
  fi
  tui_assert_contains "选择预设" "面板标题应显示" || F=$((F + 1))
  tui_assert_contains "[全局] plan" "来源标记应显示" || F=$((F + 1))

  rm -rf "$preset_home"
  tui_cleanup
  exit $F
TEST

test_it "expect: → enters detail showing preset fields [REVIEW]" <<'TEST'
  # 打开面板 → ↑ 导航到 plan → → 进详情，断言详情页唯一字段（不激活，避免 notify 干扰）
  local preset_home="$ROOT_DIR/.pi/tmp/preset-e2e-home-$$"
  mkdir -p "$preset_home/.pi/agent/extensions-data/preset"
  cat > "$preset_home/.pi/agent/extensions-data/preset/config.json" <<'JSON'
{ "plan": { "provider": "anthropic", "model": "claude-sonnet-4-5", "thinkingLevel": "high", "tools": ["read"], "instructions": "你是规划专家" } }
JSON

  tui_expect_test "pi-logger,preset" '
    proc drain {secs max} {
      set acc ""
      set n 0
      expect {
        -re {.+} {
          append acc $expect_out(0,string)
          if {[incr n] >= $max} { return $acc }
          exp_continue
        }
        -timeout $secs timeout { }
      }
      return $acc
    }
    send "/preset\r"
    drain 2 30
    send "\033\[A"
    sleep 0.3
    send "\033\[C"
    drain 2 30
  ' 25 80 "" "$preset_home"

  local F=0
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: pi exit code $TUI_EXIT_CODE"
  else
    echo "FAIL: unexpected exit code $TUI_EXIT_CODE"
    F=$((F + 1))
  fi
  tui_assert_contains "预设详情" "详情页标题应显示" || F=$((F + 1))
  tui_assert_contains "Thinking" "详情应展示字段标签" || F=$((F + 1))
  tui_assert_contains "你是规划专家" "详情应展示 instructions" || F=$((F + 1))

  rm -rf "$preset_home"
  tui_cleanup
  exit $F
TEST

test_it "expect: e enters edit mode showing 6 fields [REVIEW]" <<'TEST'
  # 文件级 plan：→ 详情 → e（复制为临时）→ 进编辑，断言编辑模式 6 字段渲染
  local preset_home="$ROOT_DIR/.pi/tmp/preset-e2e-home-$$"
  mkdir -p "$preset_home/.pi/agent/extensions-data/preset"
  cat > "$preset_home/.pi/agent/extensions-data/preset/config.json" <<'JSON'
{ "plan": { "provider": "anthropic", "model": "claude-sonnet-4-5", "thinkingLevel": "high", "tools": ["read"], "skills": [], "instructions": "你是规划专家" } }
JSON

  tui_expect_test "pi-logger,preset" '
    proc drain {secs max} {
      set acc ""
      set n 0
      expect {
        -re {.+} {
          append acc $expect_out(0,string)
          if {[incr n] >= $max} { return $acc }
          exp_continue
        }
        -timeout $secs timeout { }
      }
      return $acc
    }
    send "/preset\r"
    drain 2 30
    send "\033\[A"
    sleep 0.3
    send "\033\[C"
    drain 2 30
    send "e"
    drain 2 30
  ' 25 80 "" "$preset_home"

  local F=0
  tui_assert_contains "编辑预设" "编辑标题应显示" || F=$((F + 1))
  tui_assert_contains "Skills" "编辑应展示 Skills 字段" || F=$((F + 1))
  tui_assert_contains "Tools" "编辑应展示 Tools 字段" || F=$((F + 1))

  rm -rf "$preset_home"
  tui_cleanup
  exit $F
TEST

test_it "expect: /mode opens model selector without adapter contract error [REVIEW]" <<'TEST'
  # /mode（ADR-0034）走 model.ts 的 ModelSelectorComponent 适配器（脆弱契约，按 pi ^0.84.x 验证）。
  # 本用例只验证：/mode 打开不 crash + 适配器 Proxy 未抛「未适配」契约错误。
  # setModel/setThinkingLevel/偏离逻辑由 preset.integration.test.ts 的 /mode 单测覆盖。
  tui_expect_test "pi-logger,preset" '
    send "/mode\r"
    sleep 3
  ' 15

  local F=0
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /mode TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /mode TUI exited with code $TUI_EXIT_CODE"
    F=$((F + 1))
  fi

  # model.ts 适配器契约未破坏：输出不含「未适配」错误（Proxy 抛错即说明 pi 契约变更）
  if tui_output_contains "$TUI_OUTPUT_FILE" "未适配"; then
    echo "FAIL: ModelSelectorComponent adapter contract broken (未适配 error)"
    F=$((F + 1))
  fi

  tui_cleanup
  exit $F
TEST
