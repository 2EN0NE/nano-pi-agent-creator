#\!/usr/bin/env bash

test_describe "qna extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "qna"     --prompt "hi"     --save-output
  exit 0
TEST
