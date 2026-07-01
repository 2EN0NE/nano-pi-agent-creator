#\!/usr/bin/env bash

test_describe "project-trust extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "project-trust"     --prompt "hi"     --save-output
  exit 0
TEST
