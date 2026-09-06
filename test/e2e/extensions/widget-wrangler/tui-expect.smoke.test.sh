#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# widget-wrangler — status「|」前缀补齐的 TUI e2e 测试
#
# 验证：外部扩展（external-status 辅助扩展模拟 pi-lens 等 npm 包）在
# session_start 里设置的**不带 | 前缀**的 footer status，
# widget-wrangler 的中间人层会自动补齐 `|` 前缀。
#
# 依赖：test/e2e/helpers/external-status.ts（测试辅助扩展）
# ──────────────────────────────────────────────────────────────────────────────

test_describe "widget-wrangler status | prefix"

test_it "外部 status 被补齐竖线前缀" <<'TEST'
	# 准备 widget-wrangler（源码 + bridge index.ts）到 preset_home_dir
	# （tui_expect_test 的 tui_copy_extensions 只 cp -r 源码，不生成 bridge；
	#  而 _widget-wrangler 是 package.json pi.extensions→dist 的目录扩展，
	#  auto-discovery 需要根 index.ts 作为入口。）
	local preset="$ROOT_DIR/.pi/tmp/wr-preset-$$-$RANDOM"
	mkdir -p "$preset/.pi/agent/extensions"
	cp -r "$ROOT_DIR/extensions/meta/_widget-wrangler" "$preset/.pi/agent/extensions/_widget-wrangler"
	cat >"$preset/.pi/agent/extensions/_widget-wrangler/index.ts" <<'EOF'
export { default } from "./src/index.ts";
EOF

	# 加载 external-status（模拟外部组件）+ mock-llm；widget-wrangler 通过 preset 注入
	tui_expect_test "external-status,mock-llm" '
		sleep 3
	' 30 80 "" "$preset"

	if tui_output_contains "$TUI_OUTPUT_FILE" "|external-no-pipe"; then
		echo "PASS: external status 带 | 前缀"
	elif tui_output_contains "$TUI_OUTPUT_FILE" "external-no-pipe"; then
		echo "FAIL: external status 未带 | 前缀（widget-wrangler 未补齐）"
		exit 1
	else
		echo "FAIL: external status 未出现在 footer"
		exit 1
	fi
	tui_cleanup
	rm -rf "$preset"
TEST
