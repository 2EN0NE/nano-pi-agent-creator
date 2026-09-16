#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# e2e-test 运行器
# 执行 test/e2e/extensions/ 和 test/e2e/skills/ 下的测试案例，生成可阅读的汇总报告
# 结果按模块分类输出：
#   test/results/<timestamp>/
#   ├── summary.md              ← 全局索引
#   ├── summary.json
#   ├── extensions/<name>/      ← 每个扩展的测试结果
#   │   ├── summary.md
#   │   ├── summary.json
#   │   └── cases/
#   └── skills/<name>/          ← 每个技能的测试结果
#       ├── summary.md
#       ├── summary.json
#       └── cases/
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── git ident 环境变量 ──
# /tmp 沙箱仓库的 commit，以及 pi 进程内（HOME 被隔离）的 rebase/merge，
# 都需要明确的 user 身份。runner 无全局 user，且 pi 的 HOME 隔离使
# `git config --global` 不可见；环境变量优先级高于配置文件，对两者都生效。
export GIT_AUTHOR_NAME="CI Bot"
export GIT_AUTHOR_EMAIL="ci@nano-pi-agent-creator.invalid"
export GIT_COMMITTER_NAME="CI Bot"
export GIT_COMMITTER_EMAIL="ci@nano-pi-agent-creator.invalid"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_DIR="$ROOT_DIR/test/e2e"
RESULTS_DIR="$ROOT_DIR/test/results"
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
RUN_DIR="$RESULTS_DIR/$TIMESTAMP"

# ── 并发/争用感知（机器上同时跑多轮 e2e 时，绝对耗时与超时判定都会失真）──────────
# 确定性信号 ①：**运行注册表**——每轮 e2e 在 results 下留一个以自己 pid 命名的条目，
#   靠 kill -0 判断存活（不靠 load 猜，也不靠 pgrep 数进程数：池化 worker 是子 shell，
#   会继承同一 cmdline 被误计）。
# 辅助信号 ②：load/CPU ≥ 1.0（负载均值，可能滞后，故只作为补充）。
# 用途：超预算在争用环境下降级为显式 WARN（见 settle_budget），CI/独占机仍为阻塞判定。
RUN_REGISTRY="$RESULTS_DIR/.active-runs"
CONTENTION_OTHERS=0
CONTENTION_LOAD_PER_CPU="0"
CONTENTION_DETECTED=false

count_other_runs() {
	local n=0 f pid
	[[ -d "$RUN_REGISTRY" ]] || {
		echo 0
		return 0
	}
	for f in "$RUN_REGISTRY"/*; do
		[[ -f "$f" ]] || continue
		pid="$(basename "$f")"
		[[ "$pid" == "$$" ]] && continue
		if kill -0 "$pid" 2>/dev/null; then
			n=$((n + 1))
		else
			rm -f "$f" 2>/dev/null || true # 陈旧条目：进程已不在
		fi
	done
	echo "$n"
}

# 争用复检：其它 run 可能在本轮**中途**才开始（实测：启动时空闲、后半程 10 个并发 →
# 仅靠启动快照会漏判）。故启动时与判定时各探一次，取**较严重**者。
refresh_contention() {
	mkdir -p "$RUN_REGISTRY" 2>/dev/null || true
	: >"$RUN_REGISTRY/$$" 2>/dev/null || true
	local prev_others="$CONTENTION_OTHERS"
	CONTENTION_OTHERS="$(count_other_runs)"
	((CONTENTION_OTHERS < prev_others)) && CONTENTION_OTHERS="$prev_others"
	local cpus load1
	cpus="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 0)"
	if [[ "$cpus" =~ ^[0-9]+$ ]] && ((cpus > 0)); then
		load1="$(uptime | sed -n 's/.*load average[s]*: *\([0-9.]*\).*/\1/p')"
		if [[ -n "$load1" ]]; then
			CONTENTION_LOAD_PER_CPU="$(awk -v l="$load1" -v c="$cpus" 'BEGIN{printf "%.2f", l/c}')"
		fi
	fi
	if ((CONTENTION_OTHERS > 0)); then
		CONTENTION_DETECTED=true
	fi
	if awk -v x="${CONTENTION_LOAD_PER_CPU:-0}" 'BEGIN{exit !(x >= 1.0)}'; then
		CONTENTION_DETECTED=true
	fi
}

# 启动快照（仅用于运行头打印；判定以判定时刻的复检为准）
refresh_contention
CONTENTION_OTHERS_AT_START="$CONTENTION_OTHERS"

# ── CI 模式检测 ──
# 当 CI=true 时，自动注入 mock-llm 扩展使测试无需真实 API Key
# 开发环境也可通过 CI=true 手动启用
PI_CI_MODE=${CI:-false}

# 全局聚合
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
TOTAL_REVIEW=0
TOTAL_CASES=0
MODULE_RESULTS=() # "type|name|pass|fail|review|total"

# ── 参数解析 ──
TARGET_EXT=""
TARGET_SKILL=""
TUI_ONLY=false
SMOKE_ONLY=false
TARGET_CASE=""
SHARD_INDEX=""
SHARD_TOTAL=""

usage() {
	cat <<'EOF'
Usage: test/e2e/scripts/run-e2e.sh [options]

Options:
  --ext <name>        Run tests for a specific extension (e.g., pi-logger)
  --skill <name>      Run tests for a specific skill (e.g., e2e-test)
  --tui               Run TUI tests (tui-expect.smoke.test.sh or .exp) for the target
  --smoke-only        Run only smoke.test.sh (skip tui-expect / .exp). Use when the
                      TUI phase is known-broken in an environment (see CI permission-gate).
  --case <substring>  Only run test_it cases whose name contains this substring
                       (case-insensitive). Requires --ext or --skill. Speeds up
                       iterating on a single case instead of the whole file.
  --pool <N>          Parallel worker count (default: CPU×2, auto-detected)
  --ext-budget <sec>  Per-plugin e2e time budget in seconds (default: 300, 0 = disable).
                      超预算即判失败：要么用例挂起/等待异常（Bug），要么用例冗余需精简。
                      也可用环境变量 E2E_EXT_BUDGET_SEC 设置。
  --shard <N/M>       Run only the N-th shard (0-based) of M total shards.
                       Deterministically partitions the full module set so CI
                       can split the long full e2e run into parallel jobs.
  -h, --help          Show this help

Without options, runs all test modules (smoke.test.sh only).
Use --tui to run TUI-mode tests instead.
EOF
	exit 0
}

# ── 池化并行参数 ──
# 自动检测 CPU 核心数和内存，按三者中最小值定并行度：
#   CPU×2           — I/O 密集型任务的合理超订（2x）
#   总内存/250MB     — 每个 worker 至少 250MB（pi 进程约 100-200MB + 沙箱开销）
#   上限 CPU×4       — 绝对兜底
# 最少 2，可通过 E2E_POOL_SIZE 环境变量或 --pool 参数覆盖
_AUTO_POOL_CPU=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
_AUTO_POOL_MEM_MB=$(free -m 2>/dev/null | grep Mem | awk '{print $2}' || true)
_AUTO_POOL=$((_AUTO_POOL_CPU * 2))
# 争用上限（默认 6）：本仓最重的用例是**真实 tmux 成员 + 真实 pi 进程**的多进程编排
# 与重渲染 TUI，它们对 CPU/IO 争用敏感——实测 20 worker 会把就绪等待拖到超时（假失败：
# org 的 wait_for exit=125、ci-watch 面板断言失败，同负载下串行复跑全部通过）。
# 这些用例的墙钟瓶颈（org ~512s）不会因并发变小，故收窄并发几乎不增总时长。
_AUTO_POOL_CAP=6
[[ $_AUTO_POOL -gt $_AUTO_POOL_CAP ]] && _AUTO_POOL=$_AUTO_POOL_CAP
# 内存约束：每 worker 至少 250MB
if [[ -n "$_AUTO_POOL_MEM_MB" ]]; then
	_AUTO_POOL_MEM_CAP=$((_AUTO_POOL_MEM_MB / 250))
	[[ $_AUTO_POOL -gt $_AUTO_POOL_MEM_CAP ]] && _AUTO_POOL=$_AUTO_POOL_MEM_CAP
fi
# 最少 2
[[ $_AUTO_POOL -lt 2 ]] && _AUTO_POOL=2

POOL_SIZE=${E2E_POOL_SIZE:-$_AUTO_POOL}

# ── 插件级耗时预算（秒）──
# 单个插件（extensions/<name> / skills/<name>）的 e2e **总耗时**（该插件所有测试
# 文件耗时之和）上限。超预算 = 测试失败：要么存在挂起/异常等待（Bug），要么用例
# 冗余需精简（见 test/README.md「耗时预算」）。0 = 禁用。
EXT_BUDGET_SEC=${E2E_EXT_BUDGET_SEC:-300}

# 插件级预算**例外**（可选）：默认 300s 适用于所有插件；个别插件确有真实工作量的
# （如 org：真实 tmux 成员 + 真实 pi 进程的多进程编排），可在配置文件中显式列明。
# 例外必须写明理由——想通过"加长预算"绕过精简，请先问自己是否在用例外替代优化。
#   · 配置文件：test/e2e/budget-overrides.conf，每行 `type/name=秒数`（`#` 起注释）
#   · 环境变量：E2E_EXT_BUDGET_OVERRIDES="type/name=秒数,..."（优先，便于临时实验）
BUDGET_OVERRIDES_FILE="${BUDGET_OVERRIDES_FILE:-$ROOT_DIR/test/e2e/budget-overrides.conf}"
budget_for_module() { # $1=type $2=name → 打印该插件预算（秒）
	local key="$1/$2" line want
	if [[ -n "${E2E_EXT_BUDGET_OVERRIDES:-}" ]]; then
		for line in ${E2E_EXT_BUDGET_OVERRIDES//,/ }; do
			want="${line%%=*}"
			[[ "$want" == "$key" ]] && {
				echo "${line#*=}"
				return
			}
		done
	fi
	if [[ -f "$BUDGET_OVERRIDES_FILE" ]]; then
		while IFS= read -r line; do
			line="${line%%#*}"
			line="${line// /}"
			[[ -z "$line" ]] && continue
			want="${line%%=*}"
			[[ "$want" == "$key" ]] && {
				echo "${line#*=}"
				return
			}
		done <"$BUDGET_OVERRIDES_FILE"
	fi
	echo "${EXT_BUDGET_SEC:-0}"
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--ext)
		TARGET_EXT="$2"
		shift 2
		;;
	--skill)
		TARGET_SKILL="$2"
		shift 2
		;;
	--tui)
		TUI_ONLY=true
		shift
		;;
	--smoke-only)
		SMOKE_ONLY=true
		shift
		;;
	--case)
		TARGET_CASE="$2"
		shift 2
		;;
	--pool)
		POOL_SIZE="$2"
		shift 2
		;;
	--ext-budget)
		EXT_BUDGET_SEC="$2"
		shift 2
		;;
	--shard)
		SHARD_SPEC="$2"
		if [[ "$SHARD_SPEC" =~ ^([0-9]+)/([0-9]+)$ ]]; then
			SHARD_INDEX="${BASH_REMATCH[1]}"
			SHARD_TOTAL="${BASH_REMATCH[2]}"
			if [[ $SHARD_INDEX -ge $SHARD_TOTAL ]]; then
				echo "Invalid --shard: index must be < total" >&2
				exit 2
			fi
		else
			echo "Invalid --shard: expected N/M format (e.g., 0/4)" >&2
			exit 2
		fi
		shift 2
		;;
	-h | --help) usage ;;
	*)
		echo "Unknown option: $1" >&2
		usage
		;;
	esac
done

# ── shard 分区（--shard N/M）──
# 全量枚举模块时，用模块名的确定性 hash 分配到各 shard，保证同一模块的
# smoke/tui/exp 任务落在同一 shard，且跨 run 确定性一致。
# 刻意不用关联数组（declare -A）——macOS 自带 bash 3.2 不支持，需兼容。
if [[ -n "$SHARD_INDEX" ]]; then
	# 确定性 hash 分桶：h = (h XOR code) * 33，中间用大质数 1000003 取模保持
	# 64 位内，最终 % SHARD_TOTAL。对 59 个扩展名的实测分布接近均匀（差 ≤2）。
	# 刻意不用关联数组（declare -A）——macOS 自带 bash 3.2 不支持，需兼容。
	_shard_match() {
		local name="$1"
		local h=0 i c code
		local len=${#name}
		for ((i = 0; i < len; i++)); do
			c="${name:$i:1}"
			code=$(LC_ALL=C printf '%d' "'$c")
			h=$(((h ^ code) * 33 % 1000003))
		done
		[[ $((h % SHARD_TOTAL)) -eq "$SHARD_INDEX" ]]
	}
else
	_shard_match() { return 0; }
fi

# ══════════════════════════════════════════════════════════════════════════════
# 测试框架 API（在 source 测试文件前定义）
# ══════════════════════════════════════════════════════════════════════════════

CASE_INDEX=0

# ── 运行级环境哨兵（ADR-0045 D6）──
# 权威口径：整轮 e2e 前后对真实 $HOME/.pi 取指纹，不一致即整轮判失败，
# 并打印**具体变动的路径**（模块级归因在并发+并行会话下不可靠，见 docs/e2e-performance.md §3.4）。
RUN_ENV_FINGERPRINT_BEFORE=""

test_describe() { :; }

test_it() {
	local name="$1"
	local body
	body=$(cat)
	TEST_CASES+=("$name|$body")
}

# ── 环境哨兵（ADR-0045 D6）────────────────────────────────────────────────────
# e2e 绝不允许改动**真实**环境：历史 vitest 曾把测试成员写进真实 ~/.pi/org/dev-team，
# 使人工 UAT 跑在不可信数据上（ADR-0045 背景）。这里对真实目录做指纹比对。
#
# 三个刻意的口径（都是为消除**宿主 pi 会话 / 测试基建自身**造成的误报）：
#   ① ~/.pi/org 比内容，排除 runtime/<成员>.json：它由真实在岗成员每轮重写
#      （turn_start/end 的 setBusyAll），属运行痕迹而非泄漏。
#   ② ~/.pi/agent/extensions-data 只比**路径集合**：宿主 pi 会话（whimsical/live、
#      pi-lab/*.jsonl、各插件 config）与 run-e2e 自身的 config 备份/恢复都在持续写它，
#      比内容必然误报；测试泄漏的形态是**新增插件目录/配置**，路径集足以捕获。
#   ③ 哈希工具可移植：Linux 可能只有 sha256sum（macOS 是 shasum）；对齐 scripts/offline.sh 双路兜底。
hash_stream() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum | awk '{print $1}'
	else
		shasum -a 256 | awk '{print $1}'
	fi
}
hash_file() { hash_stream <"$1"; }
# 可读指纹行（诊断"到底哪个路径变了"用；与 real_env_hash 同源 → 语义一致）
env_fingerprint_lines() {
	local d="$HOME/.pi/org"
	if [[ -d "$d" ]]; then
		find "$d" -type f ! -path '*/runtime/*' 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
			printf '%s\t%s\n' "$f" "$(hash_file "$f" 2>/dev/null)"
		done
	fi
	local e="$HOME/.pi/agent/extensions-data"
	if [[ -d "$e" ]]; then
		# 路径集合（不含内容）：宿主会话与 config 备份/恢复都在写它，比内容必然误报
		find "$e" -mindepth 1 2>/dev/null | LC_ALL=C sort | sed 's/$/\t-/'
	fi
}

real_env_hash() {
	env_fingerprint_lines | hash_stream
}

# 运行级哨兵：比对整轮前后指纹，打印变动路径（写入 $RUN_DIR/env-sentinel.log）
SENTINEL_FAIL=0
env_sentinel_capture() { # 捕获到全局变量
	RUN_ENV_FINGERPRINT_BEFORE="$(env_fingerprint_lines)"
}
env_sentinel_check() {
	local after
	after="$(env_fingerprint_lines)"
	[[ "$after" == "$RUN_ENV_FINGERPRINT_BEFORE" ]] && return 0
	# 严重级别：默认 warn（本机常同时开着交互 pi 会话，其 org/插件写入会触发；
	# 硬失败会让整轮永远红、盖住真实信号）。CI 无并发会话 → 建议 E2E_ENV_SENTINEL=strict。
	local severity="${E2E_ENV_SENTINEL:-warn}"
	[[ "$severity" == "strict" ]] && SENTINEL_FAIL=1
	local log="$RUN_DIR/env-sentinel.log"
	{
		echo "# 环境哨兵（运行级）— 真实 \$HOME/.pi 在本次 e2e 期间被改动"
		echo "# 时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo "# 说明: 若你此刻开着交互 pi 会话，它的 org/插件写入会落在这里——"
		echo "#       关掉再跑即为干净基线；否则说明 e2e 隔离失效（ADR-0045 D6）。"
		echo ""
		echo "## 变动路径（- 仅 before / + 仅 after）"
		# 注意：diff 发现差异时退出码为 1，而 runner 是 set -euo pipefail —— 不中和它会让
		# 「检测到环境变动」这件事本身把 runner 打断（曾致 61 个模块目录全无 summary、
		# 无全局汇总，Pool 段之后一行输出都没有）。故整条管道末尾接 || true。
		diff <(printf '%s\n' "$RUN_ENV_FINGERPRINT_BEFORE" | sort) <(printf '%s\n' "$after" | sort) |
			awk -F'\t' '{print $1}' | sed -n 's/^</- /p; s/^> /+ /p' | head -80 || true
	} >"$log"
	echo ""
	if [[ "${E2E_ENV_SENTINEL:-warn}" == "strict" ]]; then
		echo "  ❌ 环境哨兵（运行级, strict）：真实 \$HOME/.pi 在本次 e2e 期间被改动"
	else
		echo "  ⚠️  环境哨兵（运行级, warn）：真实 \$HOME/.pi 在本次 e2e 期间有变动（不阻塞；CI 可 E2E_ENV_SENTINEL=strict）"
	fi
	# 注意：$VAR 后紧跟全角标点会被 macOS bash 3.2 吞进变量名（"line 327: log"）——
	# 一律用 ${VAR} 花括号界定（同 scripts/offline.sh 的教训）。
	echo "     变动清单：${log}（$(grep -c '^[+-] ' "${log}" 2>/dev/null || echo 0) 行）"
	echo "     若同时在跑交互 pi 会话，请关掉后重跑以获得干净基线。"
}

# 构建隔离环境并执行 pi 测试
# 用法：run_pi_and_check --extensions "dep1,dep2" --prompt "..." [--expect-no-error]
# 输出：
#   PI_EXIT_CODE   - pi 的 exit code
#   PI_STDOUT_FILE - pi stdout 文件路径
#   PI_LOG_DIR     - pi-logger 日志目录路径
run_pi_and_check() {
	local extensions=""
	local prompt=""
	local expect_no_error=false
	local run_cwd="" # 可选：指定 pi 的运行 cwd（如多仓库用例需要在特定目录下加载）

	while [[ $# -gt 0 ]]; do
		case "$1" in
		--extensions)
			extensions="$2"
			shift 2
			;;
		--prompt)
			prompt="$2"
			shift 2
			;;
		--expect-no-error)
			expect_no_error=true
			shift
			;;
		--cwd)
			run_cwd="$2"
			shift 2
			;;
		--save-output) shift ;; # 兼容旧标记，实际总是保存
		*)
			echo "Unknown run_pi_and_check option: $1" >&2
			return 1
			;;
		esac
	done

	# CI 模式：自动注入 mock-llm 扩展，无需真实 API Key
	if [[ "$PI_CI_MODE" == true ]] && [[ "$extensions" != *"mock-llm"* ]]; then
		extensions="mock-llm,$extensions"
	fi

	[[ -z "$prompt" ]] && {
		echo "ERROR: --prompt required" >&2
		return 1
	}

	local slug="e2e-test-$$-$RANDOM"
	local test_home="$ROOT_DIR/.pi/tmp/$slug"
	mkdir -p "$test_home/.pi/extensions" "$test_home/.pi/logs"

	# 拷贝依赖（支持递归搜索 extensions/ 子目录 + test/e2e/helpers/）
	if [[ -n "$extensions" ]]; then
		local -a DEPS
		IFS=',' read -ra DEPS <<<"$extensions"
		for dep in "${DEPS[@]}"; do
			local dn
			dn=$(echo "$dep" | xargs)
			[[ -z "$dn" ]] && continue

			# Check flat path first (backward compatibility)
			if [[ -d "$ROOT_DIR/extensions/$dn" ]]; then
				cp -r "$ROOT_DIR/extensions/$dn" "$test_home/.pi/extensions/$dn"
			elif [[ -f "$ROOT_DIR/extensions/$dn.ts" ]]; then
				cp "$ROOT_DIR/extensions/$dn.ts" "$test_home/.pi/extensions/$dn.ts"
			elif [[ -f "$ROOT_DIR/test/e2e/helpers/$dn.ts" ]]; then
				# test/e2e/helpers/ 扩展：如 mock-llm，拷贝为目录扩展
				mkdir -p "$test_home/.pi/extensions/$dn"
				cp "$ROOT_DIR/test/e2e/helpers/$dn.ts" "$test_home/.pi/extensions/$dn/index.ts"
			else
				# Search recursively in category subdirectories
				local found=""
				while IFS= read -r -d '' match; do
					found="$match"
					break
				done < <(find "$ROOT_DIR/extensions" -maxdepth 3 -name "$dn.ts" -print0 -o -type d -name "$dn" -exec test -f '{}/index.ts' \; -print0 2>/dev/null)
				if [[ -n "$found" ]]; then
					if [[ -d "$found" ]]; then
						cp -r "$found" "$test_home/.pi/extensions/$dn"
					else
						cp "$found" "$test_home/.pi/extensions/$dn.ts"
					fi
				else
					echo "WARNING: dependency '$dn' not found in extensions/ (including subdirectories) or test/e2e/helpers/"
				fi
			fi
		done
	fi

	# 拷贝 pi-logger 配置
	if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json" 2>/dev/null || true
	fi

	# ── HOME 隔离：避免全局扩展（~/.pi/agent/extensions/）与沙箱扩展冲突 ──
	local isolated_home="$test_home/home"
	mkdir -p "$isolated_home/.pi/agent"
	# 复制 pi-logger 配置到隔离 HOME（某些扩展需要）
	if [[ -f "$test_home/.pi/pi-logger.json" ]]; then
		cp "$test_home/.pi/pi-logger.json" "$isolated_home/.pi/agent/"
	fi

	# 模型配置：CI 模式下创建最小配置，否则复制用户配置
	# 初始模型使用 mock-llm 相同 provider，避免启动时未注册 provider 警告
	# mock-llm 扩展加载后会在 session_start 通过 pi.setModel() 切换到 faux core
	if [[ "$PI_CI_MODE" == true ]]; then
		cat >"$isolated_home/.pi/agent/models-store.json" <<-CIEOF
			{
			  "mock-llm": {
			    "models": [
			      {
			        "id": "mock-model-1",
			        "name": "Mock Model (CI)",
			        "api": "openai-completions",
			        "provider": "mock-llm",
			        "apiKey": "ci-noop-key",
			        "baseUrl": "http://localhost:0"
			      }
			    ],
			    "default": "mock-model-1"
			  }
			}
		CIEOF
	else
		local real_home
		real_home=$(eval echo ~)
		if [[ -f "$real_home/.pi/agent/models-store.json" ]]; then
			cp "$real_home/.pi/agent/models-store.json" "$isolated_home/.pi/agent/" 2>/dev/null || true
		elif [[ -f "$real_home/.pi/agent/models.json" ]]; then
			cp "$real_home/.pi/agent/models.json" "$isolated_home/.pi/agent/" 2>/dev/null || true
		fi
	fi

	# 拷贝共享 TUI 辅助模块（src/tui/），供 import '<root>/src/tui/helpers.js' 的扩展在沙箱内解析
	#（print 路径扩展在 $test_home/.pi/extensions/<name>，相对路径 ../../src/tui 即 $test_home/src/tui；
	#  与 TUI 路径 tui_setup_sandbox_home 的 $HOME/.pi/src/tui 对应）。
	if [[ -d "$ROOT_DIR/src/tui" ]]; then
		# 2 层 import（extensions/tui/*.ts → ../../src/tui）解析到 $test_home/src/tui
		mkdir -p "$test_home/src"
		cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
		# 3 层 import（extensions/*/*/*.ts → ../../../src/tui）扁平化后解析到
		# $test_home/../src/tui（= $ROOT_DIR/.pi/tmp/src/tui，所有 print 沙箱共享）
		mkdir -p "$test_home/../src"
		cp -r "$ROOT_DIR/src/tui" "$test_home/../src/tui" 2>/dev/null || true
	fi

	local padded
	padded=$(printf '%03d' "$CASE_INDEX")
	local pi_stdout_file="$CASE_DIR/${padded}-pi-stdout.log"
	# pi-logger 日志写到 $HOME/.pi/logs（HOME 相对，非 cwd）；同时兼容旧 cwd 相对路径
	local pi_logs_dir="$isolated_home/.pi/logs"
	local pi_logs_dir_legacy="$test_home/.pi/logs"

	# pi 的扩展发现基于 **cwd**（$cwd/.pi/extensions）：给了 --cwd 就必须把沙箱里的扩展与
	# pi-logger 配置镜像过去，否则 mock-llm（模型/API key 来源）与目标扩展都不会加载，
	# 表现为 "No API key found for the selected model"。
	cd "${run_cwd:-$test_home}"
	set +e
	HOME="$isolated_home" pi -a --no-session -p "$prompt" 2>&1 >"$pi_stdout_file"
	local pi_exit=$?
	set -e
	cd "$ROOT_DIR"

	if [[ -d "$pi_logs_dir" ]]; then
		cp -r "$pi_logs_dir" "$CASE_DIR/${padded}-logs"
	fi
	if [[ -d "$pi_logs_dir_legacy" ]]; then
		cp -r "$pi_logs_dir_legacy"/. "$CASE_DIR/${padded}-logs" 2>/dev/null || true
	fi
	rm -rf "$test_home"

	local pi_exit_ok=true
	local log_has_error=false
	if [[ "$expect_no_error" == true ]]; then
		[[ $pi_exit -ne 0 ]] && pi_exit_ok=false
		local ld="$CASE_DIR/${padded}-logs"
		if [[ -d "$ld" ]] && grep -q "ERROR" "$ld"/*.log 2>/dev/null; then
			log_has_error=true
		fi
	fi

	# shellcheck disable=SC2034
	PI_EXIT_CODE=$pi_exit
	# shellcheck disable=SC2034
	PI_STDOUT_FILE=$pi_stdout_file
	# shellcheck disable=SC2034
	PI_LOG_DIR="$CASE_DIR/${padded}-logs"
	$pi_exit_ok && ! $log_has_error && return 0 || return 1
}

# 标记当前用例需要 AI 逐条衡量
# 用法：mark_for_review "衡量说明"
mark_for_review() {
	local reason="$1"
	local padded
	padded=$(printf '%03d' "$CASE_INDEX")
	echo "${padded}|${reason}|$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CASE_DIR/${padded}-review-marker"
}

# ── TUI 测试辅助函数（加载 TUI 模式的 PTY 测试工具） ──
TUI_HELPERS="$ROOT_DIR/test/e2e/helpers/tui-functions.sh"
if [[ -f "$TUI_HELPERS" ]]; then
	# shellcheck disable=SC1091
	source "$TUI_HELPERS"
fi

# ── pi-lab 实验沙箱辅助（消费方实验 e2e 用例复用） ──
LAB_SANDBOX_HELPERS="$ROOT_DIR/test/e2e/helpers/lab-sandbox.sh"
if [[ -f "$LAB_SANDBOX_HELPERS" ]]; then
	# shellcheck disable=SC1090,SC1091
	source "$LAB_SANDBOX_HELPERS"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 测试执行引擎
# ══════════════════════════════════════════════════════════════════════════════

# ── 插件耗时记录（供预算结算，见 settle_budget）──
# 每个测试文件结束时 append 一行耗时；求和即为该插件 e2e 总耗时。
# append 单行是原子操作 → 池化并行下多个 worker 写同一插件文件也安全。
# 刻意不用关联数组（declare -A）——macOS 自带 bash 3.2 不支持，需兼容。
record_module_duration() {
	local module_type="$1" module_name="$2" secs="$3"
	mkdir -p "$RUN_DIR/.budget"
	echo "$secs" >>"$RUN_DIR/.budget/${module_type}__${module_name}.sec"
}

# 记录 worker 超时（被 kill 的插件必须留痕，否则聚合阶段会静默跳过 → 假绿）
record_module_timeout() {
	local module_type="$1" module_name="$2" secs="$3"
	mkdir -p "$RUN_DIR/.budget-timeouts"
	echo "$secs" >"$RUN_DIR/.budget-timeouts/${module_type}__${module_name}.timeout"
}

# ── 模块用例行累积（池化安全）──
# 一个插件常含多个测试文件（smoke.test.sh + tui-expect.smoke.test.sh + *.exp）。
# 池化下这些文件由**不同 worker 并行**执行：若各自「读-改-写」同一份累积文件会互相覆盖
# （实测 org 实跑 31 个用例，模块报告只剩 24 个）。故每个测试文件只写自己的专属文件
# （文件名唯一 → 无竞争），报告生成时再汇总；全部任务结束前 finalize_module_summaries
# 会用完整集合重写一次模块报告。
# 行格式（TSV）：file<TAB>num<TAB>name<TAB>status<TAB>duration<TAB>log
# worker kill 上限（≠ 预算）：预算是**报告阈值**，而 kill 上限的作用是"防挂死"。
# 两者混同的后果实测：争用下 files 模块跑到 300s 被 kill → 16 个用例与模块报告全丢
# （比误报失败更糟，是**可观测性**损失）。故争用时放宽到 max(budget×2, 600s)；
# 用户显式给 E2E_WORKER_TIMEOUT 时不干预。
worker_limit_for() { # $1=type $2=name
	local lim
	if [[ -n "${E2E_WORKER_TIMEOUT:-}" ]]; then
		echo "$E2E_WORKER_TIMEOUT"
		return 0
	fi
	lim="$(budget_for_module "$1" "$2")"
	((lim > 0)) || lim=900
	if [[ "$CONTENTION_DETECTED" == "true" ]]; then
		local relaxed=$((lim * 2))
		((relaxed < 600)) && relaxed=600
		lim="$relaxed"
	fi
	echo "$lim"
}

# 逐条用例落盘：worker 被 kill 时已完成的用例记录仍在（最终仍由 append_module_cases 规范重写）
append_case_row() { # $1=type $2=name $3=file $4=row
	local mtype="$1" mname="$2" mfile="$3" row="$4"
	local fbase safe out
	fbase="$(basename "$mfile")"
	safe="${fbase//[^A-Za-z0-9._-]/_}"
	mkdir -p "$RUN_DIR/.cases"
	out="$RUN_DIR/.cases/${mtype}__${mname}__${safe}.tsv"
	local n nm st lg dsec
	IFS='|' read -r n nm st lg dsec <<<"$row"
	printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$fbase" "$n" "$nm" "$st" "$dsec" "$lg" >>"$out"
}

append_module_cases() {
	local mtype="$1" mname="$2" mfile="$3"
	shift 3
	local fbase safe
	fbase="$(basename "$mfile")"
	safe="${fbase//[^A-Za-z0-9._-]/_}"
	mkdir -p "$RUN_DIR/.cases"
	local out="$RUN_DIR/.cases/${mtype}__${mname}__${safe}.tsv"
	: >"$out"
	local r n nm st lg dsec
	for r in "$@"; do
		IFS='|' read -r n nm st lg dsec <<<"$r"
		printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$fbase" "$n" "$nm" "$st" "$dsec" "$lg" >>"$out"
	done
}

# 汇总某模块全部测试文件的用例行（按文件+编号排序输出）。
collect_module_rows() {
	local mtype="$1" mname="$2" f
	for f in "$RUN_DIR/.cases/${mtype}__${mname}__"*.tsv; do
		[[ -f "$f" ]] || continue
		cat "$f"
	done | sort -t'	' -k1,1 -k2,2
}

# 生成模块 summary.md / summary.json（数据源 = 该模块全部测试文件的用例行）。
write_module_summary() {
	local mtype="$1" mname="$2"
	local mod_dir="$RUN_DIR/$mtype/$mname"
	mkdir -p "$mod_dir/cases"
	local rows count=0 mpass=0 mfail=0 mreview=0 mskip=0
	rows=$(collect_module_rows "$mtype" "$mname")
	local fbase n nm st dsec lg
	while IFS=$'\t' read -r fbase n nm st dsec lg; do
		[[ -z "$n" ]] && continue
		count=$((count + 1))
		case "$st" in
		PASS) mpass=$((mpass + 1)) ;;
		FAIL) mfail=$((mfail + 1)) ;;
		"[REVIEW]") mreview=$((mreview + 1)) ;;
		SKIP) mskip=$((mskip + 1)) ;;
		esac
	done <<<"$rows"

	{
		echo "# $mtype/$mname"
		echo ""
		echo "Run: $TIMESTAMP"
		echo "Cases: $count"
		echo ""
		echo "| # | Case Name | Status | Duration | Evidence |"
		echo "|---|-----------|--------|----------|----------|"
		while IFS=$'\t' read -r fbase n nm st dsec lg; do
			[[ -z "$n" ]] && continue
			echo "| $n | $nm | $st | ${dsec}s | [$lg](cases/${lg#*/cases/}) |"
		done <<<"$rows"
		echo ""
		echo "**Summary:** $mpass PASS, $mreview NEEDS_REVIEW, $mfail FAIL, $mskip SKIP"
		echo ""

		if [[ $mreview -gt 0 ]]; then
			echo "---"
			echo ""
			echo "## Review Required Cases"
			echo ""
			local marker mc idx reason
			for marker in "$mod_dir/cases"/*-review-marker; do
				[[ -f "$marker" ]] || continue
				mc=$(<"$marker")
				idx="${mc%%|*}"
				reason="${mc##*|}"
				echo "### Case $idx"
				echo ""
				echo "Review question: $reason"
				echo ""
			done
			if [[ $mreview -gt 20 ]]; then
				echo "> WARNING: $mreview cases require review (>20). Manual review advised."
				echo ""
			fi
		fi
	} >"$mod_dir/summary.md"

	{
		echo "{"
		echo "  \"module\": \"$mtype/$mname\","
		echo "  \"timestamp\": \"$TIMESTAMP\","
		echo "  \"total\": $count,"
		echo "  \"pass\": $mpass,"
		echo "  \"fail\": $mfail,"
		echo "  \"review\": $mreview,"
		echo "  \"skip\": $mskip,"
		echo "  \"cases\": ["
		local first=true
		while IFS=$'\t' read -r fbase n nm st dsec lg; do
			[[ -z "$n" ]] && continue
			$first || echo ","
			first=false
			echo -n "    { \"num\": $((10#$n)), \"name\": \"$nm\", \"status\": \"$st\", \"duration_seconds\": $dsec, \"log\": \"${lg#*/cases/}\" }"
		done <<<"$rows"
		echo ""
		echo "  ]"
		echo "}"
	} >"$mod_dir/summary.json"
}

# 全部任务结束后统一重写模块报告（串行/池化同一路径）：
# 池化下 worker 各自生成报告时会缺「兄弟测试文件」的用例（并发时序不定），
# 此处以完整用例集合重写一次，保证报告与实跑一致。
finalize_module_summaries() {
	local f base key mtype mname
	local seen=""
	for f in "$RUN_DIR/.cases/"*.tsv; do
		[[ -f "$f" ]] || continue
		base="$(basename "$f" .tsv)"
		key="${base%__*}"
		case " $seen " in
		*" $key "*) continue ;;
		esac
		seen="$seen $key"
		mtype="${key%%__*}"
		mname="${key#*__}"
		write_module_summary "$mtype" "$mname"
	done
}

# 递归终止进程及其全部后代（TERM/KILL）。
# 不依赖 `kill -TERM -- -$pid`：非交互 bash 的后台任务不建新进程组 → `-$pid` 组不存在，
# 只会杀掉 bash worker，而它派生的 expect/pi 变成孤儿继续持有 stdout/PTY，把整个 job 的
# 墙钟拖到远超预算（实测 300s 预算 → 实际 362s）。故这里显式递归杀后代并等其退出。
kill_tree() {
	local pid="$1" sig="${2:-TERM}"
	local kids k
	kids=$(pgrep -P "$pid" 2>/dev/null || true)
	for k in $kids; do
		kill_tree "$k" "$sig"
	done
	kill -"$sig" "$pid" 2>/dev/null || true
}

# 等进程真正退出（避免孤儿继续持有 fd / 占用沙箱）
wait_gone() {
	local pid="$1" max_secs="$2" waited=0
	while kill -0 "$pid" 2>/dev/null && ((waited < max_secs)); do
		sleep 1
		waited=$((waited + 1))
	done
}

# 串行路径的超时保护。
# 单目标（--ext/--skill）不走 run_pool，因此没有 worker 超时保护——挂起的用例会把整个
# job 拖到 CI 的 40min / 本地无限等。这里复用同样的语义：超时 → kill 进程组 +
# record_module_timeout 留痕（聚合阶段据此判 FAIL [TIMEOUT]，不会静默假绿）。
# 用法：run_with_timeout <secs> <label> <module_type> <module_name> <cmd...>
run_with_timeout() {
	local timeout_secs="$1" label="$2" module_type="$3" module_name="$4"
	shift 4
	"$@" &
	local wpid=$!
	local waited=0
	while kill -0 "$wpid" 2>/dev/null; do
		if ((waited >= timeout_secs)); then
			echo "  [TIMEOUT] ${label} 超过 ${timeout_secs}s，强制终止（挂起或用例冗余，需定位/精简）"
			record_module_timeout "$module_type" "$module_name" "$timeout_secs"
			record_module_duration "$module_type" "$module_name" "$waited"
			kill_tree "$wpid" TERM
			sleep 1
			kill_tree "$wpid" KILL
			wait_gone "$wpid" 10
			wait "$wpid" 2>/dev/null || true
			return 124
		fi
		sleep 1
		waited=$((waited + 1))
	done
	wait "$wpid" 2>/dev/null
	return $?
}

# 执行 .exp 交互测试文件
# .exp 文件是独立的 expect 脚本，每个文件 = 1 个测试用例
run_exp_file() {
	local exp_file="$1"
	local module_type="$2"
	local module_name="$3"

	local MODULE_DIR="$RUN_DIR/$module_type/$module_name"
	local CASE_DIR="$MODULE_DIR/cases"
	mkdir -p "$CASE_DIR"

	echo ""
	echo "═══ Testing $module_type: $module_name ═══"
	echo "  File: $exp_file (expect)"

	local module_start_sec
	module_start_sec=$(date +%s)

	CASE_INDEX=1
	local name="$(basename "$exp_file" .test.exp) integration"
	local padded
	padded=$(printf '%03d' "$CASE_INDEX")

	local case_log="$CASE_DIR/001-${name}.log"
	{
		echo "========================================"
		echo "Case: $name"
		echo "Module: $module_type/$module_name"
		echo "File: $exp_file"
		echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo "========================================"
		echo ""
	} >"$case_log"

	# 创建沙箱环境
	local slug="tui-exp-$$-$RANDOM"
	local test_home="$ROOT_DIR/.pi/tmp/$slug"
	mkdir -p "$test_home"

	# 从 exp_file 所在目录推断依赖扩展
	# 约定：.exp 文件放在 test/e2e/extensions/<name>/ 下
	local ext_name="$module_name"

	# 收集扩展依赖（从目录下 .sh 文件推断，或使用最小依赖）
	local extensions="pi-logger,$ext_name"
	if [[ -f "$TEST_DIR/$module_type/$module_name/smoke.test.sh" ]]; then
		# 从 smoke.test.sh 的第一行 run_pi_and_check 提取扩展
		local deps_from_smoke
		deps_from_smoke=$(grep -m1 "extensions " "$TEST_DIR/$module_type/$module_name/smoke.test.sh" 2>/dev/null | grep -o '"pi-logger,[^"]*"' | tr -d '"' || true)
		if [[ -n "$deps_from_smoke" ]]; then
			extensions="$deps_from_smoke"
		fi
	fi

	# CI 模式：自动注入 mock-llm
	if [[ "${CI:-false}" == true ]] && [[ "$extensions" != *"mock-llm"* ]]; then
		extensions="mock-llm,$extensions"
	fi

	# 拷贝依赖扩展
	if [[ -n "$extensions" ]]; then
		local ext_dir="$test_home/.pi/extensions"
		mkdir -p "$ext_dir" "$test_home/.pi/logs"
		local -a DEPS
		IFS=',' read -ra DEPS <<<"$extensions"
		for dep in "${DEPS[@]}"; do
			local dn
			dn=$(echo "$dep" | xargs)
			[[ -z "$dn" ]] && continue

			if [[ -d "$ROOT_DIR/extensions/$dn" ]]; then
				cp -r "$ROOT_DIR/extensions/$dn" "$ext_dir/$dn"
			elif [[ -f "$ROOT_DIR/extensions/$dn.ts" ]]; then
				cp "$ROOT_DIR/extensions/$dn.ts" "$ext_dir/$dn.ts"
			elif [[ -f "$ROOT_DIR/test/e2e/helpers/$dn.ts" ]]; then
				mkdir -p "$ext_dir/$dn"
				cp "$ROOT_DIR/test/e2e/helpers/$dn.ts" "$ext_dir/$dn/index.ts"
			else
				local found=""
				while IFS= read -r -d '' match; do
					found="$match"
					break
				done < <(find "$ROOT_DIR/extensions" -maxdepth 3 -name "$dn.ts" -print0 \
					-o -type d -name "$dn" -exec test -f '{}/index.ts' \; -print0 2>/dev/null)
				if [[ -n "$found" ]]; then
					if [[ -d "$found" ]]; then
						cp -r "$found" "$ext_dir/$dn"
					else
						cp "$found" "$ext_dir/$dn.ts"
					fi
				else
					echo "WARNING: dependency '$dn' not found"
				fi
			fi
		done
	fi

	# pi-logger 配置
	if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
		mkdir -p "$test_home/.pi"
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json" 2>/dev/null || true
	fi

	# node_modules 链接
	# 映射格式：目录名:包名 —— selector 目录导出 @zenone/pi-selector（目录名≠包名）。
	mkdir -p "$test_home/node_modules"
	for entry in "pi-logger:pi-logger" "selector:pi-selector" "pi-config:pi-config" "pi-session-tree:pi-session-tree"; do
		local pkg="${entry%%:*}" pkg_name="${entry##*:}"
		local pkg_src="$ROOT_DIR/extensions/meta/$pkg"
		local pkg_dir="$test_home/node_modules/@zenone/$pkg_name"
		if [[ -d "$pkg_src" && ! -e "$pkg_dir" ]]; then
			mkdir -p "$(dirname "$pkg_dir")"
			ln -sf "$pkg_src" "$pkg_dir"
		fi
	done

	# HOME 隔离 + 模型配置
	mkdir -p "$test_home/home/.pi/agent"
	export HOME="$test_home/home"
	[[ -f "$test_home/.pi/pi-logger.json" ]] && cp "$test_home/.pi/pi-logger.json" "$HOME/.pi/agent/"

	if [[ "${CI:-false}" == true ]]; then
		cat >"$HOME/.pi/agent/models-store.json" <<-CIEOF
			{
			  "mock-llm": {
			    "models": [
			      {
			        "id": "mock-model-1",
			        "name": "Mock Model (CI)",
			        "api": "openai-completions",
			        "provider": "mock-llm",
			        "apiKey": "ci-noop-key",
			        "baseUrl": "http://localhost:0"
			      }
			    ],
			    "default": "mock-model-1"
			  }
			}
		CIEOF
	fi

	# git init
	if ! git -C "$test_home" rev-parse --git-dir &>/dev/null; then
		git -C "$test_home" init --initial-branch main &>/dev/null || true
	fi

	# ── 运行 expect 脚本 ──
	local exp_start_sec
	exp_start_sec=$(date +%s)
	local output_file="$test_home/output.log"
	local ec_file="$test_home/exitcode"

	set +e
	HOME="$test_home/home" expect "$exp_file" >"$output_file" 2>&1
	local pi_exit=$?
	set -e
	local exp_elapsed=$(($(date +%s) - exp_start_sec))

	# 如果 expect 没有写入 exitcode（脚本本身未处理），用 expect 退出码
	if [[ -f "$ec_file" ]]; then
		pi_exit=$(cat "$ec_file" 2>/dev/null || echo 0)
	fi

	# ── 收集日志 ──
	local logs_dir="$test_home/.pi/logs"
	if [[ -d "$logs_dir" ]]; then
		cp -r "$logs_dir" "$CASE_DIR/001-logs" 2>/dev/null || true
	fi
	cp "$output_file" "$CASE_DIR/001-tui-output.log" 2>/dev/null || true

	# ── 结果判定 ──
	# 0 = 正常退出, 124 = timeout（TUI 测试中 pi 不主动退出是预期行为）
	local result
	if [[ "$pi_exit" -eq 0 ]] || [[ "$pi_exit" -eq 124 ]]; then
		result="PASS"
	else
		result="FAIL"
	fi

	{
		echo ""
		echo "========================================"
		echo "Result: $result (exit=$pi_exit)"
		echo "========================================"
	} >>"$case_log"

	echo "  → $result (${exp_elapsed}s)"
	record_module_duration "$module_type" "$module_name" "$exp_elapsed"

	# ── 模块报告（跨测试文件合并）──
	# 先写本文件专属用例文件（文件名唯一 → 池化下无写竞争），再生成报告；
	# 全部任务结束后由 finalize_module_summaries 用完整集合重写一次。
	# 文件级计数（供全局聚合 tsv）：一次 .exp 只产 1 个用例。
	local fpass=0 ffail=0
	[[ "$result" == "PASS" ]] && fpass=1 || ffail=1
	append_module_cases "$module_type" "$module_name" "$exp_file" "001|$name|$result|cases/001-${name}.log|$exp_elapsed"
	write_module_summary "$module_type" "$module_name"

	# 结果回传：与 run_test_file 一致走文件（串行路径在子 shell 中执行，内存变量不回传）
	mkdir -p "$RUN_DIR/.results"
	echo "$fpass|$ffail|0|0|1|$exp_elapsed|$(basename "$exp_file")" \
		>>"$RUN_DIR/.results/${module_type}__${module_name}.tsv"

	# 清理沙箱
	rm -rf "$test_home" 2>/dev/null || true
}

run_test_file() {
	local test_file="$1"
	local module_type="$2" # "ext" 或 "skill"
	local module_name="$3"

	local MODULE_DIR="$RUN_DIR/$module_type/$module_name"
	local CASE_DIR="$MODULE_DIR/cases"
	mkdir -p "$CASE_DIR"

	echo ""
	echo "═══ Testing $module_type: $module_name ═══"
	echo "  File: $test_file"

	# 重置状态
	TEST_CASES=()
	CASE_INDEX=0

	source "$test_file"

	# 模块计时
	local module_start_sec
	module_start_sec=$(date +%s)

	local count=${#TEST_CASES[@]}
	[[ $count -eq 0 ]] && {
		echo "  → No test cases, skipping."
		return
	}

	# ── 用例过滤（--case <substring>）：只保留 name 包含该子串（大小写不敏感）的用例，
	# 用于单独迭代验证一个用例，避免每次都要跑整个文件（bash 3.2 兼容，不用 ${x,,}）──
	if [[ -n "$TARGET_CASE" ]]; then
		local filtered=()
		for case_entry in "${TEST_CASES[@]}"; do
			local cname="${case_entry%%|*}"
			if grep -Fiq -- "$TARGET_CASE" <<<"$cname"; then
				filtered+=("$case_entry")
			fi
		done
		if [[ ${#filtered[@]} -eq 0 ]]; then
			echo "  → --case '$TARGET_CASE' matched 0 of $count cases, skipping."
			return
		fi
		TEST_CASES=("${filtered[@]}")
		count=${#filtered[@]}
		echo "  Filter: --case '$TARGET_CASE' → $count case(s)"
	fi
	echo "  Cases: $count"

	local mpass=0 mfail=0 mreview=0 mskip=0
	local module_results=()

	local real_env_before
	real_env_before="$(real_env_hash)"

	for case_entry in "${TEST_CASES[@]}"; do
		CASE_INDEX=$((CASE_INDEX + 1))
		local name="${case_entry%%|*}"
		local body="${case_entry#*|}"
		local padded
		padded=$(printf '%03d' "$CASE_INDEX")

		echo "  [$padded] $name ..."

		# 清理文件名中 GitHub Actions/NTFS 不允许的字符: " : < > | * ? \r \n
		local safe_name="${name//\//-}"
		safe_name="${safe_name//:/ -}"
		safe_name="${safe_name//\"/}"
		safe_name="${safe_name//</}"
		safe_name="${safe_name//>/}"
		safe_name="${safe_name//|/}"
		safe_name="${safe_name//\*/}"
		safe_name="${safe_name//\?/}"
		safe_name="${safe_name//$'\r'/}"
		safe_name="${safe_name//$'\n'/}"
		local case_log="$CASE_DIR/${padded}-${safe_name}.log"
		{
			echo "========================================"
			echo "Case: $name"
			echo "Module: $module_type/$module_name"
			echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
			echo "========================================"
			echo ""
		} >"$case_log"

		local review_marker="$CASE_DIR/${padded}-review-marker"
		rm -f "$review_marker"

		local result="PASS"
		# 用例级计时（预算超标时用来定位耗时大户）
		local case_start_sec
		case_start_sec=$(date +%s)
		set +e
		# 捕获用例体 stdout：既写 case_log（SKIP 判定与取证），也回显到控制台
		local case_out
		# 子 shell（命令替换）本就继承 CASE_INDEX / MODULE_DIR / CASE_DIR，无需再赋一遍
		case_out=$(
			eval "$body" 2>>"$case_log"
		)
		local exec_exit=$?
		set -e
		local case_elapsed=$(($(date +%s) - case_start_sec))
		printf '%s\n' "$case_out" >>"$case_log"
		[[ -n "$case_out" ]] && printf '%s\n' "$case_out"

		# 防「假通过」（实战踩到）：用例体用 `trap cleanup EXIT` 时，若因 `set -u`
		# 未绑定变量中止，bash 会以 **trap 的退出码**（通常 0）收尾 → 明明中途挂掉却判 PASS。
		# 典型诱因是 `$VAR` 紧跟全角括号被吞进变量名（AGENTS.md 记录过的高频坑）。
		# 这里把 shell 级致命错误显式升级为失败。
		if [[ $exec_exit -eq 0 ]] && grep -qE 'unbound variable' "$case_log" 2>/dev/null; then
			echo "  ⚠️ 用例体出现 'unbound variable' 但退出码为 0（EXIT trap 掩盖）→ 判 FAIL" >&2
			exec_exit=1
		fi

		local is_review=false
		local review_reason=""
		if [[ -f "$review_marker" ]]; then
			is_review=true
			local mc
			mc=$(<"$review_marker")
			review_reason="${mc#*|}"
			review_reason="${review_reason%|*}"
		fi

		# 用例自报 SKIP（如环境缺 tmux）→ 独立状态：**不计 PASS**，避免"静默失去覆盖"
		local is_skip=false
		if [[ $exec_exit -eq 0 ]] && grep -qE '(^|[[:space:]])SKIP:' <<<"$case_out"; then
			is_skip=true
		fi

		if $is_review; then
			result="[REVIEW]"
			mreview=$((mreview + 1))
		elif $is_skip; then
			result="SKIP"
			mskip=$((mskip + 1))
		elif [[ $exec_exit -eq 0 ]]; then
			result="PASS"
			mpass=$((mpass + 1))
		else
			result="FAIL"
			mfail=$((mfail + 1))
		fi

		{
			echo ""
			echo "========================================"
			echo "Result: $result"
			$is_review && echo "Review reason: $review_reason"
			echo "========================================"
		} >>"$case_log"

		local rel_path="${MODULE_DIR#$RUN_DIR/}"
		module_results+=("$padded|$name|$result|$rel_path/cases/${padded}-${safe_name}.log|$case_elapsed")
		# 立即落盘：worker 若被 kill，已完成的用例仍可见（正常结束时被 append_module_cases 规范重写）
		append_case_row "$module_type" "$module_name" "$test_file" \
			"$padded|$name|$result|$rel_path/cases/${padded}-${safe_name}.log|$case_elapsed"
		echo "    → $result (${case_elapsed}s)"
	done

	# 环境哨兵（ADR-0045 D6）——**模块级只报 WARN**：
	# 真实 $HOME/.pi 可能被**同机并行的交互 pi 会话**改写（实测一次全量触发 44 个文件），
	# 模块级归因不可靠 → 权威判定收敛到「运行级单次检查」（见 main 流程的 env_sentinel_check），
	# 那里会打印**具体变动的路径**。这里保留一次指纹比对，只用于把噪声钉到模块名上。
	local real_env_after
	real_env_after="$(real_env_hash)"
	if [[ "$real_env_before" != "$real_env_after" ]]; then
		echo "  WARN 环境哨兵：真实 \$HOME/.pi 在本文件执行期间有变动（归因见运行级哨兵）" >&2
	fi

	# ── 模块报告（跨测试文件合并）──
	append_module_cases "$module_type" "$module_name" "$test_file" "${module_results[@]}"
	write_module_summary "$module_type" "$module_name"

	# 文件级计数（供全局聚合 tsv）：必须用文件级计数，否则全局总数会重复累加
	local fcount=$count fpass=$mpass ffail=$mfail freview=$mreview fskip=$mskip

	# ── 模块耗时（本文件）──
	# 注意：必须先算再写 tsv —— 原先 `local module_elapsed` 声明在 tsv 之后，
	# 导致 .results 里每个文件的耗时恒为 0（日志不健全）。
	local module_elapsed
	module_elapsed=$(($(date +%s) - module_start_sec))

	# 结果回传：写入 .results（append 一行/测试文件）。
	# 串行路径经 run_with_timeout 在**子 shell** 中执行本函数，内存变量无法回传；
	# 池化路径下同模块多文件由不同 worker 并行执行，也不能靠内存累加。统一走文件。
	mkdir -p "$RUN_DIR/.results"
	echo "$fpass|$ffail|$freview|$fskip|$fcount|$module_elapsed|$(basename "$test_file")" \
		>>"$RUN_DIR/.results/${module_type}__${module_name}.tsv"
	record_module_duration "$module_type" "$module_name" "$module_elapsed"
	# 模块级 summary.json 注入 duration
	# 使用简单的 jq 风格替换，不依赖外部工具修正 JSON 格式问题
	# 如果 python3 可用则注入
	if command -v python3 &>/dev/null && [[ -f "$MODULE_DIR/summary.json" ]]; then
		python3 -c "
import json,sys
p='$MODULE_DIR/summary.json'
try:
    with open(p) as f:
        d=json.load(f)
    d['duration_seconds']=$module_elapsed
    with open(p,'w') as f:
        json.dump(d,f,indent=2)
except Exception as e:
    sys.stderr.write('  (warning: could not inject duration into summary.json: %s)\n' % e)
" 2>&1 || true
	fi

	# ── 模块耗时输出 ──
	echo ""
	echo "  ⏱  Duration: ${module_elapsed}s (${mpass} pass, ${mfail} fail, ${mreview} review)"

	# ── 模块级清理：删除所有 config 残留 ──
	# 避免 e2e 测试数据污染用户真实的 pi 环境
	rm -f "$HOME/.pi/agent/extensions-data/"*/config.json 2>/dev/null || true
}

# ══════════════════════════════════════════════════════════════════════════════
# 备份用户现存配置（测试后恢复）
# ══════════════════════════════════════════════════════════════════════════════

BACKUP_DIR="$RUN_DIR/config-backup"
mkdir -p "$BACKUP_DIR"

for cfg in "$HOME/.pi/agent/extensions-data/"*/config.json; do
	[[ -f "$cfg" ]] || continue
	rel_dir=$(basename "$(dirname "$cfg")")
	mkdir -p "$BACKUP_DIR/$rel_dir"
	cp "$cfg" "$BACKUP_DIR/$rel_dir/config.json"
done
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "config.json" -type f 2>/dev/null | wc -l | tr -d ' ')

# ══════════════════════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════"
echo "  e2e-test 运行器"
echo "  Timestamp: $TIMESTAMP"
echo "  Output: $RUN_DIR"
echo "  Config backups: $BACKUP_COUNT file(s)"
if [[ "$CONTENTION_DETECTED" == "true" ]]; then
	echo "  ⚠️  机器争用: 另有 ${CONTENTION_OTHERS} 个 e2e 运行中；load/CPU=${CONTENTION_LOAD_PER_CPU}"
	echo "      → 耗时与超时判定可能失真：超预算降级为 WARN（CI / E2E_BUDGET_STRICT=1 时不降级）"
else
	echo "  机器状态: 独占（其它 e2e 运行 ${CONTENTION_OTHERS} 个；load/CPU=${CONTENTION_LOAD_PER_CPU}）"
fi
echo "═══════════════════════════════════════════════"

# ── 全局计时 ──
GLOBAL_START_SEC=$(date +%s)

FOUND_ANY=false

# ── 任务队列（用于池化并行） ──
# 格式：type_dir|module_name|test_file
TASK_QUEUE=()

# 对单目标（--ext/--skill）直接串行执行
# 对全量运行或 --ext 逗号多值使用池化并行
USE_POOL=false
if [[ $POOL_SIZE -gt 1 ]] && { [[ -z "$TARGET_EXT" && -z "$TARGET_SKILL" ]] || [[ "$TARGET_EXT" == *,* ]]; }; then
	USE_POOL=true
fi

run_target() {
	local type_dir="$1" # "extensions" 或 "skills"
	local target_name="$2"

	# 路由函数：根据文件扩展名选择执行器。
	# 串行路径同样套超时保护（run_with_timeout），与池化路径的 worker 超时语义一致。
	_dispatch() {
		local task_type="$1"
		local task_name="$2"
		local task_file="$3"
		local limit
		limit="$(worker_limit_for "$task_type" "$task_name")"
		FOUND_ANY=true
		# 注意：超时返回 124 已在 run_with_timeout 内部 record_module_timeout 留痕，
		# 这里必须 || true 中和——否则它会冒泡成脚本退出码，被 set -e 当成致命错误，
		# 导致整轮直接终止（实测：连全局 summary 都没写出来）。
		if [[ "$task_file" == *.exp ]]; then
			run_with_timeout "$limit" "$task_name $(basename "$task_file")" "$task_type" "$task_name" run_exp_file "$task_file" "$task_type" "$task_name" || true
		else
			run_with_timeout "$limit" "$task_name $(basename "$task_file")" "$task_type" "$task_name" run_test_file "$task_file" "$task_type" "$task_name" || true
		fi
	}

	if $USE_POOL; then
		add_task() {
			TASK_QUEUE+=("$1|$2|$3")
			FOUND_ANY=true
		}
	elif [[ -n "$target_name" ]]; then
		add_task() {
			_dispatch "$1" "$2" "$3"
		}
	else
		add_task() {
			_dispatch "$1" "$2" "$3"
		}
	fi

	if [[ -n "$target_name" ]]; then
		# 根据 --tui flag 选择主测试文件
		if $TUI_ONLY; then
			local found=0
			local tf="$TEST_DIR/$type_dir/$target_name/tui-expect.smoke.test.sh"
			if [[ -f "$tf" ]]; then
				add_task "$type_dir" "$target_name" "$tf"
				found=1
			fi
			local tf_exp="$TEST_DIR/$type_dir/$target_name/tui-integration.test.exp"
			if [[ -f "$tf_exp" ]]; then
				add_task "$type_dir" "$target_name" "$tf_exp"
				found=1
			fi
			if [[ $found -eq 0 ]]; then
				echo "Not found: $target_name has no TUI tests"
			fi
		else
			# 默认：先跑 smoke.test.sh，再跑 tui-expect.smoke.test.sh（如果有）
			local tf_smoke="$TEST_DIR/$type_dir/$target_name/smoke.test.sh"
			if [[ -f "$tf_smoke" ]]; then
				add_task "$type_dir" "$target_name" "$tf_smoke"
			else
				echo "Not found: $tf_smoke"
			fi

			local tf_tui="$TEST_DIR/$type_dir/$target_name/tui-expect.smoke.test.sh"
			if [[ -f "$tf_tui" ]] && ! $SMOKE_ONLY; then
				add_task "$type_dir" "$target_name" "$tf_tui"
			fi

			# .exp 交互测试
			local tf_exp="$TEST_DIR/$type_dir/$target_name/tui-integration.test.exp"
			if [[ -f "$tf_exp" ]] && ! $SMOKE_ONLY; then
				add_task "$type_dir" "$target_name" "$tf_exp"
			fi
		fi
	else
		for d in "$TEST_DIR/$type_dir"/*/; do
			local bn
			bn=$(basename "$d")
			if ! _shard_match "$bn"; then continue; fi
			local tf="$d/smoke.test.sh"
			if [[ -f "$tf" ]]; then
				add_task "$type_dir" "$bn" "$tf"
			fi
		done

		# In non-TUI mode, also run tui-expect.smoke.test.sh files if found
		# (TUI tests supplement smoke tests)
		if ! $TUI_ONLY && ! $SMOKE_ONLY; then
			for d in "$TEST_DIR/$type_dir"/*/; do
				local bn
				bn=$(basename "$d")
				if ! _shard_match "$bn"; then continue; fi
				local tf="$d/tui-expect.smoke.test.sh"
				if [[ -f "$tf" ]]; then
					add_task "$type_dir" "$bn" "$tf"
				fi
			done
		fi

		# 发现 .exp 交互测试文件
		# tui-integration.test.exp 使用 expect 替代 script+heredoc
		for d in "$TEST_DIR/$type_dir"/*/; do
			local bn
			bn=$(basename "$d")
			if ! _shard_match "$bn"; then continue; fi
			if $SMOKE_ONLY; then continue; fi
			local tf="$d/tui-integration.test.exp"
			if [[ -f "$tf" ]]; then
				add_task "$type_dir" "$bn" "$tf"
			fi
		done

	fi
	unset -f add_task 2>/dev/null || true
}

# ── 池化并行执行器 ──
# 从 TASK_QUEUE 读取任务，用 POOL_SIZE 个 worker 并行执行
# 每个 worker 独立运行 run_test_file，输出重定向到 worker 日志
# 所有 worker 完成后，从 summary.json 汇总全局结果
run_pool() {
	local task_count=${#TASK_QUEUE[@]}
	local worker_log_dir="$RUN_DIR/workers"
	mkdir -p "$worker_log_dir"

	echo ""
	echo "─── Parallel pool (${POOL_SIZE} workers, ${task_count} tasks) ───"

	declare -a worker_pids=()
	declare -a worker_times=()
	declare -a worker_names=()
	declare -a worker_limits=() # 每个 worker 的超时上限（按插件预算，支持例外）
	local next_task=0

	while ((next_task < task_count)); do
		# 清理已完成 worker（bash 3.2 兼容：空数组用 + 展开）
		declare -a active_pids=()
		declare -a active_times=()
		declare -a active_names=()
		declare -a active_limits=()
		local idx
		for ((idx = 0; idx < ${#worker_pids[@]}; idx++)); do
			local pid="${worker_pids[$idx]}"
			if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
				active_pids+=("$pid")
				active_times+=("${worker_times[$idx]}")
				active_names+=("${worker_names[$idx]}")
				active_limits+=("${worker_limits[$idx]}")
			fi
		done
		worker_pids=("${active_pids[@]+"${active_pids[@]}"}")
		worker_times=("${active_times[@]+"${active_times[@]}"}")
		worker_names=("${active_names[@]+"${active_names[@]}"}")
		worker_limits=("${active_limits[@]+"${active_limits[@]}"}")

		# 填充空闲 slot
		while ((${#worker_pids[@]} < POOL_SIZE && next_task < task_count)); do
			local task_entry="${TASK_QUEUE[$next_task]}"
			IFS='|' read -r task_type task_name task_file <<<"$task_entry"

			local safe_name="${task_name//\//-}"
			local worker_log="$worker_log_dir/${safe_name}.log"

			(
				if [[ "$task_file" == *.exp ]]; then
					run_exp_file "$task_file" "$task_type" "$task_name"
				else
					run_test_file "$task_file" "$task_type" "$task_name"
				fi
			) >"$worker_log" 2>&1 &
			local wp=$!
			worker_pids+=("$wp")
			worker_times+=("$(date +%s)")
			worker_names+=("$task_type/$task_name")
			local _wlimit
			_wlimit="$(worker_limit_for "$task_type" "$task_name")"
			worker_limits+=("$_wlimit")
			next_task=$((next_task + 1))
			echo "  [${next_task}/${task_count}] Started: $task_type/$task_name (pid=$wp)"
		done

		sleep 1
	done

	# 等待所有 worker 完成，带 per-worker 超时保护：
	# 单个测试挂起不再拖垮整个 job（CI 上 40min timeout 的根因），
	# 超时 worker 被 kill 并留名，worker 日志保留挂起前的输出便于定位。
	# 默认与插件预算同值：卡死的用例必须在预算内被杀，否则预算形同虚设。
	# 禁用预算（EXT_BUDGET_SEC=0）时退回 900s 兜底；CI 慢机可用 E2E_WORKER_TIMEOUT 覆盖。
	local worker_timeout="${E2E_WORKER_TIMEOUT:-}"
	if [[ -z "$worker_timeout" ]]; then
		worker_timeout=$([[ "${EXT_BUDGET_SEC:-0}" -gt 0 ]] && echo "$EXT_BUDGET_SEC" || echo 900)
	fi
	: "${WORKER_TIMEOUT_SEC:=$worker_timeout}"
	WORKER_TIMEOUT_SEC="$worker_timeout"
	local remaining=${#worker_pids[@]}
	while ((remaining > 0)); do
		local now
		now=$(date +%s)
		local i
		for ((i = 0; i < ${#worker_pids[@]}; i++)); do
			local wpid="${worker_pids[$i]}"
			[[ -z "$wpid" ]] && continue
			if kill -0 "$wpid" 2>/dev/null; then
				local elapsed=$((now - worker_times[$i]))
				local wlimit="${worker_limits[$i]:-$worker_timeout}"
				if ((elapsed > wlimit)); then
					echo "  [TIMEOUT] worker pid=$wpid (${worker_names[$i]}) 超过 ${wlimit}s，强制终止"
					# 留痕：被 kill 的插件不能静默消失（聚合阶段只认 summary.json）
					local _wn="${worker_names[$i]}"
					record_module_timeout "${_wn%%/*}" "${_wn#*/}" "$wlimit"
					# 被杀的 worker 也要计入模块耗时，否则插件总耗时被低报
					# （实测 org 的 tui 文件被杀，模块却报 230s < 300s → 预算门禁形同通过）
					record_module_duration "${_wn%%/*}" "${_wn#*/}" "$(($(date +%s) - ${worker_times[$i]}))"
					# 递归杀 worker 及其全部后代（expect/pi），并等其退出
					kill_tree "$wpid" TERM
					sleep 1
					kill_tree "$wpid" KILL
					wait_gone "$wpid" 10
					worker_pids[$i]=""
					remaining=$((remaining - 1))
				fi
			else
				worker_pids[$i]=""
				remaining=$((remaining - 1))
			fi
		done
		((remaining <= 0)) && break
		sleep 3
	done

	# 结果汇总由主流程的 aggregate_results 统一完成（串行/池化同一路径）
}

# 运行级哨兵：取基线必须在**任何测试动作之前**——串行模式（--ext 单值）在 add_task 里
# 就地执行 run_test_file，因此基线要在这里取（曾误放在池化段前，串行时基线晚于执行 → 永不触发）。
env_sentinel_capture

if [[ -n "$TARGET_EXT" ]]; then
	if [[ "$TARGET_EXT" == *,* ]]; then
		IFS=',' read -r -a _ext_list <<<"$TARGET_EXT"
		for ext in "${_ext_list[@]}"; do
			run_target "extensions" "$ext"
		done
	else
		run_target "extensions" "$TARGET_EXT"
	fi
elif [[ -n "$TARGET_SKILL" ]]; then
	run_target "skills" "$TARGET_SKILL"
else
	echo ""
	echo "─── Extensions ───"
	run_target "extensions" ""
	echo ""
	echo "─── Skills ───"
	run_target "skills" ""
fi

if ! $FOUND_ANY; then
	echo "" >&2
	echo "No test files found. Create test cases under test/e2e/extensions/<name>/smoke.test.sh" >&2
	echo "or test/e2e/skills/<name>/smoke.test.sh" >&2
	# 显式目标（--ext/--skill）无任何用例时以非零退出：静默 0 会让调用方
	# （pre-push / CI）在“测试目录缺失”时假绿（见测试分析发现 P1）。
	exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# 池化并行执行
# ══════════════════════════════════════════════════════════════════════════════

if $USE_POOL && [[ ${#TASK_QUEUE[@]} -gt 0 ]]; then
	run_pool
fi

# 运行级哨兵：整轮动作结束后判定（此处仍在 config 恢复之前）
env_sentinel_check
# 池化/串行都执行完后，用完整用例集合重写模块报告（见 finalize_module_summaries）
if [[ -d "$RUN_DIR/.cases" ]]; then
	finalize_module_summaries
fi

# ══════════════════════════════════════════════════════════════════════════════
# 结果聚合（串行 / 池化 同一路径）
# ══════════════════════════════════════════════════════════════════════════════
# 每个测试文件把计数 append 到 .results/<type>__<name>.tsv（子 shell / 并行安全），
# 这里在主 shell 汇总——避免"子 shell 丢变量"导致的假绿（total=0 / modules 空）。
aggregate_results() {
	TOTAL_CASES=0
	TOTAL_PASS=0
	TOTAL_FAIL=0
	TOTAL_REVIEW=0
	TOTAL_SKIP=0
	MODULE_RESULTS=()

	echo ""
	echo "─── Aggregating results ───"

	local rf
	for rf in "$RUN_DIR/.results"/*.tsv; do
		[[ -f "$rf" ]] || continue
		local base module_type module_name
		base=$(basename "$rf" .tsv)
		module_type="${base%%__*}"
		module_name="${base#*__}"

		local mp=0 mf=0 mr=0 ms=0 mt=0 d
		while IFS='|' read -r a b c e f _g; do
			mp=$((mp + ${a:-0}))
			mf=$((mf + ${b:-0}))
			mr=$((mr + ${c:-0}))
			ms=$((ms + ${e:-0}))
			mt=$((mt + ${f:-0}))
		done <"$rf"

		TOTAL_PASS=$((TOTAL_PASS + mp))
		TOTAL_FAIL=$((TOTAL_FAIL + mf))
		TOTAL_REVIEW=$((TOTAL_REVIEW + mr))
		TOTAL_SKIP=$((TOTAL_SKIP + ms))
		TOTAL_CASES=$((TOTAL_CASES + mt))
		MODULE_RESULTS+=("$module_type|$module_name|$mp|$mf|$mr|$ms|$mt")
		echo "  $module_type/$module_name: $mp pass, $mf fail, $mr review, $ms skip"
	done

	# 兜底：被 worker 超时杀掉的模块**没有 .results 条目**（写入发生在文件跑完之后），
	# 但它的用例行已逐条落盘到 .cases/。若不补进来，全局表/总数会漏掉该模块，
	# 与模块报告（finalize 从 .cases 生成，含 12 条）**不一致**。
	# 先在 .results 已有的模块里抽出**裸键集合**：记录形如 `type|name|p|f|r|s|t`，
	# 直接对整条记录做子串匹配**永不命中** → 每个模块被重复计入（实测 658 ≈ 329×2）。
	local seen_keys=""
	local mr0 t0 n0 _rest0
	for mr0 in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
		IFS='|' read -r t0 n0 _rest0 <<<"$mr0"
		seen_keys="$seen_keys $t0|$n0"
	done

	local cf ckey ckey_raw
	for cf in "$RUN_DIR/.cases"/*.tsv; do
		[[ -f "$cf" ]] || continue
		# ckey_raw = `type__name`（与 .cases 文件名一致）；ckey = `type|name`（成员格式）
		ckey_raw="$(basename "$cf" .tsv)"
		ckey_raw="${ckey_raw%__*}"
		ckey="${ckey_raw%%__*}|${ckey_raw#*__}"
		case " $seen_keys " in
		*" $ckey "*) continue ;;
		esac
		seen_keys="$seen_keys $ckey"
		local type2="${ckey_raw%%__*}" name2="${ckey_raw#*__}"
		local p2=0 f2=0 r2=0 s2=0 t2=0 st2
		while IFS=$'\t' read -r _fb _no _nm st2 _dur _lg; do
			[[ -n "$st2" ]] || continue
			t2=$((t2 + 1))
			# review 口径与 write_module_summary 一致：**用例名**里带 [REVIEW] 即计入
			case "$_nm" in
			*"[REVIEW]"*) r2=$((r2 + 1)) ;;
			esac
			case "$st2" in
			PASS) p2=$((p2 + 1)) ;;
			FAIL) f2=$((f2 + 1)) ;;
			[REVIEW]*) r2=$((r2 + 1)) ;;
			SKIP*) s2=$((s2 + 1)) ;;
			esac
		done <"$cf"
		TOTAL_PASS=$((TOTAL_PASS + p2))
		TOTAL_FAIL=$((TOTAL_FAIL + f2))
		TOTAL_REVIEW=$((TOTAL_REVIEW + r2))
		TOTAL_SKIP=$((TOTAL_SKIP + s2))
		TOTAL_CASES=$((TOTAL_CASES + t2))
		MODULE_RESULTS+=("$type2|$name2|$p2|$f2|$r2|$s2|$t2")
		echo "  $type2/$name2: $p2 pass, $f2 fail, $r2 review, $s2 skip (worker 被超时终止；用例来自 .cases 增量落盘)"
	done

	echo "  Total: $TOTAL_CASES cases ($TOTAL_PASS pass, $TOTAL_FAIL fail, $TOTAL_REVIEW review, $TOTAL_SKIP skip)"
}

aggregate_results

# ══════════════════════════════════════════════════════════════════════════════
# 耗时预算结算（插件级）
# ══════════════════════════════════════════════════════════════════════════════
# 插件 e2e 总耗时 = 该插件所有测试文件耗时之和（.budget/<type>__<name>.sec 的累计）。
# 超预算（默认 300s）即判失败 —— 要么用例挂起/异常等待（Bug），要么用例冗余需精简。
# 详见 test/README.md「耗时预算与超标处置」。
BUDGET_FAIL=0
BUDGET_WARN=0
BUDGET_LINES=()
TIMEOUT_LINES=()

settle_budget() {
	echo ""
	echo "─── Time budget (${EXT_BUDGET_SEC}s/plugin) ───"

	# 判定时刻复检争用（覆盖"运行中途才有并发"的情形）
	refresh_contention
	if [[ "$CONTENTION_DETECTED" == "true" ]]; then
		echo "  ℹ️  判定时刻机器争用: 另有 ${CONTENTION_OTHERS} 个 e2e / load/CPU=${CONTENTION_LOAD_PER_CPU}"
	fi

	# ① worker 被超时终止的插件：判失败（若无此留痕会因缺 summary.json 被静默跳过）
	local tf
	for tf in "$RUN_DIR/.budget-timeouts"/*.timeout; do
		[[ -f "$tf" ]] || continue
		local base secs tname ttype
		base=$(basename "$tf" .timeout)
		ttype="${base%%__*}"
		tname="${base#*__}"
		secs=$(cat "$tf" 2>/dev/null || echo "?")
		TIMEOUT_LINES+=("$ttype|$tname|$secs")
		BUDGET_FAIL=$((BUDGET_FAIL + 1))
		echo "  FAIL [TIMEOUT] $ttype/$tname: worker 超过 ${secs}s 被强制终止（测试未完成）"
	done

	# ② 逐个插件比对预算
	local sf
	for sf in "$RUN_DIR/.budget"/*.sec; do
		[[ -f "$sf" ]] || continue
		local base ttype tname total exceeded=0
		base=$(basename "$sf" .sec)
		ttype="${base%%__*}"
		tname="${base#*__}"
		total=$(awk '{s+=$1} END {printf "%d", s+0}' "$sf")

		local mod_budget
		mod_budget="$(budget_for_module "$ttype" "$tname")"
		if [[ "${mod_budget:-0}" -gt 0 ]] && ((total > mod_budget)); then
			if [[ "$CONTENTION_DETECTED" == "true" && "${E2E_BUDGET_STRICT:-0}" != "1" ]]; then
				# 争用环境：绝对耗时不可比（同一批用例在独占/争用下差 3-4 倍，实测 files 109s→462s）。
				# 降级为显式 WARN 并写进汇总，避免把"机器忙"误判成"插件变慢"。
				exceeded=2
				BUDGET_WARN=$((BUDGET_WARN + 1))
				echo "  WARN [BUDGET] $ttype/$tname: ${total}s > ${mod_budget}s（机器争用：另有 ${CONTENTION_OTHERS} 个 e2e / load/CPU=${CONTENTION_LOAD_PER_CPU} → 不计失败）"
			else
				exceeded=1
				BUDGET_FAIL=$((BUDGET_FAIL + 1))
				echo "  FAIL [BUDGET] $ttype/$tname: ${total}s > ${mod_budget}s（挂起或用例冗余，需精简）"
			fi
		else
			echo "  OK   [BUDGET] $ttype/$tname: ${total}s (budget ${mod_budget}s)"
		fi
		BUDGET_LINES+=("$ttype|$tname|$total|$exceeded")

		# 注入模块 summary.json（duration_seconds 语义修正为「插件总耗时」）
		local mj="$RUN_DIR/$ttype/$tname/summary.json"
		if command -v python3 &>/dev/null && [[ -f "$mj" ]]; then
			python3 -c "
import json,sys
p='$mj'
try:
    with open(p) as f: d=json.load(f)
    d['duration_seconds']=$total
    d['budget_seconds']=${mod_budget:-0}
    d['budget_exceeded']=bool($exceeded)
    d['budget_warned']=($exceeded==2)
    with open(p,'w') as f: json.dump(d,f,indent=2)
except Exception as e:
    sys.stderr.write('  (warning: budget inject failed: %s)\n' % e)
" 2>&1 || true
		fi
	done

	if [[ $BUDGET_FAIL -gt 0 ]]; then
		echo "  → $BUDGET_FAIL budget/timeout failure(s): 见 summary.md 的 Time Budget 节"
	fi
	if [[ $BUDGET_WARN -gt 0 ]]; then
		echo "  → $BUDGET_WARN 项超预算因机器争用降级为 WARN（CI / E2E_BUDGET_STRICT=1 时按失败处理）"
	fi
}

settle_budget

GLOBAL_ELAPSED=$(($(date +%s) - GLOBAL_START_SEC))

{
	echo "# Test Run: $TIMESTAMP"
	echo ""
	if [[ -n "$TARGET_EXT" ]]; then
		echo "Target: extensions/$TARGET_EXT"
	elif [[ -n "$TARGET_SKILL" ]]; then
		echo "Target: skills/$TARGET_SKILL"
	else
		echo "Target: all modules"
	fi
	echo "Total cases: $TOTAL_CASES"
	echo "Total duration: ${GLOBAL_ELAPSED}s"
	echo ""
	echo "## Modules"
	echo ""
	echo "| Module | PASS | FAIL | REVIEW | SKIP | Total | Report |"
	echo "|--------|------|------|--------|------|-------|--------|"

	# 按类型分组显示
	for type_dir in "extensions" "skills"; do
		for mr in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
			IFS='|' read -r mt mn mp mf mr_count ms_count mtot <<<"$mr"
			[[ "$mt" != "$type_dir" ]] && continue
			echo "| $type_dir/$mn | $mp | $mf | $mr_count | $ms_count | $mtot | [summary]($type_dir/$mn/summary.md) |"
		done
	done

	echo ""
	echo "**Grand Total:** $TOTAL_PASS PASS, $TOTAL_REVIEW NEEDS_REVIEW, $TOTAL_FAIL FAIL, $TOTAL_SKIP SKIP / $TOTAL_CASES cases"
	echo ""

	echo "## Time Budget"
	echo ""
	echo "Per-plugin e2e total time budget: ${EXT_BUDGET_SEC}s (0 = disabled)."
	echo "预算超标即判失败：要么用例挂起/异常等待（Bug），要么用例冗余需精简。"
	echo ""
	if [[ ${#BUDGET_LINES[@]} -eq 0 && ${#TIMEOUT_LINES[@]} -eq 0 ]]; then
		echo "(no module durations recorded)"
		echo ""
	else
		echo "| Module | Total | Budget | Verdict |"
		echo "|--------|-------|--------|---------|"
		for bl in "${BUDGET_LINES[@]+"${BUDGET_LINES[@]}"}"; do
			IFS='|' read -r bt bn btot bex <<<"$bl"
			local_budget="$(budget_for_module "$bt" "$bn")s"
			if [[ "$bex" == "1" ]]; then
				verdict="**EXCEEDED**"
			elif [[ "$bex" == "2" ]]; then
				verdict="EXCEEDED (contended→warn)"
			else
				verdict="OK"
			fi
			echo "| $bt/$bn | ${btot}s | $local_budget | $verdict |"
		done
		for tl in "${TIMEOUT_LINES[@]+"${TIMEOUT_LINES[@]}"}"; do
			IFS='|' read -r tt tn tsec <<<"$tl"
			echo "| $tt/$tn | >${tsec}s | ${EXT_BUDGET_SEC}s | **TIMEOUT (killed)** |"
		done
		echo ""
		if [[ $BUDGET_WARN -gt 0 ]]; then
			echo "> $BUDGET_WARN 项超预算发生在**机器争用**下（另有 e2e 并发运行）→ 降级为 WARN、不计失败。"
			echo "> 需在独占机器（或 CI）复跑确认是否真超标：\`E2E_BUDGET_STRICT=1\` 可强制按失败处理。"
			echo ""
		fi
		if [[ $BUDGET_FAIL -gt 0 ]]; then
			echo "> $BUDGET_FAIL budget/timeout failure(s). 处置方式：定位挂起或用例冗余后精简，"
			echo "> 目标是把该插件 e2e 总耗时压到 ${EXT_BUDGET_SEC}s 以内（见 test/README.md）。"
			echo ""
		fi
	fi

	if [[ $TOTAL_REVIEW -gt 0 ]]; then
		echo "---"
		echo ""
		echo "## Modules with Review-Required Cases"
		echo ""
		for mr in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
			IFS='|' read -r mt mn mp mf mr_count ms_count mtot <<<"$mr"
			[[ $mr_count -eq 0 ]] && continue
			type_display="$mt"
			echo "- **$type_display/$mn**: $mr_count case(s) — see [$type_display/$mn/summary.md]($type_display/$mn/summary.md)"
		done
		echo ""

		if [[ $TOTAL_REVIEW -gt 20 ]]; then
			echo "> ⚠️ **WARNING**: $TOTAL_REVIEW cases require review (>20 threshold)."
			echo "> Too many non-standardized results for AI to judge reliably."
			echo "> Please review the case logs manually."
			echo ""
		fi
	fi
} >"$RUN_DIR/summary.md"

{
	echo "{"
	echo "  \"timestamp\": \"$TIMESTAMP\","
	echo "  \"target\": \"${TARGET_EXT:-${TARGET_SKILL:-all}}\","
	echo "  \"duration_seconds\": $GLOBAL_ELAPSED,"
	echo "  \"total\": $TOTAL_CASES,"
	echo "  \"pass\": $TOTAL_PASS,"
	echo "  \"fail\": $TOTAL_FAIL,"
	echo "  \"review\": $TOTAL_REVIEW,"
	echo "  \"skip\": $TOTAL_SKIP,"
	echo "  \"warning\": $([[ $TOTAL_REVIEW -gt 20 ]] && echo true || echo false),"
	echo "  \"budget_seconds\": ${EXT_BUDGET_SEC:-0},"
	echo "  \"budget_overrides\": $(if [[ -f "$BUDGET_OVERRIDES_FILE" ]]; then python3 -c "
import json
out={}
try:
    for ln in open('$BUDGET_OVERRIDES_FILE', encoding='utf-8'):
        ln=ln.split('#')[0].strip()
        if not ln or '=' not in ln: continue
        k,v=ln.split('=',1)
        out[k.strip()]=int(v)
except Exception:
    pass
print(json.dumps(out))
"; else echo '{}'; fi),"
	echo "  \"budget_failures\": ${BUDGET_FAIL:-0},"
	echo "  \"budget_warnings\": ${BUDGET_WARN:-0},"
	echo "  \"contention\": {\"detected\": ${CONTENTION_DETECTED}, \"other_runs\": ${CONTENTION_OTHERS}, \"load_per_cpu\": ${CONTENTION_LOAD_PER_CPU:-0}, \"other_runs_at_start\": ${CONTENTION_OTHERS_AT_START:-0}},"
	echo "  \"env_sentinel_failed\": ${SENTINEL_FAIL:-0},"
	echo "  \"modules\": ["
	first=true
	for mr in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
		$first || echo ","
		first=false
		IFS='|' read -r mt mn mp mf mr_count ms_count mtot <<<"$mr"
		echo -n "    { \"name\": \"$mt/$mn\", \"total\": $mtot, \"pass\": $mp, \"fail\": $mf, \"review\": $mr_count, \"skip\": $ms_count }"
	done
	echo ""
	echo "  ]"
	echo "}"
} >"$RUN_DIR/summary.json"

# ══════════════════════════════════════════════════════════════════════════════
# 最终输出
# ══════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════"
echo "  Results (${GLOBAL_ELAPSED}s total)"
echo "  Total: $TOTAL_CASES | PASS: $TOTAL_PASS | FAIL: $TOTAL_FAIL | REVIEW: $TOTAL_REVIEW | SKIP: $TOTAL_SKIP"
if [[ $TOTAL_REVIEW -gt 20 ]]; then
	echo "  ⚠️  WARNING: $TOTAL_REVIEW cases need manual review (threshold: 20)"
elif [[ $TOTAL_REVIEW -gt 0 ]]; then
	echo "  → $TOTAL_REVIEW case(s) need AI evaluation (under threshold: 20)"
fi
if [[ ${BUDGET_FAIL:-0} -gt 0 ]]; then
	echo "  ❌ BUDGET/TIMEOUT: ${BUDGET_FAIL} plugin(s) exceeded ${EXT_BUDGET_SEC}s budget (or were killed)"
fi
if [[ ${BUDGET_WARN:-0} -gt 0 ]]; then
	echo "  ⚠️  BUDGET(WARN): ${BUDGET_WARN} plugin(s) 超预算但处于机器争用中 → 不计失败（独占机复跑确认）"
fi
echo "═══════════════════════════════════════════════"
echo ""
echo "Global summary: $RUN_DIR/summary.md"
echo "Module reports:"
for mr in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
	IFS='|' read -r mt mn mp mf mr_count ms_count mtot <<<"$mr"
	echo "  - $RUN_DIR/$mt/$mn/summary.md"
done
echo ""
echo "View latest:"
echo "  cat test/results/$(ls -1t "$RESULTS_DIR" 2>/dev/null | head -1)/summary.md"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 恢复用户备份的配置
# ══════════════════════════════════════════════════════════════════════════════

RESTORE_COUNT=0
for bak in "$BACKUP_DIR"/*/config.json; do
	[[ -f "$bak" ]] || continue
	rel_dir=$(basename "$(dirname "$bak")")
	mkdir -p "$HOME/.pi/agent/extensions-data/$rel_dir"
	cp "$bak" "$HOME/.pi/agent/extensions-data/$rel_dir/config.json"
	RESTORE_COUNT=$((RESTORE_COUNT + 1))
done
[[ $RESTORE_COUNT -gt 0 ]] && echo "  Restored $RESTORE_COUNT config backup(s)"
echo ""

# REVIEW 用例是 advisory（待 AI 衡量）；FAIL 与预算/超时失败都阻塞
if [[ $TOTAL_FAIL -gt 0 || ${BUDGET_FAIL:-0} -gt 0 || ${SENTINEL_FAIL:-0} -gt 0 ]]; then
	exit 1
else
	exit 0
fi
