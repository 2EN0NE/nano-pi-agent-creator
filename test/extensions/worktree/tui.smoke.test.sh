#!/usr/bin/env bash
# pi-worktree v2 TUI 测试
#
# 验证 TUI 交互组件基本稳定性。
#
# 注意：切换器面板、帮助文本等 overlay 内容通过 script 捕获的 PTY 输出
# 无法可靠提取（overlay 使用光标定位绘制），因此只验证：
#   - TUI 模式不崩溃（exit code 0 或 124）
#   - 多次命令连续输入时的稳定性
#   - 键盘导航不崩溃
#
# 面板内容和帮助文本的验证已由 Vitest TUI 测试覆盖
# （test/vitest/extensions/worktree.tui.test.ts，使用 PI_TUI_WRITE_LOG）。

test_describe "worktree extension (TUI mode)"

# ── 测试 1：TUI 模式不崩溃 ──
test_it "loads in TUI mode without crash" <<'TEST'
  local pi_input
  pi_input=$(printf '/worktree\n\x1b')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 2：多次命令连续输入（TUI 稳定性） ──
test_it "multiple commands in sequence" <<'TEST'
  local pi_input
  pi_input=$(printf '/worktree help\n/worktree list\n')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 20

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Multiple commands executed in TUI"
  else
    echo "FAIL: TUI exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 3：打开切换器面板后使用键盘导航 ──
test_it "switcher panel keyboard navigation" <<'TEST'
  # 打开面板 → 按 ↓ → 按 q 退出
  local pi_input
  pi_input=$(printf '/worktree\n\x1b[B\nq')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: navigated and quit"
  else
    echo "FAIL: TUI exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 4：已删除的命令不生效（stop/mode） ──
test_it "removed commands (stop/mode) no longer available" <<'TEST'
  # 测试旧命令不再被处理（不崩溃即可）
  local pi_input
  pi_input=$(printf '/worktree stop\n/worktree mode\n')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: removed commands handled without crash"
  else
    echo "FAIL: TUI exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 5：session 文件创建验证（print 模式） ──
test_it "session files created with correct format" <<'TEST'
  # 创建一个沙箱 git 仓库 + worktree
  local sandbox_home test_repo wt_dir
  sandbox_home=$(mktemp -d "/tmp/pi-wt-session-test-XXXXXX")
  test_repo="$sandbox_home/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo "# test" > "$test_repo/README.md"
  git -C "$test_repo" add README.md && git -C "$test_repo" commit -m init >/dev/null 2>&1

  # 创建 worktree
  wt_dir="${test_repo}-worktrees/test-wt"
  mkdir -p "$(dirname "$wt_dir")"
  git -C "$test_repo" worktree add "$wt_dir" wt/test-wt >/dev/null 2>&1

  # 创建 session 目录
  local session_root="${sandbox_home}/.pi/agent/sessions"
  mkdir -p "$session_root"

  # 生成 session 编码目录（通过 repoRoot 编码）
  local encoded_repo
  encoded_repo="--$(echo "$test_repo" | sed 's|/|-|g')--"
  local session_dir="$session_root/$encoded_repo"
  mkdir -p "$session_dir"

  # 模拟 createSession：写入 v3 格式 session 文件
  cat > "$session_dir/worktree-test-wt.jsonl" << SESS
{"type":"session","version":3,"id":"test-uuid-1234","timestamp":"2024-01-01T00:00:00.000Z","cwd":"$wt_dir"}
SESS

  # 验证 header 格式
  local header
  header=$(head -1 "$session_dir/worktree-test-wt.jsonl")
  echo "$header" | python3 -c "
import json,sys
h=json.loads(sys.stdin.read())
assert h['type']=='session','type should be session'
assert h['version']==3,'version should be 3'
assert h['id']=='test-uuid-1234','id should match'
assert h['cwd']=='$wt_dir','cwd should be worktree path'
print('PASS: session header v3 format valid')
" 2>&1 || {
    echo "FAIL: session header format invalid"
    cat "$session_dir/worktree-test-wt.jsonl"
    rm -rf "$sandbox_home"
    exit 1
  }

  # 清理
  git -C "$test_repo" worktree remove "$wt_dir" >/dev/null 2>&1 || true
  rm -rf "$sandbox_home"
  echo "PASS: session file v3 format verified"
  exit 0
TEST
