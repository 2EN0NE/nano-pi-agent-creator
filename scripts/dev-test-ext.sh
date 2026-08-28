#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# dev-test-ext.sh — 生成「pi -ne -e <扩展>」单扩展隔离验证命令
#
# 用途：在 worktree 下单独验证改动的扩展，绕过 .pi 软链接与扩展自动发现。
#   - `-ne` 禁用扩展自动发现（不加载 .pi/extensions 与 ~/.pi/agent/extensions）
#   - `-e`  显式加载指定扩展（支持单文件 xxx.ts 与目录 xxx/index.ts）
#   - 自动附加 pi-logger 扩展，使日志捕获（__lifecycle__）生效
#
# 用法：
#   bash scripts/dev-test-ext.sh <扩展名>                 # 单插件 dry-run：打印命令
#   bash scripts/dev-test-ext.sh <扩展名> --run           # 单插件执行（TUI 交互模式）
#   bash scripts/dev-test-ext.sh <扩展名> --run -- -p "hi"  # 传额外 pi 参数
#   bash scripts/dev-test-ext.sh --changed                # 批量：一次性生成所有 git 变动插件的命令
#
# 示例：
#   bash scripts/dev-test-ext.sh --changed                # 本次所有变动插件的 UAT 命令
#   bash scripts/dev-test-ext.sh answer --run
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── 工具函数：扩展名 → 源路径（单文件 xxx.ts 优先，其次目录 xxx/index.ts）──
# maxdepth 2 限定到「extensions/<分类>/<名字>」层，避免误匹配插件内部同名子文件
# 函数以最后一条 `[ -n "$f" ]` 的退出码作为「是否找到」的返回值。
resolve_path() {
	local n="$1"
	local f=""
	local hit
	hit="$(find extensions -maxdepth 2 -type f -name "$n.ts" -not -path '*/node_modules/*' 2>/dev/null | head -1)"
	if [ -n "$hit" ]; then
		f="$hit"
	else
		hit="$(find extensions -maxdepth 2 -type d -name "$n" -not -path '*/node_modules/*' 2>/dev/null | head -1)"
		if [ -n "$hit" ] && [ -f "$hit/index.ts" ]; then
			f="$hit/index.ts"
		fi
	fi
	echo "$f"
	[ -n "$f" ]
}

# ── 工具函数：组装 pi 参数（绝对路径 + 附加 pi-logger）──
build_args() {
	local ext_path="$1"
	local args=(-ne -e "$ROOT_DIR/$ext_path")
	if [ "$ext_path" != "extensions/meta/pi-logger/index.ts" ]; then
		args+=(-e "$ROOT_DIR/extensions/meta/pi-logger/index.ts")
	fi
	echo "${args[*]}"
}

# ── 批量模式：一条命令加载所有 git 变动的插件 ──
if [ "${1:-}" = "--changed" ]; then
	shift
	changed="$(git status --short 2>/dev/null | grep -E '^.. +extensions/' | sed 's/^...//' | awk -F/ '{print $3}' | sed 's/\.ts$//' | sort -u)"
	if [ -z "$changed" ]; then
		echo "没有检测到 extensions/ 下的变动插件" >&2
		exit 0
	fi
	paths=()
	for n in $changed; do
		p="$(resolve_path "$n" 2>/dev/null)" || {
			echo "### $n → 解析失败（跳过）" >&2
			continue
		}
		paths+=("$ROOT_DIR/$p")
	done
	# 附加 pi-logger（去重；-ne 下它不会被自动加载）
	if [[ ! " ${paths[*]} " == *"$ROOT_DIR/extensions/meta/pi-logger/index.ts"* ]]; then
		paths+=("$ROOT_DIR/extensions/meta/pi-logger/index.ts")
	fi

	count="${#paths[@]}"
	echo "# 一条命令加载本次变动的 $count 个扩展："
	echo ""
	echo "pi -ne \\"
	last=$((${#paths[@]} - 1))
	for ((i = 0; i < ${#paths[@]}; i++)); do
		if [ "$i" -eq "$last" ]; then
			echo "  -e ${paths[$i]}"
		else
			echo "  -e ${paths[$i]} \\"
		fi
	done
	echo "  # 追加 pi 参数，如：--no-session -p \"hi\""
	echo ""
	echo "# 说明：pi -e 支持多次；上面是一条命令（多行续行），复制整段即可执行。"
	exit 0
fi

# ── 单插件模式 ──
name="${1:-}"
if [ -z "$name" ]; then
	echo "用法: $0 <扩展名> [--run] [-- <pi 额外参数>]   或   $0 --changed" >&2
	exit 1
fi
shift

run_mode=false
if [ "${1:-}" = "--run" ]; then
	run_mode=true
	shift
fi

ext_path="$(resolve_path "$name" 2>/dev/null)" || {
	echo "错误：extensions/ 下找不到扩展 '$name'（$name.ts 或 $name/index.ts）" >&2
	exit 1
}

if [ "$run_mode" = false ]; then
	echo "pi $(build_args "$ext_path")"
	echo ""
	echo "# 交互测试：复制上面命令执行，或加 --run 直接跑"
	echo "# 传额外参数：bash scripts/dev-test-ext.sh $name --run -- -p \"hi\""
	exit 0
fi

# ── 执行（透传 -- 之后的额外 pi 参数；用数组避免 word splitting）──
if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then
	shift
fi
args=(-ne -e "$ROOT_DIR/$ext_path")
if [ "$ext_path" != "extensions/meta/pi-logger/index.ts" ]; then
	args+=(-e "$ROOT_DIR/extensions/meta/pi-logger/index.ts")
fi
exec pi "${args[@]}" "$@"
