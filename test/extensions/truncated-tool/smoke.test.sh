#\!/usr/bin/env bash

test_describe "truncated-tool extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "truncated-tool"     --prompt "hi"     --save-output
  exit 0
TEST
