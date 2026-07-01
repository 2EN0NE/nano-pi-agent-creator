#\!/usr/bin/env bash

test_describe "dirty-repo-guard extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "dirty-repo-guard"     --prompt "hi"     --save-output
  exit 0
TEST
