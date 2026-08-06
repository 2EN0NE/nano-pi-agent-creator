#!/usr/bin/env bash

test_describe "mode-switcher extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "mode-switcher" \
    --prompt "hi" \
    --save-output
  exit 0
TEST
