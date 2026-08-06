#\!/usr/bin/env bash

test_describe "protected-paths extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "protected-paths"     --prompt "hi"     --save-output
  exit 0
TEST
