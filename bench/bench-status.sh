#!/usr/bin/env bash
# 查询一次 bench 运行的进度（后台跑 bench 时，用户/agent 用本脚本问「跑到哪了」）。
#
# 用法：
#   bench-status.sh                 # 查最近一次 run（按 mtime）
#   bench-status.sh <run-id>        # 查指定 run
#   bench-status.sh <run-id> --log 20   # 追加 run.log 尾部 20 行
set -u
BENCH="$(cd "$(dirname "$0")" && pwd)"
RUN_ID="${1:-}"
TAIL_N=""

if [[ "${1:-}" == "--log" ]]; then
	RUN_ID=""
	TAIL_N="${2:-20}"
	shift 2 || true
elif [[ "${2:-}" == "--log" ]]; then
	TAIL_N="${3:-20}"
fi

if [[ -z "$RUN_ID" ]]; then
	RUN_ID=$(ls -1t "$BENCH/results" 2>/dev/null | head -1)
	if [[ -z "$RUN_ID" ]]; then
		echo "无任何 run（bench/results/ 为空）" >&2
		exit 1
	fi
	echo "(未指定 run-id，取最近一次：$RUN_ID)"
fi

RUN_DIR="$BENCH/results/$RUN_ID"
[[ -d "$RUN_DIR" ]] || {
	echo "run 不存在：$RUN_ID" >&2
	echo "可用的 run：$(ls -1 "$BENCH/results" 2>/dev/null | tr '\n' ' ')" >&2
	exit 1
}

"$BENCH/progress.py" status "$RUN_DIR" || exit $?

if [[ -n "$TAIL_N" ]]; then
	echo ""
	echo "--- run.log 尾部 $TAIL_N 行 ---"
	if [[ -f "$RUN_DIR/run.log" ]]; then
		tail -n "$TAIL_N" "$RUN_DIR/run.log"
	else
		echo "(尚无 run.log)"
	fi
fi

if [[ -f "$RUN_DIR/analysis-summary.json" ]]; then
	echo ""
	echo "报告已生成：$RUN_DIR/analysis-summary.json"
fi
