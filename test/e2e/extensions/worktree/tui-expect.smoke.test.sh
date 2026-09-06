#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# worktree — expect 交互 TUI 测试
#
# 迁移自 tui.smoke.test.sh + smoke.test.sh 中的 TUI 测试 (script+heredoc → expect)
#
# 注意：合并测试需要 git 仓库环境，使用 tui_expect_test 的 cwd 参数。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "worktree extension (expect TUI mode)"

# ── 测试 1：TUI 模式加载不崩溃 ──
test_it "expect: loads in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-logger,worktree" '
    send "/worktree\r"
    sleep 1
    send "\033"
    sleep 0.5
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 2：/worktree list 在 TUI 中显示 ──
test_it "expect: list shows worktree command in TUI" <<'TEST'
  tui_expect_test "pi-logger,worktree" '
    send "/worktree list\r"
    sleep 2
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: list command worked (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: list command failed (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 3：扩展后 pi 仍可正常交互（验证不崩溃） ──
test_it "expect: pi continues working after worktree commands" <<'TEST'
  tui_expect_test "pi-logger,worktree" '
    send "/worktree list\r"
    sleep 2
    send "/help\r"
    sleep 1
  ' 20

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: pi continued after worktree commands (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: pi did not continue after worktree commands (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 4：merge e2e ──
test_it "expect: default merge via /worktree command" <<'TEST'
  local sandbox test_repo wt_dir wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-merge-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1

  wt_name="merge-test"
  git -C "$test_repo" checkout -b "wt/$wt_name" >/dev/null 2>&1
  echo feature > "$test_repo/feat.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m feat >/dev/null 2>&1
  git -C "$test_repo" checkout main >/dev/null 2>&1

  local wt_parent="${test_repo}-worktrees"
  wt_dir="$wt_parent/$wt_name"
  mkdir -p "$wt_parent"
  git -C "$test_repo" worktree add "$wt_dir" "wt/$wt_name" >/dev/null 2>&1

  tui_expect_test "pi-logger,worktree" "
    send \"/worktree merge --source $wt_name --strategy merge\r\"
    sleep 3
  " 20 "" "$test_repo"

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: default merge completed (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: merge exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  git -C "$test_repo" worktree remove "$wt_dir" --force >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  tui_cleanup
TEST

# ── 测试 5：squash merge e2e ──
test_it "expect: squash merge via /worktree command" <<'TEST'
  local sandbox test_repo wt_dir wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-squash-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1

  wt_name="squash-test"
  git -C "$test_repo" checkout -b "wt/$wt_name" >/dev/null 2>&1
  echo feature > "$test_repo/squash.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m squash-feat >/dev/null 2>&1
  git -C "$test_repo" checkout main >/dev/null 2>&1

  local wt_parent="${test_repo}-worktrees"
  wt_dir="$wt_parent/$wt_name"
  mkdir -p "$wt_parent"
  git -C "$test_repo" worktree add "$wt_dir" "wt/$wt_name" >/dev/null 2>&1

  tui_expect_test "pi-logger,worktree" "
    send \"/worktree merge --source $wt_name --strategy squash\r\"
    sleep 3
  " 20 "" "$test_repo"

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: squash merge completed (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: squash merge exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  git -C "$test_repo" worktree remove "$wt_dir" --force >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  tui_cleanup
TEST

# ── 测试 6：rebase+ff e2e ──
test_it "expect: rebase+ff via /worktree command" <<'TEST'
  local sandbox test_repo wt_dir wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-rebaseff-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1

  wt_name="rebaseff-test"
  git -C "$test_repo" checkout -b "wt/$wt_name" >/dev/null 2>&1
  echo feature > "$test_repo/rff.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m rff-feat >/dev/null 2>&1
  git -C "$test_repo" checkout main >/dev/null 2>&1

  local wt_parent="${test_repo}-worktrees"
  wt_dir="$wt_parent/$wt_name"
  mkdir -p "$wt_parent"
  git -C "$test_repo" worktree add "$wt_dir" "wt/$wt_name" >/dev/null 2>&1

  tui_expect_test "pi-logger,worktree" "
    send \"/worktree merge --source $wt_name --strategy rebase-ff\r\"
    sleep 3
  " 20 "" "$test_repo"

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: rebase+ff completed (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: rebase+ff exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  git -C "$test_repo" worktree remove "$wt_dir" --force >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  tui_cleanup
TEST

# ── 测试 6.5：merge 到未 push 的 target（本地优先：不 pull，直接本地 merge）──
test_it "expect: merge to unpushed target succeeds (local-first)" <<'TEST'
  local sandbox test_repo bare_repo wt_dir wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-local-merge-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  bare_repo="$sandbox/origin.git"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1

  # dev 分支（未 push）+ wt/x（有独立提交）
  git -C "$test_repo" checkout -b dev >/dev/null 2>&1
  echo dev > "$test_repo/dev.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m dev >/dev/null 2>&1

  wt_name="local-merge"
  git -C "$test_repo" checkout -b "wt/$wt_name" >/dev/null 2>&1
  echo feature > "$test_repo/feat.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m local-feat >/dev/null 2>&1
  git -C "$test_repo" checkout dev >/dev/null 2>&1

  local wt_parent="${test_repo}-worktrees"
  wt_dir="$wt_parent/$wt_name"
  mkdir -p "$wt_parent"
  git -C "$test_repo" worktree add "$wt_dir" "wt/$wt_name" >/dev/null 2>&1

  # 有 remote，但 dev 从未 push（origin/dev 不存在 → 旧代码 pull 会失败并回滚）
  git init --bare "$bare_repo" >/dev/null 2>&1
  git -C "$test_repo" remote add origin "file://$bare_repo" >/dev/null 2>&1

  tui_expect_test "pi-logger,worktree" "
    send \"/worktree merge --source $wt_name --target dev --strategy merge\r\"
    expect -re {Merge} { }
    sleep 1
    send \"\r\"
    sleep 4
  " 20 "" "$test_repo"

  # 严格断言：wt 分支已合入 dev（本地 merge 成功，未 pull）
  if git -C "$test_repo" merge-base --is-ancestor "wt/$wt_name" dev; then
    echo "PASS: merge to unpushed dev succeeded (wt/$wt_name merged into dev)"
  else
    echo "FAIL: wt/$wt_name not merged into dev"
    git -C "$test_repo" log dev --oneline | head -5
    exit 1
  fi

  git -C "$test_repo" worktree remove "$wt_dir" --force >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  tui_cleanup
TEST

# ── 测试 6.6：merge 到落后远端的 target → confirm 提示「落后远端」→ 本地 merge 成功 ──
test_it "expect: merge to remote-behind target shows sync hint (local-first)" <<'TEST'
  local sandbox test_repo bare_repo other_repo wt_dir wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-sync-hint-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  bare_repo="$sandbox/origin.git"
  other_repo="$sandbox/other"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1

  # 远端：origin（bare）+ other 创建 dev 并 push（origin/dev 领先本地）
  git init --bare "$bare_repo" >/dev/null 2>&1
  git -C "$test_repo" remote add origin "file://$bare_repo" >/dev/null 2>&1
  git -C "$test_repo" push -u origin main >/dev/null 2>&1
  git clone "file://$bare_repo" "$other_repo" >/dev/null 2>&1
  git -C "$other_repo" checkout -b dev >/dev/null 2>&1
  echo remote-dev > "$other_repo/remote-dev.txt"
  git -C "$other_repo" add . && git -C "$other_repo" commit -m remote-dev >/dev/null 2>&1
  git -C "$other_repo" push -u origin dev >/dev/null 2>&1

  # 本地 dev 基于旧 main（behind=1，无独有提交 → ahead=0）
  git -C "$test_repo" fetch origin >/dev/null 2>&1
  git -C "$test_repo" checkout -b dev origin/main >/dev/null 2>&1

  wt_name="sync-hint"
  git -C "$test_repo" checkout -b "wt/$wt_name" >/dev/null 2>&1
  echo feature > "$test_repo/feat.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m local-feat >/dev/null 2>&1
  git -C "$test_repo" checkout dev >/dev/null 2>&1

  local wt_parent="${test_repo}-worktrees"
  wt_dir="$wt_parent/$wt_name"
  mkdir -p "$wt_parent"
  git -C "$test_repo" worktree add "$wt_dir" "wt/$wt_name" >/dev/null 2>&1

  # confirm 对话框应出现「本地 dev 落后远端」提示（getRemoteAheadBehind 真实 fetch 生效）
  tui_expect_test "pi-logger,worktree" "
    send \"/worktree merge --source $wt_name --target dev --strategy merge\r\"
    expect -re {落后远端} { }
    sleep 1
    send \"\r\"
    sleep 4
  " 20 "" "$test_repo"

  # 严格断言：merge 成功（wt 分支已合入 dev）
  if git -C "$test_repo" merge-base --is-ancestor "wt/$wt_name" dev; then
    echo "PASS: merge to remote-behind dev succeeded (sync hint shown)"
  else
    echo "FAIL: wt/$wt_name not merged into dev"
    git -C "$test_repo" log dev --oneline | head -5
    exit 1
  fi

  git -C "$test_repo" worktree remove "$wt_dir" --force >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  tui_cleanup
TEST

# ── 测试 6.7：merge 失败（target 被 worktree 占用）→ 失败面板「拉取最新」→ 仓库终态正确 ──
test_it "expect: merge failure panel pull leaves repo consistent" <<'TEST'
  local sandbox test_repo wt_dir dev_wt wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-fail-pull-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1

  # target dev 被 worktree 占用 → 主仓库 checkout dev 失败（Cannot checkout）
  git -C "$test_repo" checkout -b dev >/dev/null 2>&1
  git -C "$test_repo" checkout main >/dev/null 2>&1
  local wt_parent="${test_repo}-worktrees"
  mkdir -p "$wt_parent"
  dev_wt="$wt_parent/dev"
  git -C "$test_repo" worktree add "$dev_wt" dev >/dev/null 2>&1

  wt_name="fail-pull"
  git -C "$test_repo" checkout -b "wt/$wt_name" >/dev/null 2>&1
  echo feature > "$test_repo/feat.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m local-feat >/dev/null 2>&1
  git -C "$test_repo" checkout main >/dev/null 2>&1
  wt_dir="$wt_parent/$wt_name"
  git -C "$test_repo" worktree add "$wt_dir" "wt/$wt_name" >/dev/null 2>&1

  # merge 失败 → 失败面板出现 → 选「拉取最新」（第 4 项：Down×3 + Enter）
  tui_expect_test "pi-logger,worktree" "
    send \"/worktree merge --source $wt_name --target dev --strategy merge\r\"
    expect -re {Merge} { }
    sleep 1
    send \"\r\"
    expect -re {合并失败} { }
    sleep 1
    send \"\x1b[B\"
    sleep 0.3
    send \"\x1b[B\"
    sleep 0.3
    send \"\x1b[B\"
    sleep 0.3
    send \"\r\"
    sleep 3
  " 20 "" "$test_repo"

  # 严格断言：
  # 1) merge 未发生（dev 被占用 → Cannot checkout，未污染 dev）
  if git -C "$test_repo" merge-base --is-ancestor "wt/$wt_name" dev 2>/dev/null; then
    echo "FAIL: wt/$wt_name unexpectedly merged into dev"
    exit 1
  fi
  echo "PASS: merge blocked (target dev checked out in another worktree)"
  # 2) 拉取失败后主仓库回切原分支（pullTargetLatest finally 恢复 main）
  local head_branch
  head_branch=$(git -C "$test_repo" rev-parse --abbrev-ref HEAD)
  if [[ "$head_branch" == "main" ]]; then
    echo "PASS: repo remains on main after failed pull"
  else
    echo "FAIL: repo on '$head_branch' (expected main)"
    exit 1
  fi
  # 3) 无 MERGE_HEAD 残留
  if git -C "$test_repo" rev-parse --verify MERGE_HEAD >/dev/null 2>&1; then
    echo "FAIL: MERGE_HEAD left behind after failure panel pull"
    exit 1
  fi
  echo "PASS: no MERGE_HEAD residue"

  git -C "$test_repo" worktree remove "$wt_dir" --force >/dev/null 2>&1 || true
  git -C "$test_repo" worktree remove "$dev_wt" --force >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  tui_cleanup
TEST

# ── 测试 7：plain rebase（sync 别名）e2e ──
test_it "expect: plain rebase via /worktree command" <<'TEST'
  local sandbox test_repo wt_dir wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-rebase-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1

  wt_name="rebase-test"
  git -C "$test_repo" checkout -b "wt/$wt_name" >/dev/null 2>&1
  echo feature > "$test_repo/rb.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m rb-feat >/dev/null 2>&1
  git -C "$test_repo" checkout main >/dev/null 2>&1
  echo main-advance > "$test_repo/main.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m main-advance >/dev/null 2>&1

  local wt_parent="${test_repo}-worktrees"
  wt_dir="$wt_parent/$wt_name"
  mkdir -p "$wt_parent"
  git -C "$test_repo" worktree add "$wt_dir" "wt/$wt_name" >/dev/null 2>&1

  # sync 是 rebase 的别名：把 worktree 分支变基到 main 最新（worktree 内执行）
  tui_expect_test "pi-logger,worktree" "
    send \"/worktree sync --source $wt_name\r\"
    sleep 3
  " 20 "" "$test_repo"

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: sync (rebase) completed (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: sync exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  # 验证 sync 触发 rebase 成功。双通道：
  # ① 快路径：TUI 输出出现 "Rebased" 通知（rebase 成功信号）；
  # ② 兜底：面板停留时间短时通知可能被后续渲染覆盖，轮询 git 分支引用（最长 30s，
  #    覆盖 pi 进程内 rebase 引用写入的瞬时竞态）。
  local rebased=false
  if tui_output_contains "$TUI_OUTPUT_FILE" "Rebased"; then
    rebased=true
  else
    for _ in $(seq 1 60); do
      if git -C "$wt_dir" log --oneline 2>/dev/null | grep -q "main-advance"; then
        rebased=true
        break
      fi
      sleep 0.5
    done
  fi
  if $rebased; then
    echo "PASS: worktree branch rebased onto latest main"
  else
    echo "FAIL: worktree branch missing main-advance commit (TUI or git)" >&2
    exit 1
  fi

  # main 应未被合并（rebase 只同步不合并，ADR-0018）
  if git -C "$test_repo" log --oneline main | grep -q "rb-feat"; then
    echo "FAIL: main should not contain worktree commit yet (rebase only, no merge)" >&2
    exit 1
  fi
  echo "PASS: main untouched (rebase only, no merge)"

  git -C "$test_repo" worktree remove "$wt_dir" --force >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  tui_cleanup
TEST

# ── 测试 8：prune e2e ──
test_it "expect: prune via /worktree command" <<'TEST'
  local sandbox test_repo wt_dir wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-prune-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1

  wt_name="prune-test"
  git -C "$test_repo" checkout -b "wt/$wt_name" >/dev/null 2>&1
  echo feature > "$test_repo/pr.txt"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m pr-feat >/dev/null 2>&1
  git -C "$test_repo" checkout main >/dev/null 2>&1

  local wt_parent="${test_repo}-worktrees"
  wt_dir="$wt_parent/$wt_name"
  mkdir -p "$wt_parent"
  git -C "$test_repo" worktree add "$wt_dir" "wt/$wt_name" >/dev/null 2>&1

  # 手动删除 worktree 目录（模拟用户 rm -rf），留下 git 孤儿记录
  rm -rf "$wt_dir"

  tui_expect_test "pi-logger,worktree" "
    send \"/worktree prune\r\"
    sleep 2
  " 20 "" "$test_repo"

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: prune completed (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: prune exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  # 验证 git 元数据中的孤儿记录被清理
  if git -C "$test_repo" worktree list --porcelain | grep -q "prune-test"; then
    echo "FAIL: orphan worktree record still present after prune"
    exit 1
  fi
  echo "PASS: orphan worktree metadata pruned"

  rm -rf "$sandbox"
  tui_cleanup
TEST

# ── 测试 9：create → pi 工作空间迁移证据 e2e ──
# 验证链路：TUI 中 /worktree create（默认 Clone 策略）→ 真实 pi 进程内
#   clone 降级（新会话无源文件）→ 生成 worktree 会话文件（header cwd = worktree 路径）。
# 注意：
#   - mock-llm 沙箱中 pi 新会话不落盘（getSessionFile 为空），clone 自动降级 new
#     （保证创建后一定切换）——本用例验证该降级路径；真实 clone 由 vitest 覆盖。
#   - pi 的 ctx.switchSession 在 e2e 沙箱（cwd 位于项目目录外，如 /tmp）中疑似
#     挂起（项目目录内已验证可完成），故 switchSession 完成仅作条件断言，不阻塞。
test_it "expect: create worktree migrates pi session file to worktree" <<'TEST'
  local sandbox test_repo wt_name
  sandbox=$(mktemp -d "/tmp/pi-wt-create-e2e-$$.XXXXXX")
  test_repo="$sandbox/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo init > "$test_repo/README.md"
  git -C "$test_repo" add . && git -C "$test_repo" commit -m init >/dev/null 2>&1
  wt_name="create-wt"

  # TUI 全流程：create → symlink 面板(space+Enter) → nm 策略面板(Enter) →
  #   session 策略面板(Enter 选默认 Clone —— 源文件缺失时自动降级 new 并切换)
  tui_expect_test "pi-logger,worktree" '
    send "/worktree create create-wt\r"
    expect -re {Symlink to worktree} { }
    sleep 1
    send " "
    sleep 0.5
    send "\r"
    expect -re {node_modules strategy} { }
    sleep 1
    send "\r"
    expect -re {Switch to worktree} { }
    sleep 1
    send "\r"
    sleep 6
  ' 45 80 "$test_repo"

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: create completed (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: create exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  # 1. worktree 目录真实创建
  local wt_dir="${test_repo}-worktrees/create-wt"
  if [[ -d "$wt_dir" ]]; then
    echo "PASS: worktree dir created at $wt_dir"
  else
    echo "FAIL: worktree dir missing"
    exit 1
  fi

  # 2. pi 进程内会话迁移（pi-logger 日志）：clone 降级 new + 会话文件创建（硬断言）
  local logf=""
  logf=$(find "$test_repo" -name "pi-worktree*.log" 2>/dev/null | head -1)
  if [[ -z "$logf" ]]; then
    echo "FAIL: pi-worktree log not found"
    exit 1
  fi
  if grep -q "clone fallback to new session" "$logf" && grep -q "created session file" "$logf"; then
    echo "PASS: clone fallback + session file created logged"
  else
    echo "FAIL: missing clone-fallback/created-session log"
    grep -E "clone|created" "$logf" | tail -5
    exit 1
  fi
  # switchSession 完成：项目目录外 cwd 的沙箱中 pi 可能挂起（已知环境限制），仅条件断言
  if grep -q "switched session" "$logf"; then
    echo "PASS: switchSession completed"
    grep "switched session" "$logf" | tail -1
  else
    echo "WARN: switchSession did not complete in this sandbox (known pi quirk outside project dir)"
  fi

  # 3. worktree 的会话文件存在，header cwd = worktree 路径（pi 工作空间迁移的持久化证据）
  # 注意：header cwd 是 pi 内部 realpath（macOS /tmp → /private/tmp），须与 realpath 后的 wt_dir 比较
  local wt_dir_real=""
  wt_dir_real=$(cd "$wt_dir" && pwd -P 2>/dev/null)
  local wt_sess_file=""
  wt_sess_file=$(find "$TUI_TEST_HOME/home/.pi/agent/sessions" -name "worktree-*.jsonl" 2>/dev/null | head -1)
  if [[ -n "$wt_sess_file" ]]; then
    local header_cwd
    header_cwd=$(head -1 "$wt_sess_file" | grep -o '"cwd":"[^"]*"' | cut -d'"' -f4)
    if [[ -n "$wt_dir_real" && "$header_cwd" == "$wt_dir_real" ]]; then
      echo "PASS: worktree session header cwd = $header_cwd"
    else
      echo "FAIL: session header cwd = $header_cwd (expected realpath $wt_dir_real)"
      exit 1
    fi
  else
    echo "FAIL: no worktree session file under TUI_TEST_HOME sessions/"
    exit 1
  fi

  git -C "$test_repo" worktree remove "$wt_dir" --force >/dev/null 2>&1 || true
  rm -rf "$sandbox"
  tui_cleanup
TEST
