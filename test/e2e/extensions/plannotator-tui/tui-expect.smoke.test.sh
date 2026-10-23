#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# plannotator-tui — expect TUI 端到端测试（真实 pi，仅 mock LLM）
#
# 覆盖三条链路，全部落在「屏幕文本 + 假二进制 argv」这类可持久化证据上：
#   1. 非 Herdr 环境 → 告警，且不调任何二进制；
#   2. `last` 别名 → 用 PLANNOTATOR_TUI_BIN 指定的 plannotator-tui 打开面板，
#      argv 必须是 `herdr last --deliver-to <pane>`；
#   3. `send` 别名 → 走 `herdr plugin action invoke send-archive --plugin annotate`，
#      且只经 HERDR_BIN_PATH 解析（PATH 里没有 herdr 也能跑通）。
#
# 安全：所有外部二进制都替换为 $CASE_DIR 下的假脚本，绝不在真实 Herdr 里开面板 /
#       发送批注；HERDR_ENV / HERDR_PANE_ID 由用例显式设定（父进程可能就在 Herdr 里）。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "plannotator-tui extension (expect TUI mode)"

# 抽取视口文本（去 ANSI / 控制符 / 空行），供关键字断言
plannotator_visible_text() {
  local file="$1"
  extract_visible_text "$file" |
    tr -d '\000-\010\016-\037' |
    sed -E 's/\]8;;//g' |
    grep -v '^$'
}

test_it "expect: outside Herdr → warning, no binary invoked" <<'TEST'
  unset HERDR_ENV HERDR_PANE_ID

  tui_expect_test "plannotator-tui" '
    send "/plannotator-tui\r"
    sleep 2
  ' 20

  txt="$TUI_TEST_HOME/visible.txt"
  plannotator_visible_text "$TUI_OUTPUT_FILE" >"$txt"

  grep -qF "plannotator-tui" "$txt" || { echo "FAIL: 启动清单里没有 plannotator-tui"; exit 1; }
  grep -qF "当前不在 Herdr 会话里" "$txt" || {
    echo "FAIL: 未出现 Herdr 环境告警"
    tail -40 "$txt"
    exit 1
  }
  echo "PASS: 非 Herdr 环境告警显示在屏幕上"

  tui_cleanup
TEST

test_it "expect: menu lists the seven review targets" <<'TEST'
  # 一屏目标选择（对齐 /review）是本次改造的核心交互，必须在真实 TUI 里看到。
  # 七项全部断言：漏掉 last/newest/terminal 任一项，菜单回归不会被这个用例拦住。
  # 覆盖层故意留到收尾：实测在用例里补 ESC（1 次 / 2 次、0.6–1s 间隔）都无差别——
  # 首个 /quit 仍被吞，收尾固定走 helper 两段式退出（恒 +8~10s），300s 预算内不值得加按键。
  export HERDR_ENV=1
  export HERDR_PANE_ID=e2e:pane

  tui_expect_test "plannotator-tui" '
    send "/plannotator-tui\r"
    sleep 2
  ' 20

  txt="$TUI_TEST_HOME/visible.txt"
  plannotator_visible_text "$TUI_OUTPUT_FILE" >"$txt"

  for label in \
    "未提交的变更" "某个提交的变更" "全部文件" "文件夹" \
    "agent 最近回复" "agent 最新回复" "本 pane 最近终端输出"; do
    grep -qF "$label" "$txt" || {
      echo "FAIL: 菜单缺少「${label}」"
      tail -40 "$txt"
      exit 1
    }
  done
  # 终端批注已移除：菜单里不应再出现这两项
  if grep -qF "把终端批注" "$txt"; then
    echo "FAIL: 菜单仍含已移除的终端批注入口"
    exit 1
  fi
  echo "PASS: 一屏菜单七项目标齐全，且无终端批注残留"
  tui_cleanup
TEST

test_it "expect: 'last' opens the panel via PLANNOTATOR_TUI_BIN" <<'TEST'
  fake_tui="$CASE_DIR/fake-plannotator-tui.sh"
  fake_log="$CASE_DIR/fake-tui-calls.log"
  cat >"$fake_tui" <<FAKE
#!/bin/sh
printf '%s\n' "\$*" >> "$fake_log"
FAKE
  chmod +x "$fake_tui"
  : >"$fake_log"

  export HERDR_ENV=1
  export HERDR_PANE_ID=e2e:pane
  export PLANNOTATOR_TUI_BIN="$fake_tui"

  tui_expect_test "plannotator-tui" '
    send "/plannotator-tui last\r"
    sleep 2
  ' 20

  txt="$TUI_TEST_HOME/visible.txt"
  plannotator_visible_text "$TUI_OUTPUT_FILE" >"$txt"

  grep -qF "已在 Herdr 面板打开：last" "$txt" || {
    echo "FAIL: 未出现面板已打开提示"
    tail -40 "$txt"
    exit 1
  }
  if [[ -f "$fake_log" ]] && grep -qxF "herdr last --deliver-to e2e:pane" "$fake_log"; then
    echo "PASS: 假 plannotator-tui 收到 herdr last --deliver-to e2e:pane"
  else
    echo "FAIL: 假二进制 argv 不符（实际：$(cat "$fake_log" 2>/dev/null)）"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: removed 'send' warns and invokes nothing" <<'TEST'
  # 终端批注能力已移除（ticket 01）：参数仍被识别，但只给提示、不调用任何二进制。
  fake_tui="$CASE_DIR/fake-plannotator-tui.sh"
  fake_log="$CASE_DIR/fake-tui-calls.log"
  cat >"$fake_tui" <<FAKE
#!/bin/sh
printf '%s\n' "\$*" >> "$fake_log"
FAKE
  chmod +x "$fake_tui"
  : >"$fake_log"

  export HERDR_ENV=1
  export HERDR_PANE_ID=e2e:pane
  export PLANNOTATOR_TUI_BIN="$fake_tui"

  tui_expect_test "plannotator-tui" '
    send "/plannotator-tui send\r"
    sleep 2
  ' 20

  txt="$TUI_TEST_HOME/visible.txt"
  plannotator_visible_text "$TUI_OUTPUT_FILE" >"$txt"

  grep -qF "终端批注能力已移除" "$txt" || {
    echo "FAIL: 未出现「能力已移除」提示"
    tail -40 "$txt"
    exit 1
  }
  if [[ -s "$fake_log" ]]; then
    echo "FAIL: send 不应调用任何二进制（实际：$(cat "$fake_log")）"
    exit 1
  fi
  echo "PASS: send 仅提示已移除，未调用二进制"

  tui_cleanup
TEST
