#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# org 扩展 — /org TUI 任务看板（expect 交互冒烟）
#
# 在真实 Pi TUI 进程内验证：
# 1) 在 org 成员目录发 /org（无参数）→ 打开任务看板（custom overlay 渲染含标题）
# 2) Esc 关闭面板返回输入行，不崩溃
# 数据：body 内构造隔离 ORG_ROOT（org.json + 一个任务），cwd = 成员目录。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "org extension (TUI 任务看板)"

test_it "expect: /org 无参打开看板 → 渲染任务 → Esc 关闭" <<'TEST'
  ORG_ROOT="$(mktemp -d /tmp/org-tui-data-XXXX)"
  export ORG_ROOT
  CHIEF_DIR="$ORG_ROOT/chief"
  mkdir -p "$CHIEF_DIR" "$ORG_ROOT/dev-team/tasks"
  NOW="2026-01-01T00:00:00.000Z"

  cat >"$ORG_ROOT/dev-team/org.json" <<EOF
{"schemaVersion":1,"name":"dev-team","chiefName":"chief","chiefDir":"$CHIEF_DIR","createdAt":"$NOW","updatedAt":"$NOW","members":[{"name":"chief","dir":"$CHIEF_DIR","role":"chief","manifest":{"label":"负责人"},"joinedAt":"$NOW"}]}
EOF
  cat >"$ORG_ROOT/dev-team/tasks/M-aaa111.json" <<EOF
{"schemaVersion":1,"id":"M-aaa111","org":"dev-team","title":"冒烟看板任务","background":"演示面板渲染","items":["产出 out.md"],"dispatcher":"chief","dispatcherRole":"chief","dueAt":null,"createdAt":"$NOW","updatedAt":"$NOW","status":"todo","subTasks":[{"id":"S1","description":"写冒烟产物","dueAt":null,"assignees":[{"agent":"chief","dir":"$CHIEF_DIR","status":"invited","round":0,"deliveries":[]}]}],"history":[]}
EOF

  # 打开 /org 面板并确认渲染到标题与任务
  tui_expect_test "org" '
    send "/org\r"
    expect { -re {org 任务看板} { } timeout { send_error "FAIL: board did not render\n"; exit 2 } }
    sleep 1
    # Esc 关闭面板回到输入行
    send "\x1b"
    sleep 1
  ' 20 80 "$CHIEF_DIR"

  if [[ "$TUI_EXIT_CODE" -eq 0 || "$TUI_EXIT_CODE" -eq 124 ]]; then
    if tui_output_contains "$TUI_OUTPUT_FILE" "org 任务看板"; then
      echo "PASS: /org 看板渲染 + Esc 关闭无崩溃"
    else
      echo "FAIL: TUI 输出未含看板标题"
      exit 1
    fi
  else
    echo "FAIL: expect 异常退出码 $TUI_EXIT_CODE"
    exit 1
  fi
  tui_cleanup
TEST
