#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# e2e-test 运行器
# 执行 test/extensions/ 和 test/skills/ 下的测试案例，生成可阅读的汇总报告
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

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$ROOT_DIR/test"
RESULTS_DIR="$TEST_DIR/results"
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

usage() {
	cat <<'EOF'
Usage: test/scripts/run-e2e.sh [options]

Options:
  --ext <name>        Run tests for a specific extension (e.g., pi-logger)
  --skill <name>      Run tests for a specific skill (e.g., e2e-test)
  --tui               Run TUI tests (tui.smoke.test.sh) for the target
  -h, --help          Show this help

Without options, runs all test modules (smoke.test.sh only).
Use --tui to run TUI-mode tests instead.
EOF
	exit 0
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
	-h | --help) usage ;;
	*)
		echo "Unknown option: $1" >&2
		usage
		;;
	esac
done

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

	local slug="e2e-test-$$"
	local test_home="$ROOT_DIR/.pi/tmp/$slug"
	mkdir -p "$test_home/.pi/extensions" "$test_home/.pi/logs"

	# 拷贝依赖（支持递归搜索 extensions/ 子目录 + test/helpers/）
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
			elif [[ -f "$ROOT_DIR/test/helpers/$dn.ts" ]]; then
				# test/helpers/ 扩展：如 mock-llm，拷贝为目录扩展
				mkdir -p "$test_home/.pi/extensions/$dn"
				cp "$ROOT_DIR/test/helpers/$dn.ts" "$test_home/.pi/extensions/$dn/index.ts"
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
					echo "WARNING: dependency '$dn' not found in extensions/ (including subdirectories) or test/helpers/"
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

	local padded
	padded=$(printf '%03d' "$CASE_INDEX")
	local pi_stdout_file="$CASE_DIR/${padded}-pi-stdout.log"
	local pi_logs_dir="$test_home/.pi/logs"

	cd "$test_home"
	set +e
	HOME="$isolated_home" pi -a --no-session -p "$prompt" 2>&1 >"$pi_stdout_file"
	local pi_exit=$?
	set -e
	cd "$ROOT_DIR"

	if [[ -d "$pi_logs_dir" ]]; then
		cp -r "$pi_logs_dir" "$CASE_DIR/${padded}-logs"
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
TUI_HELPERS="$ROOT_DIR/test/helpers/tui-functions.sh"
if [[ -f "$TUI_HELPERS" ]]; then
	# shellcheck disable=SC1091
	source "$TUI_HELPERS"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 测试执行引擎
# ══════════════════════════════════════════════════════════════════════════════

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

	local count=${#TEST_CASES[@]}
	[[ $count -eq 0 ]] && {
		echo "  → No test cases, skipping."
		return
	}
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

		local case_log="$CASE_DIR/${padded}-${name//\//-}.log"
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
		module_results+=("$padded|$name|$result|$rel_path/cases/${padded}-${name//\//-}.log")
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
			echo -n "    { \"num\": $n, \"name\": \"$nm\", \"status\": \"$st\", \"log\": \"cases/${lg#*/cases/}\" }"
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

FOUND_ANY=false

run_target() {
	local type_dir="$1" # "extensions" 或 "skills"
	local target_name="$2"

	if [[ -n "$target_name" ]]; then
		# 根据 --tui flag 选择主测试文件
		if $TUI_ONLY; then
			local tf="$TEST_DIR/$type_dir/$target_name/tui.smoke.test.sh"
			if [[ -f "$tf" ]]; then
				run_test_file "$tf" "$type_dir" "$target_name"
				FOUND_ANY=true
			else
				echo "Not found: $tf"
			fi
		else
			# 默认：先跑 smoke.test.sh，再跑 tui.smoke.test.sh（如果有）
			local tf_smoke="$TEST_DIR/$type_dir/$target_name/smoke.test.sh"
			if [[ -f "$tf_smoke" ]]; then
				run_test_file "$tf_smoke" "$type_dir" "$target_name"
				FOUND_ANY=true
			else
				echo "Not found: $tf_smoke"
			fi

			local tf_tui="$TEST_DIR/$type_dir/$target_name/tui.smoke.test.sh"
			if [[ -f "$tf_tui" ]]; then
				run_test_file "$tf_tui" "$type_dir" "$target_name"
				FOUND_ANY=true
			fi
		fi
	else
		for d in "$TEST_DIR/$type_dir"/*/; do
			local bn
			bn=$(basename "$d")
			local tf="$d/smoke.test.sh"
			if [[ -f "$tf" ]]; then
				run_test_file "$tf" "$type_dir" "$bn"
				FOUND_ANY=true
			fi
		done

		# In non-TUI mode, also run tui.smoke.test.sh files if found
		# (TUI tests supplement smoke tests)
		if ! $TUI_ONLY; then
			for d in "$TEST_DIR/$type_dir"/*/; do
				local bn
				bn=$(basename "$d")
				local tf="$d/tui.smoke.test.sh"
				if [[ -f "$tf" ]]; then
					run_test_file "$tf" "$type_dir" "$bn"
					FOUND_ANY=true
				fi
			done
		fi
	fi
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
	echo "No test files found. Create test cases under test/extensions/<name>/smoke.test.sh"
	echo "or test/skills/<name>/smoke.test.sh"
	exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# 全局汇总报告
# ══════════════════════════════════════════════════════════════════════════════

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
	echo ""
	echo "## Modules"
	echo ""
	echo "| Module | PASS | FAIL | REVIEW | Total | Report |"
	echo "|--------|------|------|--------|-------|--------|"

	# 按类型分组显示
	for type_dir in "extensions" "skills"; do
		for mr in "${MODULE_RESULTS[@]}"; do
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
		for mr in "${MODULE_RESULTS[@]}"; do
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
	echo "  \"total\": $TOTAL_CASES,"
	echo "  \"pass\": $TOTAL_PASS,"
	echo "  \"fail\": $TOTAL_FAIL,"
	echo "  \"review\": $TOTAL_REVIEW,"
	echo "  \"warning\": $([[ $TOTAL_REVIEW -gt 20 ]] && echo true || echo false),"
	echo "  \"modules\": ["
	first=true
	for mr in "${MODULE_RESULTS[@]}"; do
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
echo "  Results"
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
for mr in "${MODULE_RESULTS[@]}"; do
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
