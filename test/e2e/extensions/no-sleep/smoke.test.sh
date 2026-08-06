#\!/usr/bin/env bash

test_describe "no-sleep extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "no-sleep"     --prompt "hi"     --save-output
  exit 0
TEST
