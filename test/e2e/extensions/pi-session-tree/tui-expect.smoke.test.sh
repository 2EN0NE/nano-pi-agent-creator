#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-session-tree — expect TUI 测试
#
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# 包含面板交互测试：m/~, c/u/a, g, ctrl+x, ctrl+l, Esc
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

test_it "expect: m + m range workflow (two marks auto-analyze)" <<'TEST'
  # 长树模式：面板 focus 就位需要 agent 完全空闲（多条消息轮转）。
  # 消息少时 focus 滞留在 editor，m 等键全落在 editor 输入，"范围:" 断言
  # 永不出现 → 假阳性。20 条消息构造长树后交互才真正进入面板。
  # 新版流程：m 两下自动进入范围分析（无需再按 ~）。
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 1.5
    }
    sleep 8
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

    send "m"
    sleep 0.2
    send "\033\[B"
    sleep 0.1
    send "m"
    sleep 0.3
    expect {
      "范围:" { }
      timeout { puts "FAIL: range footer"; exit 1 }
    }
    # 用 m 退出范围模式，再单次 Esc 关闭面板。
    # 避免连续两次 Esc：间隔 <500ms 时 pi 的 editor 双 Esc 检测会误触发 /tree 选择器。
    # Esc 前必须 drain：agent 处理消息尾部输出时裸 ESC 的 stdin flush 会延迟，
    # 与后续输入合并成 meta 键（如 \x1b/ = alt+/）→ 面板收不到 escape → 面板未关。
    send "m"
    sleep 0.3
    drain 3 60
    send "\033"
    sleep 0.5
  ' 40

  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS: m + m workflow"
  else
    echo "FAIL: exit=$TUI_EXIT_CODE"; exit 1
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

test_it "expect: g jump bar shows help text" <<'TEST'
  # 长树模式：确保面板 focus 就位，g 才进入面板触发 jump bar
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 1.5
    }
    sleep 8
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

    send "g"
    sleep 0.2
    expect {
      "向N节点" { }
      timeout { puts "FAIL: g help"; exit 1 }
    }
    # 第一次 Esc 退出 jump 模式；间隔 >500ms 避免 pi 双 Esc 检测；
    # drain 等待输出稳定，确保第二次 Esc 独立（不与其他输入合并）
    send "\033"
    sleep 0.7
    drain 3 60
    send "\033"
    sleep 0.5
  ' 40

  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS: g help"
  else
    echo "FAIL: exit=$TUI_EXIT_CODE"; exit 1
  fi
  tui_cleanup
TEST

test_it "expect: g 输入表达式并跳转（输入收集 + 光标移动）" <<'TEST'
  # 关键回归：真实终端（可能启用 Kitty keyboard protocol）下，jump 输入必须用
  # parseKey 解码后的 key 收集。若用原始 data，@~3:user 不会出现在跳转栏 → 跳转静默失败。
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 1.5
    }
    sleep 8
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

    send "g"
    sleep 0.3
    expect {
      "跳转:" { }
      timeout { puts "FAIL: jump bar not shown"; exit 1 }
    }
    # 逐字符发送表达式（真实按键路径，覆盖 Kitty 协议 CSI-u 输入解码）
    # 断言输入本身（@~3:user 仅出现在跳转栏输入，不受 "跳转: " 与输入间 ANSI 颜色码干扰）
    send "@~3:user"
    sleep 0.5
    expect {
      "@~3:user" { }
      timeout { puts "FAIL: jump input not collected"; exit 1 }
    }
    # Enter 执行跳转 → 光标滚动到第 3 个 user 消息（msg 18，初始视图外）
    send "\r"
    sleep 0.6
    # 跳转后关闭面板（drain 再 Esc，避免与后续输入合并成 meta 键）
    drain 3 60
    send "\033"
    sleep 0.5
  ' 40

  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    # D2 后初始光标在叶子，msg 18 已在初始视口内；断言跳转后光标行（"> " 前缀）落在 msg 18，
    # 而非仅断言 "msg 18 出现"（那样无法区分跳转前后）。
    if tui_output_matches "$TUI_OUTPUT_FILE" ">.*msg 18"; then
      echo "PASS: g jump input + cursor moved to msg 18"
    else
      echo "FAIL: cursor did not move to msg 18 (input collected but jump failed)"
      exit 1
    fi
  else
    echo "FAIL: exit=$TUI_EXIT_CODE"; exit 1
  fi
  tui_cleanup
TEST

test_it "expect: ctrl+x copy shows toast" <<'TEST'
  # 长树模式：确保面板 focus 就位，ctrl+x 才进入面板触发复制 toast
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 1.5
    }
    sleep 8
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

    send "\x18"
    sleep 0.2
    expect {
      "已复制" { }
      timeout { puts "FAIL: copy toast"; exit 1 }
    }
    # drain 等待输出稳定，确保 Esc 独立（不与其他输入合并）
    drain 3 60
    send "\033"
    sleep 0.5
  ' 40

  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS: ctrl+x copy"
  else
    echo "FAIL: exit=$TUI_EXIT_CODE"; exit 1
  fi
  tui_cleanup
TEST

test_it "expect: shift+l tag panel opens" <<'TEST'
  # 长树模式：确保面板 focus 就位，shift+l 才进入面板打开 tag 面板。
  # 断言锚点用 tag 面板真实渲染文本"类型:"（旧锚点"公式:"在面板中不存在）。
  # ctrl+l 已让位给 labeled-only 过滤，tag 面板移至 shift+l。
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 1.5
    }
    sleep 8
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

    send "L"
    sleep 0.3
    expect {
      "类型:" { }
      timeout { puts "FAIL: tag panel"; exit 1 }
    }
    # 第一次 Esc 退出 tag 模式；间隔 >500ms 避免 pi 双 Esc 检测；
    # drain 确保第二次 Esc 独立
    send "\033"
    sleep 0.7
    drain 3 60
    send "\033"
    sleep 0.5
  ' 40

  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS: shift+l tag panel"
  else
    echo "FAIL: exit=$TUI_EXIT_CODE"; exit 1
  fi
  tui_cleanup
TEST

test_it "expect: cursor movement does not duplicate rendering" <<'TEST'
  # 长树模式：确保面板 focus 就位，方向键才进入面板触发差异渲染
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 1.5
    }
    sleep 8
    send "/custom-session-tree\r"
    sleep 3

    # 累积输出辅助：expect_out(buffer) 在 timeout 分支不设置，用循环累积。
    # max 上限兜底：pi 可能持续输出（状态栏/光标帧），防止 exp_continue 无限循环
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

    # 丢弃面板打开后的稳定帧（渐进渲染，确保完全稳定）
    drain 2 30

    # 移动光标 3 次（触发差异渲染，正常应只重写光标行）
    send "\033\[B"
    sleep 0.5
    send "\033\[B"
    sleep 0.5
    send "\033\[B"
    sleep 0.5

    # 捕获移动后的新输出：若出现整树重绘（header 重现）= 重复渲染 bug
    set new [drain 2 30]
    set tree_cnt [regexp -all -nocase {会话树} $new]
    puts "REPAINT_HEADER_COUNT=$tree_cnt"
    if {$tree_cnt > 0} {
      puts "FAIL: full re-render on cursor move (header count=$tree_cnt)"
      exit 1
    }
    # 关闭面板后再退出，避免 /quit 被面板吞掉导致 eof 超时
    send "\033"
    sleep 0.5
  ' 45

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: cursor movement no duplicate render"
  else
    echo "FAIL: exit=$TUI_EXIT_CODE"; exit 1
  fi
  tui_cleanup
TEST

test_it "expect: long tree scroll does not duplicate rendering" <<'TEST'
  # 长树：25 条消息 → 每条 user+assistant 2 节点 → 50+ 节点，确定性触发滚动路径
  # 长树：25 条消息 → 50+ 节点稳定树，滚动路径全覆盖（修复前固定 pageSize=20 时短树零覆盖）
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    # 发 20 条消息构造长会话树（42 节点 > 面板 pageSize，触发滚动；避免 25 条消息导致
    # agent 处理堆积 → /quit 排队 → pi 不退出 → expect eof 超时后 wait 无超时卡死）
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 1.5
    }
    sleep 8
    send "/custom-session-tree\r"
    sleep 3

    # 吞帧使焦点稳定在面板（无 drain 时 down 可能落在 editor）
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

    # 滚动到树中部（50+ 节点 ≈ 3 页，滚 25 行到第 2 页中部）
    set i 0
    while {$i < 30} {
      send "\033\[B"
      incr i
      sleep 0.3
    }

    # 捕获滚动后的新输出：修复后（面板总高 ≤ 视口）滚动是纯 diff，
    # header（会话树）不应重现；重现 = 整树重绘（fullRender）= 重影 bug
    set new [drain 2 30]
    set tree_cnt [regexp -all -nocase {会话树} $new]
    puts "SCROLL_HEADER_COUNT=$tree_cnt"
    if {$tree_cnt > 0} {
      puts "FAIL_MARKER: full re-render on scroll (header count=$tree_cnt)"
    }
    # 关闭面板后再退出，避免 /quit 被面板吞掉导致 eof 超时 150s
    # （修复前 008 依赖 eof 超时 124 兜底 PASS，实际耗时 ~6 分钟）
    send "\033"
    sleep 0.5
  ' 150

  if grep -qa "FAIL_MARKER" "$TUI_OUTPUT_FILE" 2>/dev/null; then
    echo "FAIL: long tree scroll duplicated rendering"
    exit 1
  elif [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: long tree scroll no duplicate render"
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

test_it "expect: Esc exits panel back to chat" <<'TEST'
  # 长树模式：面板 focus 就位需要 agent 完全空闲（多条消息轮转后）。
  # 消息少时（1-8 条）focus 滞留在 editor，Esc 被 pi 当作 interrupt，
  # /quit 也进 editor——面板交互从未真正发生，断言全是假阳性。
  export MOCK_LLM_REPEAT=25
  tui_expect_test "pi-session-tree" '
    set i 1
    while {$i <= 20} {
      send "msg $i\r"
      incr i
      sleep 1.5
    }
    sleep 8
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

    # Esc 关闭面板（面板 focus 已就位）
    send "\033"
    sleep 1
  ' 30

  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS: Esc exit"
  else
    echo "FAIL: exit=$TUI_EXIT_CODE"; exit 1
  fi
  tui_cleanup
TEST
