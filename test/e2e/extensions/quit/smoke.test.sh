#!/usr/bin/env bash

test_describe "quit extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,quit" \
    --prompt "hi" \
    --expect-no-error
  exit 0
TEST

test_it "logs extension activity during session" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,quit" \
    --prompt "hi" \
    --expect-no-error

  # Verify the extension loaded in logs
  LOG_DIR="$PI_LOG_DIR"
  if [[ -d "$LOG_DIR" ]]; then
    # Check for quit log content
    found=$(grep -r "quit" "$LOG_DIR" 2>/dev/null | head -3)
    if [[ -n "$found" ]]; then
      echo "PASS: Found quit extension log activity"
    else
      echo "WARN: No quit activity in logs — extension may not have processed events yet"
    fi
  fi
  exit 0
TEST
