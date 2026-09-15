#!/usr/bin/env bash
# 解析插件名 → 扩展入口路径。
#
# 从 run-cell.sh 的 find_extension 抽出（ADR-0057 后果），使 preflight.sh 的臂校验能复用
# 同一份解析规则，而不是各写一份（两份必然漂移）。
#
# 用法：find-extension.sh <name>
#   stdout: 解析到的路径（找不到时为空）
#   exit:   0 找到 / 1 未找到
set -u
BENCH="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$BENCH/.." && pwd)"
NAME="${1:-}"
[[ -n "$NAME" ]] || {
	echo "用法: find-extension.sh <name>" >&2
	exit 1
}

# 1. 目录形式 extensions/<分类>/<name>/index.ts
found=$(find "$REPO_ROOT/extensions" -maxdepth 3 -type d -name "$NAME" -exec test -f '{}/index.ts' \; -print -quit 2>/dev/null)
[[ -n "$found" ]] && {
	echo "$found"
	exit 0
}

# 2. 单文件形式 extensions/<分类>/<name>.ts
found=$(find "$REPO_ROOT/extensions" -maxdepth 3 -type f -name "$NAME.ts" -print -quit 2>/dev/null)
[[ -n "$found" ]] && {
	echo "$found"
	exit 0
}

# 3. test helpers（mock-llm 等）
for helper in "$REPO_ROOT/test/helpers/$NAME.ts" "$REPO_ROOT/test/e2e/helpers/$NAME.ts"; do
	[[ -f "$helper" ]] && {
		echo "$helper"
		exit 0
	}
done

# 4. npm 安装的插件（~/.pi/agent/npm/node_modules/<包名>，读 package.json 的 pi.extensions 入口）
NPM_NM="${HOME}/.pi/agent/npm/node_modules"
if [[ -f "$NPM_NM/$NAME/package.json" ]]; then
	entry=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
exts = (d.get('pi') or {}).get('extensions') or []
print(exts[0] if exts else '')
" "$NPM_NM/$NAME/package.json" 2>/dev/null)
	if [[ -n "$entry" ]]; then
		entry="${entry#./}"
		if [[ "$entry" = /* ]]; then
			echo "$entry"
		else
			echo "$NPM_NM/$NAME/$entry"
		fi
		exit 0
	fi
fi

exit 1
