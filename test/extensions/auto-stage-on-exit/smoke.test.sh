#\!/usr/bin/env bash

test_describe "auto-stage-on-exit extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "auto-stage-on-exit"     --prompt "hi"     --save-output
  exit 0
TEST
