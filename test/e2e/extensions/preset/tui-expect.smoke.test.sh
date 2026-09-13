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

test_it "expect: 激活带 tools 的 preset → /tools 视图 == 白名单（ADR-0049 语义）" <<'TEST'
  # 预置 user 级 plan preset（tools 白名单 = ['read']），激活后 /tools 应显示 1/N 且锁定
  local preset_home="$ROOT_DIR/.pi/tmp/preset-e2e-home-$$"
  mkdir -p "$preset_home/.pi/agent/extensions-data/preset"
  cat > "$preset_home/.pi/agent/extensions-data/preset/config.json" <<'JSON'
{ "plan": { "tools": ["read"] } }
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
    send "/preset plan\r"
    drain 2 30
    send "/tools\r"
    drain 3 40
    send "\033\[B"
    drain 2 30
  ' 30 110 "" "$preset_home"

  local F=0
  tui_assert_contains "Enabled tools: 1/" "激活后 /tools 视图应等于白名单（1/N）" || F=$((F + 1))
  tui_assert_contains "预设锁定" "/tools 应显示 [预设锁定]" || F=$((F + 1))
  # 封闭集：非白名单工具的详情应标注来源（下移一项展示 bash 的描述）
  tui_assert_contains "被预设限制（封闭集），不可启用" "受限工具应标注预设来源" || F=$((F + 1))

  rm -rf "$preset_home"
  tui_cleanup
  exit $F
TEST

test_it "expect: 激活后 /tools 写操作被拒绝并告警（ADR-0049 契约4）" <<'TEST'
  # 激活带 tools 白名单的 preset → 在 /tools 面板 toggle（写操作）应被拒绝 + error 告警
  local preset_home="$ROOT_DIR/.pi/tmp/preset-e2e-home-$$"
  mkdir -p "$preset_home/.pi/agent/extensions-data/preset"
  cat > "$preset_home/.pi/agent/extensions-data/preset/config.json" <<'JSON'
{ "plan": { "tools": ["read"] } }
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
    send "/preset plan\r"
    drain 2 30
    send "/tools\r"
    drain 3 40
    send " "
    drain 2 30
  ' 30 110 "" "$preset_home"

  local F=0
  tui_assert_contains "修改不被允许" "写操作应被拒绝并告警" || F=$((F + 1))
  tui_assert_contains "Enabled tools: 1/" "拒绝后活动集不应变化（仍为白名单 1/N）" || F=$((F + 1))

  rm -rf "$preset_home"
  tui_cleanup
  exit $F
TEST

test_it "expect: 清除 preset → /tools 回到无限制（ADR-0049 契约2）" <<'TEST'
  local preset_home="$ROOT_DIR/.pi/tmp/preset-e2e-home-$$"
  mkdir -p "$preset_home/.pi/agent/extensions-data/preset"
  cat > "$preset_home/.pi/agent/extensions-data/preset/config.json" <<'JSON'
{ "plan": { "tools": ["read"] } }
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
    send "/preset plan\r"
    drain 2 30
    send "/preset\r"
    drain 2 30
    send "\033\[B"
    sleep 0.5
    send " "
    drain 2 30
    send "/tools\r"
    drain 3 40
  ' 30 110 "" "$preset_home"

  local F=0
  tui_assert_not_contains "预设锁定" "清除后 /tools 不应再显示锁定" || F=$((F + 1))
  # 基础层原本启用的 bash 应恢复启用（白名单态下为禁用），证明 overlay 已撤回
  tui_assert_contains "• bash" "清除后基础层工具应恢复启用" || F=$((F + 1))
  tui_assert_not_contains "Enabled tools: 1/" "清除后活动集不应仍为白名单 1/N" || F=$((F + 1))

  rm -rf "$preset_home"
  tui_cleanup
  exit $F
TEST

test_it "expect: /reload 后已清除的 preset 不复活（ADR-0049 契约3）" <<'TEST'
  local preset_home="$ROOT_DIR/.pi/tmp/preset-e2e-home-$$"
  mkdir -p "$preset_home/.pi/agent/extensions-data/preset"
  cat > "$preset_home/.pi/agent/extensions-data/preset/config.json" <<'JSON'
{ "plan": { "tools": ["read"], "instructions": "你是规划专家" } }
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
    send "/preset plan\r"
    drain 2 30
    send "/preset\r"
    drain 2 30
    send "\033\[B"
    sleep 0.5
    send " "
    drain 2 30
    send "/reload\r"
    drain 4 50
    send "/tools\r"
    drain 3 40
  ' 40 110 "" "$preset_home"

  local F=0
  tui_assert_not_contains "预设锁定" "/reload 后已清除的 preset 不应复活（无锁定）" || F=$((F + 1))
  tui_assert_contains "• bash" "/reload 后基础层工具应仍启用（overlay 未复活）" || F=$((F + 1))

  rm -rf "$preset_home"
  tui_cleanup
  exit $F
TEST

test_it "expect: preset 封闭集遮罩动态注册工具（ADR-0050 契约2）" <<'TEST'
  # dynamic-tool 助手在加载期注册 mock_search；preset tools=['read'] 激活后
  # /tools 面板中该动态工具应被标注为「被预设限制（封闭集）」
  local preset_home="$ROOT_DIR/.pi/tmp/preset-e2e-home-$$"
  mkdir -p "$preset_home/.pi/agent/extensions-data/preset"
  cat > "$preset_home/.pi/agent/extensions-data/preset/config.json" <<'JSON'
{ "plan": { "tools": ["read"] } }
JSON

  tui_expect_test "pi-logger,preset,dynamic-tool" '
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
    send "/preset plan\r"
    drain 2 30
    send "/tools\r"
    drain 3 40
    send "mock"
    drain 2 30
  ' 30 110 "" "$preset_home"

  local F=0
  tui_assert_contains "mock_search" "动态注册工具应出现在 /tools 列表" || F=$((F + 1))
  tui_assert_contains "被预设限制（封闭集），不可启用" "动态工具应被 overlay 遮罩" || F=$((F + 1))

  rm -rf "$preset_home"
  tui_cleanup
  exit $F
TEST
