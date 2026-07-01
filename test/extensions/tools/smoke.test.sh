#\!/usr/bin/env bash

test_describe "tools extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "tools"     --prompt "hi"     --save-output
  exit 0
TEST
