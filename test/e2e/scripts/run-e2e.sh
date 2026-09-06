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

# ── CI 模式检测 ──
# 当 CI=true 时，自动注入 mock-llm 扩展使测试无需真实 API Key
# 开发环境也可通过 CI=true 手动启用
PI_CI_MODE=${CI:-false}

# 全局聚合
TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_REVIEW=0
TOTAL_CASES=0
MODULE_RESULTS=() # "type|name|pass|fail|review|total"

# ── 参数解析 ──
TARGET_EXT=""
TARGET_SKILL=""
TUI_ONLY=false
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
  --case <substring>  Only run test_it cases whose name contains this substring
                       (case-insensitive). Requires --ext or --skill. Speeds up
                       iterating on a single case instead of the whole file.
  --pool <N>          Parallel worker count (default: CPU×2, auto-detected)
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
# 内存约束：每 worker 至少 250MB
if [[ -n "$_AUTO_POOL_MEM_MB" ]]; then
	_AUTO_POOL_MEM_CAP=$((_AUTO_POOL_MEM_MB / 250))
	[[ $_AUTO_POOL -gt $_AUTO_POOL_MEM_CAP ]] && _AUTO_POOL=$_AUTO_POOL_MEM_CAP
fi
# 上限 CPU×4
_AUTO_POOL_CPU_CAP=$((_AUTO_POOL_CPU * 4))
[[ $_AUTO_POOL -gt $_AUTO_POOL_CPU_CAP ]] && _AUTO_POOL=$_AUTO_POOL_CPU_CAP
# 最少 2
[[ $_AUTO_POOL -lt 2 ]] && _AUTO_POOL=2

POOL_SIZE=${E2E_POOL_SIZE:-$_AUTO_POOL}

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
	--case)
		TARGET_CASE="$2"
		shift 2
		;;
	--pool)
		POOL_SIZE="$2"
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

test_describe() { :; }

test_it() {
	local name="$1"
	local body
	body=$(cat)
	TEST_CASES+=("$name|$body")
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
		mkdir -p "$test_home/src"
		cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
	fi

	local padded
	padded=$(printf '%03d' "$CASE_INDEX")
	local pi_stdout_file="$CASE_DIR/${padded}-pi-stdout.log"
	# pi-logger 日志写到 $HOME/.pi/logs（HOME 相对，非 cwd）；同时兼容旧 cwd 相对路径
	local pi_logs_dir="$isolated_home/.pi/logs"
	local pi_logs_dir_legacy="$test_home/.pi/logs"

	cd "$test_home"
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
	local output_file="$test_home/output.log"
	local ec_file="$test_home/exitcode"

	set +e
	HOME="$test_home/home" expect "$exp_file" >"$output_file" 2>&1
	local pi_exit=$?
	set -e

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

	echo "  → $result"

	# ── 模块 summary ──
	local mpass=0 mfail=0 mreview=0
	[[ "$result" == "PASS" ]] && mpass=1 || mfail=1

	{
		echo "# $module_type/$module_name"
		echo ""
		echo "Run: $TIMESTAMP"
		echo "Cases: 1"
		echo ""
		echo "| # | Case Name | Status | Evidence |"
		echo "|---|-----------|--------|----------|"
		echo "| 1 | $name | $result | [cases/001-${name}.log](cases/001-${name}.log) |"
		echo ""
		echo "**Summary:** $mpass PASS, 0 NEEDS_REVIEW, $mfail FAIL"
	} >"$MODULE_DIR/summary.md"

	# ── 全局聚合 ──
	TOTAL_CASES=$((TOTAL_CASES + 1))
	TOTAL_PASS=$((TOTAL_PASS + mpass))
	TOTAL_FAIL=$((TOTAL_FAIL + mfail))
	MODULE_RESULTS+=("$module_type|$module_name|$mpass|$mfail|0|1")

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

	local mpass=0 mfail=0 mreview=0
	local module_results=()

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
		set +e
		(
			CASE_INDEX=$CASE_INDEX
			MODULE_DIR="$MODULE_DIR"
			CASE_DIR="$CASE_DIR"
			eval "$body" 2>>"$case_log"
		)
		local exec_exit=$?
		set -e

		local is_review=false
		local review_reason=""
		if [[ -f "$review_marker" ]]; then
			is_review=true
			local mc
			mc=$(<"$review_marker")
			review_reason="${mc#*|}"
			review_reason="${review_reason%|*}"
		fi

		if $is_review; then
			result="[REVIEW]"
			mreview=$((mreview + 1))
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
		module_results+=("$padded|$name|$result|$rel_path/cases/${padded}-${safe_name}.log")
		echo "    → $result"
	done

	# ── 模块级 summary.md ──
	{
		echo "# $module_type/$module_name"
		echo ""
		echo "Run: $TIMESTAMP"
		echo "Cases: $count"
		echo ""
		echo "| # | Case Name | Status | Evidence |"
		echo "|---|-----------|--------|----------|"
		for r in "${module_results[@]}"; do
			IFS='|' read -r n nm st lg <<<"$r"
			echo "| $n | $nm | $st | [$lg](cases/${lg#*/cases/}) |"
		done
		echo ""
		echo "**Summary:** $mpass PASS, $mreview NEEDS_REVIEW, $mfail FAIL"
		echo ""

		if [[ $mreview -gt 0 ]]; then
			echo "---"
			echo ""
			echo "## Review Required Cases"
			echo ""
			for marker in "$CASE_DIR"/*-review-marker; do
				[[ -f "$marker" ]] || continue
				mc=$(<"$marker")
				idx="${mc%%|*}"
				rest="${mc#*|}"
				reason="${rest%|*}"
				echo "### Case $idx"
				echo ""
				echo "Review question: $reason"
				echo ""
				for r in "${module_results[@]}"; do
					IFS='|' read -r n nm st lg <<<"$r"
					[[ "$n" == "$idx" ]] && {
						echo "Case: $nm"
						echo "Log: [$lg](cases/${lg#*/cases/})"
						echo ""
					}
				done
			done

			if [[ $mreview -gt 20 ]]; then
				echo "> ⚠️ **WARNING**: $mreview cases require review (>20). Manual review advised."
				echo ""
			fi
		fi
	} >"$MODULE_DIR/summary.md"

	# ── 模块级 summary.json ──
	{
		echo "{"
		echo "  \"module\": \"$module_type/$module_name\","
		echo "  \"timestamp\": \"$TIMESTAMP\","
		echo "  \"total\": $count,"
		echo "  \"pass\": $mpass,"
		echo "  \"fail\": $mfail,"
		echo "  \"review\": $mreview,"
		echo "  \"cases\": ["
		local first=true
		for r in "${module_results[@]}"; do
			$first || echo ","
			first=false
			IFS='|' read -r n nm st lg <<<"$r"
			# Strip leading zeros from padded case number for valid JSON
			local json_num=$((10#$n))
			echo -n "    { \"num\": $json_num, \"name\": \"$nm\", \"status\": \"$st\", \"log\": \"cases/${lg#*/cases/}\" }"
		done
		echo ""
		echo "  ]"
		echo "}"
	} >"$MODULE_DIR/summary.json"

	# 累加到全局
	TOTAL_CASES=$((TOTAL_CASES + count))
	TOTAL_PASS=$((TOTAL_PASS + mpass))
	TOTAL_FAIL=$((TOTAL_FAIL + mfail))
	TOTAL_REVIEW=$((TOTAL_REVIEW + mreview))
	MODULE_RESULTS+=("$module_type|$module_name|$mpass|$mfail|$mreview|$count")

	# ── 模块耗时 ──
	local module_elapsed
	module_elapsed=$(($(date +%s) - module_start_sec))
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
echo "═══════════════════════════════════════════════"

# ── 全局计时 ──
GLOBAL_START_SEC=$(date +%s)

FOUND_ANY=false

# ── 任务队列（用于池化并行） ──
# 格式：type_dir|module_name|test_file
TASK_QUEUE=()

# 对单目标（--ext/--skill）直接串行执行
# 对全量运行使用池化并行
USE_POOL=false
if [[ -z "$TARGET_EXT" && -z "$TARGET_SKILL" && $POOL_SIZE -gt 1 ]]; then
	USE_POOL=true
fi

run_target() {
	local type_dir="$1" # "extensions" 或 "skills"
	local target_name="$2"

	# 路由函数：根据文件扩展名选择执行器
	_dispatch() {
		local task_type="$1"
		local task_name="$2"
		local task_file="$3"
		if [[ "$task_file" == *.exp ]]; then
			run_exp_file "$task_file" "$task_type" "$task_name"
		else
			run_test_file "$task_file" "$task_type" "$task_name"
		fi
		FOUND_ANY=true
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
			if [[ -f "$tf_tui" ]]; then
				add_task "$type_dir" "$target_name" "$tf_tui"
			fi

			# .exp 交互测试
			local tf_exp="$TEST_DIR/$type_dir/$target_name/tui-integration.test.exp"
			if [[ -f "$tf_exp" ]]; then
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
		if ! $TUI_ONLY; then
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
	local next_task=0

	while ((next_task < task_count)); do
		# 清理已完成 worker（bash 3.2 兼容：空数组用 + 展开）
		declare -a active_pids=()
		local pid
		for pid in "${worker_pids[@]+"${worker_pids[@]}"}"; do
			if kill -0 "$pid" 2>/dev/null; then
				active_pids+=("$pid")
			fi
		done
		worker_pids=("${active_pids[@]+"${active_pids[@]}"}")

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
			worker_pids+=($!)
			next_task=$((next_task + 1))
			echo "  [${next_task}/${task_count}] Started: $task_type/$task_name (pid=$!)"
		done

		sleep 1
	done

	# 等待所有 worker 完成
	local remaining=${#worker_pids[@]}
	for pid in "${worker_pids[@]+"${worker_pids[@]}"}"; do
		wait "$pid" 2>/dev/null || true
		remaining=$((remaining - 1))
		echo "  Worker pid=$pid finished (${remaining} remaining)"
	done

	# ── 汇总结果：从每个模块的 summary.json 读取 ──
	echo ""
	echo "─── Aggregating results ───"
	TOTAL_CASES=0
	TOTAL_PASS=0
	TOTAL_FAIL=0
	TOTAL_REVIEW=0
	MODULE_RESULTS=()

	local base_dir
	for base_dir in "$RUN_DIR/extensions" "$RUN_DIR/skills"; do
		[[ -d "$base_dir" ]] || continue
		local module_name
		for module_dir in "$base_dir"/*/; do
			[[ -d "$module_dir" ]] || continue
			module_name=$(basename "$module_dir")
			local sf="$module_dir/summary.json"
			[[ -f "$sf" ]] || continue

			local json_data module_type
			module_type=$(basename "$base_dir")
			json_data=$(python3 -c "
import json,sys
with open('$sf') as f:
    d=json.load(f)
sys.stdout.write('{p}|{f}|{r}|{t}'.format(p=d.get('pass',0),f=d.get('fail',0),r=d.get('review',0),t=d.get('total',0)))
" 2>/dev/null) || continue

			IFS='|' read -r mp mf mr mt <<<"$json_data"
			: "${mp:=0}" "${mf:=0}" "${mr:=0}" "${mt:=0}"
			TOTAL_PASS=$((TOTAL_PASS + mp))
			TOTAL_FAIL=$((TOTAL_FAIL + mf))
			TOTAL_REVIEW=$((TOTAL_REVIEW + mr))
			TOTAL_CASES=$((TOTAL_CASES + mt))
			MODULE_RESULTS+=("$module_type|$module_name|$mp|$mf|$mr|$mt")
			echo "  $module_type/$module_name: $mp pass, $mf fail, $mr review"
		done
	done

	echo "  Total: $TOTAL_CASES cases ($TOTAL_PASS pass, $TOTAL_FAIL fail, $TOTAL_REVIEW review)"
}

if [[ -n "$TARGET_EXT" ]]; then
	run_target "extensions" "$TARGET_EXT"
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
	echo ""
	echo "No test files found. Create test cases under test/e2e/extensions/<name>/smoke.test.sh"
	echo "or test/e2e/skills/<name>/smoke.test.sh"
	exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# 池化并行执行
# ══════════════════════════════════════════════════════════════════════════════

if $USE_POOL && [[ ${#TASK_QUEUE[@]} -gt 0 ]]; then
	run_pool
fi

# ══════════════════════════════════════════════════════════════════════════════
# 全局汇总报告
# ══════════════════════════════════════════════════════════════════════════════

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
	echo "| Module | PASS | FAIL | REVIEW | Total | Report |"
	echo "|--------|------|------|--------|-------|--------|"

	# 按类型分组显示
	for type_dir in "extensions" "skills"; do
		for mr in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
			IFS='|' read -r mt mn mp mf mr_count mtot <<<"$mr"
			[[ "$mt" != "$type_dir" ]] && continue
			echo "| $type_dir/$mn | $mp | $mf | $mr_count | $mtot | [summary]($type_dir/$mn/summary.md) |"
		done
	done

	echo ""
	echo "**Grand Total:** $TOTAL_PASS PASS, $TOTAL_REVIEW NEEDS_REVIEW, $TOTAL_FAIL FAIL / $TOTAL_CASES cases"
	echo ""

	if [[ $TOTAL_REVIEW -gt 0 ]]; then
		echo "---"
		echo ""
		echo "## Modules with Review-Required Cases"
		echo ""
		for mr in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
			IFS='|' read -r mt mn mp mf mr_count mtot <<<"$mr"
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
	echo "  \"warning\": $([[ $TOTAL_REVIEW -gt 20 ]] && echo true || echo false),"
	echo "  \"modules\": ["
	first=true
	for mr in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
		$first || echo ","
		first=false
		IFS='|' read -r mt mn mp mf mr_count mtot <<<"$mr"
		echo -n "    { \"name\": \"$mt/$mn\", \"total\": $mtot, \"pass\": $mp, \"fail\": $mf, \"review\": $mr_count }"
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
echo "  Total: $TOTAL_CASES | PASS: $TOTAL_PASS | FAIL: $TOTAL_FAIL | REVIEW: $TOTAL_REVIEW"
if [[ $TOTAL_REVIEW -gt 20 ]]; then
	echo "  ⚠️  WARNING: $TOTAL_REVIEW cases need manual review (threshold: 20)"
elif [[ $TOTAL_REVIEW -gt 0 ]]; then
	echo "  → $TOTAL_REVIEW case(s) need AI evaluation (under threshold: 20)"
fi
echo "═══════════════════════════════════════════════"
echo ""
echo "Global summary: $RUN_DIR/summary.md"
echo "Module reports:"
for mr in "${MODULE_RESULTS[@]+"${MODULE_RESULTS[@]}"}"; do
	IFS='|' read -r mt mn mp mf mr_count mtot <<<"$mr"
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

# REVIEW 用例是 advisory（待 AI 衡量），只有 FAIL 才表示真的失败
if [[ $TOTAL_FAIL -gt 0 ]]; then
	exit 1
else
	exit 0
fi
