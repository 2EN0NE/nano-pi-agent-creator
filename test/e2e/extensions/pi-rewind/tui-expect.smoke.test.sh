#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-rewind — 真实回退 E2E（expect 驱动 TUI）
#
# 覆盖 smoke.test.sh 未覆盖的端到端链路：
#   打 checkpoint（真实 Pi turn）→ /rewind 交互选择 → 文件真的回到旧状态。
#
# 为什么用 TUI 模式（pi -a）而非 --no-session：
#   1. `/rewind` 是交互命令，print 模式（ctx.hasUI=false）下选择器直接返回 undefined；
#   2. checkpoint storage 按 session 文件寻址，需要真实会话文件。
#   因此本用例属 AGENTS「--no-session 例外」——依赖会话记录来验证回退。
#
# 关键前提（否则 pi-rewind 会把「项目根」当成 cwd）：
#   pi 从 cwd 向上找 git 根解析项目目录。测试项目目录必须 `git init`，
#   否则 ctx.cwd 会落到本仓库大目录 → pi-rewind 的 stageAll 全树扫描拖死 agent turn。
#
# 断言设计（防假阳性）：
#   仅断言「最终文件 == v1」不足够——若 agent 从未改动文件，初始 v1 会假通过。
#   因此依次断言：① mock bash 工具真实执行（marker）② checkpoint 记录 files>=1
#   ③ 文件回到 v1 ④ 存储落在新路径 ~/.pi/agent/rewind/checkpoints/。
#
# 运行：bash test/e2e/scripts/run-e2e.sh --ext pi-rewind --tui
#
# 时序策略（防假阴性）：每一步都用 expect 等待真实 UI 状态（overlay 标题、恢复模式
# 列表、最终「回退完成」通知），不用固定 sleep 抢跑；timeout 给到 180s，因为沙箱
# 冷启动 + 机器负载下 TUI 单帧可能慢到分钟级（曾观察到 pi 启动 ~90s、各交互阶段
# ~75s）。需要 git 子命令轨迹诊断时设 E2E_GIT_TRACE=1（默认关闭，避免给每次 git
# 调用叠加 GIT_TRACE_PERFORMANCE 开销）。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-rewind real rollback (expect TUI mode)"

test_it "expect: /rewind 真实回退文件到旧 checkpoint 状态" <<'TEST'
  local base="$ROOT_DIR/.pi/tmp/pirw-rewind-tui-$$-$RANDOM"
  local proj="$base/proj"
  mkdir -p "$proj"
  # proj 必须是独立 git 根，否则 pi 把 cwd 解析到本仓库大目录
  git -C "$proj" init -q --initial-branch main 2>/dev/null || git -C "$proj" init -q
  printf 'v1' >"$proj/target.txt"

  # mock-llm 首轮返回 1 个 bash 工具调用：写 marker + 把 target.txt 改成 v2
  export MOCK_LLM_TOOL_CALLS=1
  export MOCK_LLM_BASH_COMMAND="printf RAN > \"\$HOME/tool-ran.txt\"; printf v2 > target.txt"
  # 诊断：记录 git 子命令轨迹（定位 exec 卡在哪条命令）。
  # 默认关闭——GIT_TRACE_PERFORMANCE 会给每条 git 子命令加开销，负载下拖慢交互；
  # 需要诊断时 E2E_GIT_TRACE=1 开启，轨迹与其它产物一起落进 test/results。
  if [[ -n "${E2E_GIT_TRACE:-}" ]]; then
    export GIT_TRACE="$base/git-trace.log"
    export GIT_TRACE_PERFORMANCE=1
  fi

  tui_expect_test "pi-rewind,pi-logger" '
    send "please modify the file\r"
    # 等 agent 完成（mock 的最终文本），确保 checkpoint 已 finalize
    expect { -re {Continuing\.} { } timeout { send_error "no agent response\n"; exit 124 } }
    sleep 1

    # /rewind 打开 checkpoint 选择覆盖层；初始选中「(当前)」，↑ 移到最新 checkpoint
    send "/rewind\r"
    expect { -re {Rewind Checkpoints} { } timeout { send_error "no rewind overlay\n"; exit 124 } }
    sleep 1
    send "\033\[A"
    sleep 1
    send "\r"

    # 恢复模式列表第 1 项为「恢复代码和会话」，末项为「仅恢复代码」。
    # 连按 down 到末尾（列表不越界，多次按必落在末项）。用普通字符键 j（
    # ExtensionSelectorComponent 显式支持 j/k），规避连续方向键在 PTY 下偶发丢键。
    expect { -re {恢复模式} { } timeout { send_error "no restore mode list\n"; exit 124 } }
    sleep 1
    send "j"
    sleep 0.5
    send "j"
    sleep 0.5
    send "j"
    sleep 0.5
    send "\r"

    # 等待「回退完成」通知（状态驱动）——不要用固定 sleep：沙箱冷启动 + 机器负载下
    # 交互各阶段可能慢到分钟级，固定 sleep 会假阴性；由 expect 的 timeout 兜底报错。
    expect { -re {回退完成} { } timeout { send_error "restore did not report completion\n"; exit 124 } }
    sleep 1
  ' 180 80 "$proj"

  local rc=0

  # 把 pi 实际 cwd（$proj）下的扩展日志纳入报告，便于诊断
  local padded_diag
  padded_diag=$(printf '%03d' "$CASE_INDEX")
  if [[ -d "$proj/.pi/logs" ]]; then
    mkdir -p "$CASE_DIR/${padded_diag}-proj-logs"
    cp -r "$proj/.pi/logs/." "$CASE_DIR/${padded_diag}-proj-logs/" 2>/dev/null || true
  fi
  [[ -f "$base/git-trace.log" ]] && cp "$base/git-trace.log" "$CASE_DIR/${padded_diag}-git-trace.log" 2>/dev/null || true

  # ① agent 真的改过文件（否则 v1 断言是假阳性）
  if [[ "$(cat "$HOME/tool-ran.txt" 2>/dev/null)" == "RAN" ]]; then
    echo "PASS: mock bash tool executed (v2 was written by the agent)"
  else
    echo "FAIL: tool marker missing — agent never modified target.txt"
    rc=1
  fi

  # ② checkpoint 快照真的捕获了文件变更（files>=1）
  # 注意：pi-logger 的 file appender 路径 `./.pi/logs` 相对 pi 的 cwd（本用例 = $proj），
  # 因此日志落在 $proj/.pi/logs，而非 harness 收集的 $test_home/.pi/logs。
  local padded logf logtext
  padded=$(printf '%03d' "$CASE_INDEX")
  logf=$(find "$proj/.pi/logs" "$CASE_DIR/${padded}-logs" -name 'pi-rewind_*.log' 2>/dev/null | head -1)
  logtext=""
  if [[ -n "$logf" ]]; then logtext=$(cat "$logf"); fi
  if grep -q "checkpoint finalized.*files=[1-9]" <<<"$logtext"; then
    echo "PASS: checkpoint finalized with file changes"
  else
    echo "FAIL: no checkpoint with file changes recorded"
    echo "$logtext" | tail -5
    rc=1
  fi

  # ③ 回退后文件内容必须回到 v1
  local actual
  actual=$(cat "$proj/target.txt" 2>/dev/null || echo "<missing>")
  echo "  (target.txt after /rewind: '$actual')"
  if [[ "$actual" == "v1" ]]; then
    echo "PASS: /rewind restored target.txt to v1"
  else
    echo "FAIL: expected target.txt == 'v1' after /rewind, got '$actual'"
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -40
    rc=1
  fi

  # ④ checkpoint 落在新存储路径 ~/.pi/agent/rewind/checkpoints/<sid>/
  if find "$HOME/.pi/agent/rewind/checkpoints" -maxdepth 2 -name '.git' -type d 2>/dev/null | grep -q .; then
    echo "PASS: checkpoint bare repo created under ~/.pi/agent/rewind/checkpoints/"
  else
    echo "FAIL: no checkpoint bare repo under ~/.pi/agent/rewind/checkpoints/"
    rc=1
  fi

  # ⑤ /rewind 覆盖层确实渲染（PTY 命中英文标题；中文模式列表逐帧还原不可靠，留给人工复核）
  if tui_output_contains "$TUI_OUTPUT_FILE" "Rewind Checkpoints"; then
    echo "PASS: /rewind overlay rendered"
  else
    echo "FAIL: 'Rewind Checkpoints' not captured in PTY output"
    rc=1
  fi

  tui_cleanup
  rm -rf "$base"
  if [[ "$rc" -ne 0 ]]; then
    exit 1
  fi
  echo "NOTE: overlay 视觉细节（纯横线边框/列表项/按键提示）由 scripts/check-tui-compliance.ts 门禁 + 人工抽查覆盖"
TEST
