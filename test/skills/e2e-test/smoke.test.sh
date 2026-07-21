#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# e2e-test 技能的端到端自举测试
# ──────────────────────────────────────────────────────────────────────────────

test_describe "e2e-test skill"

# ── 用例 1：技能目录结构正确 ──
test_it "skill directory has SKILL.md" <<'TEST'
  if find "$ROOT_DIR/skills" -name 'SKILL.md' -path '*/e2e-test/SKILL.md' | grep -q .; then
    exit 0
  else
    echo "SKILL.md not found for e2e-test skill (looked in skills/*/e2e-test/)"
    exit 1
  fi
TEST

# ── 用例 2：run-e2e.sh 可执行 ──
test_it "run-e2e.sh is executable" <<'TEST'
  if [[ -x "$ROOT_DIR/test/scripts/run-e2e.sh" ]]; then
    exit 0
  else
    echo "run-e2e.sh is not executable"
    exit 1
  fi
TEST

# ── 用例 3：测试目录结构完整 ──
test_it "test infrastructure directories exist" <<'TEST'
  missing=""
  [[ -d "$ROOT_DIR/test/extensions" ]] || missing="$missing test/extensions"
  [[ -d "$ROOT_DIR/test/skills" ]]     || missing="$missing test/skills"
  [[ -d "$ROOT_DIR/test/scripts" ]]    || missing="$missing test/scripts"
  [[ -d "$ROOT_DIR/test/results" ]]    || missing="$missing test/results"
  if [[ -n "$missing" ]]; then
    echo "Missing directories:$missing"
    exit 1
  fi
  exit 0
TEST

# ── 用例 4：run-e2e.sh --help 输出帮助 ──
test_it "run-e2e.sh --help prints usage" <<'TEST'
  output=$(bash "$ROOT_DIR/test/scripts/run-e2e.sh" --help 2>&1 || true)
  if echo "$output" | grep -q "Usage"; then
    exit 0
  else
    echo "Expected 'Usage' in --help output"
    echo "Got: $output"
    exit 1
  fi
TEST

# ── 用例 5：AGENTS.md 引用了 e2e-test skill（需 AI 衡量） ──
test_it "AGENTS.md references e2e-test skill [REVIEW]" <<'TEST'
  run_pi_and_check \
    --prompt "show me the content of AGENTS.md" \
    --save-output || true
  mark_for_review "验证 AGENTS.md 中是否包含对 e2e-test 技能或 test/ 目录的引用说明"
TEST
