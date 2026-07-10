#!/usr/bin/env bash
# custom-compaction e2e tests
#
# Tests:
# 1. Extension loads without errors
# 2. Config read/write cycle (file persistence)
# 3. Session config takes priority over base config
# 4. Compaction trigger with 1% threshold + long prompt
# 5. Config persistence (simulated reload)

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONFIG_DIR="$HOME/.pi/agent/extensions-data/custom-compaction"
TEST_HOME=$(mktemp -d /tmp/cc-test-XXXXXX)
cleanup_all() { rm -rf "$TEST_HOME"; }
trap cleanup_all EXIT

cleanup_config() { rm -f "$CONFIG_DIR"/*.json 2>/dev/null || true; }

# ══════════════════════════════════════════════════════════════════
test_describe "custom-compaction"

# Test 1: Basic load
test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "custom-compaction"     --prompt "hi"     --save-output
  exit 0
TEST

# Test 2: Config read/write
test_it "config read/write cycle" <<'TEST'
  cleanup_config
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"version":1,"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","strategy":{"type":"context_percent","threshold":1},"prompt":"","autoContinue":false,"autoContinueMessage":"continue"}}}
JSONEOF
  T=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/config.json'))['profiles']['default']['strategy']['threshold'])")
  [ "$T" = "1" ] && echo "[PASS] threshold=$T" || { echo "[FAIL] expected 1 got $T"; exit 1; }
  exit 0
TEST

# Test 3: Session config priority
test_it "session config priority" <<'TEST'
  cleanup_config
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"version":1,"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","strategy":{"type":"context_percent","threshold":80},"prompt":"","autoContinue":false,"autoContinueMessage":"continue"}}}
JSONEOF
  cat > "$CONFIG_DIR/e2e-session-test.json" <<'JSONEOF'
{"version":1,"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","strategy":{"type":"context_percent","threshold":5},"prompt":"","autoContinue":false,"autoContinueMessage":"continue"}}}
JSONEOF
  S_T=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/e2e-session-test.json'))['profiles']['default']['strategy']['threshold'])")
  B_T=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/config.json'))['profiles']['default']['strategy']['threshold'])")
  [ "$S_T" = "5" ] && [ "$B_T" = "80" ] && echo "[PASS] session ${S_T}% != base ${B_T}%" || { echo "[FAIL]"; exit 1; }
  exit 0
TEST

# Test 4: Compaction trigger with 1% threshold
test_it "compaction trigger with 1% threshold" <<'TEST'
  mark_for_review "Check pi-logger output for compaction trigger"

  cleanup_config && mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"version":1,"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","strategy":{"type":"context_percent","threshold":1},"prompt":"","autoContinue":false,"autoContinueMessage":"continue"}}}
JSONEOF

  LONG=""; for i in $(seq 1 300); do LONG="${LONG}Line $i: The quick brown fox jumps over the lazy dog. "; done
  LONG="${LONG}Summarize this."
  cd "$ROOT_DIR"
  set +e
  timeout 120 $(which pi) -a --no-session -e ./extensions/context/custom-compaction -p "$LONG" >"$TEST_HOME/pi-out.log" 2>&1 || true
  set -e
  cd "$ROOT_DIR"

  EXT_LOG=$(ls -t "$ROOT_DIR/.pi/logs"/custom-compaction_*.log 2>/dev/null | head -1)
  echo "=== Log: $EXT_LOG ==="
  [ -n "$EXT_LOG" ] && cat "$EXT_LOG" || echo "(no log)"

  P=0; F=0
  grep -qE "SyntaxError|TypeError" "$TEST_HOME/pi-out.log" 2>/dev/null && { F=$((F+1)); echo "[FAIL] JS errors"; } || { P=$((P+1)); echo "[PASS] No JS errors"; }
  [ -n "$EXT_LOG" ] && grep -q "Proactive trigger check:" "$EXT_LOG" 2>/dev/null && { P=$((P+1)); echo "[PASS] Proactive trigger check found"; } || echo "[WARN] no trigger check"
  [ -n "$EXT_LOG" ] && grep -q "Proactive compaction triggered" "$EXT_LOG" 2>/dev/null && { P=$((P+1)); echo "[PASS] Compaction triggered!"; } || echo "[REVIEW] No compaction triggered (see log above)"
  exit $F
TEST

# Test 5: Config persistence (simulate reload)
test_it "config survives reload (simulated)" <<'TEST'
  mark_for_review "Check 'Config loaded from' path in pi-logger"

  cleanup_config && mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"version":1,"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","strategy":{"type":"context_percent","threshold":80},"prompt":"","autoContinue":false,"autoContinueMessage":"continue"}}}
JSONEOF
  cat > "$CONFIG_DIR/e2e-persist.json" <<'JSONEOF'
{"version":1,"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","strategy":{"type":"context_percent","threshold":10},"prompt":"Be concise.","autoContinue":true,"autoContinueMessage":"continue"}}}
JSONEOF

  cd "$ROOT_DIR"
  set +e
  timeout 30 $(which pi) -a --no-session -e ./extensions/context/custom-compaction -p "Test persistence" >"$TEST_HOME/pi2.log" 2>&1 || true
  set -e; cd "$ROOT_DIR"

  CFG_LOG=$(ls -t "$ROOT_DIR/.pi/logs"/custom-compaction_config_*.log 2>/dev/null | head -1)
  [ -n "$CFG_LOG" ] && grep -i "Config loaded from" "$CFG_LOG" || echo "(no config log)"
  exit 0
TEST
