#\!/usr/bin/env bash

test_describe "uv extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "uv"     --prompt "hi"     --save-output
  exit 0
TEST
