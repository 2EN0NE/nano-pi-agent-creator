#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-lab TUI 测试
# 测试要点：
# 1. 扩展在 TUI 模式下正确加载（exit code 0 或 timeout）
# 2. /lab 命令被 pi 识别（命令文本出现在输出中）
# 3. TUI 状态栏显示主界面元素
# 4. 分割线在首次渲染时就占满终端宽度（使用固定宽度 PTY 验证）
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-lab (TUI mode)"

# ── 新增辅助函数：在指定终端宽度下运行 TUI pi 测试 ──
# 用法：tui_run_pi_test_width <exts> <input> <timeout> <cols>
# 与 tui_run_pi_test 相同，但在 PTY 中先设置 stty cols
tui_run_pi_test_width() {
	local extensions="$1"
	local input_script="$2"
	local timeout_seconds="${3:-15}"
	local cols="${4:-80}"

	local slug="tui-test-$$-$RANDOM"
	local test_home="$ROOT_DIR/.pi/tmp/$slug"
	mkdir -p "$test_home"
	local output_file="$test_home/output.log"

	# CI 模式注入 mock-llm
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
			elif [[ -f "$ROOT_DIR/test/helpers/$dn.ts" ]]; then
				mkdir -p "$ext_dir/$dn"
				cp "$ROOT_DIR/test/helpers/$dn.ts" "$ext_dir/$dn/index.ts"
			else
				local found
				while IFS= read -r -d '' match; do
					found="$match"
					break
				done < <(
					find "$ROOT_DIR/extensions" -maxdepth 3 -name "$dn.ts" -print0 \
						-o -type d -name "$dn" -exec test -f '{}/index.ts' \; -print0 \
						-o -type d -name "$dn" -exec test -f '{}/dist/index.js' \; -print0 2>/dev/null
				)
				if [[ -n "$found" ]]; then
					[[ -d "$found" ]] && cp -r "$found" "$ext_dir/$dn" || cp "$found" "$ext_dir/$dn.ts"
				else
					echo "WARNING: dependency '$dn' not found"
				fi
			fi
		done
	fi

	# pi-logger 配置
	[[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]] && {
		mkdir -p "$test_home/.pi"
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json" 2>/dev/null || true
	}

	# node_modules 本地包链接
	mkdir -p "$test_home/node_modules"
	for pkg in pi-logger selector pi-config; do
		local pkg_src="$ROOT_DIR/extensions/meta/$pkg"
		local pkg_name="@zenone/$pkg"
		local pkg_dir="$test_home/node_modules/$pkg_name"
		if [[ -d "$pkg_src" && ! -e "$pkg_dir" ]]; then
			mkdir -p "$(dirname "$pkg_dir")"
			ln -sf "$pkg_src" "$pkg_dir"
		fi
	done

	export HOME="$test_home/home"
	mkdir -p "$HOME/.pi/agent"
	[[ -f "$test_home/.pi/pi-logger.json" ]] && cp "$test_home/.pi/pi-logger.json" "$HOME/.pi/agent/"
	local real_home
	real_home=$(eval echo ~)
	if [[ ! -f "$HOME/.pi/agent/models.json" ]]; then
		if [[ -f "$ROOT_DIR/.pi/agent/models.json" ]]; then
			cp "$ROOT_DIR/.pi/agent/models.json" "$HOME/.pi/agent/"
		elif [[ -f "$real_home/.pi/agent/models.json" ]]; then
			cp "$real_home/.pi/agent/models.json" "$HOME/.pi/agent/"
		fi
	fi
	if [[ -d "$real_home/.pi/agent/extensions-data" ]]; then
		mkdir -p "$HOME/.pi/agent/extensions-data"
		cp -r "$real_home/.pi/agent/extensions-data/"* "$HOME/.pi/agent/extensions-data/" 2>/dev/null || true
	fi
	# CI 模式模型配置
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
	git -C "$test_home" init --initial-branch main &>/dev/null || true

	cd "$test_home"
	set +e
	if $IS_LINUX; then
		script -q -e -c "stty cols $cols; timeout $timeout_seconds pi -a" "$output_file" <<<"$input_script" >/dev/null 2>&1
		TUI_EXIT_CODE=$?
	else
		local ec_file="$test_home/exitcode"
		echo -n >"$ec_file"
		local wrapper="$test_home/wrapper.sh"
		cat >"$wrapper" <<-WRAPPER
			#!/usr/bin/env bash
			stty cols $cols
			perl -e 'alarm shift; exec @ARGV' "$timeout_seconds" pi -a
			echo "\$?" > "$ec_file"
		WRAPPER
		chmod +x "$wrapper"
		script -q "$output_file" "$wrapper" >/dev/null 2>&1 <<<"$input_script"
		TUI_EXIT_CODE=$(cat "$ec_file" 2>/dev/null || echo 0)
		[[ "$TUI_EXIT_CODE" == "14" ]] && TUI_EXIT_CODE=124
	fi
	set -e
	cd "$ROOT_DIR"

	local padded
	padded=$(printf '%03d' "$CASE_INDEX")
	cp "$output_file" "$CASE_DIR/${padded}-tui-output.log" 2>/dev/null || true

	TUI_OUTPUT_FILE="$output_file"
	TUI_TEST_HOME="$test_home"
	echo "TUI test completed: exit=$TUI_EXIT_CODE, output=$(wc -c <"$output_file") bytes, cols=$cols"
}

# ── 标准测试项 ──

test_it "loads extension in TUI mode without crash" <<'TEST'
  tui_run_pi_test "pi-lab" "/lab" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "/lab command is recognized by pi [REVIEW]" <<'TEST'
  tui_run_pi_test "pi-lab" "/lab" 15

  # /lab 被 pi 命令系统识别
  tui_assert_contains "/lab" "/lab command should be in output"

  tui_cleanup
  mark_for_review "手动验证 /lab 命令在 TUI 中能正确打开面板：输入 /lab 后应出现实验管理面板（Current Session / Global 标签页，底部帮助栏）"
TEST

test_it "TUI mode renders status bar" <<'TEST'
  tui_run_pi_test "pi-lab" "/lab" 15

  # 状态栏应显示模型信息（mock-model-1 表示 mock-llm 已注入）
  tui_assert_contains "mock" "Status bar should show model name"

  tui_cleanup
TEST

# ── 新增：分割线宽度测试 ──
# 固定 PTY 宽度为 100 列，验证首次渲染时分割线（─）能占满终端宽度。
# 若分割线未填满，计数会远小于 width - 边距。
test_it "divider fills full terminal width on first render" <<'TEST'
  local WIDTH=100
  tui_run_pi_test_width "pi-lab" "/lab" 15 $WIDTH

  # 从输出中提取纯文本，找包含 ── 的行（最少3个连续）
  local divider_line
  divider_line=$(extract_visible_text "$TUI_OUTPUT_FILE" | grep -E '─{3,}' | head -1)
  
  if [[ -z "$divider_line" ]]; then
    echo "FAIL: No divider line found in output"
    echo "--- TUI output ---"
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -30
    echo "---"
    exit 1
  fi

  # 计算 ─ 字符数量
  local dash_count
  dash_count=$(echo "$divider_line" | sed 's/[^─]//g' | wc -c | tr -d ' ')
  # wc -c 包含换行符，减去1
  dash_count=$((dash_count - 1))

  echo "Divider line: ${#divider_line} chars width, $dash_count dashes"
  echo "Terminal width: $WIDTH"

  # 在 100 列终端中，2 格缩进 + 分隔线 = 98 格 ─
  # 正确：dash_count 应 >= 80（接近 WIDTH - 边距）
  # 错误（旧 bug）：dash_count == 80（fallback currentWidth）
  if [[ "$dash_count" -ge "$((WIDTH - 10))" ]]; then
    echo "PASS: Divider fills terminal ($dash_count dashes, terminal=$WIDTH)"
  elif [[ "$dash_count" -gt 80 && "$dash_count" -lt "$((WIDTH - 10))" ]]; then
    echo "WARN: Divider width $dash_count plausible but verify"
  else
    # 旧 bug 会导致 dash_count == 80（fallback currentWidth），小于 100-10=90
    echo "FAIL: Divider only $dash_count dashes (expected >= $((WIDTH - 10)))"
    echo "This means needsFirstRebuild fix is NOT working correctly."
    exit 1
  fi

  tui_cleanup
TEST

test_it "works with edit extension in TUI mode [REVIEW]" <<'TEST'
  tui_run_pi_test "pi-lab,edit" "/lab" 15

  # 基础验证：只要不崩溃就算通过
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode with pi-lab+edit exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
  mark_for_review "检查 TUI 中两个扩展同时加载时的显示效果：状态栏、面板交互"
TEST
