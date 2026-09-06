#!/usr/bin/env bash

test_describe "bash-timeout extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,bash-timeout" \
    --prompt "hi" \
    --save-output
  exit 0
TEST
