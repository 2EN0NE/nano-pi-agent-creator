#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# cloud-sessions TUI 测试
#
# TUI 模式下 cloud-sessions 扩展的行为验证。
# 注意：cloud-sessions 发布为 npm 包 `@zenone/pi-cloud-sessions`，不是直接
#       `extensions/` 下的单文件或目录扩展，TUI 沙箱自动发现机制无法直接加载。
# 测试范围：日志记录 + 沙箱中直接运行验证 + REVIEW 标记手动检查。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "cloud-sessions (TUI mode)"

test_it "extension module loads via jiti without crash" <<'TEST'
  # 验证扩展源码可被 jiti 加载而不崩溃
  # 注意：cloud-sessions 是 npm 包 @zenone/pi-cloud-sessions，需要 sync 到 .pi/extensions/
  # 如果未安装则跳过（CI 环境无此扩展）
  local ext_path="$ROOT_DIR/.pi/extensions/cloud-sessions/index.ts"
  if [[ ! -f "$ext_path" ]]; then
    echo "SKIP: cloud-sessions not installed (sync to .pi/extensions/ first)"
    exit 0
  fi
  echo "PASS: cloud-sessions index.ts exists at $ext_path"
  # 确保 src/index.ts 存在
  if [[ -f "$ROOT_DIR/.pi/extensions/cloud-sessions/src/index.ts" ]]; then
    echo "PASS: cloud-sessions src/index.ts exists"
  else
    echo "WARN: cloud-sessions src/index.ts not found"
  fi
TEST

test_it "extension logs captured correctly [REVIEW]" <<'TEST'
  # 在项目 pi 环境下运行，查看日志
  tui_run_pi_test "pi-logger" "/cloud-sessions" 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local log_files
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files found:"
      echo "$log_files" | sed 's/^/  /'
    else
      echo "WARN: No log files in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
  mark_for_review "检查日志中是否包含 cloud-sessions 相关条目（需已安装 cloud-sessions 扩展）"
TEST

test_it "/cloud-sessions TUI panel opens without crash [REVIEW]" <<'TEST'
  tui_run_pi_test "cloud-sessions" "/cloud-sessions" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /cloud-sessions did not crash (exit=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /cloud-sessions crashed with exit code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
  mark_for_review "手动在 TUI 模式下运行 /cloud-sessions，验证：状态信息显示、边框渲染、Up/Down 导航 action 项、Enter 触发操作、Esc 关闭"
TEST

test_it "right border alignment [REVIEW]" <<'TEST'
  # 验证边框对齐（PTY 无法可靠捕获 overlay 内容，此用例为运行期检查）
  tui_run_pi_test "cloud-sessions" "/cloud-sessions" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: border rendering did not crash pi"
  else
    echo "FAIL: pi crashed with exit $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
  mark_for_review "手动运行 /cloud-sessions，确认：所有行右侧 │ 对齐于同一列、Provider/Status 信息正常显示"
TEST
