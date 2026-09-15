#!/usr/bin/env bash
# 运行一个 benchmark cell：checkout 任务 base ref → 一次 agent 运行 → 验收 → 指标提取。
# 从 pi-fabric bench/run-cell.sh 移植，适配 nano：
#   - config 语义改为 none（无插件）| plugin-<name>（单插件）
#   - 模型强制显式（BENCH_MODEL 必填，无默认）
#   - 成本从 session jsonl 的 usage.cost 直接读，不 hardcode 费率
#   - 新增 plugin_triggered 指标（触发工具名由 bench/arms.json 的臂声明，见 ADR-0057）
#   - 阶段（clone/agent/metrics/verify）写入 progress.json（BENCH_RUN_DIR 设置时）
#
# 用法：run-cell.sh <task-dir> <config> <rep> <cell-out-dir>
#   可选环境变量：
#     BENCH_MODEL    模型（必填，<provider>/<model-id>）
#     BENCH_THINKING 思考级别（默认 low）
#     BENCH_HOME     隔离 HOME（含 .pi/agent/models-store.json，冒烟测试用 mock-llm 时设置）
#     BENCH_RUN_DIR  所属 run 目录（run-matrix.sh 设置；设置后 cell 阶段写入 progress.json）
set -u

# 工具链 PATH 兜底：nohup 从非登录 shell 启动时不会读 /etc/paths.d（macOS path_helper 机制），
# Go 等装在 /usr/local/<tool>/bin 的工具链会缺失，导致 verify.sh 报 `go: command not found` 误判 0 分。
[ -d /usr/local/go/bin ] && export PATH="$PATH:/usr/local/go/bin"

TASK_DIR="$1"
# 转绝对路径：后续会 cd 到 workdir，相对路径会失效（PROMPT/verify.sh 都用 TASK_DIR）
TASK_DIR="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")"
CONFIG="$2"
REP="$3"
CELL="$4"

BENCH="$(cd "$(dirname "$0")" && pwd)"
TASK="$TASK_DIR/task.json"

SLUG=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['slug'])" "$TASK")
REPO_URL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['repo'])" "$TASK")
BASE_REF=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['base_ref'])" "$TASK")
AGENT_TIMEOUT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['agent_timeout_s'])" "$TASK")
VERIFY_TIMEOUT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['verify_timeout_s'])" "$TASK")

# --- 臂注册表（bench/arms.json）：读本臂声明的触发工具名 ---
# 工具名已从 task.json 下沉到臂（见 docs/adr/0057-bench-arm-registry-and-pilot.md）：
# 任务与插件正交，不再需要「一个任务测多插件就写并集」的 hack。
ARMS="$BENCH/arms.json"
[[ -f "$ARMS" ]] || {
	echo "缺少臂注册表 $ARMS" >&2
	exit 2
}
# 臂封闭：未登记的臂会静默产出 plugin_triggered=null、污染触发率分母，故 fail-fast
ARM_TRIGGER_TOOLS=$(python3 -c "
import json,sys
arms=json.load(open(sys.argv[1])).get('arms') or {}
if sys.argv[2] not in arms:
    sys.stderr.write('未注册的 config 臂：%s（请在 bench/arms.json 登记）\n' % sys.argv[2])
    sys.exit(2)
print(','.join((arms[sys.argv[2]] or {}).get('triggerTools') or []))
" "$ARMS" "$CONFIG") || exit 2

MODEL="${BENCH_MODEL:-}"
[[ -n "$MODEL" ]] || {
	echo "BENCH_MODEL 必填（<provider>/<model-id>），由 run-matrix.sh 或调用方注入" >&2
	exit 2
}

# --- 前置检查：本 cell 任务的前置条件（见 docs/adr/0056-bench-preflight-module.md） ---
# 入口自保护：smoke-test.sh 与手动调试会直接调 run-cell.sh，绕开 run-matrix.sh 的全量检查。
# 放在文件头的 PATH 兜底之后，检查的是「实际会被 verify.sh 用到的环境」。
bash "$BENCH/preflight.sh" "$TASK_DIR" || exit 2

# --- 阶段标记：写 progress.json（仅 run-matrix.sh 编排时 BENCH_RUN_DIR 非空） ---
phase() {
	[[ -n "${BENCH_RUN_DIR:-}" ]] || return 0
	"$BENCH/progress.py" mark "$BENCH_RUN_DIR" "$CONFIG" "$SLUG" "$REP" running "$1" >/dev/null 2>&1 || true
}
THINKING="${BENCH_THINKING:-low}"
# 会话显示名：bench-test:<task> <config> rep<N>，便于在会话历史/导出/日志中识别该 cell
SESSION_NAME="bench-test:${SLUG} ${CONFIG} rep${REP}"

# git ident：scc/superjson 等任务的 prompt 要求 agent 自行 commit，需明确身份
export GIT_AUTHOR_NAME="Bench Agent"
export GIT_AUTHOR_EMAIL="bench@nano-pi-agent-creator.invalid"
export GIT_COMMITTER_NAME="Bench Agent"
export GIT_COMMITTER_EMAIL="bench@nano-pi-agent-creator.invalid"

mkdir -p "$CELL/session-store" "$CELL/session" "$CELL/logs" "$CELL/artifacts"
WORKDIR="$CELL/workdir"

# --- 插件名 → 路径（解析规则见 bench/find-extension.sh；preflight 的臂校验复用同一份）---
find_extension() {
	bash "$BENCH/find-extension.sh" "$1"
}

# --- 新鲜 checkout 到 base ref ---
phase clone
CACHE="$BENCH/.cache/$(basename "$REPO_URL" .git)"
if [[ ! -d "$CACHE/.git" ]]; then
	# 不抑制 git 的 stderr：区分「外网不可用/仓库不可达」与「任务资产问题」要靠它
	# （见测试分析发现 P2；彻底去网络依赖——bundle fixture / 浅克隆——待专项）。
	git clone "$REPO_URL" "$CACHE" >/dev/null || {
		echo "clone failed（上方为 git 原始错误：网络不可用 / 仓库不可达）：$REPO_URL" >&2
		exit 1
	}
fi
# 不额外 fetch：base_ref 是 pin 的 commit，clone 全历史已包含；网络 fetch 在离线/慢网环境会挂起。
git clone --quiet "$CACHE" "$WORKDIR" || {
	echo "clone failed: $CACHE -> $WORKDIR" >&2
	exit 1
}
# pin 任务 base 状态：本地 main/master == base ref，agent "branch from main" 从正确树出发
git -C "$WORKDIR" branch -f master "$BASE_REF" 2>/dev/null || true
git -C "$WORKDIR" branch -f main "$BASE_REF" 2>/dev/null || true
git -C "$WORKDIR" checkout --quiet "$BASE_REF" || {
	echo "checkout failed: $BASE_REF in $WORKDIR" >&2
	exit 1
}

# --- config flags ---
# 双臂统一隔离：--no-extensions/--no-skills 放 COMMON（pi 文档：-ne 下显式 -e 仍加载）。
# 若只给 none 臂隔离，plugin-* 臂会读入用户 ~/.pi/agent/extensions 全量扩展——配对对称性被破坏
# （"全量环境+目标插件 vs 纯净 pi"），且目标插件若同时存在于全局副本（如 sync 过的 truncated-tool）
# 与 -e 仓库副本，会触发重复注册冲突导致该臂失效。
COMMON_FLAGS=(--print --approve --thinking "$THINKING" --model "$MODEL" --session-dir "$CELL/session-store" --name "$SESSION_NAME" --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes)
# 公共基座（arms.json 的 baseline，非被测变量）：两臂统一加载，配对唯一差异仍是被测插件本身。
# bash-timeout 是评测环境安全网（防 agent 慢命令如 find / 卡死）。
while IFS= read -r baseline_name; do
	[[ -z "$baseline_name" ]] && continue
	baseline_path=$(bash "$BENCH/find-extension.sh" "$baseline_name") || {
		echo "baseline 插件未找到：${baseline_name}（检查 bench/arms.json 的 baseline）" >&2
		exit 2
	}
	COMMON_FLAGS+=(-e "$baseline_path")
done < <(python3 -c "
import json,sys
print('\n'.join(json.load(open(sys.argv[1])).get('baseline') or []))
" "$ARMS")

# 冒烟专用：把测试替身 mock-llm 注入公共基座——none 臂也能不烧钱地跑冒烟（见 ADR-0057）。
# 真实评测不设此变量。它早先是伪装成一个 config 臂（plugin-mock-llm），已废弃。
if [[ -n "${BENCH_MOCK_LLM:-}" ]]; then
	COMMON_FLAGS+=(-e "$BENCH_MOCK_LLM")
fi

case "$CONFIG" in
none)
	CFG_FLAGS=()
	;;
plugin-*)
	PLUGIN_LIST="${CONFIG#plugin-}"
	CFG_FLAGS=()
	IFS='+' read -ra PLUGIN_ARR <<<"$PLUGIN_LIST"
	for pname in "${PLUGIN_ARR[@]}"; do
		[[ -z "$pname" ]] && continue
		PPATH=$(find_extension "$pname")
		if [[ -z "$PPATH" ]]; then
			echo "plugin not found: $pname" >&2
			exit 2
		fi
		CFG_FLAGS+=(-e "$PPATH")
	done
	;;
*)
	echo "unknown config: $CONFIG" >&2
	exit 2
	;;
esac

# --- agent run，看门狗超时（macOS 无 GNU timeout） ---
phase agent
cd "$WORKDIR" || {
	echo "cd failed: $WORKDIR" >&2
	exit 1
}
START=$(python3 -c 'import time;print(time.time())')
PROMPT="$(cat "$TASK_DIR/prompt.txt")"
if [[ -n "${BENCH_HOME:-}" ]]; then
	export HOME="$BENCH_HOME"
fi
(
	# ${CFG_FLAGS[@]+...} 安全展开：none 臂 CFG_FLAGS 为空数组，bash 3.2 + set -u 下
	# "${CFG_FLAGS[@]}" 会报 unbound variable 导致 pi 根本没执行（对照组 token=0 全废）。
	pi "${COMMON_FLAGS[@]}" "${CFG_FLAGS[@]+"${CFG_FLAGS[@]}"}" "$PROMPT" \
		>"$CELL/logs/pi.stdout.txt" 2>"$CELL/logs/pi.stderr.txt" &
	AGENT_PID=$!
	# 看门狗：轮询存活，超时 TERM→KILL。用 sleep 1 轮询（而非单次长 sleep），
	# 这样 kill 看门狗后最多残留 1s 孤儿 sleep；输出重定向 /dev/null，不占 stdout（避免后台跑挂住管道）。
	(
		elapsed=0
		while kill -0 "$AGENT_PID" 2>/dev/null; do
			sleep 1
			elapsed=$((elapsed + 1))
			if [[ "$elapsed" -ge "$AGENT_TIMEOUT" ]]; then
				kill -TERM "$AGENT_PID" 2>/dev/null
				sleep 20
				kill -KILL "$AGENT_PID" 2>/dev/null
				break
			fi
		done
	) >/dev/null 2>&1 &
	WATCHDOG=$!
	wait "$AGENT_PID"
	AGENT_EXIT=$?
	kill "$WATCHDOG" 2>/dev/null
	echo "$AGENT_EXIT" >"$CELL/agent-exit-code.txt"
)
END=$(python3 -c 'import time;print(time.time())')
WALL=$(python3 -c "print(round($END - $START, 1))")

# session artifacts
find "$CELL/session-store" -name '*.jsonl' -exec cp {} "$CELL/session/" \; 2>/dev/null || true

# --- patch artifact ---
git -C "$WORKDIR" add -A >/dev/null 2>&1
git -C "$WORKDIR" diff --cached "$BASE_REF" -- . ':(exclude)vendor/**' ':(exclude)**/node_modules/**' ':(exclude).verify-bin/**' ':(exclude).verify-out/**' >"$CELL/artifacts/model.patch" 2>/dev/null
(git -C "$WORKDIR" ls-files --cached -- 'vendor/*' '*/node_modules/*' | sed -e 's/.*/[vendored dependency paths omitted from patch]/' | head -1 >>"$CELL/artifacts/model.patch" 2>/dev/null) || true

# --- 指标提取 + plugin_triggered 检测（实现见 bench/metrics.py，带单元测试） ---
phase metrics
TRIGGER_TOOLS="$ARM_TRIGGER_TOOLS" python3 "$BENCH/metrics.py" "$CELL" "$WALL" || {
	# 原 heredoc 未检查退出码：python 崩溃会静默留下缺失的 result.json，
	# 让 verify.sh / analyze 拿到残缺数据——正是 ADR-0027 要消灭的假信号。
	echo "metrics.py failed: $SLUG $CONFIG rep$REP" >&2
	exit 1
}

# --- 验收探针 ---
phase verify
if [[ -x "$TASK_DIR/verify.sh" ]]; then
	(
		cd "$WORKDIR"
		(
			"$TASK_DIR/verify.sh" "$WORKDIR" "$CELL/result.json" >"$CELL/logs/verify.stdout.txt" 2>"$CELL/logs/verify.stderr.txt" &
			VPID=$!
			# 看门狗：与 agent 看门狗同款轮询式，避免孤儿 sleep 且输出重定向 /dev/null
			(
				elapsed=0
				while kill -0 "$VPID" 2>/dev/null; do
					sleep 1
					elapsed=$((elapsed + 1))
					if [[ "$elapsed" -ge "$VERIFY_TIMEOUT" ]]; then
						kill -TERM "$VPID" 2>/dev/null
						sleep 10
						kill -KILL "$VPID" 2>/dev/null
						break
					fi
				done
			) >/dev/null 2>&1 &
			WD=$!
			wait $VPID 2>/dev/null
			kill $WD 2>/dev/null
		)
	)
fi
echo "cell done: $SLUG $CONFIG rep$REP -> $CELL"
cat "$CELL/result.json"
