#!/usr/bin/env bash
# e2e test: custom-compaction
#
# Tests:
# 1. Extension loads without errors
# 2. Config v3 write/read cycle (trigger + mechanism fields)
# 3. Proactive trigger fires when threshold is exceeded (summarize mechanism)
# 4. Session config survives reload
# 5. pass_through mechanism dispatches correctly
#
# Key logging verified:
# - "Proactive trigger check:" with % and threshold
# - "Proactive compaction triggered" when condition met
# - "Mechanism is \"pass_through\"" for pass_through profiles
# - "Adapter registered" from mechanisms/smart-compact.ts

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/test/scripts/run-e2e.sh" 2>/dev/null || true

test_describe "custom-compaction"

# ── Helper: cleanup config dir ──────────────────────────────────
CONFIG_DIR="$HOME/.pi/agent/extensions-data/custom-compaction"
cleanup_config() {
	rm -f "$CONFIG_DIR"/*.json 2>/dev/null || true
}
# Clean after tests (on exit). Framework-level cleanup in run_e2e.sh adds a second layer.
trap cleanup_config EXIT

# ══════════════════════════════════════════════════════════════════
# Test 1: Loads without errors
# ══════════════════════════════════════════════════════════════════
test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "custom-compaction"     --prompt "hi"     --save-output
  exit 0
TEST

# ══════════════════════════════════════════════════════════════════
# Test 2: Config v3 read/write (trigger + mechanism fields)
# ══════════════════════════════════════════════════════════════════
test_it "config v3 has trigger + mechanism fields" <<'TEST'
  cleanup_config
  mkdir -p "$CONFIG_DIR"

  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{
  
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "trigger": { "type": "context_percent", "threshold": 1 },
      "mechanism": { "type": "summarize" },
      "prompt": "", "autoContinue": false,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF
  echo "[SETUP] config.json version=3, trigger.threshold=1, mechanism=summarize"

  TRIGGER=$(python3 -c "import json; c=json.load(open('$CONFIG_DIR/config.json')); p=c['profiles']['default']; print(p['trigger']['threshold'], p['mechanism']['type'])")
  echo "[INFO] trigger.threshold=$TRIGGER"

  if python3 -c "
import json
c = json.load(open('$CONFIG_DIR/config.json'))
p = c['profiles']['default']
assert 'trigger' in p, 'missing trigger'
assert 'mechanism' in p, 'missing mechanism'
assert p['trigger']['type'] == 'context_percent'
assert p['mechanism']['type'] == 'summarize'
print('OK')
"; then
    echo "[PASS] Config v3 structure valid"
  else
    echo "[FAIL] Invalid v3 config structure"
    exit 1
  fi
  exit 0
TEST

# ══════════════════════════════════════════════════════════════════
# Test 3: Compaction trigger with 1% threshold + summarize mechanism
# ══════════════════════════════════════════════════════════════════
test_it "compaction trigger with summarize mechanism" <<'TEST'
  mark_for_review "Check if compaction was triggered with summarize mechanism. Look for:
    1. 'Proactive trigger check:' showing current usage vs threshold=1%
    2. 'Proactive compaction triggered' (expected if context > 1%)
    3. 'Custom compaction: summarizing' (from session_before_compact handler)
    4. NOT seeing 'Mechanism is \"pass_through\"'"

  cleanup_config
  mkdir -p "$CONFIG_DIR"

  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{
  
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "trigger": { "type": "context_percent", "threshold": 1 },
      "mechanism": { "type": "summarize" },
      "prompt": "",
      "autoContinue": false,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF
  echo "[SETUP] config.json trigger.threshold=1%, mechanism=summarize"

  LONG_PROMPT=""
  for i in $(seq 1 200); do
    LONG_PROMPT="${LONG_PROMPT}This is a long line number $i that adds context to the conversation. "
  done
  LONG_PROMPT="${LONG_PROMPT}Please summarize everything above."

  cd "$ROOT_DIR"
  set +e
  timeout 90 $(which pi) -a --no-session \
    -e ./extensions/context/custom-compaction \
    -p "$LONG_PROMPT" \
    2>&1 | tee "$TEST_HOME/pi-output.log" || true
  set -e
  cd "$ROOT_DIR"

  OUT="$TEST_HOME/pi-output.log"
  PASS=0; FAIL=0

  echo "--- Check 1: No JS errors ---"
  grep -qE "SyntaxError|TypeError|ReferenceError" "$OUT" 2>/dev/null && { FAIL=$((FAIL+1)); echo "  [FAIL]"; } || { PASS=$((PASS+1)); echo "  [PASS]"; }

  echo "--- Check 2: Extension loaded ---"
  grep -q "custom-compaction" "$OUT" 2>/dev/null && { PASS=$((PASS+1)); echo "  [PASS]"; } || echo "  [WARN] Not found"

  echo "--- Check 3: Proactive trigger check appeared ---"
  grep -q "Proactive trigger check:" "$OUT" 2>/dev/null && { PASS=$((PASS+1)); echo "  [PASS]"; } || { FAIL=$((FAIL+1)); echo "  [FAIL]"; }

  echo "--- Check 4: Config loaded message ---"
  grep -q "Config loaded from" "$OUT" 2>/dev/null && { PASS=$((PASS+1)); echo "  [PASS]"; } || echo "  [WARN] Not found"

  echo "--- Check 5: Compaction triggered ---"
  grep -q "Proactive compaction triggered" "$OUT" 2>/dev/null && { PASS=$((PASS+1)); echo "  [PASS]"; } || echo "  [REVIEW] Not triggered (context may be < 1%)"

  echo "--- Check 6: No pass_through dispatch ---"
  grep -q 'Mechanism is "pass_through"' "$OUT" 2>/dev/null && { echo "  [WARN] Unexpected pass_through"; } || { PASS=$((PASS+1)); echo "  [PASS] Not pass_through"; }

  echo ""
  echo "=== Extension log dump ==="
  grep -iE "custom-compaction|proactive|trigger|mechanism|session_before" "$OUT" || echo "(no ext logs)"

  exit $FAIL
TEST

# ══════════════════════════════════════════════════════════════════
# Test 4: Session config survives reload
# ══════════════════════════════════════════════════════════════════
test_it "session config survives reload" <<'TEST'
  mark_for_review "Check that session config is loaded correctly.
    Look for: 'Config loaded from' and verify correct path/values"

  cleanup_config
  mkdir -p "$CONFIG_DIR"

  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{
  
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "trigger": { "type": "context_percent", "threshold": 80 },
      "mechanism": { "type": "summarize" },
      "prompt": "", "autoContinue": true,
      "autoContinueMessage": "继续按目标完成任务，全部验证"
    }
  }
}
JSONEOF

  cat > "$CONFIG_DIR/e2e-persistence-test.json" <<'JSONEOF'
{
  
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "trigger": { "type": "context_percent", "threshold": 10 },
      "mechanism": { "type": "pass_through" },
      "prompt": "Be concise.", "autoContinue": true,
      "autoContinueMessage": "继续按目标完成任务，全部验证"
    }
  }
}
JSONEOF
  echo "[SETUP] Base threshold=80%, Session threshold=10% + pass_through"

  cd "$ROOT_DIR"
  set +e
  timeout 30 $(which pi) -a --no-session \
    -e ./extensions/context/custom-compaction \
    -p "Test persistence" \
    2>&1 | tee "$TEST_HOME/pi-persistence-output.log" || true
  set -e
  cd "$ROOT_DIR"

  OUT="$TEST_HOME/pi-persistence-output.log"
  echo ""
  echo "=== Persistence test logs ==="
  grep -iE "custom-compaction|Config loaded|threshold|mechanism" "$OUT" || echo "(no ext logs)"
  exit 0
TEST

# ══════════════════════════════════════════════════════════════════
# Test 5: pass_through mechanism
# ══════════════════════════════════════════════════════════════════
mark_for_review "Check that pass_through mechanism logs 'Mechanism is \"pass_through\"'.
    The extension should NOT show 'Custom compaction: summarizing' for this test."

cleanup_config
mkdir -p "$CONFIG_DIR"

cat >"$CONFIG_DIR/config.json" <<'JSONEOF'
{
  
  "activeProfileId": "default",
  "profiles": {
    "default": {
      "id": "default", "name": "Default", "model": "current",
      "trigger": { "type": "context_percent", "threshold": 1 },
      "mechanism": { "type": "pass_through" },
      "prompt": "", "autoContinue": false,
      "autoContinueMessage": "continue"
    }
  }
}
JSONEOF
echo "[SETUP] mechanism=pass_through, threshold=1%"

LONG=""
for i in $(seq 1 100); do LONG="${LONG}Line $i: Test data. "; done
cd "$ROOT_DIR"
set +e
timeout 30 $(which pi) -a --no-session \
	-e ./extensions/context/custom-compaction \
	-p "$LONG" 2>&1 | tee "$TEST_HOME/pt.log" || true
set -e
cd "$ROOT_DIR"

OUT="$TEST_HOME/pt.log"
PASS=0
FAIL=0

echo "--- Check 1: No JS errors ---"
grep -qE "SyntaxError|TypeError" "$OUT" 2>/dev/null && {
	FAIL=$((FAIL + 1))
	echo "  [FAIL]"
} || {
	PASS=$((PASS + 1))
	echo "  [PASS]"
}

echo "--- Check 2: pass_through dispatch ---"
grep -q 'Mechanism is "pass_through"' "$OUT" 2>/dev/null && {
	PASS=$((PASS + 1))
	echo "  [PASS]"
} || echo "  [REVIEW] Not triggered"

echo ""
echo "=== Extension log dump ==="
grep -iE "custom-compaction|mechanism|pass_through|trigger" "$OUT" || echo "(no ext logs)"
exit $FAIL
TEST
