#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# org 扩展 — /org TUI 任务看板（expect 交互）
#
# 在真实 Pi TUI 进程内验证：
# 1) 打开 /org 看板 → 公司 tab 显示本机 org、任务列表渲染 → Esc 关闭无崩溃
# 2) 非派发人目录打开看板 → 人类强制验收（a→y）→ 账本 closed + human@
#
# 数据注入：tui 沙箱会隔离 HOME（export HOME=$test_home/home）；org 扩展在无
# ORG_ROOT 环境时默认读 $HOME/.pi/org —— 因此用 tui_expect_test 的 preset_home_dir
# 参数把 org 数据镜像进沙箱 HOME（避免跨环境传 env 的不可靠）。
# 成员目录（pi cwd）保留在 preset 外部的 mktemp 下，org.json 中 dir 用绝对路径。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "org extension (TUI 任务看板)"

test_it "expect: /org 无参打开看板 → 渲染本机组织与任务 → Esc 关闭" <<'TEST'
  ROOT="$(mktemp -d /tmp/org-tui-data-XXXX)"
  CHIEF_DIR="$ROOT/chief"
  mkdir -p "$CHIEF_DIR" "$ROOT/preset/.pi/org/dev-team/tasks"
  NOW="2026-01-01T00:00:00.000Z"

  cat >"$ROOT/preset/.pi/org/dev-team/org.json" <<EOF
{"schemaVersion":1,"name":"dev-team","chiefName":"chief","chiefDir":"$CHIEF_DIR","createdAt":"$NOW","updatedAt":"$NOW","members":[{"name":"chief","dir":"$CHIEF_DIR","role":"chief","manifest":{"label":"负责人"},"joinedAt":"$NOW"}]}
EOF
  cat >"$ROOT/preset/.pi/org/dev-team/tasks/M-aaa111.json" <<EOF
{"schemaVersion":1,"id":"M-aaa111","org":"dev-team","title":"冒烟看板任务","background":"演示面板渲染","items":["产出 out.md"],"dispatcher":"chief","dispatcherRole":"chief","dueAt":null,"createdAt":"$NOW","updatedAt":"$NOW","status":"todo","subTasks":[{"id":"S1","description":"写冒烟产物","dueAt":null,"assignees":[{"agent":"chief","dir":"$CHIEF_DIR","status":"invited","round":0,"deliveries":[]}]}],"history":[]}
EOF

  # 打开 /org 面板：断言标题 + 公司 tab 出现 dev-team + 任务标题渲染
  tui_expect_test "org" '
    send "/org\r"
    expect { -re {org:} { } timeout { send_error "FAIL: board did not render\n"; exit 2 } }
    wait_for {冒烟看板任务}
  ' 20 80 "$CHIEF_DIR" "$ROOT/preset"

  if [[ "$TUI_EXIT_CODE" -eq 0 || "$TUI_EXIT_CODE" -eq 124 ]]; then
    if tui_output_contains "$TUI_OUTPUT_FILE" "org:"; then
      if tui_output_contains "$TUI_OUTPUT_FILE" "冒烟看板任务"; then
        echo "PASS: /org 看板渲染本机组织任务列表"
      else
        echo "FAIL: 看板未显示组织 dev-team/任务（数据未注入沙箱 HOME？）"
        exit 1
      fi
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

test_it "expect: 非派发人目录打开看板 → 人类强制验收（a→y）→ 账本 closed + human@" <<'TEST'
  ROOT="$(mktemp -d /tmp/org-tui-data-XXXX)"
  CHIEF_DIR="$ROOT/chief"
  WB_DIR="$ROOT/worker-b"
  mkdir -p "$CHIEF_DIR" "$WB_DIR" "$ROOT/preset/.pi/org/dev-team/tasks"
  NOW="2026-01-01T00:00:00.000Z"
  LATER="2026-01-02T00:00:00.000Z"

  cat >"$ROOT/preset/.pi/org/dev-team/org.json" <<EOF
{"schemaVersion":1,"name":"dev-team","chiefName":"chief","chiefDir":"$CHIEF_DIR","createdAt":"$NOW","updatedAt":"$NOW","members":[{"name":"chief","dir":"$CHIEF_DIR","role":"chief","manifest":{"label":"负责人"},"joinedAt":"$NOW"},{"name":"worker-b","dir":"$WB_DIR","role":"member","manifest":{"label":"员工B"},"joinedAt":"$NOW"}]}
EOF
  cat >"$ROOT/preset/.pi/org/dev-team/tasks/M-hum001.json" <<EOF
{"schemaVersion":1,"id":"M-hum001","org":"dev-team","title":"人类验收目标","background":"chief 派发，worker-b 已交付","items":["产出 x.md"],"dispatcher":"chief","dispatcherRole":"chief","dueAt":null,"createdAt":"$NOW","updatedAt":"$LATER","status":"waiting_accept","subTasks":[{"id":"S1","description":"交付内容","dueAt":null,"assignees":[{"agent":"worker-b","dir":"$WB_DIR","status":"delivered","round":0,"deliveries":[{"at":"$LATER","by":"worker-b","summary":"完成交付","files":[{"path":"x.md"}]}]}]}],"history":[{"at":"$LATER","event":"delivered","by":"worker-b","note":"完成交付"}]}
EOF

  # 以 worker-b（非派发人）目录打开面板 → 等待验收 tab（3）→ 详情（回车）→ a → y
  tui_expect_test "org" '
    send "/org\r"
    expect { -re {org:} { } timeout { send_error "FAIL: board did not render\n"; exit 2 } }
    wait_for {dev-team}
    send "3"
    wait_for {人类验收目标}
    send "\r"
    expect { -re {人类强制|a 验收} { } timeout { send_error "FAIL: 详情/操作键未见\n"; exit 4 } }
    send "a"
    wait_for {确认}
    send "y"
    send "\x1b"
    sleep 1
  ' 25 80 "$WB_DIR" "$ROOT/preset"

  if [[ "$TUI_EXIT_CODE" -eq 0 || "$TUI_EXIT_CODE" -eq 124 ]]; then
    # 账本终态断言：pi 修改的是沙箱 HOME 内副本（preset 被拷贝进 test_home），断言读 $TUI_TEST_HOME/home
    LEDGER="$TUI_TEST_HOME/home/.pi/org/dev-team/tasks/M-hum001.json"
    # 轮询到条件（不依赖固定 sleep）：落账是异步写，慢机上给足窗口
    for _ in $(seq 1 40); do
      grep -q '"status": "closed"' "$LEDGER" 2>/dev/null && break
      sleep 0.25
    done
    grep -q '"status": "closed"' "$LEDGER" || { echo "FAIL: 人类验收未关闭任务"; exit 1; }
    grep -q '"event": "human_forced_approve"' "$LEDGER" || { echo "FAIL: 无 human_forced_approve 留痕"; exit 1; }
    grep -q '"by": "human@worker-b"' "$LEDGER" || { echo "FAIL: acceptance.by 非 human@worker-b"; exit 1; }
    echo "PASS: 人类强制验收（human@）闭环"
  else
    echo "FAIL: expect 异常退出码 $TUI_EXIT_CODE"
    exit 1
  fi
  tui_cleanup
TEST

test_it "expect: 成员视角四态圆点 + footer 按态键 + 成员详情诊断行" <<'TEST'
  ROOT="$(mktemp -d /tmp/org-tui-life-XXXX)"
  CHIEF_DIR="$ROOT/chief"; WA_DIR="$ROOT/worker-a"; SOCK="$ROOT/wa.sock"
  mkdir -p "$CHIEF_DIR" "$WA_DIR" "$ROOT/preset/.pi/org/dev-team/runtime"
  NOW="2026-01-01T00:00:00.000Z"

  # 起一个真实 unix socket 监听（只应答 ping）：让 worker-a 真的"在岗"
  node -e '
    const net = require("net");
    const s = net.createServer((c) => c.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          if (JSON.parse(line).type === "ping")
            c.write(JSON.stringify({type:"response",command:"ping",success:true})+"\n");
        } catch {}
      }
    }));
    s.listen(process.argv[1]);
  ' "$SOCK" &
  LISTENER=$!
  trap 'kill $LISTENER 2>/dev/null || true; rm -rf "$ROOT"' EXIT
  for _ in $(seq 1 30); do [[ -S "$SOCK" ]] && break; sleep 0.1; done

  cat >"$ROOT/preset/.pi/org/dev-team/org.json" <<EOF
{"schemaVersion":1,"name":"dev-team","chiefName":"chief","chiefDir":"$CHIEF_DIR","createdAt":"$NOW","updatedAt":"$NOW","members":[{"name":"chief","dir":"$CHIEF_DIR","role":"chief","manifest":{"label":"负责人"},"joinedAt":"$NOW"},{"name":"worker-a","dir":"$WA_DIR","role":"member","manifest":{"label":"员工A"},"joinedAt":"$NOW"}]}
EOF
  # worker-a：runtime + 可连 socket → 空闲；chief 无 runtime → 睡眠
  cat >"$ROOT/preset/.pi/org/dev-team/runtime/worker-a.json" <<EOF
{"schemaVersion":1,"name":"worker-a","dir":"$WA_DIR","pid":12345,"socketPath":"$SOCK","sessionId":"abc123def456","busy":false,"startedAt":"$NOW","updatedAt":"$NOW"}
EOF

  tui_expect_test "org" '
    send "/org\r"
    expect { -re {org:} { } timeout { send_error "FAIL: board did not render\n"; exit 2 } }
    wait_for {dev-team}
    # 说明：本用例靠方向键导航（右→成员视角、下→选中行），视图切换/选择落定没有
    # 唯一可匹配的屏幕标记（tab 标签与成员名在切换前就已在屏幕上），故这一段保留
    # 固定等待——改成 wait_for 会提前发送按键导致选择落错行（实测 FAIL）。
    send "\033\[C"
    sleep 2
    send "\033\[B"
    sleep 2
    send "\r"
    wait_for {成员 worker-a}
  ' 25 100 "$CHIEF_DIR" "$ROOT/preset"

  if [[ "$TUI_EXIT_CODE" -eq 0 || "$TUI_EXIT_CODE" -eq 124 ]]; then
    OUT="$TUI_OUTPUT_FILE"
    ok=0
    # footer 按态：默认选中睡眠的 chief → 只显示 w 唤醒（不是 s 睡眠）
    tui_output_contains "$OUT" "w 唤醒" || { echo "FAIL: 睡眠成员未显示「w 唤醒」"; ok=1; }
    # 成员行圆点（睡眠=暗空心 / 在岗=空心）
    tui_output_contains "$OUT" "worker-a" || { echo "FAIL: 成员列表未渲染 worker-a"; ok=1; }
    # 详情：状态词 + 诊断行（pid / 在岗 / 手工启动 / 会话前 6 位）
    tui_output_contains "$OUT" "成员 worker-a" || { echo "FAIL: 未进入成员详情"; ok=1; }
    tui_output_contains "$OUT" "空闲" || { echo "FAIL: 详情未显示状态词「空闲」"; ok=1; }
    tui_output_contains "$OUT" "pid 12345" || { echo "FAIL: 诊断行缺 pid"; ok=1; }
    tui_output_contains "$OUT" "在岗" || { echo "FAIL: 诊断行缺在岗时长"; ok=1; }
    tui_output_contains "$OUT" "手工启动" || { echo "FAIL: 诊断行未标明启动形态"; ok=1; }
    tui_output_contains "$OUT" "会话 abc123" || { echo "FAIL: 诊断行缺会话 id 前 6 位"; ok=1; }
    if [[ "$ok" -eq 0 ]]; then echo "PASS: 四态圆点 + footer 按态 + 诊断行"; else exit 1; fi
  else
    echo "FAIL: expect 异常退出码 $TUI_EXIT_CODE"
    exit 1
  fi
  tui_cleanup
TEST

# ══════════════════════════════════════════════════════════════════════════════
# 上岗链路（ADR-0046）：必要条件 → 显式上岗 → 条件丢失强制回落
#
# 用真实 pi 的**命令面**驱动全链路：
#   ① `/control on` 只让 org 变「可上岗」，**不得**自动上岗（control 驱动已解除）
#   ② `/org on` 才上岗（状态栏转为在岗计数）
#   ③ 在岗中 `/control off`（必要条件丢失）→ 强制回落（状态栏回到「未连接」）
#
# 断言口径 = **运行期证据**：取 TUI 输出里**最后一条** `|org:` 状态栏文本。
# 不用「在岗注册文件是否存在」：`session_shutdown` 会 clearRuntime，进程退出后该文件
# 必然消失（初版用例因此假阳性/假阴性）。
# ══════════════════════════════════════════════════════════════════════════════

# 造一个「worker-a 已加入 dev-team」的沙箱预设；回显 worker 目录（作为 pi 的 cwd）
duty_tui_preset() {
  local root="$1"
  local worker_dir="$root/worker-a"
  mkdir -p "$worker_dir" "$root/preset/.pi/org/dev-team/tasks"
  cat >"$root/preset/.pi/org/dev-team/org.json" <<EOF
{"schemaVersion":1,"name":"dev-team","chiefName":"chief","chiefDir":"$root/chief","createdAt":"$NOW","updatedAt":"$NOW","members":[{"name":"chief","dir":"$root/chief","role":"chief","manifest":{"label":"负责人"},"joinedAt":"$NOW"},{"name":"worker-a","dir":"$worker_dir","role":"member","manifest":{"label":"阿A"},"joinedAt":"$NOW"}]}
EOF
  printf '%s' "$worker_dir"
}

# 最后一条 org 状态栏文本（状态栏随操作重绘 → 取最后一条才是有序断言）
duty_last_status() {
  extract_visible_text "$TUI_OUTPUT_FILE" | grep -o '|org: [^|]*' | tail -1
}

# 短路径沙箱根：unix socket 路径上限约 104 字符（macOS），长仓库路径会让 control 建 socket
# 失败（listen EINVAL）→ 必须用短根（/tmp/od<pid>）。
duty_expect() {
  local root="$1" cwd="$2" preset="$3" timeout="$4" cmds="$5"
  export TUI_SANDBOX_ROOT="/tmp/od$$"
  tui_expect_test "org,control" "$cmds" "$timeout" 80 "$cwd" "$preset"
}

test_it "expect: 运行中 /control on 不自动上岗（状态栏停在「待上岗」）" <<'TEST'
  ROOT="$(mktemp -d /tmp/od1-XXXX)"
  NOW="2026-01-01T00:00:00.000Z"
  WORKER_DIR="$(duty_tui_preset "$ROOT")"

  duty_expect "$ROOT" "$WORKER_DIR" "$ROOT/preset" 25 '
    send "/control on\r"
    wait_for {待上岗}
  '

  LAST="$(duty_last_status)"
  if [[ "${LAST}" != *"待上岗"* ]]; then
    echo "FAIL: 最后一次状态栏应为「待上岗（/org on）」，实为：${LAST:-（未捕获）}"
    tui_cleanup; exit 1
  fi
  if tui_output_contains "$TUI_OUTPUT_FILE" "已在岗"; then
    echo "FAIL: 运行中 /control on 竟然自动上岗（ADR-0046 D1 被违反）"
    tui_cleanup; exit 1
  fi
  echo "PASS: /control on 只到「可上岗」——未自动上岗（状态栏：${LAST}）"
  tui_cleanup
TEST

test_it "expect: /control on → /org on 才上岗（状态栏转为在岗计数）" <<'TEST'
  ROOT="$(mktemp -d /tmp/od2-XXXX)"
  NOW="2026-01-01T00:00:00.000Z"
  WORKER_DIR="$(duty_tui_preset "$ROOT")"

  duty_expect "$ROOT" "$WORKER_DIR" "$ROOT/preset" 30 '
    send "/control on\r"
    expect { -re {待上岗} { } timeout { send_error "FAIL: /control on 后未进入「待上岗」\n"; exit 2 } }
    send "/org on\r"
    wait_for {成员}
  '

  LAST="$(duty_last_status)"
  if [[ "${LAST}" != *"成员"* ]]; then
    echo "FAIL: 最后一次状态栏应为在岗计数（x/y/z成员），实为：${LAST:-（未捕获）}"
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -20
    tui_cleanup; exit 1
  fi
  echo "PASS: /org on 上岗（状态栏：${LAST}）"
  tui_cleanup
TEST

test_it "expect: 在岗中 /control off 强制回落（状态栏回到「未连接」）" <<'TEST'
  ROOT="$(mktemp -d /tmp/od3-XXXX)"
  NOW="2026-01-01T00:00:00.000Z"
  WORKER_DIR="$(duty_tui_preset "$ROOT")"

  duty_expect "$ROOT" "$WORKER_DIR" "$ROOT/preset" 35 '
    send "/control on\r"
    expect { -re {待上岗} { } timeout { send_error "FAIL: 未进入待上岗\n"; exit 2 } }
    send "/org on\r"
    expect { -re {已在岗} { } timeout { send_error "FAIL: 未上岗成功\n"; exit 2 } }
    send "/control off\r"
    wait_for {未连接}
  '

  LAST="$(duty_last_status)"
  if [[ "${LAST}" != *"未连接"* ]]; then
    echo "FAIL: 必要条件丢失后状态栏应回到「未连接（/control on）」，实为：${LAST:-（未捕获）}"
    tui_cleanup; exit 1
  fi
  echo "PASS: 必要条件丢失 → 强制回落（状态栏：${LAST}）"
  tui_cleanup
TEST

# ── 用例 007：人类强制取消（x → 确认）→ human_forced_cancel ────────────────────
# 覆盖缺口：`human_forced_*` 家族此前只有 approve 有 e2e；人类取消（看板 `x`）无覆盖。
# 口径与 002 一致：以账本终态为准（human_forced_cancel + closed + by=human@<目录>）。
test_it "expect: 非派发人目录打开看板 → 人类强制取消（x→y）→ 账本 closed + human_forced_cancel" <<'TEST'
  ROOT="$(mktemp -d /tmp/org-tui-cancel-XXXX)"
  CHIEF_DIR="$ROOT/chief"
  WB_DIR="$ROOT/worker-b"
  mkdir -p "$CHIEF_DIR" "$WB_DIR" "$ROOT/preset/.pi/org/dev-team/tasks"
  NOW="2026-01-01T00:00:00.000Z"
  LATER="2026-01-02T00:00:00.000Z"

  cat >"$ROOT/preset/.pi/org/dev-team/org.json" <<EOF
{"schemaVersion":1,"name":"dev-team","chiefName":"chief","chiefDir":"$CHIEF_DIR","createdAt":"$NOW","updatedAt":"$NOW","members":[{"name":"chief","dir":"$CHIEF_DIR","role":"chief","manifest":{"label":"负责人"},"joinedAt":"$NOW"},{"name":"worker-b","dir":"$WB_DIR","role":"member","manifest":{"label":"员工B"},"joinedAt":"$NOW"}]}
EOF
  cat >"$ROOT/preset/.pi/org/dev-team/tasks/M-can001.json" <<EOF
{"schemaVersion":1,"id":"M-can001","org":"dev-team","title":"人类取消目标","background":"chief 派发，worker-b 已交付","items":["产出 x.md"],"dispatcher":"chief","dispatcherRole":"chief","dueAt":null,"createdAt":"$NOW","updatedAt":"$LATER","status":"waiting_accept","subTasks":[{"id":"S1","description":"交付内容","dueAt":null,"assignees":[{"agent":"worker-b","dir":"$WB_DIR","status":"delivered","round":0,"deliveries":[{"at":"$LATER","by":"worker-b","summary":"完成交付","files":[{"path":"x.md"}]}]}]}],"history":[{"at":"$LATER","event":"delivered","by":"worker-b","note":"完成交付"}]}
EOF

  # 以 worker-b（非派发人）目录打开面板 → 待验收 tab（3）→ 详情（回车）→ x → y（确认）
  tui_expect_test "org" '
    send "/org\r"
    expect { -re {org:} { } timeout { send_error "FAIL: board did not render\n"; exit 2 } }
    wait_for {dev-team}
    send "3"
    wait_for {人类取消目标}
    send "\r"
    expect { -re {人类强制|x 取消} { } timeout { send_error "FAIL: 详情/操作键未见\n"; exit 4 } }
    send "x"
    wait_for {确认}
    send "y"
    send "\x1b"
    sleep 1
  ' 25 80 "$WB_DIR" "$ROOT/preset"

  if [[ "$TUI_EXIT_CODE" -eq 0 || "$TUI_EXIT_CODE" -eq 124 ]]; then
    LEDGER="$TUI_TEST_HOME/home/.pi/org/dev-team/tasks/M-can001.json"
    for _ in $(seq 1 40); do
      grep -q '"status": "closed"' "$LEDGER" 2>/dev/null && break
      sleep 0.25
    done
    grep -q '"status": "closed"' "$LEDGER" || { echo "FAIL: 人类取消未关闭任务"; exit 1; }
    grep -q '"event": "human_forced_cancel"' "$LEDGER" || { echo "FAIL: 无 human_forced_cancel 留痕"; exit 1; }
    grep -q '"by": "human@worker-b"' "$LEDGER" || { echo "FAIL: 取消留痕 by 非 human@worker-b"; exit 1; }
    echo "PASS: 人类强制取消（human_forced_cancel）闭环"
  else
    echo "FAIL: expect 异常退出码 $TUI_EXIT_CODE"
    exit 1
  fi
  tui_cleanup
TEST
