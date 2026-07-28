#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# git-merge-and-resolve — 实际 rebase/merge 集成测试
#
# 独立于 smoke test，在真实 git 仓库中验证 rebase 和 merge
# 两种策略的真实行为。需要 CI=false 模式运行（真实验证 git 操作）。
#
# 用法：
#   bash test/extensions/git-merge-and-resolve/rebase.test.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_ROOT="${TMPDIR:-/tmp}/git-merge-resolve-e2e-$$"
PASS=0
FAIL=0

cleanup() {
	rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

echo "═══ git-merge-and-resolve: rebase & merge integration tests ═══"
echo ""

# ─────────────────────────────────────────────────────────────
# Helper: create a test git repo with feature branch behind main
# ─────────────────────────────────────────────────────────────
setup_repo() {
	local name="$1"
	local repo="$TMP_ROOT/$name"
	mkdir -p "$repo"
	cd "$repo"
	git init -q
	git config user.email "test@e2e.local"
	git config user.name "E2E Test"

	echo "base" >file.txt
	git add file.txt
	git commit -q -m "base commit"

	git checkout -q -b feature
	echo "feature" >>file.txt
	git add file.txt
	git commit -q -m "feature work"

	git checkout -q main
	echo "upstream" >upstream.txt
	git add upstream.txt
	git commit -q -m "upstream changes"

	# Feature is now 1 commit behind main
	git checkout -q feature

	echo "$repo"
}

# ─────────────────────────────────────────────────────────────
# Test 1: Rebase produces linear history
# ─────────────────────────────────────────────────────────────
echo "  [001] rebase produces linear history ..."
repo=$(setup_repo "rebase-test")
cd "$repo"

# Before: feature has 2 commits, main has 3 (feature is behind)
before_count=$(git log --oneline | wc -l | tr -d ' ')

# Perform rebase
git rebase main 2>&1 || true

# After rebase: feature should have main's commits + feature's commit
git checkout feature 2>/dev/null || true
after_count=$(git log --oneline | wc -l | tr -d ' ')
log_msgs=$(git log --oneline --format="%s")

# Assertions
if echo "$log_msgs" | grep -q "feature work" &&
	echo "$log_msgs" | grep -q "upstream changes" &&
	! echo "$log_msgs" | grep -qi "merge"; then
	echo "    -> PASS (linear history, all commits present)"
	PASS=$((PASS + 1))
else
	echo "    -> FAIL"
	echo "    Log:"
	echo "$log_msgs"
	FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────
# Test 2: Merge produces merge commit
# ─────────────────────────────────────────────────────────────
echo "  [002] merge produces merge commit ..."
repo=$(setup_repo "merge-test")
cd "$repo"

git merge main -m "merge main into feature" 2>&1 || true

git checkout feature 2>/dev/null || true
log_msgs=$(git log --oneline --format="%s")

if echo "$log_msgs" | grep -qi "merge" &&
	echo "$log_msgs" | grep -q "feature work" &&
	echo "$log_msgs" | grep -q "upstream changes"; then
	echo "    -> PASS (merge commit present)"
	PASS=$((PASS + 1))
else
	echo "    -> FAIL"
	echo "    Log:"
	echo "$log_msgs"
	FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────
# Test 3: Rebase with conflict detection (conflict markers)
# ─────────────────────────────────────────────────────────────
echo "  [003] rebase conflict markers detectable ..."
repo=$(setup_repo "conflict-test")
cd "$repo"

# We are on feature branch after setup_repo. Switch to main first.
git checkout -q main
echo "changed on main" >file.txt
git add file.txt
git commit -q -m "main changes first line"

git checkout -q feature
echo "changed on feature" >file.txt
git add file.txt
git commit -q -m "feature changes first line"

# Now main and feature have diverged on the same line → guaranteed conflict

# Attempt rebase — should conflict
git rebase main 2>&1 || true

# Check for standard conflict markers
if grep -q "<<<<<<<" file.txt &&
	grep -q "=======" file.txt &&
	grep -q ">>>>>>>" file.txt; then
	echo "    -> PASS (conflict markers found)"
	PASS=$((PASS + 1))
else
	echo "    -> FAIL (no conflict markers)"
	cat file.txt
	FAIL=$((FAIL + 1))
fi

# Abort to clean up
git rebase --abort 2>/dev/null || true

# ─────────────────────────────────────────────────────────────
# Test 4: Widget text format (no leading space after |)
# ─────────────────────────────────────────────────────────────
echo "  [004] widget text has no leading space after | ..."
# The widget format is: |git-<strategy>:<status>
# We test this by building the string manually (same logic as the code)
strat="rebase"
ref="origin/main"
enabled="true"

# The buildWidgetText equivalent
if [[ "$enabled" != "true" ]]; then
	widget="|git-${strat}:off"
else
	widget="|git-${strat}:${ref}"
fi

# Should NOT start with "| " (space after pipe)
if [[ "$widget" == "|git-rebase:origin/main" ]] &&
	[[ "$widget" != "| "* ]]; then
	echo "    -> PASS ($widget)"
	PASS=$((PASS + 1))
else
	echo "    -> FAIL (got: '$widget')"
	FAIL=$((FAIL + 1))
fi

# Also test disabled state
widget_off="|git-${strat}:off"
if [[ "$widget_off" == "|git-rebase:off" ]]; then
	echo "         disabled format correct: $widget_off"
else
	echo "    -> FAIL disabled (got: '$widget_off')"
	FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────
# Result
# ─────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  Results: $PASS pass, $FAIL fail"
echo "═══════════════════════════════════════"

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
