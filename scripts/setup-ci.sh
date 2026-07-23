#!/usr/bin/env bash
# ── CI 环境初始化脚本 ──
# 用法: bash scripts/setup-ci.sh
# 在 GitHub Actions 中运行 `npm ci` 后执行。
#
# 注意：@zenone 本地包（pi-logger、pi-config）已通过 package.json 的 file: 协议
# 在 npm ci 阶段安装在项目 node_modules/@zenone/ 下。
# 当 pi 从项目目录内运行时，jiti 通过向上遍历 node_modules 即可解析这些包，
# 无需额外链接到全局 pi 目录。

set -euo pipefail

echo "═══════════════════════════════════════════════"
echo "  CI Environment Setup"
echo "  Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════"

# ── 1. 版本与信息 ──
echo "node: $(node -v)"
echo "npm:  $(npm -v)"
echo "cwd:  $(pwd)"
echo "arch: $(uname -m)"

# ── 2. 验证项目 node_modules/@zenone ──
echo ""
echo "--- Verifying @zenone local packages ---"
for pkg in pi-logger pi-config; do
	target="node_modules/@zenone/$pkg"
	if [[ -d "$target" ]]; then
		echo "  $target: OK (resolved via npm ci file: protocol)"
	else
		echo "  WARNING: $target not found (some extensions may fail)"
	fi
done

# ── 3. 重建原生模块（node-pty） ──
echo ""
echo "--- Rebuilding native modules ---"
if npm rebuild node-pty 2>&1; then
	echo "  node-pty: rebuild OK"
	node -e "require('node-pty'); console.log('  node-pty: verified OK')" 2>/dev/null ||
		echo "  node-pty: rebuild reported OK but verification failed"
else
	echo "  WARNING: node-pty rebuild failed (TUI tests will use describe.skip)"
fi

# ── 4. 安装 pi 全局 ──
echo ""
echo "--- Installing pi globally ---"
PIPELINE="${PIPELINE:-latest}"
npm install -g "@earendil-works/pi-coding-agent@$PIPELINE"
echo "  pi bin: $(which pi)"
echo "  pi pkg: $(readlink -f "$(which pi)" | xargs dirname | xargs dirname)"

# ── 5. 链接 @zenone 到全局 pi（兼容 pi 在项目外运行） ──
# 非必要：大部分 e2e 测试在项目目录内运行，jiti 通过向上遍历
# node_modules/@zenone/ 即可解析。但有些场景（如 tui 测试启动
# 独立 pi 进程 HOME 被隔离），可能找不到项目 node_modules。
# 用 readlink -f 替代 require.resolve，避免 package exports 字段限制。
echo ""
echo "--- Linking @zenone to global pi (belt-and-suspenders) ---"
PI_PKG="$(dirname "$(dirname "$(readlink -f "$(which pi)")")")"
PI_ZENONE="$PI_PKG/node_modules/@zenone"
mkdir -p "$PI_ZENONE"
ln -sf "$PWD/node_modules/@zenone/pi-logger" "$PI_ZENONE/pi-logger" 2>/dev/null ||
	ln -sf "$PWD/extensions/meta/pi-logger" "$PI_ZENONE/pi-logger"
ln -sf "$PWD/node_modules/@zenone/pi-config" "$PI_ZENONE/pi-config" 2>/dev/null ||
	ln -sf "$PWD/extensions/meta/pi-config" "$PI_ZENONE/pi-config"
echo "  linked: $(ls -la "$PI_ZENONE")"

# ── 6. 清理 ──
echo ""
echo "--- Cleaning ---"
rm -rf .pi/tmp/
mkdir -p test/results
echo "  .pi/tmp/: cleaned"
echo "  test/results/: ready"

echo ""
echo "═══════════════════════════════════════════════"
echo "  CI setup complete"
echo "═══════════════════════════════════════════════"
