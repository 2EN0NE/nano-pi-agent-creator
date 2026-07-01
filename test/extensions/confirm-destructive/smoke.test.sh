#\!/usr/bin/env bash

test_describe "confirm-destructive extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "confirm-destructive"     --prompt "hi"     --save-output
  exit 0
TEST
