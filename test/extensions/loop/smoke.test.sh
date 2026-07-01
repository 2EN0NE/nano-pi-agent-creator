#\!/usr/bin/env bash

test_describe "loop extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "loop"     --prompt "hi"     --save-output
  exit 0
TEST
