#!/usr/bin/env bash
# bench 前置检查（Preflight）：跑任何 cell 之前验证本机前置条件，缺失即 fail-fast。
#
# 用法：bash bench/preflight.sh [--arms <a,b,c>] <task-dir>...
#   --arms  本次 run 的 config 臂列表（含 none）；给出时校验每个臂都能解析到插件（见 ADR-0057）
#   exit 0 — 全部就绪
#   exit 2 — 有缺失；stderr 聚合列出全部缺失项 + 每项一句修复提示
#
# 设计见 docs/adr/0056-bench-preflight-module.md：
#   - 纯自检：只检查，不预热、不安装、不探测远端
#   - 两层：框架级内置（不随任务变）+ 任务级按 task.json 的 language 映射
#   - 用 bash 而非 python 实现：它要检查 python3 是否存在，自身不能依赖 python3
#   - 聚合报告：跑完全部检查项再统一退出，不首个即退
#
# 调用点：run-matrix.sh 启动时（传本次 run 的全部任务）+ run-cell.sh 开头（传本 cell 的任务）
set -u

BENCH="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$BENCH/.." && pwd)"
MODEL="${BENCH_MODEL:-}"

# --- 参数：--arms <a,b,c> 可选，其余位置参数是任务目录 ---
ARMS_LIST=""
TASK_DIRS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
	--arms)
		ARMS_LIST="${2:-}"
		shift 2
		;;
	*)
		TASK_DIRS+=("$1")
		shift
		;;
	esac
done

PROBLEMS=()
FOUND=()

add_problem() {
	local p="$1" existing
	# bash 3.2 + set -u：空数组展开需 ${arr[@]+...} 守卫（同 run-cell.sh CFG_FLAGS 的教训）
	for existing in ${PROBLEMS[@]+"${PROBLEMS[@]}"}; do
		[[ "$existing" == "$p" ]] && return 0
	done
	PROBLEMS+=("$p")
}

# 检查命令可用；$2 为修复提示。找到则记录路径（让 PATH 兜底等环境适配可见，而非静默生效）。
need_cmd() {
	local path
	if path=$(command -v "$1" 2>/dev/null); then
		FOUND+=("$1 → $path")
	else
		add_problem "缺少命令 $1 — $2"
	fi
}

# --- 框架级检查（不随任务变） ---
need_cmd pi "安装 pi 后重试（见项目 README）"
need_cmd git "clone 任务仓库依赖 git"
need_cmd python3 "analyze.py / progress.py 与验证脚本依赖 python3"

# 模型存在于 models-store。需要 python3 解析 JSON —— python3 缺失时降级为提示，不崩溃。
if [[ -z "$MODEL" ]]; then
	add_problem "未指定模型 — 设置 BENCH_MODEL=<provider>/<model-id>"
elif ! command -v python3 >/dev/null 2>&1; then
	add_problem "python3 缺失，已跳过模型校验"
else
	MODEL_STORE="${BENCH_HOME:-$HOME}/.pi/agent/models-store.json"
	if [[ ! -f "$MODEL_STORE" ]]; then
		add_problem "找不到模型库 $MODEL_STORE — 先配置模型：pi --list-models"
	else
		model_rc=0
		# 边界：内联 python 把三类失败转成独立退出码（3=标识格式非法，4=读/解析失败，
		# 2=模型不存在），stderr 带回真实原因——否则损坏的模型库会被误报为
		# 「换个模型」，用户在错误方向上排查。
		model_err=$(python3 -c '
import json, sys
model, store = sys.argv[1], sys.argv[2]
provider, sep, mid = model.partition("/")
if not sep or not mid:
    sys.exit(3)
try:
    with open(store) as fh:
        data = json.load(fh)
except (OSError, json.JSONDecodeError) as exc:
    sys.stderr.write(str(exc))
    sys.exit(4)
ids = []
entry = data.get(provider) if isinstance(data, dict) else None
if isinstance(entry, dict) and isinstance(entry.get("models"), list):
    ids = [m.get("id") for m in entry["models"] if isinstance(m, dict)]
sys.exit(0 if mid in ids else 2)
' "$MODEL" "$MODEL_STORE" 2>&1) || model_rc=$?
		case "$model_rc" in
		0) FOUND+=("model → $MODEL") ;;
		2) add_problem "模型 $MODEL 不在 $MODEL_STORE 中 — pi --list-models 查看可用模型" ;;
		3) add_problem "模型标识格式非法：${MODEL}（应为 <provider>/<model-id>）" ;;
		*) add_problem "模型库 $MODEL_STORE 读取或解析失败 — $model_err" ;;
		esac
	fi
fi

# bench/.cache 可读写（run-cell 在其中 clone/复用任务仓库）
if [[ -d "$BENCH/.cache" ]]; then
	[[ -w "$BENCH/.cache" ]] || add_problem "bench/.cache 不可写：$BENCH/.cache"
elif [[ ! -w "$BENCH" ]]; then
	add_problem "bench 目录不可写，无法创建 .cache：$BENCH"
else
	FOUND+=(".cache → $BENCH/.cache")
fi

# @zenone/* 本地包就位。公共基座 bash-timeout 自身 import @zenone/pi-config 与
# @zenone/pi-logger，两个臂（含 none）都加载它 —— 缺失时连 none 臂都起不来。
for pkg in pi-logger pi-config; do
	if [[ -e "$REPO_ROOT/node_modules/@zenone/$pkg" ]]; then
		FOUND+=("@zenone/$pkg → node_modules")
	else
		add_problem "缺少本地包 @zenone/$pkg — 在仓库根执行 npm install"
	fi
done

# --- 臂级检查：本次 run 的每个臂（含 baseline）都能解析到插件（见 ADR-0057） ---
# 用与 run-cell.sh 同一份解析规则（bench/find-extension.sh），避免两份实现漂移。
if [[ -n "$ARMS_LIST" ]]; then
	ARMS_JSON="$BENCH/arms.json"
	if [[ ! -f "$ARMS_JSON" ]]; then
		add_problem "缺少臂注册表 $ARMS_JSON"
	elif ! command -v python3 >/dev/null 2>&1; then
		add_problem "python3 缺失，已跳过臂校验"
	else
		# python3 输出「kind<TAB>payload」行：plug=待解析插件名 / err=臂层面的问题
		if ! arm_report=$(python3 -c '
import json, sys
doc = json.load(open(sys.argv[1]))
registered = doc.get("arms") or {}
for name in doc.get("baseline") or []:
    print("plug\t%s" % name)
for arm in [a for a in sys.argv[2].split(",") if a and a != "none"]:
    if not arm.startswith("plugin-"):
        print("err\tunknown config arm: %s" % arm)
    elif arm not in registered:
        print("err\t未注册的 config 臂：%s（请在 bench/arms.json 登记）" % arm)
    else:
        for pname in [p for p in arm[7:].split("+") if p]:
            print("plug\t%s" % pname)
' "$ARMS_JSON" "$ARMS_LIST" 2>/dev/null); then
			add_problem "臂注册表解析失败：$ARMS_JSON"
			arm_report=""
		fi
		while IFS=$'\t' read -r kind payload; do
			[[ -z "$kind" ]] && continue
			if [[ "$kind" == err ]]; then
				add_problem "$payload"
			elif resolved=$(bash "$BENCH/find-extension.sh" "$payload" 2>/dev/null); then
				FOUND+=("plugin:$payload → $resolved")
			else
				add_problem "插件未找到：${payload}（臂声明的插件解析不到入口）"
			fi
		done <<<"$arm_report"
	fi
fi

# --- 任务级检查：按 task.json 的 language 映射工具链 ---
# 字段用 python3 JSON 解析读取（而非逐行 sed 正则）：task.json 被格式化（值换行）
# 或同行出现其他含 "language" 的字符串时，sed 会误判「缺 language 字段」并在跑任何
# cell 前阻塞整轮评测。python3 已是本模块硬依赖（need_cmd python3 已登记），缺失时
# 跳过并记一个问题。语言 → 工具链是本模块唯一需要随新语言维护的地方；
# 未登记的语言 fail-loud，避免「新语言任务静默跳过检查」回到原问题。
for task_dir in ${TASK_DIRS[@]+"${TASK_DIRS[@]}"}; do
	task_json="$task_dir/task.json"
	if [[ ! -f "$task_json" ]]; then
		add_problem "任务定义缺失 $task_json"
		continue
	fi
	if ! command -v python3 >/dev/null 2>&1; then
		add_problem "python3 缺失，已跳过任务工具链校验"
		continue
	fi
	# 边界：task.json 解析失败转成一条聚合问题（含文件路径），不带 traceback 噪音。
	if ! task_fields=$(python3 -c '
import json, sys
with open(sys.argv[1]) as fh:
    doc = json.load(fh)
print("%s\t%s" % (doc.get("language") or "", doc.get("slug") or ""))
' "$task_json" 2>/dev/null); then
		add_problem "任务定义解析失败 $task_json — 修复该 JSON 后重试"
		continue
	fi
	IFS=$'\t' read -r lang slug <<<"$task_fields"
	label="${slug:-$task_dir}"
	case "$lang" in
	go)
		need_cmd go "任务 ${label}（language=go）的验证脚本需要 go 工具链"
		;;
	typescript | javascript)
		need_cmd node "任务 ${label}（language=${lang}）的验证脚本需要 node"
		need_cmd npm "任务 ${label}（language=${lang}）的验证脚本需要 npm"
		;;
	"")
		add_problem "任务 ${label} 的 task.json 缺 language 字段，无法确定工具链"
		;;
	*)
		add_problem "语言 '$lang'（任务 ${label}）未登记 — 在 bench/preflight.sh 的 language 映射中补一行"
		;;
	esac
done

# --- 报告（聚合）：先列找到的，再列缺失的 ---
for f in ${FOUND[@]+"${FOUND[@]}"}; do
	echo "  [ok] $f"
done
if [[ "${#PROBLEMS[@]}" -gt 0 ]]; then
	echo "" >&2
	echo "前置检查失败（${#PROBLEMS[@]} 项）:" >&2
	for p in "${PROBLEMS[@]}"; do
		echo "  [缺少] $p" >&2
	done
	echo "" >&2
	echo "修复后重试。设计见 docs/adr/0056-bench-preflight-module.md" >&2
	exit 2
fi

echo "前置检查通过（preflight）"
exit 0
