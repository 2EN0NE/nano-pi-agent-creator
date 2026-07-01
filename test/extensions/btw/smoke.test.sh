#\!/usr/bin/env bash

test_describe "btw extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "btw"     --prompt "hi"     --save-output
  exit 0
TEST
