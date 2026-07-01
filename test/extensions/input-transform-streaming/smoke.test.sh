#\!/usr/bin/env bash

test_describe "input-transform-streaming extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "input-transform-streaming"     --prompt "hi"     --save-output
  exit 0
TEST
