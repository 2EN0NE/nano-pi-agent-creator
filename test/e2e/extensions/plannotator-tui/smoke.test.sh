#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# plannotator-tui 扩展 — 集成 e2e（真实 pi 进程，print 模式）
#
# 外部边界只有一个：plannotator-tui 二进制。用 PLANNOTATOR_TUI_BIN 指向桩脚本，
# 桩把收到的 argv 落盘，于是"扩展到底发起了什么调用"可以被逐行断言。
# 真实 herdr pane 在 CI 里不可得 —— 这是唯一诚实的 e2e 边界（见 ticket 04）。
#
# 菜单与选择器的交互渲染由 test/vitest/ 的 headless snapshot 覆盖，不在此重复。
# 兼容 macOS 自带 bash 3.2：不用 mapfile / 关联数组。
# ──────────────────────────────────────────────────────────────────────────────
test_describe "plannotator-tui extension"

# 造一个把 argv 落盘的桩二进制，回显其目录。
_make_stub() {
  local stub_dir="$ROOT_DIR/.pi/tmp/plannotator-stub-$$-$RANDOM"
  mkdir -p "$stub_dir"
  cat >"$stub_dir/plannotator-tui" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >"${PLANNOTATOR_TUI_STUB_LOG:?PLANNOTATOR_TUI_STUB_LOG unset}"
exit 0
STUB
  chmod +x "$stub_dir/plannotator-tui"
  echo "$stub_dir"
}

# 断言桩日志逐行等于期望（$1=日志文件，其余=期望的 argv 行）
_expect_argv() {
  local log_file="$1"
  shift
  if [[ ! -f "$log_file" ]]; then
    echo "FAIL: 桩二进制没有被调用（$log_file 不存在）"
    return 1
  fi
  local expected_file="$log_file.expected"
  printf '%s\n' "$@" >"$expected_file"
  if diff -u "$expected_file" "$log_file"; then
    echo "PASS: argv = $(tr '\n' ' ' <"$log_file")"
    rm -f "$expected_file"
    return 0
  fi
  echo "FAIL: argv 与期望不一致（见上方 diff）"
  rm -f "$expected_file"
  return 1
}

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,plannotator-tui" \
    --prompt "hi" \
    --expect-no-error
  exit 0
TEST

test_it "path argument opens the file with herdr open" <<'TEST'
  STUB_DIR="$(_make_stub)"
  export PLANNOTATOR_TUI_BIN="$STUB_DIR/plannotator-tui"
  export PLANNOTATOR_TUI_STUB_LOG="$STUB_DIR/argv.txt"
  export HERDR_ENV=1
  export HERDR_PANE_ID="w1:pE2E"
  TARGET="$ROOT_DIR/CHANGELOG.md"

  run_pi_and_check \
    --extensions "pi-logger,plannotator-tui" \
    --prompt "/plannotator-tui $TARGET" \
    --expect-no-error || { rm -rf "$STUB_DIR"; exit 1; }

  status=0
  _expect_argv "$STUB_DIR/argv.txt" \
    "herdr" "open" "$TARGET" "--deliver-to" "w1:pE2E" || status=1
  rm -rf "$STUB_DIR"
  exit $status
TEST

test_it "last / newest / terminal map to their own argv" <<'TEST'
  for arg in last newest terminal; do
    STUB_DIR="$(_make_stub)"
    export PLANNOTATOR_TUI_BIN="$STUB_DIR/plannotator-tui"
    export PLANNOTATOR_TUI_STUB_LOG="$STUB_DIR/argv.txt"
    export HERDR_ENV=1
    export HERDR_PANE_ID="w1:pE2E"

    run_pi_and_check \
      --extensions "pi-logger,plannotator-tui" \
      --prompt "/plannotator-tui $arg" \
      --expect-no-error || { rm -rf "$STUB_DIR"; exit 1; }

    if [[ "$arg" == "newest" ]]; then
      expected=("herdr" "last" "--newest" "--deliver-to" "w1:pE2E")
    elif [[ "$arg" == "last" ]]; then
      expected=("herdr" "last" "--deliver-to" "w1:pE2E")
    else
      expected=("herdr" "terminal" "--deliver-to" "w1:pE2E")
    fi

    if ! _expect_argv "$STUB_DIR/argv.txt" "${expected[@]}"; then
      rm -rf "$STUB_DIR"
      exit 1
    fi
    rm -rf "$STUB_DIR"
  done
  exit 0
TEST

test_it "removed annotation arguments never reach herdr" <<'TEST'
  STUB_DIR="$(_make_stub)"
  export PLANNOTATOR_TUI_BIN="$STUB_DIR/plannotator-tui"
  export PLANNOTATOR_TUI_STUB_LOG="$STUB_DIR/argv.txt"
  export HERDR_ENV=1
  export HERDR_PANE_ID="w1:pE2E"

  run_pi_and_check \
    --extensions "pi-logger,plannotator-tui" \
    --prompt "/plannotator-tui send" \
    --expect-no-error || { rm -rf "$STUB_DIR"; exit 1; }

  if [[ -f "$STUB_DIR/argv.txt" ]]; then
    echo "FAIL: send 不应触发 herdr 调用，实际 argv=$(cat "$STUB_DIR/argv.txt")"
    rm -rf "$STUB_DIR"
    exit 1
  fi
  echo "PASS: send 未触发 herdr 调用"
  rm -rf "$STUB_DIR"
  exit 0
TEST

test_it "outside herdr nothing is launched and the reason is logged" <<'TEST'
  STUB_DIR="$(_make_stub)"
  export PLANNOTATOR_TUI_BIN="$STUB_DIR/plannotator-tui"
  export PLANNOTATOR_TUI_STUB_LOG="$STUB_DIR/argv.txt"
  unset HERDR_ENV
  unset HERDR_PANE_ID

  run_pi_and_check \
    --extensions "pi-logger,plannotator-tui" \
    --prompt "/plannotator-tui last" \
    --expect-no-error || { rm -rf "$STUB_DIR"; exit 1; }

  status=0
  if [[ -f "$STUB_DIR/argv.txt" ]]; then
    echo "FAIL: 不在 herdr 会话仍调用了二进制"
    status=1
  fi
  if ! grep -rq "不在 Herdr 会话里" "$PI_LOG_DIR" 2>/dev/null; then
    echo "FAIL: 日志里没有「不在 Herdr 会话里」的留痕"
    status=1
  fi
  [[ $status -eq 0 ]] && echo "PASS: 会话外不调用、且留痕可查"
  rm -rf "$STUB_DIR"
  exit $status
TEST

test_it "missing binary reports a readable error without hanging" <<'TEST'
  export PLANNOTATOR_TUI_BIN="$ROOT_DIR/.pi/tmp/definitely-missing-plannotator-$$"
  rm -f "$PLANNOTATOR_TUI_BIN"
  export HERDR_ENV=1
  export HERDR_PANE_ID="w1:pE2E"

  run_pi_and_check \
    --extensions "pi-logger,plannotator-tui" \
    --prompt "/plannotator-tui last" \
    --expect-no-error || exit 1

  if grep -rq "PLANNOTATOR_TUI_BIN 指向的文件不存在" "$PI_LOG_DIR" 2>/dev/null; then
    echo "PASS: 二进制缺失有可读报错"
    exit 0
  fi
  echo "FAIL: 二进制缺失没有留下可读报错"
  exit 1
TEST
