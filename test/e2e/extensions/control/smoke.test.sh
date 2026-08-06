#!/usr/bin/env bash

test_describe "control extension (meta)"

# ====================================================================
# SCENARIO 1: Basic loading
# ====================================================================
test_it "loads without errors [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,control" \
    --prompt "hi" \
    --save-output
  # pi exit code 0 or 124 (timeout with mock LLM) means it loaded
  if [[ "${PI_EXIT_CODE:-1}" == "0" ]] || [[ "${PI_EXIT_CODE:-1}" == "124" ]]; then
    exit 0
  fi
  echo "pi exit: ${PI_EXIT_CODE:-unknown}"
  exit 1
TEST

# ====================================================================
# SCENARIO 2: Extension logs captured by pi-logger
# ====================================================================
test_it "extension logs captured by pi-logger" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,control" \
    --prompt "hi" \
    --save-output
  if compgen -G "${PI_LOG_DIR:-/dev/null}"/*.log >/dev/null 2>&1; then
    exit 0
  else
    echo "No log files found in ${PI_LOG_DIR:-<unset>}"
    exit 1
  fi
TEST

# ====================================================================
# SCENARIO 3: Extension produces stdout output
# ====================================================================
test_it "produces output [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,control" \
    --prompt "hi" \
    --save-output
  if [[ -f "${PI_STDOUT_FILE:-}" ]] && [[ $(wc -c < "$PI_STDOUT_FILE" | tr -d ' ') -gt 0 ]]; then
    exit 0
  fi
  echo "No stdout output found"
  exit 1
TEST

# ====================================================================
# SCENARIO 4: No ERROR in log files
# ====================================================================
test_it "no ERROR in log files" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,control" \
    --prompt "hi" \
    --save-output
  if compgen -G "${PI_LOG_DIR:-/dev/null}"/*.log >/dev/null 2>&1; then
    for f in "${PI_LOG_DIR:-/dev/null}"/*.log; do
      if grep -q "ERROR" "$f" 2>/dev/null; then
        echo "ERROR found in: $f"
        exit 1
      fi
    done
  fi
  exit 0
TEST
