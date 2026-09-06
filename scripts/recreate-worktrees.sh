#!/usr/bin/env bash
# =============================================================================
# recreate-worktrees.sh — 一键清空并重建 extensions 子类的 worktree
#
# 用法:
#   bash scripts/recreate-worktrees.sh            # 重建全部 6 个 worktree
#   bash scripts/recreate-worktrees.sh context    # 仅重建某一个
#   bash scripts/recreate-worktrees.sh --list     # 仅列出映射，不执行
#   bash scripts/recreate-worktrees.sh --force    # 跳过未提交改动检查，强制清空
#
# 说明:
#   - 每个 worktree 从当前 dev 分支拉出，对应 extensions 的一个子类
#   - 清空 = git worktree remove + git branch -D（未提交改动默认会中止）
#   - 分支有相对 dev 未合并的提交时会警告（这些提交将丢失）
#
# 兼容: macOS bash 3.2（set -u 下变量一律 ${VAR} 花括号界定）
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_ROOT="${REPO_ROOT}-worktrees"
BASE_BRANCH="${BASE_BRANCH:-dev}"

# worktree 名 -> 对应 extensions 子类的映射（顺序即重建顺序）
declare -a NAMES=(bugfix context observability security tool verification)
declare -a DESCS=(
	'跨类 bug 修复'
	'extensions/context'
	'extensions/observability'
	'extensions/security'
	'extensions/accuracy'
	'extensions/verification'
)

FORCE=0
TARGET=""
LIST_ONLY=0

for arg in "$@"; do
	case "$arg" in
	--force) FORCE=1 ;;
	--list) LIST_ONLY=1 ;;
	-*)
		echo "未知参数: $arg" >&2
		exit 2
		;;
	*) TARGET="$arg" ;;
	esac
done

list_names() {
	printf '%-14s %-18s %s\n' 'worktree' '分支' '对应'
	for i in "${!NAMES[@]}"; do
		printf '%-14s %-18s %s\n' "${NAMES[$i]}" "wt/${NAMES[$i]}" "${DESCS[$i]}"
	done
}

if [ "$LIST_ONLY" -eq 1 ]; then
	list_names
	exit 0
fi

# 校验目标分支存在
if ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/${BASE_BRANCH}"; then
	echo "✗ 基础分支 ${BASE_BRANCH} 不存在" >&2
	exit 1
fi

recreate_one() {
	local name="$1"
	local dir="${WORKTREE_ROOT}/${name}"
	local branch="wt/${name}"

	echo ""
	echo "── ${name} ──"

	# 1. 检查未提交改动（仅当目录存在时）
	if [ -d "$dir" ]; then
		local dirty
		dirty="$(git -C "$dir" status --porcelain 2>/dev/null | head -1)"
		if [ -n "$dirty" ] && [ "$FORCE" -ne 1 ]; then
			echo "✗ ${name}: 有未提交改动，跳过（用 --force 强制清空）" >&2
			return 1
		fi
	fi

	# 2. 警告相对 dev 未合并的提交（这些将丢失）
	if git show-ref --verify --quiet "refs/heads/${branch}"; then
		local unpushed
		unpushed="$(git -C "$REPO_ROOT" log --oneline "${BASE_BRANCH}..${branch}" 2>/dev/null)"
		if [ -n "$unpushed" ]; then
			echo "⚠ ${branch} 有相对 ${BASE_BRANCH} 未合并的提交，将丢失:"
			echo "$unpushed" | sed 's/^/    /'
		fi
	fi

	# 3. 移除 worktree
	if [ -d "$dir" ]; then
		git -C "$REPO_ROOT" worktree remove --force "$dir"
		echo "  已移除 worktree: ${dir}"
	fi

	# 4. 删除分支
	if git show-ref --verify --quiet "refs/heads/${branch}"; then
		git -C "$REPO_ROOT" branch -D "$branch"
		echo "  已删除分支: ${branch}"
	fi

	# 5. 从基础分支重建
	git -C "$REPO_ROOT" worktree add -b "$branch" "$dir" "$BASE_BRANCH" >/dev/null
	echo "✓ 已从 ${BASE_BRANCH} 重建: ${branch} -> ${dir}"
}

if [ -n "$TARGET" ]; then
	# 校验目标在映射内
	found=0
	for n in "${NAMES[@]}"; do
		if [ "$n" = "$TARGET" ]; then
			found=1
			break
		fi
	done
	if [ "$found" -eq 0 ]; then
		echo "✗ 未知 worktree: ${TARGET}" >&2
		list_names >&2
		exit 2
	fi
	recreate_one "$TARGET"
else
	list_names
	for n in "${NAMES[@]}"; do
		recreate_one "$n" || echo "⚠ ${n} 重建失败或已跳过"
	done
fi

echo ""
echo "完成。worktree 列表:"
git -C "$REPO_ROOT" worktree list
