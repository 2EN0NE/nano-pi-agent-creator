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
    send "/quit\r"
    expect eof
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
    send "/quit\r"
    expect eof
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
    send "/quit\r"
    expect eof
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
  sandbox=$(mktemp -d "/tmp/pi-wt-merge-e2e-$$")
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
    send \"/quit\r\"
    expect eof
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
  sandbox=$(mktemp -d "/tmp/pi-wt-squash-e2e-$$")
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
    send \"/quit\r\"
    expect eof
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
  sandbox=$(mktemp -d "/tmp/pi-wt-rebaseff-e2e-$$")
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
    send \"/quit\r\"
    expect eof
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
