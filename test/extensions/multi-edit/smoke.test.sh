#\!/usr/bin/env bash

test_describe "multi-edit extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "multi-edit"     --prompt "hi"     --save-output
  exit 0
TEST
