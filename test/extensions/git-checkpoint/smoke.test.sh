#\!/usr/bin/env bash

test_describe "git-checkpoint extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "git-checkpoint"     --prompt "hi"     --save-output
  exit 0
TEST
