#\!/usr/bin/env bash

test_describe "trigger-compact extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "trigger-compact"     --prompt "hi"     --save-output
  exit 0
TEST
