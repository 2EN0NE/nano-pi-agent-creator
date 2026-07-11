#\!/usr/bin/env bash

test_describe "permission-gate extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "permission-gate"     --prompt "hi"     --save-output
  exit 0
TEST

test_it "intercepts chmod commands [REVIEW]" <<'TEST'
  # Prompt the model to run a chmod command, which should trigger permission-gate's block
  run_pi_and_check     --extensions "permission-gate"     --prompt "run chmod +x on /tmp/test-chmod-file and tell me the result"     --save-output
  mark_for_review "Verify that permission-gate intercepted the chmod command. The output should show a block message (no-UI fallback) or the command was blocked. Check the pi-logger logs for 'Dangerous command blocked' containing 'chmod'."
TEST
