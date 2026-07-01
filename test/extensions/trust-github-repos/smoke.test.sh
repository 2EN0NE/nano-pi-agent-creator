#\!/usr/bin/env bash

test_describe "trust-github-repos extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "trust-github-repos"     --prompt "hi"     --save-output
  exit 0
TEST
