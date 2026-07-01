#\!/usr/bin/env bash

test_describe "answer extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "answer"     --prompt "hi"     --save-output
  exit 0
TEST
