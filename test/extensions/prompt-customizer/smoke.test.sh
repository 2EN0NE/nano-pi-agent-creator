#\!/usr/bin/env bash

test_describe "prompt-customizer extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "prompt-customizer"     --prompt "hi"     --save-output
  exit 0
TEST
