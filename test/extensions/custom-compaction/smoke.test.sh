#\!/usr/bin/env bash

test_describe "custom-compaction extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "custom-compaction"     --prompt "hi"     --save-output
  exit 0
TEST
