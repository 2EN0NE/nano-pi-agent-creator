#!/usr/bin/env bash
# 编排一次 benchmark 运行：task × config × rep 循环，串行执行（LLM token 共享、避免并发刷新竞态）。
# 从 pi-fabric bench/run-matrix.sh 移植，config 语义改为 none / plugin-<name>。
#
# 相比上游新增：
#   - 强制显式 --model（无默认），preflight 校验模型存在于 models-store
#   - --resume <run-id> 断点续跑（跳过已完成 cell，中断/残缺 cell 重跑，配置不一致拒绝）
#   - progress.json 结构化进度 + run.log 自留档（配合 bench-status.sh 后台查询）
#   - run-id 在开始与结束都显式打印
#
# 用法：
#   run-matrix.sh [--tasks slug,slug] [--configs none,plugin-truncated-tool] [--reps N]
#                 --model <provider>/<model-id> [--thinking low] [--home <隔离HOME>] [--resume <run-id>]
set -u
BENCH="$(cd "$(dirname "$0")" && pwd)"
TASKS=""
CONFIGS="none"
REPS=1
MODEL="${BENCH_MODEL:-}"
THINKING="${BENCH_THINKING:-low}"
BENCH_HOME="${BENCH_HOME:-}"
RESUME=""

while [[ $# -gt 0 ]]; do
	case "$1" in
	--tasks)
		TASKS="$2"
		shift 2
		;;
	--configs)
		CONFIGS="$2"
		shift 2
		;;
	--reps)
		REPS="$2"
		shift 2
		;;
	--model)
		MODEL="$2"
		shift 2
		;;
	--thinking)
		THINKING="$2"
		shift 2
		;;
	--home)
		BENCH_HOME="$2"
		shift 2
		;;
	--resume)
		RESUME="$2"
		shift 2
		;;
	*)
		echo "unknown arg: $1" >&2
		exit 2
		;;
	esac
done

# --- 强制显式模型（去掉「碰运气」的隐式默认） ---
if [[ -z "$MODEL" ]]; then
	echo "错误：必须显式指定 --model <provider>/<model-id>（或 BENCH_MODEL）。" >&2
	echo "可用模型：pi --list-models" >&2
	exit 2
fi

# --- preflight：模型必须存在于 models-store（fail-fast，而非第一个 cell 内部静默失败） ---
MODEL_STORE="${BENCH_HOME:-$HOME}/.pi/agent/models-store.json"
if [[ ! -f "$MODEL_STORE" ]]; then
	echo "错误：找不到模型库 $MODEL_STORE" >&2
	echo "先配置模型：pi --list-models 查看，或用 pi 的模型管理添加。" >&2
	exit 2
fi
python3 - "$MODEL" "$MODEL_STORE" <<'PYEOF'
import json, sys
model, store = sys.argv[1], sys.argv[2]
provider, sep, mid = model.partition('/')
if not sep or not mid:
    print(f"错误：模型格式应为 <provider>/<model-id>，got: {model}", file=sys.stderr)
    sys.exit(2)
data = json.load(open(store))
ids = [m.get('id') for m in ((data.get(provider) or {}).get('models') or [])]
if mid not in ids:
    print(f"错误：模型 {model} 不在 {store} 中", file=sys.stderr)
    print("可用 provider/model（pi --list-models）：", file=sys.stderr)
    for p, v in data.items():
        for m in ((v or {}).get('models') or []):
            print(f"  {p}/{m.get('id')}", file=sys.stderr)
    sys.exit(2)
PYEOF
# preflight 失败必须立即退出（无 set -e，显式检查）
[[ $? -eq 0 ]] || exit 2

# --- task 列表 ---
if [[ -z "$TASKS" ]]; then
	TASKS=$(ls "$BENCH/tasks" | paste -sd, -)
fi

# --- run-id：全新 or 续跑 ---
if [[ -n "$RESUME" ]]; then
	RUN_ID="$RESUME"
	RUN_DIR="$BENCH/results/$RUN_ID"
	if [[ ! -f "$RUN_DIR/manifest.json" ]]; then
		echo "无法续跑：$RUN_DIR/manifest.json 不存在（run-id 拼写是否正确？）" >&2
		exit 2
	fi
	# 严格配置相等：与上游 Harbor `job resume` 一致，配置不一致拒绝续跑
	python3 - "$RUN_DIR/manifest.json" "$TASKS" "$CONFIGS" "$REPS" "$MODEL" "$THINKING" <<'PYEOF'
import json, sys
mpath, tasks, configs, reps, model, thinking = sys.argv[1:7]
m = json.load(open(mpath))
errs = []
if m.get("tasks") != tasks:
    errs.append(f"tasks: manifest={m.get('tasks')!r} vs now={tasks!r}")
if m.get("configs") != configs:
    errs.append(f"configs: manifest={m.get('configs')!r} vs now={configs!r}")
if int(m.get("reps", 0)) != int(reps):
    errs.append(f"reps: manifest={m.get('reps')} vs now={reps}")
if m.get("model") != model:
    errs.append(f"model: manifest={m.get('model')} vs now={model}")
if m.get("thinking") != thinking:
    errs.append(f"thinking: manifest={m.get('thinking')} vs now={thinking}")
if errs:
    print("无法续跑：配置与原始 run 不一致（严格配置相等语义）：", file=sys.stderr)
    for e in errs:
        print(f"  - {e}", file=sys.stderr)
    sys.exit(2)
PYEOF
	# 续跑校验失败必须立即退出（无 set -e，显式检查）
	[[ $? -eq 0 ]] || exit 2
else
	RUN_ID="run-$(date +%Y%m%d-%H%M%S)"
	RUN_DIR="$BENCH/results/$RUN_ID"
	mkdir -p "$RUN_DIR"
	cat >"$RUN_DIR/manifest.json" <<EOF
{"run_id": "$RUN_ID", "tasks": "$TASKS", "configs": "$CONFIGS", "reps": $REPS, "model": "$MODEL", "thinking": "$THINKING"}
EOF
fi

export BENCH_MODEL="$MODEL"
export BENCH_THINKING="$THINKING"
export BENCH_RUN_DIR="$RUN_DIR"
[[ -n "$BENCH_HOME" ]] && export BENCH_HOME

# --- 自身输出 tee 到 run.log（后台跑也能留档，无需调用方重定向） ---
exec > >(tee -a "$RUN_DIR/run.log") 2>&1

# --- 结构化进度初始化 ---
"$BENCH/progress.py" init "$RUN_DIR" || {
	echo "progress init failed: $RUN_DIR" >&2
	exit 2
}

echo "RUN_ID=$RUN_ID"
echo "run dir:   $RUN_DIR"
echo "report:    $RUN_DIR/analysis-summary.json"
echo "progress:  $RUN_DIR/progress.json"
echo "查进度:    bash bench/bench-status.sh $RUN_ID"

IFS=',' read -ra TASK_ARR <<<"$TASKS"
IFS=',' read -ra CFG_ARR <<<"$CONFIGS"
FAILED=0
for slug in "${TASK_ARR[@]}"; do
	for cfg in "${CFG_ARR[@]}"; do
		# scoped npm 包名（@scope/pkg 含 /）不能作目录段：/ 转义为 __，analyze.py 才能 glob 到
		CFG_SAFE="${cfg//\//__}"
		for ((rep = 0; rep < REPS; rep++)); do
			CELL="$RUN_DIR/$CFG_SAFE/$slug/rep$rep"
			# 续跑：跳过已完成 cell（result.json 存在且含 reward_binary），中断/残缺的默认重跑
			if [[ -n "$RESUME" ]] && "$BENCH/progress.py" is_complete "$CELL"; then
				"$BENCH/progress.py" mark "$RUN_DIR" "$cfg" "$slug" "$rep" skipped
				echo "skip (resume 已完成): $slug / $cfg / rep$rep"
				continue
			fi
			rm -rf "$CELL"
			"$BENCH/progress.py" mark "$RUN_DIR" "$cfg" "$slug" "$rep" running
			echo "=== cell $slug / $cfg / rep$rep ==="
			if "$BENCH/run-cell.sh" "$BENCH/tasks/$slug" "$cfg" "$rep" "$CELL"; then
				"$BENCH/progress.py" mark "$RUN_DIR" "$cfg" "$slug" "$rep" done
			else
				RC=$?
				"$BENCH/progress.py" mark "$RUN_DIR" "$cfg" "$slug" "$rep" failed "run-cell.sh exit=$RC"
				echo "CELL FAILED: $slug $cfg rep$rep (exit=$RC)" >&2
				FAILED=$((FAILED + 1))
			fi
		done
	done
done

python3 "$BENCH/analyze.py" "$RUN_DIR" || {
	echo "analyze failed: $RUN_DIR" >&2
	exit 1
}
if [[ "$FAILED" -gt 0 ]]; then
	# 一次真实评测烧钱且耗时，若 cell 全灭/部分失败，跑 analyze 留档后必须以非零退出暴露健康信号，
	# 不能假绿成"run complete"（空/残缺数据上的分析结论会误导插件去留决策）。
	echo "run finished with $FAILED failed cell(s): $RUN_DIR" >&2
	echo "RUN_ID=$RUN_ID (failed=$FAILED)"
	exit 1
fi
echo "run complete: $RUN_DIR"
echo "RUN_ID=$RUN_ID (done)"
