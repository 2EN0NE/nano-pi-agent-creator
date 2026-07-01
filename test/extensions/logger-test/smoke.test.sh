#\!/usr/bin/env bash

test_describe "logger-test extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,logger-test" \
    --prompt "hi" \
    --save-output
  # Soft check: log directory indicates extension was loaded
  if compgen -G "${PI_LOG_DIR:-/dev/null}"/*.log >/dev/null 2>&1; then
    exit 0
  else
    echo "No log files found in ${PI_LOG_DIR:-<unset>}"
    exit 1
  fi
TEST

test_it "extension logs captured by pi-logger" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,logger-test" \
    --prompt "hi" \
    --save-output
  if compgen -G "${PI_LOG_DIR:-/dev/null}"/*.log >/dev/null 2>&1; then
    exit 0
  else
    echo "No log files found in ${PI_LOG_DIR:-<unset>}"
    exit 1
  fi
TEST
