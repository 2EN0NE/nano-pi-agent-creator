#\!/usr/bin/env bash

test_describe "permission-gate extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "permission-gate"     --prompt "hi"     --save-output
  exit 0
TEST
