#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# TUI 测试辅助函数
# 在 TUI 模式下运行 pi 并验证交互式输出
# 使用方式：source 本文件后调用其中的函数
# ──────────────────────────────────────────────────────────────────────────────

# ── 平台检测 ──
IS_LINUX=false
case "$(uname -s)" in
Linux*) IS_LINUX=true ;;
esac

# ── 跨平台 timeout 封装 ──
# macOS 没有 timeout 命令；Linux 有
run_with_timeout() {
	local seconds="$1"
	shift
	if $IS_LINUX; then
		timeout "$seconds" "$@"
	else
		perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"
	fi
}

# ANSI 清理函数：剥离终端转义序列，保留纯文本
# 支持标准 SGR (m) 转义 + OSC 转义 (0-9;...) + 其他控制序列
# 以及 macOS Terminal 特定的 CSI 序列（? > = 等前导字符）
strip_ansi() {
	sed '
		# CSI sequences: \x1b[ ... letter
		s/\x1b\[[0-9;?]*[a-zA-Z]//g
		# CSI sequences with >, =, < modifiers
		s/\x1b\[[>][0-9;]*[a-zA-Z~]//g
		s/\x1b\[[=][0-9;]*[a-zA-Z~]//g
		s/\x1b\[[<][0-9;]*[a-zA-Z~]//g
		s/\x1b\[[?][0-9;]*[a-zA-Z~]//g
		# OSC sequences: \x1b]...\x07 or \x1b]...\x1b\\
		s/\x1b\][0-9;]*[^\x07\x1b]*\(\x07\|\x1b\\\)//g
		# DEC private sequences
		s/\x1b[[\]][^a-zA-Z]*[a-zA-Z]//g
		s/\x1b[^a-zA-Z\[\]]*[a-zA-Z]//g
		s/\x1b[PX^_]//g
		# Carriage return
		s/\r//g
	'
}

# 从 script 输出中提取纯文本视口内容
# 参数：$1 = script 输出文件路径
# 输出：纯文本（ANSI 已去除），每行一条
extract_visible_text() {
	local file="$1"
	# 去除 script 的头部控制序列 + ANSI + 只保留可打印内容
	# 1. 跳过 script 自己的 header（以 "Script started" 或类似开头）
	# 2. 剥离所有 ANSI 转义
	# 3. 去除空行两侧的空白
	# 4. 只保留有实质内容的行（≥2 个可见字符，且不是纯空格/control）
	strip_ansi <"$file" |
		grep -v '^Script started' |
		grep -v '^Script done' |
		sed 's/[[:space:]]*$//' |
		sed 's/^[[:space:]]*//' |
		grep -v '^$' |
		grep -v '^[[:space:]]*$' |
		cat
}

# 从 script 输出中提取 "视口快照"：过滤掉 TUI 渲染过程中的中间帧
# 只保留完整渲染出的内容（由换行和重置序列分割）
# 参数：$1 = script 输出文件路径
# 输出：纯文本（ANSI 已去除），每行一条，按视口分组
extract_viewport_snapshots() {
	local file="$1"
	# 思路：TUI 的每次完整渲染后通常会有一段稳定的文本
	# 我们用 clear screen 序列 (\x1b[2J 或 \x1b[H) 作为视口分界
	# 在分界之间取最后一次渲染作为快照

	# 以 \x1b[2J 或 \x1b[H 作为分界
	# 但 script 输出是流式的，更稳妥的是在整个输出中找特定 markers

	# 简化：对整个输出 strip-ansi 后提取有意义的行
	strip_ansi <"$file" |
		tr -d '\000-\010\016-\037' |
		sed 's/[[:space:]]*$//' |
		grep -v '^$' |
		grep -v '^[[:space:]]*$' |
		awk '!seen[$0]++' # 去重（TUI 差量渲染会产生重复）
}

# 在 TUI 视口输出中搜索关键字
# 参数：$1 = script 输出文件路径
#     $2 = 搜索关键字
# 返回：0 找到，1 未找到
tui_output_contains() {
	local file="$1"
	local keyword="$2"
	extract_visible_text "$file" | grep -qF "$keyword"
}

# 在 TUI 视口输出中用正则搜索
# 参数：$1 = script 输出文件路径
#     $2 = 正则表达式
# 返回：0 找到，1 未找到
tui_output_matches() {
	local file="$1"
	local pattern="$2"
	extract_visible_text "$file" | grep -qE "$pattern"
}

# 获取匹配关键字的行数
# 参数：$1 = script 输出文件路径
#     $2 = 搜索关键字
# 输出：匹配行数
tui_output_count() {
	local file="$1"
	local keyword="$2"
	extract_visible_text "$file" | grep -cF "$keyword" || true
}

# 构建隔离环境并执行 pi 的 TUI 测试
# 用法：tui_run_pi_test <extension_list> <input_script> <timeout_seconds>
#   extension_list  - 逗号分隔的依赖扩展列表
#   input_script    - 要发送到 pi 的输入（支持多行）
#   timeout_seconds - 超时秒数（默认：15）
# 输出：
#   TUI_OUTPUT_FILE - script 输出文件路径
#   TUI_EXIT_CODE   - pi 的 exit code
tui_run_pi_test() {
	local extensions="$1"
	local input_script="$2"
	local timeout_seconds="${3:-15}"

	# CI 模式检测：CI=true 时自动注入 mock-llm
	local PI_CI_MODE=${CI:-false}

	local slug="tui-test-$$"
	local test_home="$ROOT_DIR/.pi/tmp/$slug"
	mkdir -p "$test_home"
	local output_file="$test_home/output.log"

	# CI 模式：自动注入 mock-llm，无需真实 API Key
	if [[ "$PI_CI_MODE" == true ]] && [[ "$extensions" != *"mock-llm"* ]]; then
		extensions="mock-llm,$extensions"
	fi

	# 拷贝依赖扩展到 .pi/extensions/ 下（pi 自动发现的位置）
	if [[ -n "$extensions" ]]; then
		local ext_dir="$test_home/.pi/extensions"
		mkdir -p "$ext_dir" "$test_home/.pi/logs"

		local -a DEPS
		IFS=',' read -ra DEPS <<<"$extensions"
		for dep in "${DEPS[@]}"; do
			local dn
			dn=$(echo "$dep" | xargs)
			[[ -z "$dn" ]] && continue

			# 与 run_pi_and_check 相同的查找逻辑：
			# 1) extensions/ 下的目录扩展或单文件扩展
			# 2) test/helpers/ 下的测试辅助扩展（如 mock-llm）
			# 3) 递归搜索 extensions/ 子目录
			if [[ -d "$ROOT_DIR/extensions/$dn" ]]; then
				cp -r "$ROOT_DIR/extensions/$dn" "$ext_dir/$dn"
			elif [[ -f "$ROOT_DIR/extensions/$dn.ts" ]]; then
				cp "$ROOT_DIR/extensions/$dn.ts" "$ext_dir/$dn.ts"
			elif [[ -f "$ROOT_DIR/test/helpers/$dn.ts" ]]; then
				# test/helpers/ 扩展：拷贝为目录扩展
				mkdir -p "$ext_dir/$dn"
				cp "$ROOT_DIR/test/helpers/$dn.ts" "$ext_dir/$dn/index.ts"
			else
				local found=""
				while IFS= read -r -d '' match; do
					found="$match"
					break
				done < <(find "$ROOT_DIR/extensions" -maxdepth 3 -name "$dn.ts" -print0 -o -type d -name "$dn" -exec test -f '{}/index.ts' \; -print0 2>/dev/null)
				if [[ -n "$found" ]]; then
					if [[ -d "$found" ]]; then
						cp -r "$found" "$ext_dir/$dn"
					else
						cp "$found" "$ext_dir/$dn.ts"
					fi
				else
					echo "WARNING: dependency '$dn' not found in extensions/ (including subdirectories) or test/helpers/"
				fi
			fi
		done
	fi

	# 拷贝 pi-logger 配置
	if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
		mkdir -p "$test_home/.pi"
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json" 2>/dev/null || true
	fi

	# ── 关键修复：建立 node_modules 本地包链接 ──
	# 扩展中 import '@zenone/pi-logger' 需要能找到本地包
	# 在项目目录中通过 node_modules/@zenone/pi-logger -> ../../extensions/meta/pi-logger 链接工作
	mkdir -p "$test_home/node_modules"
	local pkgs=("pi-logger" "selector")
	for pkg in "${pkgs[@]}"; do
		local pkg_src="$ROOT_DIR/extensions/meta/$pkg"
		local pkg_name="@zenone/$pkg"
		local pkg_dir="$test_home/node_modules/$pkg_name"
		if [[ -d "$pkg_src" && ! -e "$pkg_dir" ]]; then
			mkdir -p "$(dirname "$pkg_dir")"
			ln -sf "$pkg_src" "$pkg_dir"
		fi
	done

	# 创建 HOME 下的 .pi 链接（某些扩展需要读取配置）
	mkdir -p "$test_home/home"
	export HOME="$test_home/home"
	if [[ ! -f "$HOME/.pi/agent/pi-logger.json" ]]; then
		mkdir -p "$HOME/.pi/agent"
		[[ -f "$test_home/.pi/pi-logger.json" ]] && cp "$test_home/.pi/pi-logger.json" "$HOME/.pi/agent/"
	fi
	# 复制 pi 全局配置中的 models.json（避免模型配置丢失）
	local real_home
	real_home=$(eval echo ~)
	if [[ -f "$HOME/.pi/agent/models.json" ]]; then
		: # 已存在
	elif [[ -f "$ROOT_DIR/.pi/agent/models.json" ]]; then
		mkdir -p "$HOME/.pi/agent"
		cp "$ROOT_DIR/.pi/agent/models.json" "$HOME/.pi/agent/"
	elif [[ -f "$real_home/.pi/agent/models.json" ]]; then
		mkdir -p "$HOME/.pi/agent"
		cp "$real_home/.pi/agent/models.json" "$HOME/.pi/agent/"
	fi

	# 复制全局 extension 配置（防止启动时缺少文件报错）
	if [[ -d "$real_home/.pi/agent/extensions-data" ]]; then
		mkdir -p "$HOME/.pi/agent/extensions-data"
		cp -r "$real_home/.pi/agent/extensions-data/"* "$HOME/.pi/agent/extensions-data/" 2>/dev/null || true
	fi

	# 在 test_home 下初始化 git（某些扩展需要）
	if ! git -C "$test_home" rev-parse --git-dir &>/dev/null; then
		git -C "$test_home" init --initial-branch main &>/dev/null || true
	fi

	# CI 模式：创建 mock-llm 模型配置，覆盖用户配置
	if [[ "$PI_CI_MODE" == true ]]; then
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

	# 使用 script 在 PTY 中运行 pi
	# 通过 HEREDOC 一次性输入所有命令
	cd "$test_home"
	set +e
	# 注意：Linux/macOS 的 script 语法不同：
	#   Linux: script -q -e -c "command" output_file
	#   macOS: script -q output_file command (no -c flag)
	# 使用 perl 实现跨平台 timeout（macOS 没有 timeout 命令）
	local pi_exit=0
	if $IS_LINUX; then
		script -q -e -c "timeout $timeout_seconds pi -a" "$output_file" <<<"$input_script" >/dev/null 2>&1
		pi_exit=$?
	else
		# macOS: script 不传递子进程 exit code，用 wrapper 写入文件
		local ec_file="$test_home/exitcode"
		echo -n >"$ec_file"
		local wrapper="$test_home/wrapper.sh"
		# 注意：heredoc 里 $$ 会被展开，用 \$ 或直接写字符串
		cat >"$wrapper" <<-WRAPPER
			#!/usr/bin/env bash
			perl -e 'alarm shift; exec @ARGV' "\$1" pi -a
			echo "\$?" > "$ec_file"
		WRAPPER
		chmod +x "$wrapper"
		# macOS script 语法：script -q output_file command args
		script -q "$output_file" "$wrapper" "$timeout_seconds" <<<"$input_script" >/dev/null 2>&1
		pi_exit=$(cat "$ec_file" 2>/dev/null || echo 0)
		# timeout 映射：perl alarm 退出码 14（SIGALRM）
		[[ "$pi_exit" == "14" ]] && pi_exit=124
	fi
	set -e
	cd "$ROOT_DIR"

	# 收集日志
	local logs_dir="$test_home/.pi/logs"
	if [[ -d "$logs_dir" ]]; then
		local padded
		padded=$(printf '%03d' "$CASE_INDEX")
		cp -r "$logs_dir" "$CASE_DIR/${padded}-logs" 2>/dev/null || true
	fi

	# 复制输出到 cases 目录做持久化
	local padded
	padded=$(printf '%03d' "$CASE_INDEX")
	cp "$output_file" "$CASE_DIR/${padded}-tui-output.log" 2>/dev/null || true

	# 导出供调用方使用
	TUI_OUTPUT_FILE="$output_file"
	TUI_EXIT_CODE=$pi_exit
	TUI_TEST_HOME="$test_home"

	# 输出摘要信息
	echo "TUI test completed: exit=$pi_exit, output=$(wc -c <"$output_file") bytes"
}

# TUI 测试结果判定
# 调用 tui_run_pi_test 后使用
# 用法：tui_assert_contains <keyword> [error_message]
tui_assert_contains() {
	local keyword="$1"
	local msg="${2:-Expected TUI output to contain: $keyword}"
	if ! tui_output_contains "$TUI_OUTPUT_FILE" "$keyword"; then
		echo "FAIL: $msg"
		echo "--- TUI output (visible text) ---"
		extract_visible_text "$TUI_OUTPUT_FILE" | tail -50
		echo "---"
		return 1
	fi
	echo "PASS: Found '$keyword' in TUI output"
	return 0
}

# 用法：tui_assert_matches <regex> [error_message]
tui_assert_matches() {
	local pattern="$1"
	local msg="${2:-Expected TUI output to match: $pattern}"
	if ! tui_output_matches "$TUI_OUTPUT_FILE" "$pattern"; then
		echo "FAIL: $msg"
		echo "--- TUI output (visible text) ---"
		extract_visible_text "$TUI_OUTPUT_FILE" | tail -50
		echo "---"
		return 1
	fi
	echo "PASS: Pattern '$pattern' matched in TUI output"
	return 0
}

# 用法：tui_assert_exit_code <expected_code>
tui_assert_exit_code() {
	local expected="$1"
	if [[ "$TUI_EXIT_CODE" -ne "$expected" ]]; then
		# timeout (124) is also acceptable for TUI tests (pi didn't exit on its own)
		if [[ "$expected" -eq 0 && "$TUI_EXIT_CODE" -eq 124 ]]; then
			echo "PASS: TUI test timed out (expected for non-exiting commands)"
			return 0
		fi
		echo "FAIL: Expected exit code $expected, got $TUI_EXIT_CODE"
		return 1
	fi
	echo "PASS: Exit code $expected"
	return 0
}

# 清理 TUI 测试产生的临时文件
tui_cleanup() {
	if [[ -n "$TUI_TEST_HOME" && -d "$TUI_TEST_HOME" ]]; then
		rm -rf "$TUI_TEST_HOME"
		TUI_TEST_HOME=""
	fi
}
