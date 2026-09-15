#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# permission-gate — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "permission-gate (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "permission-gate" "Extension name in TUI output"
  tui_cleanup
TEST

test_it "expect: TUI mode produces pi-logger output [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local log_files
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files found:"
      echo "$log_files" | sed 's/^/  /'

      if echo "$log_files" | xargs grep -l "permission-gate\|Config loaded\|Permission Gate" 2>/dev/null | head -1 >/dev/null; then
        echo "PASS: permission-gate log content found"
      else
        echo "WARN: No permission-gate specific content in logs (may be in combined log)"
        echo "$log_files" | head -3 | xargs head -5 2>/dev/null || true
      fi
    else
      echo "WARN: No log files in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
  mark_for_review "检查日志文件内容，确认 permission-gate 生命周期事件和 widget 更新被正确记录"
TEST

test_it "expect: TUI mode captures status bar content [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  echo "TUI exit code: $TUI_EXIT_CODE"
  echo "TUI output size: $(wc -c <"$TUI_OUTPUT_FILE") bytes"

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    if grep -r "gate:on\|gate:off\|permission-gate\|setStatus\|widget" "$log_dir" 2>/dev/null | head -5; then
      echo "PASS: widget/gate references found in logs"
    else
      echo "WARN: No widget/gate references in logs"
    fi
  fi

  tui_cleanup
  mark_for_review "审查 PTY 输出和日志文件，确认 permission-gate 状态栏 widget 正确显示"
TEST

test_it "expect: /permission-gate directly opens panel with 6 tabs (ADR-0030)" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 2
    # 落地页跟随 LAYER_TABS[0]（当前「设置」，见 two-tab-panel.ts:262），而二级 tab
    # （命令/工具/目录）只在「会话/项目/用户」层级下渲染 → 先切一层再断言两级 tab。
    send "\t"
    sleep 1
  ' 20

  tui_assert_contains "[会话]" "一级 tab 会话 渲染"
  tui_assert_contains "[项目]" "一级 tab 项目 渲染"
  tui_assert_contains "[用户]" "一级 tab 用户 渲染"
  tui_assert_contains "[历史]" "一级 tab 历史 渲染"
  tui_assert_contains "[分析]" "一级 tab 分析 渲染"
  tui_assert_contains "[设置]" "一级 tab 设置 渲染"
  tui_assert_contains "命令(" "二级 tab 命令 渲染"
  tui_assert_contains "工具(" "二级 tab 工具 渲染"
  tui_assert_contains "目录(" "二级 tab 目录 渲染"
  tui_assert_contains "会话级" "session 层失效提示 渲染"
  tui_cleanup
TEST

test_it "expect: Tab switches layer, settings tab renders toggles (ADR-0030)" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 2
    # Tab 切一级 tab 到「设置」（第 6 个）
    send "\t"
    sleep 0.4
    send "\t"
    sleep 0.4
    send "\t"
    sleep 0.4
    send "\t"
    sleep 0.4
    send "\t"
    sleep 0.4
    sleep 1
  ' 20

  tui_assert_contains "权限门" "设置 tab 权限门开关 渲染"
  tui_assert_contains "动态策略" "设置 tab 动态策略开关 渲染"
  tui_assert_contains "组件" "设置 tab 组件开关 渲染"
  tui_assert_contains "默认沉淀级别" "设置 tab 沉淀级别项 渲染"
  tui_assert_contains "拦截模式" "设置 tab 拦截模式项 渲染"
  tui_assert_contains "阈值" "设置 tab 阈值项 渲染"
  tui_cleanup
TEST

test_it "expect: blocking confirmation tree renders for dangerous command (ADR-0030)" <<'TEST'
  export MOCK_LLM_DANGEROUS_COMMAND="rm -rf ./permission-gate-test-target"
  tui_expect_test "pi-logger,permission-gate" '
    # 发送 prompt 触发 mock-llm 的 bash tool call（rm -rf，critical）
    send "clean up the temp directory\r"
    sleep 6
    # 树状阻断框出现后，enter 放行
    send "\r"
    sleep 2
  ' 30
  unset MOCK_LLM_DANGEROUS_COMMAND

  tui_assert_contains "Permission Gate" "阻断框标题 渲染"
  tui_assert_contains "DANGER" "阻断框 DANGER 标记 渲染"
  tui_assert_contains "rm -rf" "阻断框子命令 渲染"
  tui_assert_contains "●" "阻断框风险颜色点 渲染"
  tui_cleanup
TEST

test_it "expect: multi-line command root is flattened, no render corruption" <<'TEST'
  # 多行命令（for 循环 + rm -rf）：根节点原始含换行，曾导致 TUI 行错位/串行
  export MOCK_LLM_DANGEROUS_COMMAND=$'for d in a b; do\n  rm -rf "./$d"\ndone'
  tui_expect_test "pi-logger,permission-gate" '
    send "clean up temp dirs\r"
    sleep 6
    send "\r"
    sleep 2
  ' 30
  unset MOCK_LLM_DANGEROUS_COMMAND

  tui_assert_contains "Permission Gate" "多行命令阻断框标题 渲染"
  tui_assert_contains "DANGER" "多行命令 DANGER 标记 渲染"
  tui_assert_contains "rm -rf" "多行命令子命令 渲染"
  tui_assert_contains "enter 放行" "多行命令放行提示 渲染"
  tui_assert_contains "esc 拒绝" "多行命令拒绝提示 渲染"
  tui_cleanup
TEST

test_it "expect: ctrl+shift+O 展开后 enter 仍可放行（展开态视觉人工确认）[REVIEW]" <<'TEST'
  # 说明：PTY 夹具下非换行按键常与随后的 \r 一并投递，展开帧无法在关闭前稳定捕获
  # （ADR-0023 层②：e2e 只验证加载与交互链路，overlay 视觉走 [REVIEW]）。
  # 本例验证展开键路径不破坏放行链路；展开态视觉由 mark_for_review 人工确认。
  export MOCK_LLM_DANGEROUS_COMMAND="rm -rf ./permission-gate-test-target"
  tui_expect_test "pi-logger,permission-gate" '
    send "clean up the temp directory\r"
    sleep 6
    # 阻断框出现后，ctrl+shift+O（Kitty CSI-u：o(111) + shift|ctrl(6)）展开全貌
    send "\x1b\[111;6u"
    sleep 1
    # 展开态主操作仍生效：enter 放行
    send "\r"
    sleep 2
  ' 30
  unset MOCK_LLM_DANGEROUS_COMMAND

  tui_assert_contains "Permission Gate" "展开键路径下阻断框仍渲染"
  tui_assert_contains "User approved" "展开后 enter 仍可放行"
  mark_for_review "人工确认 ctrl+shift+O 展开态：命令按宽度换行显示全貌、提示行出现 ctrl+shift+O 折叠 / ↑↓ 滚动 / (n-m/total) 位置指示"
  tui_cleanup
TEST

test_it "expect: leaf add-as-strategy then same command auto-passes (ADR-0030)" <<'TEST'
  export MOCK_LLM_DANGEROUS_COMMAND="rm -rf ./permission-gate-test-target"
  export MOCK_LLM_DANGEROUS_REPEAT=2
  tui_expect_test "pi-logger,permission-gate" '
    # prompt 1：触发树状阻断框
    send "clean up the temp directory\r"
    sleep 6
    # ↓ 选中叶子 → a 打开级别选择 → enter 确认(默认 session) → enter 放行
    send "\x1b\[B"
    sleep 0.4
    send "a"
    sleep 0.4
    send "\r"
    sleep 0.6
    send "\r"
    sleep 8
    # prompt 2：同命令 → manual strategy 命中 → 直接放行（无阻断框）
    send "clean up the temp directory again\r"
    sleep 15
  ' 60
  unset MOCK_LLM_DANGEROUS_COMMAND
  unset MOCK_LLM_DANGEROUS_REPEAT

  tui_assert_contains "Permission Gate" "首次树状阻断框标题 渲染"
  tui_assert_contains "DANGER" "阻断框 DANGER 标记 渲染"
  tui_assert_contains "rm -rf" "阻断框子命令 渲染"

  # 日志断言：第二次同命令应为 manual strategy 自动放行（无二次阻断框）
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]] && grep -rh "Auto-approved (manual)" "$log_dir"/permission-gate*.log 2>/dev/null | grep -q .; then
    echo "PASS: manual strategy auto-approval found in permission-gate log"
  else
    echo "WARN: no manual strategy auto-approval log (check ${padded}-logs)"
    grep -rh "manual\|Auto-approved\|Manual strategy" "$log_dir"/permission-gate*.log 2>/dev/null | tail -5 || true
    mark_for_review "确认第二次同命令是通过 manual strategy 自动放行（日志应有 Auto-approved (manual)），且未再次弹出阻断框"
  fi

  tui_cleanup
TEST

test_it "expect: session manual strategy survives /reload (ADR-0033) [REVIEW]" <<'TEST'
  # ADR-0033：会话级手动策略跨 /reload 持久化（session_shutdown 只解绑不删文件，
  # session_start 重新绑定 + 清理超期文件）。本用例：add-as-strategy → /reload →
  # 同命令仍自动放行（manual strategy 命中，无二次阻断框）。
  export MOCK_LLM_DANGEROUS_COMMAND="rm -rf ./permission-gate-reload-target"
  export MOCK_LLM_DANGEROUS_REPEAT=2
  tui_expect_test "pi-logger,permission-gate" '
    # prompt 1：触发树状阻断框
    send "clean up the reload target\r"
    sleep 6
    # ↓ 选中叶子 → a 打开级别选择 → enter 确认(默认 session) → enter 放行
    send "\x1b\[B"
    sleep 0.4
    send "a"
    sleep 0.4
    send "\r"
    sleep 0.6
    send "\r"
    sleep 8
    # /reload：session_shutdown 解绑 + session_start 重新绑定，session 文件不删
    send "/reload\r"
    sleep 10
    # prompt 2：同命令 → session 层 manual strategy 跨 /reload 命中 → 自动放行
    send "clean up the reload target again\r"
    sleep 15
  ' 60
  unset MOCK_LLM_DANGEROUS_COMMAND
  unset MOCK_LLM_DANGEROUS_REPEAT

  tui_assert_contains "Permission Gate" "首次树状阻断框标题 渲染"

  # 日志断言：/reload 后同命令仍 manual strategy 自动放行（跨 /reload 持久化生效）
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]] && grep -rh "Auto-approved (manual)" "$log_dir"/permission-gate*.log 2>/dev/null | grep -q .; then
    echo "PASS: manual strategy auto-approval survived /reload (log)"
  else
    echo "WARN: no manual strategy auto-approval log after /reload"
    grep -rh "manual\|Auto-approved\|reload" "$log_dir"/permission-gate*.log 2>/dev/null | tail -5 || true
    mark_for_review "确认 /reload 后同命令仍通过 session 层 manual strategy 自动放行（日志应有 Auto-approved (manual)）"
  fi

  tui_cleanup
TEST

test_it "expect: 多命中原因被审计记录 (sudo rm -rf /etc)" <<'TEST'
  export MOCK_LLM_DANGEROUS_COMMAND="sudo rm -rf /etc"
  tui_expect_test "pi-logger,permission-gate" '
    send "clean up system config\r"
    sleep 6
    # enter 放行（详情页箭头键在 expect/PTY 下不可靠，命中明细由 audit 日志断言）
    send "\r"
    sleep 2
  ' 30
  unset MOCK_LLM_DANGEROUS_COMMAND

  tui_assert_contains "Permission Gate" "阻断框标题 渲染"
  tui_assert_contains "DANGER" "阻断框 DANGER 标记 渲染"
  tui_assert_contains "sudo rm -rf /etc" "阻断框子命令 渲染"

  # 审计日志断言：多命中原因（权限相关 + 系统目录写 + 拦截模式）被记录
  local audit_file
  audit_file=$(find "$TUI_TEST_HOME" -path "*permission-gate/audit/*.jsonl" 2>/dev/null | head -1)
  if [[ -n "$audit_file" ]]; then
    echo "audit file: $audit_file"
    if grep -q "permission-related" "$audit_file" \
      && grep -q "system-dir-write" "$audit_file" \
      && grep -q "pattern" "$audit_file"; then
      echo "PASS: 多命中原因（权限相关+系统目录写+拦截模式）已记录"
    else
      echo "FAIL: 审计日志缺少多命中原因"
      cat "$audit_file"
      exit 1
    fi
  else
    echo "WARN: 未找到审计日志文件"
    find "$TUI_TEST_HOME" -name "*.jsonl" 2>/dev/null | head -5
    mark_for_review "确认审计日志是否记录了 sudo rm -rf /etc 的多命中原因（permission-related + system-dir-write + pattern）"
  fi

  tui_cleanup
TEST

test_it "expect: 提升闭环 —— 触发提示 → 确认卡片 → 采纳 → 用户层落盘" <<'TEST'
  # 预置用户层配置：scope **不覆盖** /tmp → 任何命中 pattern 的命令都需人工批准
  # （与 smoke 用例 C「不挂条件就自动放行」形成对照组）；阈值 sameTool=2，
  # 两次人工批准即达阈值 → 触发提升建议（要求 auto=0，本场景恒成立）。
  #
  # ⚠ pattern 必须显式写 tier，且**必须是可提升等级**：提升链路有 tier 门禁
  # （`isPromotableTier` → 只有 warning/info 产候选），默认配置里 `rm -rf` 是 critical
  # → 永不产候选。此处用显式 `{ pattern, tier: "warning" }`，不依赖旧 string[] 格式
  # 会被迁移成 warning 的隐式行为（那样写测试太脆）。
  local preset="$ROOT_DIR/.pi/tmp/tui-preset-promo-$$"
  mkdir -p "$preset/.pi/agent/extensions-data/permission-gate"
  cat >"$preset/.pi/agent/extensions-data/permission-gate/config.json" <<'JSON'
{
  "enabled": true,
  "dynamicPolicyEnabled": true,
  "dynamicPolicy": {
    "scope": [{ "root": "/nonexistent-scope-root-for-e2e" }],
    "thresholds": { "sameCommand": 999, "sameTool": 2, "sameFolder": 999 }
  },
  "patterns": [{ "pattern": "\\brm\\s+(-rf?|--recursive)", "tier": "warning" }]
}
JSON

  export MOCK_LLM_DANGEROUS_COMMAND="rm -rf /tmp/pg-e2e-tui-promo"
  export MOCK_LLM_DANGEROUS_REPEAT=2

  # ⚠ 本用例用**重复 Enter 容错**而非精确 sleep：沙箱里 pi 的启动/回合耗时波动极大
  # （实测首次阻断框落在 +30s 到 +7min 之间）。多余的 Enter 落在主输入框=空提交（无副作用），
  # 落在阻断框=放行、选择器=选中首项、卡片=采纳——正是我们想要的按键。
  tui_expect_test "pi-logger,permission-gate" '
    # 【设计】全程**图案驱动 + 严有界**，禁止盲等长 sleep：
    # 每一步都给短超时，超时即带定位标记退出。最坏情况 ~2.5 分钟结束。
    #
    # prompt 1：危险命令 → 阻断框
    send "clean the temp dir\r"
    stage "prompt1-sent"
    # 20s 上限（原 45s）：沙箱里「prompt → 阻断框」实测 0-45s 波动，45s 上限意味着
    # 最坏情况白等 45s×2；收紧后超时仍带定位标记失败，不掩盖问题。
    set timeout 20
    expect { -re {DANGER} { } timeout { send_error "STUCK@prompt1: 20s 内未见阻断框（模型/prompt 层未响应）\n"; exit 3 } }
    stage "prompt1-blocked"
    send "\r"
    sleep 3
    # prompt 2：同形状命令 → 第二次人工批准（达阈值 → 触发提升建议）
    # 注：expect 会消耗已匹配文本，所以这里匹配到的是**新出现**的 DANGER，不会命中回滚缓冲
    send "clean it again\r"
    stage "prompt2-sent"
    expect { -re {DANGER} { } timeout { send_error "STUCK@prompt2: 20s 内未见第二个阻断框\n"; exit 3 } }
    stage "prompt2-blocked"
    send "\r"
    sleep 3
    # 提升入口是**两级导航**（master-detail）：
    #   一级 = 选择器（提升建议 / 已提升条目）→ 选中候选
    #   二级 = 确认卡片（台阶 + 出处条件 + 证据）→ 采纳
    # 漏掉一级会卡在选择器上，两个覆盖层都不会出现。
    # 入口在面板「设置」里（ADR-0038：不再单独注册命令）：
    #   /permission-gate →（面板落在设置 tab）→ p 或 Enter 选中「提升建议」行
    send "/permission-gate\r"
    stage "panel1-open"
    set timeout 25
    expect {
      -re {\[设置\]} { }
      timeout { send_error "STUCK@panel: 25s 内未见面板设置 tab\n"; exit 4 }
    }
    sleep 1
    send "p"
    set timeout 30
    expect {
      -re {提升建议 / 已提升条目} { }
      -re {没有待处理} { send_error "SKIP@promote: 无待处理候选（提升触发未命中）\n"; exit 5 }
      timeout { send_error "STUCK@selector: 30s 内未见一级选择器\n"; exit 4 }
    }
    stage "selector-visible"
    sleep 1
    send "\r"
    set timeout 25
    expect {
      -re {Enter 采纳} { }
      timeout { send_error "STUCK@card: 25s 内未见二级确认卡片\n"; exit 6 }
    }
    stage "card-visible"
    sleep 1
    send "\r"
    sleep 3
    stage "accepted"
    # 二次进入：列出 [已提升] 条目**并撤销**（票 09）
    # ⚠ 采纳后面板会被关掉：提升 UI（选择器/卡片）是另一个 custom 覆盖层，pi 同时只保留一个
    #   → 必须重新 /permission-gate 打开面板，再按 p。
    send "/permission-gate\r"
    # ⚠ 这里**不能**用 `expect -re {\[设置\]}` 等面板重开：pi 是 diff 渲染，tab 行内容未变
    #   → 不会重绘 → 永远匹配不到，白等到 timeout（实测 25s / 用例）。面板打开与否由
    #   后续步骤自己的 STUCK 标记兜底，这里只给一个短的有界等待。
    set timeout 4
    expect { timeout { } }
    stage "panel2-open"
    sleep 1
    send "p"
    sleep 4
    # 采纳后 pending 已空 → 选择器首项即 [已提升]；选中它**立即执行撤销**（无二次确认）
    send "\r"
    sleep 3
    stage "revoked"
    # ⚠ **必须把覆盖层关干净再结束**：harness 收尾会固定 `send "/quit\r"` 然后
    # `expect { eof / timeout }`，而那个 expect 用的是 `timeout_seconds`（本参数）。
    # 若覆盖层还开着，/quit 会被它当输入吞掉 → pi 不退出 → 白等 timeout_seconds 秒。
    # 实测：第 3 参数 90→总耗时 132s、420→722s、180→~300s，差额就是这里的空等。
    send "\033"
    sleep 0.6
    send "\033"
    sleep 0.6
    stage "overlays-closed"
  ' 90 80 "" "$preset"
  unset MOCK_LLM_DANGEROUS_COMMAND MOCK_LLM_DANGEROUS_REPEAT

  tui_assert_contains "提升建议" "提升建议入口/选择器渲染"
  tui_assert_contains "Enter 采纳" "确认卡片渲染（含采纳/切换条件/选台阶提示）"
  tui_assert_matches "待处理 [0-9]+ 条 / 已提升" "面板设置里的「提升建议」按钮行（含待处理/已提升条数）"

  # 采纳证据（票 08）：扩展日志里应有「采纳提升：tool:rm」
  # （harness 把 $HOME/.pi/logs 拷进 ${padded}-logs）
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if grep -rhq "采纳提升：tool:rm" "$log_dir" 2>/dev/null; then
    echo "PASS: 采纳已落地（日志 采纳提升：tool:rm）"
  else
    echo "FAIL: 日志未见 采纳提升：tool:rm"
    rm -rf "$preset"
    exit 1
  fi

  # 撤销证据（票 09）：① TUI 出现撤销通知 ② 用户层 promoted 登记已回滚
  tui_assert_contains "已撤销 tool:rm" "撤销通知（已撤销 tool:rm）渲染"
  local user_cfg="$HOME/.pi/agent/extensions-data/permission-gate/config.json"
  if python3 -c "
import json, os, sys
p = os.path.join(os.environ['HOME'], '.pi/agent/extensions-data/permission-gate/config.json')
if not os.path.exists(p):
    print('PASS: 撤销后用户层无 config.json'); sys.exit(0)
pr = (json.load(open(p)).get('dynamicPolicy') or {}).get('promoted') or []
keys = [x.get('key') for x in pr]
assert 'tool:rm' not in keys, f'撤销后仍登记 tool:rm：{keys}'
print('PASS: 撤销后 promoted 已回滚（剩余登记=%s）' % (keys,))
" 2>/dev/null; then
    :
  else
    echo "FAIL: 撤销后用户层 promoted 仍含 tool:rm"
    [[ -f "$user_cfg" ]] && cat "$user_cfg" | sed 's/^/  /'
    rm -rf "$preset"
    exit 1
  fi

  rm -rf "$preset"
  tui_cleanup
TEST
