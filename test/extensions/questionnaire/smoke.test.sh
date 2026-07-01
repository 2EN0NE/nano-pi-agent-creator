#\!/usr/bin/env bash

test_describe "questionnaire extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "questionnaire"     --prompt "hi"     --save-output
  exit 0
TEST
