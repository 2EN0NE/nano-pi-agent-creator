#!/usr/bin/env bash

test_describe "prompt-editor - prompt assembly inspector"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "prompt-editor"     --prompt "hi"     --save-output
  exit 0
TEST

test_it "session starts without lifecycle errors" <<'TEST'
  run_pi_and_check     --extensions "pi-logger,prompt-editor"     --prompt "hi"     --save-output

  # Check lifecycle log for session start/end - confirms session events fire
  local log_dir="$PI_LOG_DIR"
  local lc_log=""
  while IFS= read -r -d '' f; do
    if [[ "$(basename "$f")" == "__lifecycle__"*".log" ]]; then
      lc_log="$f"
      break
    fi
  done < <(find "$log_dir" -maxdepth 1 -type f -name "__lifecycle__*.log" -print0)

  if [[ -z "$lc_log" ]]; then
    echo "FAIL: No lifecycle log found"
    exit 1
  fi

  echo "Lifecycle log: $lc_log"

  # Must have session start
  if ! grep -q "session.*reason=startup" "$lc_log"; then
    echo "FAIL: No session startup in lifecycle log"
    cat "$lc_log"
    exit 1
  fi

  # Must have session end (quit)
  if ! grep -q "session.*reason=quit" "$lc_log"; then
    echo "FAIL: No session quit in lifecycle log"
    cat "$lc_log"
    exit 1
  fi

  # No ERROR level entries
  if grep -q "ERROR" "$lc_log"; then
    echo "FAIL: ERROR entries found in lifecycle log"
    grep "ERROR" "$lc_log"
    exit 1
  fi

  echo "PASS: Session lifecycle clean"
  exit 0
TEST
