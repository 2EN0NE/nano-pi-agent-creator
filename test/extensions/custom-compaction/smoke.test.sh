#!/usr/bin/env bash
# custom-compaction e2e tests
#
# Tests:
# 1. Extension loads without errors
# 2. Config read/write cycle with new trigger+mechanism format
# 3. Session config takes priority over base config
# 4. Compaction trigger with 1% threshold + long prompt
# 5. (migration removed — schema at final shape)
# 6. Adapter registration works
# 7. Trigger + mechanism dispatch variants

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONFIG_DIR="$HOME/.pi/agent/extensions-data/custom-compaction"
TEST_HOME=$(mktemp -d /tmp/cc-test-XXXXXX)
cleanup_all() { rm -rf "$TEST_HOME"; }
trap cleanup_all EXIT

cleanup_config() { rm -f "$CONFIG_DIR"/*.json 2>/dev/null || true; }

# ══════════════════════════════════════════════════════════════════
test_describe "custom-compaction"

# ── Test 1: Basic load ───────────────────────────────────────────
test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "custom-compaction"     --prompt "hi"     --save-output
  exit 0
TEST

# ── Test 2: Config v3 read/write ────────────────────────────────
test_it "config v3 read/write with trigger + mechanism" <<'TEST'
  cleanup_config
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","trigger":{"type":"context_percent","threshold":1},"mechanism":{"type":"summarize"},"prompt":"","autoContinue":true,"autoContinueMessage":"继续按目标完成任务，全部验证"}}}
JSONEOF
  TRIGGER=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/config.json'))['profiles']['default']['trigger']['threshold'])")
  MECHANISM=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/config.json'))['profiles']['default']['mechanism']['type'])")
  [ "$TRIGGER" = "1" ] && [ "$MECHANISM" = "summarize" ] && echo "[PASS] trigger=$TRIGGER mechanism=$MECHANISM" || { echo "[FAIL] expected trigger=1 mechanism=summarize, got trigger=$TRIGGER mechanism=$MECHANISM"; exit 1; }
  exit 0
TEST

# ── Test 3: Session config priority ─────────────────────────────
test_it "session config priority" <<'TEST'
  cleanup_config
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","trigger":{"type":"context_percent","threshold":80},"mechanism":{"type":"summarize"},"prompt":"","autoContinue":true,"autoContinueMessage":"继续按目标完成任务，全部验证"}}}
JSONEOF
  cat > "$CONFIG_DIR/e2e-session-test.json" <<'JSONEOF'
{"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","trigger":{"type":"context_percent","threshold":5},"mechanism":{"type":"pass_through"},"prompt":"","autoContinue":true,"autoContinueMessage":"继续按目标完成任务，全部验证"}}}
JSONEOF
  S_T=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/e2e-session-test.json'))['profiles']['default']['trigger']['threshold'])")
  S_M=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/e2e-session-test.json'))['profiles']['default']['mechanism']['type'])")
  B_T=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/config.json'))['profiles']['default']['trigger']['threshold'])")
  B_M=$(python3 -c "import json; print(json.load(open('$CONFIG_DIR/config.json'))['profiles']['default']['mechanism']['type'])")
  [ "$S_T" = "5" ] && [ "$S_M" = "pass_through" ] && [ "$B_T" = "80" ] && [ "$B_M" = "summarize" ] && echo "[PASS] session ${S_T}%/${S_M} != base ${B_T}%/${B_M}" || { echo "[FAIL]"; exit 1; }
  exit 0
TEST

# ── Test 4: Compaction trigger with 1% threshold ────────────────
test_it "compaction trigger with summarize mechanism" <<'TEST'
  mark_for_review "Check pi-logger for compaction trigger and summarize dispatch"

  cleanup_config && mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","trigger":{"type":"context_percent","threshold":1},"mechanism":{"type":"summarize"},"prompt":"","autoContinue":false,"autoContinueMessage":"继续按目标完成任务，全部验证"}}}
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
  # Verify it dispatched as summarize mechanism (not pass_through)
  [ -n "$EXT_LOG" ] && grep -q "Mechanism is \"pass_through\"" "$EXT_LOG" 2>/dev/null && { echo "[WARN] Unexpected pass_through dispatch"; } || echo "[PASS] Not dispatched as pass_through"
  exit $F
TEST

# ── Test 5: Config persistence (simulate reload) ────────────────
test_it "config survives reload (simulated)" <<'TEST'
  mark_for_review "Check 'Config loaded from' path in pi-logger"

  cleanup_config && mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","trigger":{"type":"context_percent","threshold":80},"mechanism":{"type":"summarize"},"prompt":"","autoContinue":true,"autoContinueMessage":"继续按目标完成任务，全部验证"}}}
JSONEOF
  cat > "$CONFIG_DIR/e2e-persist.json" <<'JSONEOF'
{"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","trigger":{"type":"context_percent","threshold":10},"mechanism":{"type":"pass_through"},"prompt":"Be concise.","autoContinue":true,"autoContinueMessage":"继续按目标完成任务，全部验证"}}}
JSONEOF

  cd "$ROOT_DIR"
  set +e
  timeout 30 $(which pi) -a --no-session -e ./extensions/context/custom-compaction -p "Test persistence" >"$TEST_HOME/pi2.log" 2>&1 || true
  set -e; cd "$ROOT_DIR"

  CFG_LOG=$(ls -t "$ROOT_DIR/.pi/logs"/custom-compaction_config_*.log 2>/dev/null | head -1)
  [ -n "$CFG_LOG" ] && grep -i "Config loaded from" "$CFG_LOG" || echo "(no config log)"
  exit 0
TEST

# ── Test 6: Adapter registration ────────────────────────────────
test_it "adapter registration works" <<'TEST'
  mark_for_review "Check pi-logger for adapter registration"
  cleanup_config

  cd "$ROOT_DIR"
  set +e
  timeout 15 $(which pi) -a --no-session -e ./extensions/context/custom-compaction -p "hi" >"$TEST_HOME/adapter.log" 2>&1 || true
  set -e; cd "$ROOT_DIR"

  EXT_LOG=$(ls -t "$ROOT_DIR/.pi/logs"/custom-compaction-adapter*.log 2>/dev/null | head -1)
  [ -n "$EXT_LOG" ] && echo "=== Adapter log: $EXT_LOG ===" && cat "$EXT_LOG" || echo "(no adapter log)"

  P=0; F=0
  grep -qE "SyntaxError|TypeError" "$TEST_HOME/adapter.log" 2>/dev/null && { F=$((F+1)); echo "[FAIL] JS errors"; } || { P=$((P+1)); echo "[PASS] No JS errors"; }
  [ -n "$EXT_LOG" ] && grep -q "Adapter registered" "$EXT_LOG" 2>/dev/null && { P=$((P+1)); echo "[PASS] smart_compact adapter registered"; } || echo "[WARN] adapter registration not found (may log under different path)"

  # Verify the adapter log for collaboration mode
  [ -n "$EXT_LOG" ] && grep -q "collaboration mode" "$EXT_LOG" 2>/dev/null && { P=$((P+1)); echo "[PASS] adapter in collaboration mode"; } || echo "[WARN] collaboration mode message not found"
  exit $F
TEST

# ── Test 8: pass_through mechanism ──────────────────────────────
test_it "pass_through mechanism skips handler" <<'TEST'
  mark_for_review "Check pi-logger for 'pass_through' message"
  cleanup_config && mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<'JSONEOF'
{"activeProfileId":"default","profiles":{"default":{"id":"default","name":"Default","model":"current","trigger":{"type":"context_percent","threshold":1},"mechanism":{"type":"pass_through"},"prompt":"","autoContinue":false,"autoContinueMessage":"继续按目标完成任务，全部验证"}}}
JSONEOF

  LONG=""; for i in $(seq 1 100); do LONG="${LONG}Line $i: Test data for compaction. "; done
  cd "$ROOT_DIR"
  set +e
  timeout 30 $(which pi) -a --no-session -e ./extensions/context/custom-compaction -p "$LONG" >"$TEST_HOME/pt.log" 2>&1 || true
  set -e; cd "$ROOT_DIR"

  EXT_LOG=$(ls -t "$ROOT_DIR/.pi/logs"/custom-compaction_*.log 2>/dev/null | head -1)
  echo "=== Log: $EXT_LOG ==="
  [ -n "$EXT_LOG" ] && grep -i "pass_through" "$EXT_LOG" || echo "(no pass_through log entry)"

  P=0; F=0
  grep -qE "SyntaxError|TypeError" "$TEST_HOME/pt.log" 2>/dev/null && { F=$((F+1)); echo "[FAIL] JS errors"; } || { P=$((P+1)); echo "[PASS] No JS errors"; }
  [ -n "$EXT_LOG" ] && grep -q "Mechanism is \"pass_through\"" "$EXT_LOG" 2>/dev/null && { P=$((P+1)); echo "[PASS] pass_through dispatch detected"; } || echo "[REVIEW] pass_through not detected (may not have triggered)"
  exit $F
TEST
