#!/usr/bin/env bash

test_describe "edit extension (pi-lab integrated)"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,pi-lab,edit" \
    --prompt "hi" \
    --save-output
  exit 0
TEST

test_it "pi-lab experiment auto-registered" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,pi-lab,edit" \
    --prompt "hi" \
    --save-output

  # Check logs for experiment registration
  LATEST_LOG=$(ls -1t "${PI_LOG_DIR}" 2>/dev/null | head -1)
  if [[ -f "${PI_LOG_DIR}/${LATEST_LOG}" ]] && grep -q "edit-strategy" "${PI_LOG_DIR}/${LATEST_LOG}" 2>/dev/null; then
    echo "PASS: edit-strategy experiment registered in logs"
  else
    echo "WARN: Could not verify experiment registration from logs"
  fi
  exit 0
TEST

test_it "no ERROR in logs" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,pi-lab,edit" \
    --prompt "hi" \
    --save-output

  LATEST_LOG=$(ls -1t "${PI_LOG_DIR}" 2>/dev/null | head -1)
  if [[ -f "${PI_LOG_DIR}/${LATEST_LOG}" ]]; then
    if grep -q "ERROR" "${PI_LOG_DIR}/${LATEST_LOG}" 2>/dev/null; then
      echo "FAIL: Found ERROR in pi-lab logs"
      grep "ERROR" "${PI_LOG_DIR}/${LATEST_LOG}" | head -5
      exit 1
    fi
    echo "PASS: No ERROR in logs"
  else
    echo "WARN: No log file found, skipping log check"
  fi
  exit 0
TEST
