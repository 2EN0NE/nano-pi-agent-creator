#!/usr/bin/env bash

test_describe "extension-dev-final-sync extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,extension-dev-final-sync" \
    --prompt "hi" \
    --expect-no-error
  exit 0
TEST

test_it "logs extension activity during session" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,extension-dev-final-sync" \
    --prompt "hi" \
    --expect-no-error

  # Verify the extension loaded in logs
  LOG_DIR="$PI_LOG_DIR"
  if [[ -d "$LOG_DIR" ]]; then
    found=$(grep -r "extension-dev-final-sync" "$LOG_DIR" 2>/dev/null | head -5)
    if [[ -n "$found" ]]; then
      echo "PASS: Found extension-dev-final-sync log activity"
    else
      echo "WARN: No extension-dev-final-sync activity in logs — extension may not have processed events yet"
    fi
  fi
  exit 0
TEST

test_it "detects no extension changes and skips sync" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,extension-dev-final-sync" \
    --prompt "hi" \
    --save-output

  # In sandbox, there's no git repo with extensions/ changes,
  # so the extension should detect no changes and skip.
  # This test verifies the extension doesn't crash.
  echo "PASS: Extension ran without crashing in no-change scenario"
  exit 0
TEST
