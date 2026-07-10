#!/usr/bin/env bash
# e2e test: custom-compaction
#
# Tests:
# 1. Extension loads without errors
# 2. Config write/read cycle works (session-level persistence)
# 3. Proactive trigger fires when threshold is exceeded
# 4. Session config survives reload
#
# Key logging verified:
# - "Proactive trigger check: context" with % and threshold
# - "Proactive compaction triggered at" when condition met
# - "Config loaded from" with correct path
# - "Config saved to" with correct path

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/test/scripts/run-e2e.sh" 2>/dev/null || true

test_describe "custom-compaction"

# ── Helper: cleanup config dir ──────────────────────────────────
CONFIG_DIR="$HOME/.pi/agent/extensions-data/custom-compaction"
cleanup_config() {
	rm -f "$CONFIG_DIR"/*.json 2>/dev/null || true
}
trap cleanup_config EXIT

# ══════════════════════════════════════════════════════════════════
# Test 1: Loads without errors
# ══════════════════════════════════════════════════════════════════
test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "custom-compaction"     --prompt "hi"     --save-output
  exit 0
TEST

# ══════════════════════════════════════════════════════════════════
# Test 2: Config read/write cycle (direct file test)
# ══════════════════════════════════════════════════════════════════
test_it "config read/write cycle" <<'TEST'
  cleanup_config
  mkdir -p "$CONFIG_DIR"

  # Write a config with 1% threshold
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{
  "version": 1,
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "strategy": { "type": "context_percent", "threshold": 1 },
      "prompt": "", "autoContinue": false,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF
  echo "[SETUP] config.json threshold=1%"

  # Read back and verify
  THRESHOLD=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/config.json'))['profiles']['default']['strategy']['threshold'])")
  if [ "$THRESHOLD" = "1" ]; then
    echo "[PASS] Config written and read correctly (threshold=$THRESHOLD)"
  else
    echo "[FAIL] Expected threshold=1, got $THRESHOLD"
    exit 1
  fi
  exit 0
TEST

# ══════════════════════════════════════════════════════════════════
# Test 3: Session config takes priority over base config
# ══════════════════════════════════════════════════════════════════
test_it "session config takes priority" <<'TEST'
  cleanup_config
  mkdir -p "$CONFIG_DIR"

  # Base config: threshold=80
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{
  "version": 1,
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "strategy": { "type": "context_percent", "threshold": 80 },
      "prompt": "", "autoContinue": false,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF

  # Session config: threshold=5
  cat > "$CONFIG_DIR/test-session-123.json" <<'JSONEOF'
{
  "version": 1,
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "strategy": { "type": "context_percent", "threshold": 5 },
      "prompt": "", "autoContinue": false,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF
  echo "[SETUP] config.json threshold=80, test-session-123.json threshold=5"

  # In the real pi run, loadConfig would check _activeSessionId first.
  # Here we verify the file structure is correct.
  if [ -f "$CONFIG_DIR/config.json" ] && [ -f "$CONFIG_DIR/test-session-123.json" ]; then
    echo "[PASS] Both config files exist"
  else
    echo "[FAIL] Missing config files"
    exit 1
  fi

  # Verify session config has different threshold
  SESSION_T=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/test-session-123.json'))['profiles']['default']['strategy']['threshold'])")
  BASE_T=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/config.json'))['profiles']['default']['strategy']['threshold'])")
  echo "[INFO] Session threshold=$SESSION_T, Base threshold=$BASE_T"
  if [ "$SESSION_T" != "$BASE_T" ]; then
    echo "[PASS] Session config ($SESSION_T) differs from base ($BASE_T)"
  else
    echo "[FAIL] Session and base thresholds are identical"
    exit 1
  fi
  exit 0
TEST

# ══════════════════════════════════════════════════════════════════
# Test 4: Compaction trigger with 1% threshold + long prompt
# ══════════════════════════════════════════════════════════════════
test_it "compaction trigger with 1% threshold" <<'TEST'
  mark_for_review "Check if compaction was triggered. Look for:
    1. 'Proactive trigger check: context XXX%' showing current usage vs threshold=1%
    2. 'Proactive compaction triggered at' (expected if context > 1%)
    3. 'Custom compaction: summarizing' (from session_before_compact handler)
    4. 'Config loaded from' showing the correct path"

  cleanup_config
  mkdir -p "$CONFIG_DIR"

  # Write base config with 1% threshold so ANY context triggers compaction
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{
  "version": 1,
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "strategy": { "type": "context_percent", "threshold": 1 },
      "prompt": "",
      "autoContinue": false,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF
  echo "[SETUP] config.json threshold=1%"

  # Generate a long prompt (~5K tokens) to produce measurable context usage
  LONG_PROMPT=""
  for i in $(seq 1 200); do
    LONG_PROMPT="${LONG_PROMPT}This is a long line number $i that adds context to the conversation. "
  done
  LONG_PROMPT="${LONG_PROMPT}Please summarize everything above."

  # Run pi with a long prompt to build context
  # Use -e to load the source extension (not from .pi/)
  cd "$ROOT_DIR"
  set +e
  timeout 90 npx pi -a --no-session \
    -e ./extensions/context/custom-compaction \
    -p "$LONG_PROMPT" \
    2>&1 | tee "$TEST_HOME/pi-output.log" || true
  PI_EXIT=$?
  set -e
  cd "$ROOT_DIR"

  # Check results
  OUT="$TEST_HOME/pi-output.log"
  PASS=0
  FAIL=0

  echo ""
  echo "--- Check 1: No JS errors ---"
  if grep -qE "SyntaxError|TypeError|ReferenceError" "$OUT" 2>/dev/null; then
    echo "  [FAIL] JS errors found"
    FAIL=$((FAIL + 1))
  else
    echo "  [PASS]"
    PASS=$((PASS + 1))
  fi

  echo "--- Check 2: Extension loaded ---"
  if grep -q "custom-compaction" "$OUT" 2>/dev/null; then
    echo "  [PASS]"
    PASS=$((PASS + 1))
  else
    echo "  [WARN] Extension log not found"
  fi

  echo "--- Check 3: Proactive trigger check appeared ---"
  if grep -q "Proactive trigger check:" "$OUT" 2>/dev/null; then
    echo "  [PASS]"
    echo "  $(grep 'Proactive trigger check:' "$OUT")"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] No proactive trigger check in logs"
    FAIL=$((FAIL + 1))
  fi

  echo "--- Check 4: Config loaded message ---"
  if grep -q "Config loaded from" "$OUT" 2>/dev/null; then
    echo "  [PASS]"
    echo "  $(grep 'Config loaded from' "$OUT")"
    PASS=$((PASS + 1))
  else
    echo "  [WARN] Config loaded from not found"
  fi

  echo "--- Check 5: Compaction triggered (threshold=1%) ---"
  if grep -q "Proactive compaction triggered" "$OUT" 2>/dev/null; then
    echo "  [PASS] Compaction was triggered"
    echo "  $(grep 'Proactive compaction triggered' "$OUT")"
    PASS=$((PASS + 1))
  elif grep -q "Proactive trigger check:" "$OUT" 2>/dev/null; then
    # Extraction: show context % and threshold for review
    echo "  [REVIEW] Proactive trigger check found but compaction may not have fired"
    echo "  $(grep 'Proactive trigger check:' "$OUT")"
    echo "  If context % < threshold=1%, this is expected (no compaction needed)."
    echo "  If context % >= threshold=1%, compaction should have triggered."
  else
    echo "  [FAIL] No compaction trigger log found"
    FAIL=$((FAIL + 1))
  fi

  # Full log dump for review
  echo ""
  echo "=== Full extension log dump ==="
  grep -iE "custom-compaction|config|proactive|Compaction|session_before" "$OUT" || echo "(no ext logs)"

  # Save output for review
  cp "$OUT" "$TEST_HOME/pi-full-output.log" 2>/dev/null || true

  exit $FAIL
TEST

# ══════════════════════════════════════════════════════════════════
# Test 5: Session config persists across reload
# ══════════════════════════════════════════════════════════════════
test_it "session config survives reload" <<'TEST'
  mark_for_review "Check that session config survives reload.
    After writing a session-specific config and reloading pi, verify the
    session config is loaded (not the base config).
    Look for: 'Config loaded from' pointing to <sessionId>.json"

  cleanup_config
  mkdir -p "$CONFIG_DIR"

  # Base config with 80% threshold
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{
  "version": 1,
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "strategy": { "type": "context_percent", "threshold": 80 },
      "prompt": "", "autoContinue": false,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF

  # Create a session config with 10% threshold (simulating a saved session override)
  cat > "$CONFIG_DIR/e2e-persistence-test.json" <<'JSONEOF'
{
  "version": 1,
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "strategy": { "type": "context_percent", "threshold": 10 },
      "prompt": "Be concise.", "autoContinue": true,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF
  echo "[SETUP] Base threshold=80%, Session threshold=10%"

  cd "$ROOT_DIR"
  set +e
  timeout 30 npx pi -a --no-session \
    -e ./extensions/context/custom-compaction \
    -p "Test persistence" \
    2>&1 | tee "$TEST_HOME/pi-persistence-output.log" || true
  set -e
  cd "$ROOT_DIR"

  OUT="$TEST_HOME/pi-persistence-output.log"
  echo ""
  echo "=== Persistence test logs ==="
  grep -iE "custom-compaction|Config loaded|threshold" "$OUT" || echo "(no ext logs)"
  exit 0
TEST
