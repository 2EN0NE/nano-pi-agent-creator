#\!/usr/bin/env bash

test_describe "split-fork extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "split-fork"     --prompt "hi"     --save-output
  exit 0
TEST
