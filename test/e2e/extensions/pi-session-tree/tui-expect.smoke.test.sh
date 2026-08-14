#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-session-tree — expect TUI 测试
#
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
#
# 结构（集中方案，2026-08 重构）：
#   ① TUI load no crash       — 空交互加载（快，~15s）
#   ② c/u/a filter toggle      — 短交互过滤（~20s）
#   ③ 91col ghosting repro     — 真实 pi 渲染缺陷复现（~30s，诊断用，不阻塞）
#   ④ consolidated long-tree   — 8 个长树交互合并到单进程（~85s）
#
# 为什么集中：原 8 个长树交互（m+m / g help / g jump / ctrl+x / shift+l /
#   cursor / scroll / Esc）各自独立 spawn pi 并重发 20 条消息构造长树，
#   仅构造前置（sleep 0.5×20 + sleep 8 ≈ 18s）× 8 ≈ 144s 纯重复开销。
#   合并后共享一次构造，省 ~150s，且 sleep 1.5 → 0.5 再省 ~160s。
#
# 失败定位（consolidated 用例内）：
#   - 每步输出 STEP_BEGIN <id> <名称> / STEP_OK <id> <名称>
#   - 失败统一走 fail proc：输出 FAIL_MARKER step=<id> reason=<原因> 后 exit 1
#   - 排查：grep "FAIL_MARKER" cases/<NNN>-tui-output.log 即知失败步骤；
#     完整 pi-logger 日志在 cases/<NNN>-logs/，渲染诊断在 cases/<NNN>-render-*.log（③ 用例）
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-session-tree (expect TUI mode)"

test_it "expect: extension loads in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-session-tree" '
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: c/u/a filter toggle without crash" <<'TEST'
  tui_expect_test "pi-session-tree" '
    send "filter test\r"
    sleep 1
    send "/custom-session-tree\r"
    sleep 1
    send "c"
    sleep 0.2
    send "c"
    sleep 0.2
    send "u"
    sleep 0.2
    send "a"
    sleep 0.2
    send "\033"
    sleep 0.5
  ' 20

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: c/u/a toggle"
  else
    echo "FAIL: exit=$TUI_EXIT_CODE"; exit 1
  fi
  tui_cleanup
TEST

test_it "expect: 91col narrow terminal + active tools scroll ghosting repro (KNOWN PI ISSUE)" <<'TEST'
  # 已知问题复现（pi 渲染缺陷，扩展侧无解——见 docs/pi-ext-knowledge/pi-session-tree-ghosting.md）：
  #   chat 区活跃更新（工具执行的多行输出） + 底部组件 → pi 行定位错位 → 叠印/堆积
  #   触发条件：agent 活跃（工具执行/消息追加）时打开面板滚动 → fullRender(true) → 同步输出失效时重影
  #   扩展侧验证：方案1(overlay)/方案2(wrap防护) 实测均不解决（root cause 在 pi-tui diff/doRender）
  #   本用例为诊断复现（不阻塞）：输出叠印统计供分析；若未来 pi 修复后此处应能检测到改善
  export MOCK_LLM_TOOL_CALLS=5
  export PI_TUI_DEBUG=1
  export PI_DEBUG_REDRAW=1
  tui_expect_test "pi-session-tree" '
    # 触发工具调用（bash 长命令 → chat 区多行输出），agent 保持活跃
    send "读一下 handoff 文件\r"
    sleep 20
    send "/custom-session-tree\r"
    sleep 3

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
    drain 2 30

    # agent 仍活跃时滚动树（用户场景）
    set i 0
    while {$i < 15} {
      send "\033\[B"
      incr i
      sleep 0.3
    }
    set new [drain 2 30]
    # 统计：滚动后 header（会话树）重现次数（>0 = fullRender 触发 = pi 缺陷路径）
    set tree_cnt [regexp -all -nocase {会话树} $new]
    # 统计：chat 工具输出（cat:）与树行（▼ [bash]）叠印候选（同一物理行内同时出现）
    set ghost_cnt 0
    set lines [split $new "\n"]
    foreach l $lines {
      if {[string match "*cat:*" $l] && [string match "*▼*" $l]} { incr ghost_cnt }
    }
    puts "ACTIVE_TREE_HEADER=$tree_cnt GHOST_LINES=$ghost_cnt"
    # 关闭面板后再退出，避免 /quit 被面板吞掉导致 eof 超时
    send "\033"
    sleep 0.5
  ' 60 91

  # bash 层：收集 PI_TUI_DEBUG 日志供分析（行定位/行宽）
  if [[ -d /tmp/tui ]]; then
    cp /tmp/tui/render-*.log "$CASE_DIR/" 2>/dev/null || true
  fi
  echo "PASS: known-issue repro case executed (diagnostics in CASE_DIR)"
  tui_cleanup
TEST

test_it "expect: consolidated long-tree panel interactions (single process)" <<'TEST'
  # ─────────────────────────────────────────────────────────────────────────
  # 集中方案：8 个长树交互合并到一个 pi 进程，共享一次 20 条消息构造。
  #
  # 8 个交互（均需 agent 完全空闲后面板 focus 才就位）：
  #   01 m+m range / 02 g help / 03 g jump @~3:user / 04 ctrl+x copy
  #   05 shift+l tag / 06 cursor 移动 / 07 长树滚动 / 08 Esc 退出
  #
  # 失败定位约定：
  #   - 每步 step_begin/step_ok 输出 "STEP_BEGIN/STEP_OK <id> <名称>"
  #   - 失败统一走 fail proc → "FAIL_MARKER step=<id> reason=<原因>" 后 exit 1
  #   - 排查入口：grep "FAIL_MARKER" cases/<NNN>-tui-output.log
  #     （该文件由 tui_expect_test 自动持久化，含完整 expect 输出 + TUI 渲染帧）
  #   - pi-logger 日志：cases/<NNN>-logs/（扩展自身 error 在此）
  # ─────────────────────────────────────────────────────────────────────────
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    # ── 构造长树（一次）：20 条消息 → 42 节点 > 面板 pageSize，确定性触发滚动 ──
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 0.5
    }
    sleep 8

    # ── 辅助 proc ──
    # drain：吞帧直到输出停止 secs 秒（或匹配 max 次兜底），返回累积文本
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
    # fail：统一失败出口，输出可定位的 FAIL_MARKER 后退出
    proc fail {step reason} {
      puts "FAIL_MARKER step=$step reason=$reason"
      exit 1
    }
    proc step_begin {id name} { puts "STEP_BEGIN $id $name" }
    proc step_ok {id name} { puts "STEP_OK $id $name" }
    # open_panel：打开面板并等渲染稳定（drain 信号代替固定 sleep）
    proc open_panel {} {
      send "/custom-session-tree\r"
      drain 3 30
    }
    # close_panel：drain 后 Esc 关面板（避免 Esc 与其他输入合并成 meta 键）
    proc close_panel {} {
      drain 3 60
      send "\033"
      sleep 0.5
    }

    # ── 01) m + m range workflow（两下 m 自动进入范围分析）──
    step_begin "01-range" "m+m range workflow"
    open_panel
    send "m"
    sleep 0.2
    send "\033\[B"
    sleep 0.1
    send "m"
    sleep 0.3
    expect {
      "范围:" { }
      timeout { fail "01-range" "range footer not shown" }
    }
    send "m"
    sleep 0.3
    close_panel
    step_ok "01-range" "m+m range workflow"

    # ── 02) g jump bar help ──
    step_begin "02-ghelp" "g jump bar help text"
    open_panel
    send "g"
    sleep 0.2
    expect {
      "向N节点" { }
      timeout { fail "02-ghelp" "g jump bar help text not shown" }
    }
    send "\033"
    sleep 0.7
    drain 3 60
    send "\033"
    sleep 0.5
    step_ok "02-ghelp" "g jump bar help text"

    # ── 03) g jump input @~3:user + 光标移动到 msg 18 ──
    # 关键回归：真实终端（Kitty keyboard protocol）下 jump 输入必须用 parseKey
    # 解码后的 key 收集；且跳转后光标应落在第 3 个 user 消息（msg 18）。
    step_begin "03-jump" "g jump @~3:user + cursor to msg 18"
    open_panel
    send "g"
    sleep 0.3
    expect {
      "跳转:" { }
      timeout { fail "03-jump" "jump bar not shown" }
    }
    send "@~3:user"
    sleep 0.5
    expect {
      "@~3:user" { }
      timeout { fail "03-jump" "jump input not collected (@~3:user)" }
    }
    send "\r"
    sleep 0.6
    # 断言跳转后光标行（"> " 前缀）落在 msg 18，而非仅断言 "msg 18 出现"
    # （那样无法区分跳转前后）。先 strip ANSI 颜色码再匹配。
    set new [drain 2 30]
    set stripped [regsub -all {\x1b\[[0-9;]*[A-Za-z]} $new ""]
    if {![regexp {>.*msg 18} $stripped]} {
      fail "03-jump" "cursor did not move to msg 18 (input collected but jump failed)"
    }
    close_panel
    step_ok "03-jump" "g jump @~3:user + cursor to msg 18"

    # ── 04) ctrl+x copy toast ──
    step_begin "04-copy" "ctrl+x copy toast"
    open_panel
    send "\x18"
    sleep 0.2
    expect {
      "已复制" { }
      timeout { fail "04-copy" "copy toast not shown" }
    }
    close_panel
    step_ok "04-copy" "ctrl+x copy toast"

    # ── 05) shift+l tag panel ──
    step_begin "05-tag" "shift+l tag panel"
    open_panel
    send "L"
    sleep 0.3
    expect {
      "类型:" { }
      timeout { fail "05-tag" "tag panel not shown" }
    }
    send "\033"
    sleep 0.7
    drain 3 60
    send "\033"
    sleep 0.5
    step_ok "05-tag" "shift+l tag panel"

    # ── 06) cursor movement no duplicate render ──
    # 移动光标 3 次触发差异渲染；若 header（会话树）重现 = 整树重绘 bug
    step_begin "06-cursor" "cursor movement no duplicate render"
    open_panel
    send "\033\[B"
    sleep 0.5
    send "\033\[B"
    sleep 0.5
    send "\033\[B"
    sleep 0.5
    set new [drain 2 30]
    set cnt [regexp -all -nocase {会话树} $new]
    if {$cnt > 0} {
      fail "06-cursor" "full re-render on cursor move (header count=$cnt)"
    }
    send "\033"
    sleep 0.5
    step_ok "06-cursor" "cursor movement no duplicate render"

    # ── 07) long tree scroll no duplicate render ──
    # 滚动 30 行到树中部；header 重现 = fullRender = 重影 bug
    step_begin "07-scroll" "long tree scroll no duplicate render"
    open_panel
    set j 0
    while {$j < 30} {
      send "\033\[B"
      incr j
      sleep 0.3
    }
    set new [drain 2 30]
    set cnt [regexp -all -nocase {会话树} $new]
    if {$cnt > 0} {
      fail "07-scroll" "full re-render on scroll (header count=$cnt)"
    }
    send "\033"
    sleep 0.5
    step_ok "07-scroll" "long tree scroll no duplicate render"

    # ── 08) Esc exits panel ──
    step_begin "08-esc" "Esc exits panel"
    open_panel
    send "\033"
    sleep 1
    step_ok "08-esc" "Esc exits panel"
  ' 120

  # bash 层：失败时提取定位信息（FAIL_MARKER + 步骤轨迹 + 末尾可见输出）
  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS: consolidated long-tree interactions"
  else
    echo "FAIL: consolidated interactions exit=$TUI_EXIT_CODE"
    if [[ -f "$TUI_OUTPUT_FILE" ]]; then
      echo "  ── 失败定位（步骤轨迹）──"
      grep -aE "FAIL_MARKER|STEP_BEGIN|STEP_OK" "$TUI_OUTPUT_FILE" | tail -20
      echo "  ── 末尾 TUI 可见输出 ──"
      extract_visible_text "$TUI_OUTPUT_FILE" | tail -30
    fi
    exit 1
  fi
  tui_cleanup
TEST
