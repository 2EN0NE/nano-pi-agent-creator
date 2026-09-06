# ──────────────────────────────────────────────────────────────────────────────
# pi-lab 实验沙箱 — 供消费方扩展（tools/preset 等）的实验 e2e 用例
# 复用的手动沙箱构造器。
#
# 背景：run_pi_and_check 不建立 node_modules/@zenone 链接，且不写入消费方
# 的 extensions-data 配置（如 preset config），无法验证 record 型实验的
# 「注册 + 结算」链路。故实验用例走手动沙箱模式（参考 pi-rate-limiter）。
#
# 用法：
#   setup_lab_sandbox <test_home>      # 拷贝 pi-lab + 依赖 + mock-llm + src/tui
#   # 之后由调用方自行拷贝目标扩展 + 写入 extensions-data 配置
# ──────────────────────────────────────────────────────────────────────────────

# 拷贝 pi-lab 实验基础设施（pi-lab + pi-logger + pi-config + pi-session-tree
# + mock-llm + node_modules/@zenone 链接 + src/tui）。
setup_lab_sandbox() {
	local test_home="$1"
	mkdir -p \
		"$test_home/home/.pi/agent/extensions" \
		"$test_home/.pi/extensions" \
		"$test_home/.pi/logs" \
		"$test_home/src"
	cp -r "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/.pi/extensions/pi-logger"
	cp -r "$ROOT_DIR/extensions/meta/pi-lab" "$test_home/.pi/extensions/pi-lab"
	cp -r "$ROOT_DIR/extensions/meta/pi-config" "$test_home/.pi/extensions/pi-config"
	cp -r "$ROOT_DIR/extensions/meta/pi-session-tree" "$test_home/.pi/extensions/pi-session-tree"
	mkdir -p "$test_home/.pi/extensions/mock-llm"
	cp "$ROOT_DIR/test/e2e/helpers/mock-llm.ts" "$test_home/.pi/extensions/mock-llm/index.ts"
	mkdir -p "$test_home/node_modules/@zenone"
	for pkg in pi-logger pi-config pi-session-tree; do
		ln -sf "$ROOT_DIR/extensions/meta/$pkg" "$test_home/node_modules/@zenone/$pkg"
	done
	cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
	cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json" 2>/dev/null
}

# 在实验沙箱内运行一次 pi（print 模式），返回退出码。
# 用法：run_lab_pi <test_home> <slug> <prompt>
run_lab_pi() {
	local test_home="$1"
	local slug="$2"
	local prompt="${3:-hi}"
	cd "$test_home"
	set +e
	HOME="$test_home/home" pi -a --no-session -p "$prompt" \
		>"$ROOT_DIR/.pi/tmp/${slug}-stdout.log" 2>&1
	local ec=$?
	set -e
	cd "$ROOT_DIR"
	echo "pi exit: $ec"
	return "$ec"
}
