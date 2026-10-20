#!/usr/bin/env bash

test_describe "whimsical extension"

test_it "loads without errors and outputs a whimsical message" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,whimsical" \
    --prompt "hi" \
    --expect-no-error
  exit 0
TEST

test_it "logs whimsical:refresh with dimension and level" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,whimsical" \
    --prompt "hi" \
    --expect-no-error

  LOG_DIR="$PI_LOG_DIR"
  if [[ -d "$LOG_DIR" ]]; then
    line=$(grep -r "whimsical:refresh" "$LOG_DIR" 2>/dev/null | head -1)
    if [[ -z "$line" ]]; then
      echo "FAIL: No whimsical:refresh log entry found"
      find "$LOG_DIR" -type f 2>/dev/null | head -5
      exit 1
    fi
    echo "Found refresh line: $line"

    # Check it has a dimension= field with a known key
    if echo "$line" | grep -qE 'dimension=(thinkingSteps|avgTurnsPerQuestion|userQuestions|toolTypesUsed)'; then
      echo "PASS: dimension field valid"
    else
      echo "FAIL: dimension not recognized: $line"
      exit 1
    fi

    # Check it has a level= field (0, 1, or 2)
    if echo "$line" | grep -qE 'level=[012]'; then
      echo "PASS: level field valid"
    else
      echo "FAIL: level not found: $line"
      exit 1
    fi

    # Check it has a colorLevel= field (0-2)
    if echo "$line" | grep -qE 'colorLevel=[0-2]'; then
      echo "PASS: colorLevel field valid"
    else
      echo "FAIL: colorLevel not found: $line"
      exit 1
    fi

    # Check it has a colorName= field (default / warning / error)
    if echo "$line" | grep -qE 'colorName=(default|warning|error)'; then
      echo "PASS: colorName field valid"
    else
      echo "FAIL: colorName not recognized: $line"
      exit 1
    fi
  else
    echo "FAIL: No log directory found"
    exit 1
  fi
  exit 0
TEST

test_it "contains Chinese characters in the message field" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,whimsical" \
    --prompt "hi" \
    --expect-no-error

  LOG_DIR="$PI_LOG_DIR"
  if [[ -d "$LOG_DIR" ]]; then
    line=$(grep -r "whimsical:refresh" "$LOG_DIR" 2>/dev/null | head -1)
    echo "Refresh line: $line"

    # Extract the message=... part（可移植：macOS 自带 BSD grep 不支持 -P/\K）
    msg=$(printf '%s' "$line" | sed -n 's/.*message=\([^ ]*\).*/\1/p')
    if [[ -z "$msg" ]]; then
      echo "FAIL: Could not extract message field"
      exit 1
    fi
    echo "Extracted message: $msg"

    # Check for CJK characters (U+4E00–U+9FFF → UTF-8 首字节 0xE4–0xE9)
    # 可移植：不用 grep -P（BSD grep 无 PCRE）；LC_ALL=C 下按字节匹配首字节集合。
    # 注：该范围是 CJK 的**超集**（含假名/中日韩标点），对本用例（断言消息含中文）足够。
    cjk_lead=$(printf '\344\345\346\347\350\351') # 0xE4..0xE9
    if LC_ALL=C grep -q "[$cjk_lead]" <<<"$msg"; then
      echo "PASS: Message contains Chinese characters"
    else
      echo "FAIL: No CJK chars in: $msg"
      exit 1
    fi
  else
    echo "FAIL: No log directory found"
    exit 1
  fi
  exit 0
TEST

test_it "logs whimsical:history with session count" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,whimsical" \
    --prompt "hi" \
    --expect-no-error

  LOG_DIR="$PI_LOG_DIR"
  if [[ -d "$LOG_DIR" ]]; then
    line=$(grep -r "whimsical:history" "$LOG_DIR" 2>/dev/null | head -1)
    if [[ -z "$line" ]]; then
      echo "FAIL: No whimsical:history log entry found"
      exit 1
    fi
    echo "Found history line: $line"

    # Check it has sessions= field (should be 0 on first run)
    if echo "$line" | grep -qE 'sessions=[0-9]+'; then
      echo "PASS: sessions count found"
    else
      echo "FAIL: sessions= not found in: $line"
      exit 1
    fi
  else
    echo "FAIL: No log directory found"
    exit 1
  fi
  exit 0
TEST

test_it "logs whimsical:persist with sessionId on shutdown" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,whimsical" \
    --prompt "hi" \
    --expect-no-error

  LOG_DIR="$PI_LOG_DIR"
  if [[ -d "$LOG_DIR" ]]; then
    line=$(grep -r "whimsical:persist" "$LOG_DIR" 2>/dev/null | head -1)
    if [[ -z "$line" ]]; then
      echo "FAIL: No whimsical:persist log entry found"
      exit 1
    fi
    echo "Found persist line: $line"

    if echo "$line" | grep -qE 'sessionId=[a-f0-9-]+'; then
      echo "PASS: sessionId found in persist"
    else
      echo "FAIL: no sessionId in: $line"
      exit 1
    fi
  else
    echo "FAIL: No log directory found"
    exit 1
  fi
  exit 0
TEST
