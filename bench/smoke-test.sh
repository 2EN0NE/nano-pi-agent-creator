#!/usr/bin/env bash
# 冒烟测试：用 mock-llm（不烧钱）验证骨架全链路 + verify.sh 的失败侧判定。
#
# mock-llm 只回复 "Mock LLM is ready."，不会实现任务功能，因此每个任务的
# verify.sh 都必须产出 reward_binary=0（判 FAIL）。这等价验证了「verify.sh 在
# base 状态判 FAIL」——证明验收探针能正确判失败，而非恒 PASS。
#
# 遍历 arms.json 的**全部臂**（none + 每个 plugin-*），见 ADR-0057：
#   - none 臂也纳入覆盖（早先只跑 plugin-mock-llm，而 none 臂专属的 CFG_FLAGS
#     空数组展开 bug 因此漏网，全量跑 3h 才发现对照组全废）
#   - mock-llm 不再是「一个臂」，改为经 BENCH_MOCK_LLM 注入的公共基座，
#     使 none 臂也能不烧钱地跑
#
# 默认遍历 bench/tasks/ 下全部任务 × 全部臂；--task <slug> 只跑单个任务（CI 用）。
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

# --- 任务列表（无 --task 时遍历全部） ---
if [[ -n "$TASK_FILTER" ]]; then
  TASK_LIST="$TASK_FILTER"
else
  TASK_LIST=$(ls "$BENCH/tasks")
fi

# --- 臂列表 = arms.json 的全部臂（单一来源，见 ADR-0057） ---
SMOKE_ARMS=()
while IFS= read -r arm; do
  [[ -z "$arm" ]] && continue
  SMOKE_ARMS+=("$arm")
done < <(python3 -c "
import json, sys
print('\n'.join((json.load(open(sys.argv[1])).get('arms') or {}).keys()))
" "$BENCH/arms.json")
[[ "${#SMOKE_ARMS[@]}" -gt 0 ]] || {
  echo "arms.json 未声明任何臂：$BENCH/arms.json" >&2
  exit 2
}

# 过滤本环境解析不到的臂（warn+skip）。冒烟遍历 arms.json 的全部臂，但某些臂依赖
# 第三方 npm 包（如 plugin-@ff-labs/pi-fff 只在装了该包的环境可解析）；CI 的 HOME
# 无此包，不应让整个冒烟在跑任何 cell 之前失败（见测试分析发现 P0）。
#   - none 臂始终保留；非 plugin- 前缀的臂不做解析检查
#   - 真实评测的 run-matrix.sh 语义不放宽：--configs 明确要求的臂缺失仍 fail-fast
RESOLVED_ARMS=()
SKIPPED_ARMS=()
for arm in ${SMOKE_ARMS[@]+"${SMOKE_ARMS[@]}"}; do
  if [[ "$arm" != plugin-* ]]; then
    RESOLVED_ARMS+=("$arm")
    continue
  fi
  arm_ok=1
  IFS='+' read -ra _arm_plugins <<<"${arm#plugin-}"
  for pname in ${_arm_plugins[@]+"${_arm_plugins[@]}"}; do
    [[ -n "$pname" ]] || continue
    bash "$BENCH/find-extension.sh" "$pname" >/dev/null 2>&1 || {
      arm_ok=0
      break
    }
  done
  if [[ "$arm_ok" -eq 1 ]]; then
    RESOLVED_ARMS+=("$arm")
  else
    SKIPPED_ARMS+=("$arm")
  fi
done
if [[ "${#SKIPPED_ARMS[@]}" -gt 0 ]]; then
  echo "⚠️  跳过本环境解析不到的臂（插件未安装）：${SKIPPED_ARMS[*]}" >&2
fi
SMOKE_ARMS=(${RESOLVED_ARMS[@]+"${RESOLVED_ARMS[@]}"})
[[ "${#SMOKE_ARMS[@]}" -gt 0 ]] || {
  echo "所有臂在本环境都解析不到（arms.json 缺 none 基线臂？）：$BENCH/arms.json" >&2
  exit 2
}
SMOKE_ARMS_CSV=$(
  IFS=,
  echo "${SMOKE_ARMS[*]}"
)

# mock-llm 测试替身：经 BENCH_MOCK_LLM 注入公共基座（不再是 config 臂）。
# 用与 run-cell 同一份解析规则，避免路径写死。
MOCK_LLM_PATH=$(bash "$BENCH/find-extension.sh" mock-llm) || {
  echo "找不到 mock-llm 测试替身（test/helpers/mock-llm.ts）" >&2
  exit 2
}

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

# --- 前置检查：收编原依赖检查（git / python3 / pi），并覆盖工具链 / 本地包 / cache / 臂 ---
# 放在 mock-llm 的 models-store 写好之后，preflight 才能一并校验它。
SMOKE_TASK_ARGS=()
for TASK in $TASK_LIST; do
  [[ -d "$BENCH/tasks/$TASK" ]] || {
    echo "task not found: $TASK" >&2
    exit 2
  }
  SMOKE_TASK_ARGS+=("$BENCH/tasks/$TASK")
done
BENCH_HOME="$SMOKE_HOME" BENCH_MODEL="mock-llm/mock-model-1" \
  bash "$BENCH/preflight.sh" --arms "$SMOKE_ARMS_CSV" ${SMOKE_TASK_ARGS[@]+"${SMOKE_TASK_ARGS[@]}"} || exit 2

# --- 单 cell 的两条断言（抽成函数，使「任务 × 臂」双层循环体保持短小） ---
assert_cell() {
  local task="$1" arm="$2" cell="$3"

  # 断言 1：agent 确实以 mock-llm 起过会话（假绿防护）。
  # pi 在 print 模式下模型不存在/扩展加载失败也常以 exit 0 结束，只有真实会话才有 turns/tokens，
  # 因此单独断言 exit code 不够，必须叠加会话健康信号。
  if ! python3 - "$cell" <<'PYEOF'
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
    echo "FAIL: agent-run health assertion failed for $task / $arm" >&2
    return 1
  fi

  # 断言 2：verify.sh 产出 reward_binary=0（mock 未实现功能 → FAIL），
  # 并按臂类型断言 plugin_triggered 三态（见测试分析发现 P2）：
  #   none 臂未声明 triggerTools → null；plugin-* 臂声明了但 mock 不调用 → false。
  # 若 plugin 臂也退化为 null，analyze.py 会把该 cell 当作「纳入配对」，触发率分母被污染。
  if ! python3 - "$cell/result.json" "$arm" <<'PYEOF'
import json, sys
res = json.load(open(sys.argv[1]))
arm = sys.argv[2]
assert "reward_binary" in res, "verify.sh 未产出 reward_binary（可能未执行或崩溃）"
assert res["reward_binary"] == 0, f"期望 reward_binary=0（mock 未实现功能），实际 {res['reward_binary']}"
assert "plugin_triggered" in res, "result.json 缺少 plugin_triggered 字段"
got = res["plugin_triggered"]
if arm == "none":
    assert got is None, f"none 臂的 plugin_triggered 应为 null，实际 {got!r}"
elif arm.startswith("plugin-"):
    assert got is False, f"{arm} 臂声明了 triggerTools，mock 未触发时应为 false，实际 {got!r}"
print("PASS: verify.sh 正确判定 mock 状态为 FAIL（reward_binary=0）")
print(f"  plugin_triggered={got}（{arm}）")
PYEOF
  then
    echo "FAIL: verify.sh assertion failed for $task / $arm" >&2
    return 1
  fi
  return 0
}

FAILED=0
CELL_COUNT=0
TASK_COUNT=0
for TASK in $TASK_LIST; do
  [[ -d "$BENCH/tasks/$TASK" ]] || {
    echo "task not found: $TASK" >&2
    exit 2
  }
  TASK_COUNT=$((TASK_COUNT + 1))
  for ARM in ${SMOKE_ARMS[@]+"${SMOKE_ARMS[@]}"}; do
    # 臂名含 /（scoped npm 包）不能作目录段：与 run-matrix.sh 的 CFG_SAFE 同一规则
    ARM_SAFE="${ARM//\//__}"
    CELL="$SMOKE_ROOT/cell-$TASK-$ARM_SAFE"
    CELL_COUNT=$((CELL_COUNT + 1))
    echo "=== smoke cell: $TASK / $ARM ==="
    if ! BENCH_HOME="$SMOKE_HOME" BENCH_MODEL="mock-llm/mock-model-1" BENCH_MOCK_LLM="$MOCK_LLM_PATH" \
      "$BENCH/run-cell.sh" "$BENCH/tasks/$TASK" "$ARM" 0 "$CELL"; then
      echo "FAIL: run-cell error for $TASK / $ARM" >&2
      FAILED=1
      continue
    fi
    assert_cell "$TASK" "$ARM" "$CELL" || FAILED=1
  done
done

[[ "$FAILED" -eq 0 ]] || {
  echo "" >&2
  echo "冒烟测试失败。" >&2
  exit 1
}

echo ""
echo "冒烟测试通过（$CELL_COUNT 个 cell = $TASK_COUNT 任务 × ${#SMOKE_ARMS[@]} 臂）。真实评测运行："
echo "  $BENCH/run-matrix.sh --tasks scc-bounded-memory-spilling --configs none,plugin-truncated-tool --reps 1 --model <provider>/<model-id>"
