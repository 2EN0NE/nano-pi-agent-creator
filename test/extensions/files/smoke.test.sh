#\!/usr/bin/env bash

test_describe "files extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "files"     --prompt "hi"     --save-output
  exit 0
TEST
