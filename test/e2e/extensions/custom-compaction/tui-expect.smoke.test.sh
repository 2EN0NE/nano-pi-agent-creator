#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# custom-compaction — expect TUI 测试
# 验证：扩展在 TUI 模式加载不崩、/custom-compaction-setting 打开面板、
# 纯横线边框（ADR-0023）由 [REVIEW] 人工确认。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "custom-compaction (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "custom-compaction" '
    send "/custom-compaction-setting\r"
    sleep 3
    send "\x1b"
    sleep 1
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "custom-compaction" "Extension name in TUI output"
  tui_cleanup
TEST

test_it "expect: settings panel renders pure-horizontal border [REVIEW]" <<'TEST'
  tui_expect_test "custom-compaction" '
    send "/custom-compaction-setting\r"
    sleep 3
  ' 15

  # PTY 无法可靠还原 overlay，纯横线边框（── custom-compaction）只能人工确认
  mark_for_review "检查设置面板：顶边框为纯横线 '── custom-compaction'，无圆角字符（╭╮）、无竖线（│）"
  tui_cleanup
TEST

test_it "expect: settings panel produces pi-logger output [REVIEW]" <<'TEST'
  tui_expect_test "custom-compaction" '
    send "/custom-compaction-setting\r"
    sleep 3
    send "\x1b"
    sleep 1
  ' 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    echo "PASS: Log files found:"
    find "$log_dir" -name "*.log" -type f 2>/dev/null | sed 's/^/  /'
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
  mark_for_review "检查日志文件，确认 custom-compaction 面板打开/关闭被正确记录"
TEST

# ── Test 4: Invisible continue 完整链路（P0）──────────────────
# 验证「压缩成功 → 发送隐形 marker → context hook 过滤 → LLM 零文本 → 新 turn 恢复」。
#
# 为什么用 TUI 模式（pi -a）而非 --no-session：
#   ctx.compact() 是 fire-and-forget，--no-session 下 pi 处理完 prompt 立即退出，
#   摘要→onComplete 异步链来不及完成（日志只见 "Proactive compaction triggered"，
#   无 onComplete/onError）。TUI 交互模式 pi 不退出，压缩能完整跑完。
#
# 为什么发 12 个 prompt：Pi 的 prepareCompaction 用 keepRecentTokens=20000 从后往前
# 累积找切分点。单条超长 user 消息会把切分点顶到第一条消息，messagesToSummarize 为空
# （"Nothing to compact"）。多条 user 消息（每条 <20000 tokens）累积 >20000 后，
# 切分点落在中间，才有可摘要的历史。
test_it "expect: invisible continue full chain (marker filtered, zero text)" <<'TEST'
  export MOCK_LLM_RECORD_CONTEXT=1
  local TH
  TH=$(mktemp -d /tmp/cc-inv-XXXXXX)

  # 手动搭沙箱（复用 tui 辅助，避免 tui_expect_test 在 spawn 前无法注入 config）
  tui_copy_extensions "$TH/.pi/extensions" "custom-compaction,pi-logger,mock-llm"
  mkdir -p "$TH/.pi/logs"
  tui_setup_sandbox_home "$TH"

  # 配置：autoContinue + injectContinueText=false（隐形 continue）+ 1% 阈值
  mkdir -p "$HOME/.pi/agent/extensions-data/custom-compaction"
  printf '%s' '{"enabledProfileIds":["default"],"profiles":{"default":{"id":"default","name":"Default","model":"current","trigger":{"type":"context_percent","threshold":1},"mechanism":{"type":"summarize"},"prompt":"","autoContinue":true,"injectContinueText":false,"autoContinueMessage":"继续按目标完成任务，全部验证"}}}}' \
    > "$HOME/.pi/agent/extensions-data/custom-compaction/config.json"

  # 12 个 prompt（每个 ~2750 tokens），积累多轮消息供压缩切分
  local n
  for n in $(seq 1 12); do
    {
      printf 'Prompt %s: ' "$n"
      for _ in $(seq 1 100); do
        printf 'The quick brown fox jumps over the lazy dog while the slow turtle reads ancient scrolls in the morning light. '
      done
    } > "$TH/prompt$n.txt"
  done

  # 生成 expect 脚本：逐条发送 prompt，等待压缩 + 隐形 continue 跑完
  export TH
  {
    echo '#!/usr/bin/env expect'
    echo 'set timeout 120'
    echo 'log_user 1'
    echo 'set stty_init "cols 80 rows 24"'
    echo 'cd $env(TH)'
    echo 'spawn pi -a'
    echo 'expect { -re {\(auto\)|0\.0%/0} { } timeout { exit 124 } }'
    echo 'sleep 1'
    for n in $(seq 1 12); do
      echo "send \"[exec cat \$env(TH)/prompt$n.txt]\\r\""
      echo 'sleep 4'
    done
    echo 'sleep 15'
    echo 'send "/quit\r"'
    echo 'sleep 2'
    echo 'expect { eof { } timeout { exit 124 } }'
  } > "$TH/test.exp"
  chmod +x "$TH/test.exp"

  set +e
  expect "$TH/test.exp" > "$TH/tui.log" 2>&1
  set -e

  # 日志落点与 smoke 的 find_cc_log 一致：cwd($TH) 与隔离 HOME 两个位置
  local ext_log
  ext_log=$(ls -t "$TH"/.pi/logs/custom-compaction_*.log "$HOME"/.pi/logs/custom-compaction_*.log 2>/dev/null | grep -vE '_lab_|_config_' | head -1)
  echo "=== Log: $ext_log ==="
  [ -n "$ext_log" ] && grep -E "Compaction completed|Auto-continue|invisible marker" "$ext_log" || echo "(no ext log)"

  local P=0 F=0
  # 1. 压缩成功 + 隐形 marker 发送（确定性，非 REVIEW）
  if [ -n "$ext_log" ] && grep -q "Auto-continue: sending invisible marker" "$ext_log" 2>/dev/null; then
    P=$((P+1)); echo "[PASS] invisible marker sent after compaction"
  else
    F=$((F+1)); echo "[FAIL] invisible marker not sent (compaction did not complete)"
  fi
  # 2. LLM 零文本：全程无 marker 泄漏、无空 user 消息（context hook 过滤生效）
  if grep -qE "\[mock-llm-context\].*(has-invisible-marker=true|empty-user=true)" "$TH/tui.log" 2>/dev/null; then
    F=$((F+1)); echo "[FAIL] invisible marker leaked into LLM context"
  else
    P=$((P+1)); echo "[PASS] LLM context contains no invisible marker leak"
  fi
  # 3. 新 turn 恢复（mock-llm 被多次调用：用户 prompts + 压缩摘要 + 继续 turn）
  local calls
  calls=$(grep -ac "mock-llm-context" "$TH/tui.log" 2>/dev/null || echo 0)
  echo "[INFO] mock-llm call count=$calls"
  if [ "$calls" -ge 5 ] 2>/dev/null; then
    P=$((P+1)); echo "[PASS] multiple turns observed (>=5 calls)"
  else
    F=$((F+1)); echo "[FAIL] too few mock-llm calls (continue turn did not fire)"
  fi

  rm -rf "$TH"
  exit $F
TEST
