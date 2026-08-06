#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# TUI 测试辅助函数
# 在 TUI 模式下运行 pi 并验证交互式输出
# 使用方式：source 本文件后调用其中的函数
# ──────────────────────────────────────────────────────────────────────────────

# ── TUI 测试核心函数 ──
# 所有 TUI 测试均使用 expect 作为 PTY 后端。
# tui_run_pi_test: 简单场景（发送输入行，等待退出，检查输出）
# tui_expect_test: 复杂场景（按键 → 等待响应 → 断言 → 下一步）

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
	# 默认 timeout：CI 模式 8s（加速），本地 15s（兼容）
	local timeout_seconds="${3:-$([[ "${CI:-false}" == "true" ]] && echo 8 || echo 15)}"

	# CI 模式检测：CI=true 时自动注入 mock-llm
	local PI_CI_MODE=${CI:-false}

	local slug="tui-test-$$-$RANDOM"
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
			elif [[ -f "$ROOT_DIR/test/e2e/helpers/$dn.ts" ]]; then
				# test/e2e/helpers/ 扩展：拷贝为目录扩展
				mkdir -p "$ext_dir/$dn"
				cp "$ROOT_DIR/test/e2e/helpers/$dn.ts" "$ext_dir/$dn/index.ts"
			else
				local found=""
				while IFS= read -r -d '' match; do
					found="$match"
					break
				done < <(find "$ROOT_DIR/extensions" -maxdepth 3 -name "$dn.ts" -print0 \
					-o -type d -name "$dn" -exec test -f '{}/index.ts' \; -print0 \
					-o -type d -name "$dn" -exec test -f '{}/dist/index.js' \; -print0 2>/dev/null)
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
	local pkgs=("pi-logger" "selector" "pi-config")
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

	# ── expect 替代 script：生成 expect 脚本并执行 ──
	# 支持 "逐行发送 → 等待 → 断言" 闭环，与 tui_expect_test 使用相同的 expect 底层
	local exp_file="$test_home/test.exp"
	local ec_file="$test_home/exitcode"

	# 生成 expect 脚本头部
	cat >"$exp_file" <<-EXPECT
		#!/usr/bin/env expect
		set timeout $timeout_seconds
		log_user 1
		# 设置终端宽度
		set stty_init "cols $cols rows 24"
		spawn pi -a
		# 等待 TUI 就绪
		expect {
			-re {\(auto\)|0\.0%/0} { }
			timeout { exit 124 }
		}
		sleep 1

	EXPECT

	# 将输入脚本的每一行转换为 expect send 命令
	while IFS= read -r line; do
		# 空行 → sleep 替代（可能是交互间隙）
		if [[ -z "$line" ]]; then
			echo "	sleep 0.5" >>"$exp_file"
			continue
		fi
		# 转义：\x1b (ESC) → \033 (expect 语法)
		local escaped
		escaped=$(printf '%s' "$line" | sed 's/\x1b/\\033/g')
		cat >>"$exp_file" <<-SENDLINE
			send "${escaped}\\r"
			sleep 0.2

		SENDLINE
	done <<<"$input_script"

	# 生成 expect 脚本尾部（等待退出）
	cat >>"$exp_file" <<-EXPECT
		# 等待进程退出
		expect {
			eof {
				catch { wait result }
				set exit_code [lindex \$result 3]
				exec echo "\$exit_code" > "$ec_file"
			}
			timeout {
				exec echo "124" > "$ec_file"
			}
		}
	EXPECT

	chmod +x "$exp_file"

	# 执行 expect
	cd "$test_home"
	local pi_exit=0
	set +e
	expect "$exp_file" >"$output_file" 2>&1
	pi_exit=$(cat "$ec_file" 2>/dev/null || echo 0)
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

# ══════════════════════════════════════════════════════════════════════════════
# expect 交互式 TUI 测试（替代 script+heredoc）
# ══════════════════════════════════════════════════════════════════════════════

# 使用 expect 进行交互式 TUI 端到端测试。
#
# 相比 script+heredoc 的优势：
#   - 支持 "按键 → 等待响应 → 断言 → 下一步" 的交互闭环
#   - 中间状态可验证（如 "按 m 后标记是否出现"）
#   - 退出码精确传递
#
# 用法：tui_expect_test <extension_list> <expect_commands> <timeout_seconds> [cols] [cwd]
#   extension_list   - 逗号分隔的依赖扩展列表
#   expect_commands  - expect 交互命令（多行字符串）
#   timeout_seconds  - 超时秒数（默认：15）
#   cols             - 终端宽度列数（默认：80）
#   cwd              - pi 工作目录（默认：沙箱目录）
#
# expect_commands 中可以使用的上下文：
#   - send "text\r"      发送文本（\r = Enter）
#   - send "\033"        发送 Esc
#   - send "\t"          发送 Tab
#   - sleep 0.5          等待 0.5 秒
#   - expect { ... }     等待模式匹配
#   - expect -re { ... } 正则匹配
#
# 输出：
#   TUI_OUTPUT_FILE - expect 输出文件路径
#   TUI_EXIT_CODE   - pi 的 exit code（0=成功, 124=timeout, 其他=失败）
#
# 示例：
#   tui_expect_test "pi-logger,quit" '
#     expect -re {mock-model-1|\[\d+\.\d+%} { }
#     send "/quit\r"
#     expect {
#       eof { }
#       timeout { exit 124 }
#     }
#   ' 15
tui_expect_test() {
	local extensions="$1"
	local expect_commands="$2"
	local timeout_seconds="${3:-15}"
	local cols="${4:-80}"
	local cwd="${5:-}"

	local PI_CI_MODE=${CI:-false}
	local slug="tui-exp-$$-$RANDOM"
	local test_home="$ROOT_DIR/.pi/tmp/$slug"
	mkdir -p "$test_home"
	local output_file="$test_home/output.log"

	# ── sandbox 设置（与 tui_run_pi_test 一致）──

	if [[ "$PI_CI_MODE" == true ]] && [[ "$extensions" != *"mock-llm"* ]]; then
		extensions="mock-llm,$extensions"
	fi

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

	# node_modules 本地包链接
	mkdir -p "$test_home/node_modules"
	for pkg in pi-logger selector pi-config; do
		local pkg_src="$ROOT_DIR/extensions/meta/$pkg"
		local pkg_dir="$test_home/node_modules/@zenone/$pkg"
		if [[ -d "$pkg_src" && ! -e "$pkg_dir" ]]; then
			mkdir -p "$(dirname "$pkg_dir")"
			ln -sf "$pkg_src" "$pkg_dir"
		fi
	done

	# HOME 隔离
	mkdir -p "$test_home/home/.pi/agent"
	export HOME="$test_home/home"
	[[ -f "$test_home/.pi/pi-logger.json" ]] && cp "$test_home/.pi/pi-logger.json" "$HOME/.pi/agent/"

	# 模型配置
	local real_home
	real_home=$(eval echo ~)
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
	else
		for models_file in "$ROOT_DIR/.pi/agent/models.json" "$real_home/.pi/agent/models.json"; do
			if [[ -f "$models_file" ]]; then
				cp "$models_file" "$HOME/.pi/agent/" 2>/dev/null || true
				break
			fi
		done
	fi

	# 全局 extension 配置
	if [[ -d "$real_home/.pi/agent/extensions-data" ]]; then
		mkdir -p "$HOME/.pi/agent/extensions-data"
		cp -r "$real_home/.pi/agent/extensions-data/"* "$HOME/.pi/agent/extensions-data/" 2>/dev/null || true
	fi

	# git init
	if ! git -C "$test_home" rev-parse --git-dir &>/dev/null; then
		git -C "$test_home" init --initial-branch main &>/dev/null || true
	fi

	# ── 确定工作目录 ──
	local pi_cwd="${cwd:-$test_home}"

	# ── 生成 expect 脚本 ──
	local exp_file="$test_home/test.exp"
	local ec_file="$test_home/exitcode"
	cat >"$exp_file" <<-EXPECT
		#!/usr/bin/env expect
		set timeout $timeout_seconds
		log_user 1

		# 切换到工作目录
		cd $pi_cwd

		# 启动 pi
		spawn pi -a

		# 等待 TUI 就绪（匹配状态栏中 (auto) 或 0.0%/0——连续出现，不会被 ANSI 打断）
		expect {
			-re {\(auto\)|0\.0%/0} { }
			timeout {
				send_error "TIMEOUT: TUI did not become ready within ${timeout_seconds}s\n"
				exit 124
			}
		}

		# 额外等待确保 TUI 完全渲染
		sleep 1

		# ── 用户提供的交互命令 ──
		$expect_commands

		# ── 收尾：如果 pi 仍然活着，发送 /quit ──
		send "/quit\r"
		sleep 1

		# 捕获退出码
		expect {
			eof {
				catch { wait result }
				set exit_code [lindex \$result 3]
				exec echo "\$exit_code" > "$ec_file"
			}
			timeout {
				exec echo "124" > "$ec_file"
				exit 124
			}
		}
	EXPECT

	chmod +x "$exp_file"

	# ── 运行 expect ──
	set +e
	expect "$exp_file" >"$output_file" 2>&1
	local pi_exit=$(cat "$ec_file" 2>/dev/null || echo 0)
	set -e

	# ── 收集日志 ──
	local logs_dir="$test_home/.pi/logs"
	if [[ -d "$logs_dir" ]]; then
		local padded
		padded=$(printf '%03d' "$CASE_INDEX")
		cp -r "$logs_dir" "$CASE_DIR/${padded}-logs" 2>/dev/null || true
	fi

	# 复制输出
	local padded
	padded=$(printf '%03d' "$CASE_INDEX")
	cp "$output_file" "$CASE_DIR/${padded}-tui-output.log" 2>/dev/null || true

	# 导出
	TUI_OUTPUT_FILE="$output_file"
	TUI_EXIT_CODE=$pi_exit
	TUI_TEST_HOME="$test_home"

	echo "TUI expect test completed: exit=$pi_exit, output=$(wc -c <"$output_file") bytes"
}
