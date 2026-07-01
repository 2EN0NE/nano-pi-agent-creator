#\!/usr/bin/env bash

test_describe "git-merge-and-resolve extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "git-merge-and-resolve"     --prompt "hi"     --save-output
  exit 0
TEST
