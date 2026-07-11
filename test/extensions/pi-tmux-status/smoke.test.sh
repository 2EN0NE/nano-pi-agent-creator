#!/usr/bin/env bash

test_describe "pi-tmux-status (tmux border color indicator)"

test_it "loads without errors (no tmux context) via project root" <<'TEST'
  cd "$ROOT_DIR"
  pi -a --no-session \
    -e ./extensions/meta/selector \
    -e ./extensions/auto/pi-tmux-status/index.ts \
    -p "hi" \
    2>&1 >/dev/null
  local exit_code=$?
  [[ $exit_code -eq 0 ]] || {
    echo "FAIL: pi exit code = $exit_code"
    return 1
  }
  echo "pi-tmux-status loaded successfully (non-tmux context, should warn and skip)"
TEST

test_it "loads alongside btw and selector" <<'TEST'
  cd "$ROOT_DIR"
  pi -a --no-session \
    -e ./extensions/meta/selector \
    -e ./extensions/tui/btw.ts \
    -e ./extensions/auto/pi-tmux-status/index.ts \
    -p "hi" \
    2>&1 >/dev/null
  local exit_code=$?
  [[ $exit_code -eq 0 ]] || {
    echo "FAIL: pi exit code = $exit_code"
    return 1
  }
  echo "All extensions loaded together with npm import chain"
TEST
