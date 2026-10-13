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

# ── 1.5. git 默认分支（裸 `git init` 的测试脚本 checkout main 依赖；runner 默认可能是 master）──
echo ""
echo "--- Configuring git default branch ---"
git config --global init.defaultBranch main
echo "  init.defaultBranch: $(git config --global init.defaultBranch)"

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

# ── 3. 安装系统依赖（expect，用于 TUI expect 交互测试） ──
echo ""
echo "--- Installing system dependency: expect ---"
if command -v expect >/dev/null 2>&1; then
	echo "  expect: already present at $(command -v expect)"
elif command -v apt-get >/dev/null 2>&1; then
	if command -v sudo >/dev/null 2>&1; then
		sudo apt-get update -qq && sudo apt-get install -y -qq expect
	else
		apt-get update -qq && apt-get install -y -qq expect
	fi
	echo "  expect: installed via apt-get"
else
	echo "  WARNING: expect not found and apt-get unavailable; TUI expect tests will fail"
fi

# ── 3.5. 安装系统依赖（tmux，用于 org 多进程 e2e） ──
# org 的唤醒/自主闭环用例依赖 tmux 承载成员终端；缺 tmux 时用例会 SKIP（
# 不再计 PASS，但会以 SKIP 形式丢失覆盖），故此处必须安装并断言。
echo ""
echo "--- Installing system dependency: tmux ---"
if command -v tmux >/dev/null 2>&1; then
	echo "  tmux: already present at $(command -v tmux)"
elif command -v apt-get >/dev/null 2>&1; then
	if command -v sudo >/dev/null 2>&1; then
		sudo apt-get update -qq && sudo apt-get install -y -qq tmux
	else
		apt-get update -qq && apt-get install -y -qq tmux
	fi
	echo "  tmux: installed via apt-get"
fi
if ! command -v tmux >/dev/null 2>&1; then
	echo "  ERROR: tmux unavailable —— org 唤醒/自主闭环 e2e 将 SKIP（覆盖丢失）" >&2
	exit 1
fi
tmux -V

# ── 4. 重建原生模块（node-pty） ──
echo ""
echo "--- Rebuilding native modules ---"
if npm rebuild node-pty 2>&1; then
	echo "  node-pty: rebuild OK"
	node -e "require('node-pty'); console.log('  node-pty: verified OK')" 2>/dev/null ||
		echo "  node-pty: rebuild reported OK but verification failed"
else
	echo "  WARNING: node-pty rebuild failed (TUI tests will use describe.skip)"
fi

# ── 5. 安装 pi 全局（运行基座 = lock 里 npm ci 装出来的版本）──
# ADR-0063 决策 6：基座的**唯一来源**是 `npm ci` 装出的 node_modules 版本，全局装
# 同一版本 → 类型层（tsc 用的 devDependency）与运行层永久绑定、结果可复现。
# `PIPELINE` 从「默认 latest」降级为**显式覆盖开关**：只有探测 job 这类刻意试新版
# 的场景才设置它；主流水线不设 → 不再随 upstream 漂移。读不到版本即 fail-fast。
echo ""
echo "--- Installing pi globally ---"
SETUP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_DEV_PKG="$SETUP_ROOT/node_modules/@earendil-works/pi-coding-agent/package.json"
if [[ -n "${PIPELINE:-}" ]]; then
	PI_PKG_VERSION="$PIPELINE"
	echo "  ⚠️  PIPELINE 覆盖基座版本: ${PI_PKG_VERSION}（非 lock 版本，仅限探测/排障）"
else
	PI_PKG_VERSION="$(node -p "require('$PI_DEV_PKG').version" 2>/dev/null || true)"
	if [[ -z "$PI_PKG_VERSION" ]]; then
		echo "  ERROR: 读不到 $PI_DEV_PKG 的 version" >&2
		echo "  运行基座必须来自 npm ci 装出的 lock（ADR-0063 决策 6）；" >&2
		echo "  确要刻意指定版本，请显式设置 PIPELINE=<版本>。" >&2
		exit 1
	fi
fi
npm install -g "@earendil-works/pi-coding-agent@$PI_PKG_VERSION"
echo "  pi bin:  $(which pi)"
echo "  pi pkg:  $(readlink -f "$(which pi)" | xargs dirname | xargs dirname)"
echo "  pi version: $(pi --version 2>/dev/null || echo unknown)  (base=$PI_PKG_VERSION)"

# ── 6. 链接 @zenone 到全局 pi（兼容 pi 在项目外运行） ──
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

# ── 7. 清理 ──
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
