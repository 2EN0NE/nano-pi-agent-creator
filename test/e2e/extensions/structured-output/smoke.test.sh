#\!/usr/bin/env bash

test_describe "structured-output extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "structured-output"     --prompt "hi"     --save-output
  exit 0
TEST
