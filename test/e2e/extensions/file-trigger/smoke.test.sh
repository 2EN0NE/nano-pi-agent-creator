#\!/usr/bin/env bash

test_describe "file-trigger extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "file-trigger"     --prompt "hi"     --save-output
  exit 0
TEST
