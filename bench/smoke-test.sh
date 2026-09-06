#!/usr/bin/env bash
# 冒烟测试：用 mock-llm（不烧钱）验证骨架全链路 + verify.sh 的失败侧判定。
#
# mock-llm 只回复 "Mock LLM is ready."，不会实现任务功能，因此每个任务的
# verify.sh 都必须产出 reward_binary=0（判 FAIL）。这等价验证了「verify.sh 在
# base 状态判 FAIL」——证明验收探针能正确判失败，而非恒 PASS。
#
# 默认遍历 bench/tasks/ 下全部任务；--task <slug> 只跑单个（CI 用 scc 单任务）。
#
# 用法：smoke-test.sh [--task <slug>]
set -euo pipefail

BENCH="$(cd "$(dirname "$0")" && pwd)"
TASK_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
  --task)
    TASK_FILTER="$2"
    shift 2
    ;;
  *)
    echo "unknown arg: $1" >&2
    exit 2
    ;;
  esac
done

# --- 依赖检查 ---
for cmd in git python3 pi; do
  command -v "$cmd" >/dev/null || {
    echo "missing dependency: $cmd" >&2
    exit 1
  }
done

# --- 任务列表（无 --task 时遍历全部） ---
if [[ -n "$TASK_FILTER" ]]; then
  TASK_LIST="$TASK_FILTER"
else
  TASK_LIST=$(ls "$BENCH/tasks")
fi

# --- 隔离 BENCH_HOME：只含 mock-llm 模型配置，避免读到用户真实模型/扩展 ---
SMOKE_ROOT="$BENCH/.smoke"
SMOKE_HOME="$SMOKE_ROOT/home"
rm -rf "$SMOKE_ROOT"
mkdir -p "$SMOKE_HOME/.pi/agent"
cat >"$SMOKE_HOME/.pi/agent/models-store.json" <<'EOF'
{
  "mock-llm": {
    "models": [
      {
        "id": "mock-model-1",
        "name": "Mock Model (smoke)",
        "api": "openai-completions",
        "provider": "mock-llm",
        "apiKey": "smoke-noop-key",
        "baseUrl": "http://localhost:0"
      }
    ],
    "default": "mock-model-1"
  }
}
EOF

FAILED=0
TASK_COUNT=0
for TASK in $TASK_LIST; do
  [[ -d "$BENCH/tasks/$TASK" ]] || {
    echo "task not found: $TASK" >&2
    exit 2
  }
  TASK_COUNT=$((TASK_COUNT + 1))
  CELL="$SMOKE_ROOT/cell-$TASK"
  echo "=== smoke cell: $TASK / plugin-mock-llm ==="
  if ! BENCH_HOME="$SMOKE_HOME" BENCH_MODEL="mock-llm/mock-model-1" \
    "$BENCH/run-cell.sh" "$BENCH/tasks/$TASK" "plugin-mock-llm" 0 "$CELL"; then
    echo "FAIL: run-cell error for $TASK" >&2
    FAILED=1
    continue
  fi

  # --- 断言 1：agent 确实以 mock-llm 起过会话（假绿防护） ---
  # pi 在 print 模式下模型不存在/扩展加载失败也常以 exit 0 结束；只有真实会话才有 turns/tokens，
  # 因此单独断言 exit code 不够，必须叠加会话健康信号。
  if ! python3 - "$CELL" <<'PYEOF'
import json, os, sys
cell = sys.argv[1]
res = json.load(open(os.path.join(cell, "result.json")))
exit_code_path = os.path.join(cell, "agent-exit-code.txt")
if os.path.exists(exit_code_path):
    exit_code = int(open(exit_code_path).read().strip())
    assert exit_code == 0, f"pi 进程异常退出：exit={exit_code}"
assert res.get("turns", 0) >= 1, "无任何 agent turn：pi 未以 mock-llm 起会话"
assert res.get("combined_total_tokens", 0) > 0, "零 token 消耗：pi 未以 mock-llm 起会话"
print("PASS: agent 确实运行过（exit=0 / turns>=1 / tokens>0）")
print(json.dumps(res, indent=2, ensure_ascii=False))
PYEOF
  then
    echo "FAIL: agent-run health assertion failed for $TASK" >&2
    FAILED=1
    continue
  fi

  # --- 断言 2：verify.sh 产出 reward_binary=0（mock 未实现功能 → FAIL） ---
  if ! python3 - "$CELL/result.json" <<'PYEOF'
import json, sys
res = json.load(open(sys.argv[1]))
assert "reward_binary" in res, "verify.sh 未产出 reward_binary（可能未执行或崩溃）"
assert res["reward_binary"] == 0, f"期望 reward_binary=0（mock 未实现功能），实际 {res['reward_binary']}"
assert "plugin_triggered" in res, "result.json 缺少 plugin_triggered 字段"
print("PASS: verify.sh 正确判定 mock 状态为 FAIL（reward_binary=0）")
print(f"  plugin_triggered={res['plugin_triggered']} (mock-llm 不调用任务声明的 trigger_tools，应为 False)")
PYEOF
  then
    echo "FAIL: verify.sh assertion failed for $TASK" >&2
    FAILED=1
  fi
done

[[ "$FAILED" -eq 0 ]] || {
  echo "" >&2
  echo "冒烟测试失败。" >&2
  exit 1
}

echo ""
echo "冒烟测试通过（$TASK_COUNT 个任务）。真实评测运行："
echo "  $BENCH/run-matrix.sh --tasks scc-bounded-memory-spilling --configs none,plugin-truncated-tool --reps 1 --model <provider>/<model-id>"
