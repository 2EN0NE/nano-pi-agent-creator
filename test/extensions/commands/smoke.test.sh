#\!/usr/bin/env bash

test_describe "commands extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "commands"     --prompt "hi"     --save-output
  exit 0
TEST
