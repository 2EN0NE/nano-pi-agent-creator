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
    wait_for {org:}
    wait_for {冒烟看板任务}
  ' 60 80 "$CHIEF_DIR" "$ROOT/preset"

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
    wait_for {org:}
    wait_for {dev-team}
    send "3"
    wait_for {人类验收目标}
    send "\r"
    wait_for {人类强制|a 验收}
    send "a"
    wait_for {确认}
    send "y"
    send "\x1b"
    sleep 1
  ' 60 80 "$WB_DIR" "$ROOT/preset"

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
    wait_for {org:}
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
  ' 60 100 "$CHIEF_DIR" "$ROOT/preset"

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

test_it "expect: /control on → /org on → /control off 状态栏三态时间线（单进程）" <<'TEST'
  # ── 合并依据（ADR-0046 D1 / ADR-0070；范式见 pi-session-tree 的 consolidated single process）──
  # 原 004/005/006 是**同一条时间线**的三个切点：待上岗 → 在岗计数 → 未连接。
  # 三条原本各自起一次真实 pi + control socket（沙箱/tmux/冷启动 ~40-90s），在 2 核 CI 上
  # 纯属重复开销 → 合并为一次 spawn。断言也比原先更强：三态必须**都出现**且末态为「未连接」，
  # 而 expect 的阻塞式等待天然保证了它们**按序**发生。
  # 失败定位：grep -aE "STEP_BEGIN|STEP_OK|FAIL_MARKER" cases/<NNN>-tui-output.log
  # ─────────────────────────────────────────────────────────────────────────────────
  ROOT="$(mktemp -d /tmp/od-all-XXXX)"
  NOW="2026-01-01T00:00:00.000Z"
  WORKER_DIR="$(duty_tui_preset "$ROOT")"

  duty_expect "$ROOT" "$WORKER_DIR" "$ROOT/preset" 90 '
    puts "STEP_BEGIN 01-controlOn /control on → 待上岗（不得自动上岗）"
    send "/control on\r"
    # 注意：expect 的 braced body **必须多行**——整段写在一行时 expect 会把它当成
    # 单个 glob 模式（`expect -d` 可见 `match glob pattern " -re {…} … "`），
    # 于是既不会匹配、超时动作也不会执行，等于一条恒真的空断言。
    expect {
      -re {待上岗} { puts "STEP_OK 01-controlOn" }
      timeout { puts "FAIL_MARKER step=01-controlOn"; send_error "FAIL: /control on 后未进入「待上岗」\n"; exit 2 }
    }

    puts "STEP_BEGIN 02-orgOn /org on → 在岗计数"
    send "/org on\r"
    expect {
      -re {成员} { puts "STEP_OK 02-orgOn" }
      timeout { puts "FAIL_MARKER step=02-orgOn"; send_error "FAIL: /org on 后未转成在岗计数\n"; exit 3 }
    }

    puts "STEP_BEGIN 03-controlOff /control off → 强制回落未连接"
    send "/control off\r"
    expect {
      -re {未连接} { puts "STEP_OK 03-controlOff" }
      timeout { puts "FAIL_MARKER step=03-controlOff"; send_error "FAIL: /control off 后未回落「未连接」\n"; exit 4 }
    }
  '

  if [[ "$TUI_EXIT_CODE" -ne 0 && "$TUI_EXIT_CODE" -ne 124 ]]; then
    echo "FAIL: expect 异常退出码 $TUI_EXIT_CODE"
    grep -aE "STEP_BEGIN|STEP_OK|FAIL_MARKER" "$TUI_OUTPUT_FILE" 2>/dev/null | tail -10
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -15
    tui_cleanup; exit 1
  fi

  # 三态必须都出现过（顺序已由 expect 阻塞式断言保证）
  for pair in "待上岗|/control on 未到「待上岗」" "成员|/org on 未在岗" "未连接|/control off 未回落"; do
    text="${pair%%|*}"; msg="${pair##*|}"
    tui_output_contains "$TUI_OUTPUT_FILE" "$text" || { echo "FAIL: $msg"; tui_cleanup; exit 1; }
  done

  # 末态断言（006 原口径）：状态栏最后一条必须是「未连接」
  LAST="$(duty_last_status)"
  if [[ "${LAST}" != *"未连接"* ]]; then
    echo "FAIL: 末态状态栏应为「未连接（/control on）」，实为：${LAST:-（未捕获）}"
    tui_cleanup; exit 1
  fi

  # 004 原关键断言：运行中 /control on 不得自动上岗（ADR-0046 D1）。
  # 判据：**/control on 那段窗口内**（从开跑到 `STEP_BEGIN 02-orgOn`，即 /org on 发出之前）
  # 不得出现「已在岗」——一旦自动上岗，applyOnDuty 会打印「已在岗：org 工具…」
  # （extensions/auto/org/index.ts）。原用例是整份输出的负向断言；合并成单进程后
  # 「已在岗」在 /org on 之后必然出现，故改为按窗口判定，强度与原断言等价。
  # 边界取 STEP_BEGIN 02（而不是 STEP_OK 01）：后者在「待上岗」匹配瞬间就打印，
  # 而自动上岗的消息可能在它之后才落盘，用 STEP_OK 01 会漏判。
  window_end="$(grep -abo -m1 "STEP_BEGIN 02-orgOn" "$TUI_OUTPUT_FILE" | cut -d: -f1 || true)"
  # 边界缺失 = 证据链断了（日志被截断 / puts 丢失）：**判失败**，不能让负向断言静默消失。
  if [[ -z "$window_end" ]]; then
    echo "FAIL: 日志里找不到 STEP_BEGIN 02-orgOn 窗口边界，无法判定是否自动上岗（ADR-0046 D1）"
    grep -aE "STEP_BEGIN|STEP_OK|FAIL_MARKER" "$TUI_OUTPUT_FILE" 2>/dev/null | tail -10
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -20
    tui_cleanup; exit 1
  fi
  if head -c "$window_end" "$TUI_OUTPUT_FILE" | grep -aq "已在岗"; then
    echo "FAIL: /control on 之后、/org on 之前就出现「已在岗」→ 自动上岗（ADR-0046 D1 被违反）"
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -20
    tui_cleanup; exit 1
  fi

  echo "PASS: 状态栏三态按序（待上岗 → 在岗计数 → 未连接），/control on 未自动上岗，末态=${LAST}"
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
    wait_for {org:}
    wait_for {dev-team}
    send "3"
    wait_for {人类取消目标}
    send "\r"
    wait_for {人类强制|x 取消}
    send "x"
    wait_for {确认}
    send "y"
    send "\x1b"
    sleep 1
  ' 60 80 "$WB_DIR" "$ROOT/preset"

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

test_describe "org extension (TUI 所属组织 / tab 在岗计数 — ADR-0070)"

test_it "expect: 所属组织排最前 + 分段符 + 其余 org 的盲文在岗点数" <<'TEST'
  ROOT="$(mktemp -d /tmp/org-tui-own-XXXX)"
  CHIEF_DIR="$ROOT/chief"          # ← pi 的 cwd，也是 zeta 的成员目录（= 本目录所属组织）
  OTHER_DIR="$ROOT/other"          # ← alpha 的成员目录（不属于我）
  NOW="2026-01-01T00:00:00.000Z"
  NEWER="2026-09-01T00:00:00.000Z"
  mkdir -p "$CHIEF_DIR" "$OTHER_DIR" \
           "$ROOT/preset/.pi/org/alpha/tasks" \
           "$ROOT/preset/.pi/org/alpha/runtime" \
           "$ROOT/preset/.pi/org/zeta/tasks"

  # zeta = 本目录所属（成员目录就是 CHIEF_DIR），但**派活更早**
  cat >"$ROOT/preset/.pi/org/zeta/org.json" <<EOF
{"schemaVersion":1,"name":"zeta","chiefName":"chief","chiefDir":"$CHIEF_DIR","createdAt":"$NOW","updatedAt":"$NOW","members":[{"name":"chief","dir":"$CHIEF_DIR","role":"chief","manifest":{"label":"负责人"},"joinedAt":"$NOW"}]}
EOF
  cat >"$ROOT/preset/.pi/org/zeta/tasks/M-zzz111.json" <<EOF
{"schemaVersion":1,"id":"M-zzz111","org":"zeta","title":"我的组织任务","background":"b","items":[],"dispatcher":"chief","dispatcherRole":"chief","dueAt":null,"createdAt":"$NOW","updatedAt":"$NOW","status":"todo","subTasks":[{"id":"S1","description":"s","dueAt":null,"assignees":[]}],"history":[]}
EOF

  # alpha = 非所属，但**派活更新**（证明"所属优先"压过"最近派活"）
  cat >"$ROOT/preset/.pi/org/alpha/org.json" <<EOF
{"schemaVersion":1,"name":"alpha","chiefName":"a-chief","chiefDir":"$OTHER_DIR","createdAt":"$NOW","updatedAt":"$NOW","members":[{"name":"a-chief","dir":"$OTHER_DIR","role":"chief","manifest":{"label":"别家"},"joinedAt":"$NOW"},{"name":"w-other","dir":"$OTHER_DIR/dist","role":"member","manifest":{},"joinedAt":"$NOW"}]}
EOF
  mkdir -p "$OTHER_DIR/dist"
  cat >"$ROOT/preset/.pi/org/alpha/tasks/M-aaa999.json" <<EOF
{"schemaVersion":1,"id":"M-aaa999","org":"alpha","title":"别家更新的任务","background":"b","items":[],"dispatcher":"a-chief","dispatcherRole":"chief","dueAt":null,"createdAt":"$NEWER","updatedAt":"$NEWER","status":"todo","subTasks":[{"id":"S1","description":"s","dueAt":null,"assignees":[]}],"history":[]}
EOF

  # alpha 的成员 w-other 有一份"pid 存活"的在岗注册（socket 不可连）：
  # 非当前 org 走廉价 pid 判据 → 应计为 1 人（点阵 ⠁）
  sleep 300 &
  ALIVE_PID=$!
  # 用例被预算/人工中断时也要收掉这个哨兵进程（否则孤儿 sleep 最长活 300s）
  trap 'kill "$ALIVE_PID" 2>/dev/null || true' EXIT
  cat >"$ROOT/preset/.pi/org/alpha/runtime/w-other.json" <<EOF
{"schemaVersion":1,"name":"w-other","dir":"$OTHER_DIR/dist","pid":$ALIVE_PID,"socketPath":"/nonexistent/org-tui.sock","sessionId":"sess-w","busy":false,"startedAt":"$NOW","updatedAt":"$NOW"}
EOF

  tui_expect_test "org" '
    send "/org\r"
    wait_for {org:}
    wait_for {我的组织任务}
  ' 60 100 "$CHIEF_DIR" "$ROOT/preset"

  FAILED=""
  if [[ "$TUI_EXIT_CODE" -ne 0 && "$TUI_EXIT_CODE" -ne 124 ]]; then
    FAILED="expect 异常退出码 $TUI_EXIT_CODE"
  fi

  VIS="$(extract_visible_text "$TUI_OUTPUT_FILE")"
  # ① 默认落点 = 所属组织 zeta（不是字母序第一的 alpha）
  grep -q 'org:zeta' <<<"$VIS" || FAILED="${FAILED:+$FAILED; }标题未落在所属组织 zeta"
  # ② 所属段在前：必须在**同一行**（org tab 行）里比位置。
  # 不能拿整屏首个 'zeta' 命中——那是标题行 `── org:zeta`，恒在 tab 行之上，断言会永远通过。
  # 定位 org tab 行：用**固定字符串**匹配两枚 chip 的同现，不用字符类。
  # 教训：grep -E '[盲文起-盲文止]' 这类非 ASCII 范围在 GNU grep（Linux/CI）下报
  # "Invalid collation character"，而 macOS 的 BSD grep 按字节比较能过——本地绿、CI 红。
  TAB_LINE="$(grep -F '[ zeta ' <<<"$VIS" | grep -F '[ alpha ' | head -1)"
  ZETA_POS=$(grep -bo 'zeta' <<<"$TAB_LINE" | head -1 | cut -d: -f1)
  ALPHA_POS=$(grep -bo 'alpha' <<<"$TAB_LINE" | head -1 | cut -d: -f1)
  if [[ -z "$TAB_LINE" ]] || [[ -z "$ZETA_POS" ]] || [[ -z "$ALPHA_POS" ]]; then
    FAILED="${FAILED:+$FAILED; }org tab 行未同时出现 zeta 与 alpha（无法判定顺序）"
  elif (( ZETA_POS > ALPHA_POS )); then
    FAILED="${FAILED:+$FAILED; }tab 顺序错误（alpha 在 zeta 之前）"
  fi
  # 只在 tab 行上断言分隔符：整屏 grep 会被别处任一 `│`（pi UI/其它行）满足而假通过
  grep -q '│' <<<"$TAB_LINE" || FAILED="${FAILED:+$FAILED; }缺少所属/非所属分段符"
  # ④ 非当前 org 的在岗人数以盲文点阵显示（1 人 = ⠁）
  grep -qF '[ alpha ⠁ ]' <<<"$VIS" || FAILED="${FAILED:+$FAILED; }alpha 的盲文在岗点数不是 ⠁"

  kill "$ALIVE_PID" 2>/dev/null
  if [[ -n "$FAILED" ]]; then
    echo "FAIL: $FAILED"
    echo "--- TUI output (visible text) ---"
    tail -30 <<<"$VIS"
    echo "---"
    tui_cleanup
    exit 1
  fi
  echo "PASS: 所属组织排最前 + 分段符 + 盲文在岗点数正确"
  tui_cleanup
TEST
