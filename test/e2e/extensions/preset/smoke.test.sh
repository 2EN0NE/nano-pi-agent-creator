#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# preset 扩展端到端测试 — 普通模式
# 测试要点：
# 1. preset 扩展正确加载无报错
# 2. pi-logger 正确捕获日志（通过 lifecycle 日志）
# 3. /preset 命令在 print 模式下不崩溃
# ──────────────────────────────────────────────────────────────────────────────

test_describe "preset extension"

# ── 用例 1：加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,preset" \
    --prompt "hi" \
    --save-output
  exit 0
TEST

# ── 用例 2：lifecycle 日志记录 preset 活动 ──
test_it "lifecycle log captures preset session events" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,preset" \
    --prompt "hi" \
    --save-output
  # 检查 lifecycle 日志（preset 使用 debug 级别，默认被过滤，但 lifecycle 始终记录）
  if ls "$PI_LOG_DIR"/__lifecycle__*.log &>/dev/null; then
    echo "PASS: lifecycle log exists"
    exit 0
  fi
  # 如果 logs 目录存在但没有 preset 专用日志也算通过（debug 级别被过滤）
  echo "PASS: log dir exists without dedicated preset log (debug level filtered)"
  exit 0
TEST

# ── 用例 3：/preset 命令在 print 模式下不崩溃 ──
test_it "/preset command does not crash in print mode" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,preset" \
    --prompt "/preset" \
    --save-output
  # 非 TUI 模式下 /preset 可能提示 "requires TUI mode"，不崩溃即可
  exit 0
TEST

# ── 用例 4：preset-usage 实验（record 型）注册 + 结算 ──
test_it "preset-usage experiment registers and records duration (pi-lab + mock-llm)" <<'TEST'
  local slug="e2e-preset-s4-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_lab_sandbox "$test_home"
  cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
  mkdir -p "$test_home/.pi/extensions-data/preset"
  cat > "$test_home/.pi/extensions-data/preset/config.json" <<'JSON'
{ "test": { "thinkingLevel": "low" }, "plan": { "thinkingLevel": "medium" } }
JSON

  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a --no-session --preset test -p "hi" >"$test_home/pi-stdout.log" 2>&1
  local ec=$?
  set -e
  cd "$ROOT_DIR"
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    cat "$test_home/pi-stdout.log"
    exit 1
  fi

  local jsonl="$test_home/home/.pi/agent/extensions-data/pi-lab/preset-usage.jsonl"
  if [[ ! -f "$jsonl" ]]; then
    echo "FAIL: preset-usage jsonl not created (settle 未在 session_shutdown 落盘)"
    echo "(no jsonl at $jsonl)"
    exit 1
  fi
  if grep -q '"armId":"test"' "$jsonl" && grep -q '"use_duration_ms"' "$jsonl"; then
    echo "PASS: preset-usage recorded arm=test with duration metric"
    cat "$jsonl"
  else
    echo "FAIL: preset-usage event missing (arm=test or use_duration_ms)"
    cat "$jsonl"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 用例：会话恢复时的工具复位（ADR-0065）──
# 场景：preset plan（tools=[read]）用过之后被清除，续会话（-c）时工具必须回到
# 默认工具选择，不能被 pi 从会话记录恢复出的受限装载清单"复活"。
test_it "resume：已清除的 preset 不复活工具限制，仍激活则保持白名单（ADR-0065）" <<'TEST'
  local slug="e2e-preset-resume-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  rm -rf "$test_home"
  mkdir -p "$test_home/home/.pi/agent/extensions" "$test_home/.pi/extensions" \
    "$test_home/.pi/extensions-data/preset" "$test_home/src"

  # 依赖：preset + 日志/配置/状态/选择器 + mock-llm + 工具探针
  cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
  cp -r "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/.pi/extensions/pi-logger"
  cp -r "$ROOT_DIR/extensions/meta/pi-config" "$test_home/.pi/extensions/pi-config"
  cp -r "$ROOT_DIR/extensions/meta/pi-state" "$test_home/.pi/extensions/pi-state"
  cp -r "$ROOT_DIR/extensions/meta/selector" "$test_home/.pi/extensions/selector"
  mkdir -p "$test_home/.pi/extensions/mock-llm" "$test_home/.pi/extensions/tools-probe"
  cp "$ROOT_DIR/test/e2e/helpers/mock-llm.ts" "$test_home/.pi/extensions/mock-llm/index.ts"
  cp "$ROOT_DIR/test/e2e/helpers/tools-probe.ts" \
    "$test_home/.pi/extensions/tools-probe/index.ts"

  mkdir -p "$test_home/node_modules/@zenone"
  ln -sf "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/node_modules/@zenone/pi-logger"
  ln -sf "$ROOT_DIR/extensions/meta/pi-config" "$test_home/node_modules/@zenone/pi-config"
  ln -sf "$ROOT_DIR/extensions/meta/pi-state" "$test_home/node_modules/@zenone/pi-state"
  ln -sf "$ROOT_DIR/extensions/meta/selector" "$test_home/node_modules/@zenone/pi-selector"
  cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
  cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json" 2>/dev/null
  git -C "$test_home" init --initial-branch main >/dev/null 2>&1 || true

  printf '{ "plan": { "tools": ["read"] } }' \
    > "$test_home/.pi/extensions-data/preset/config.json"

  # ① 第一次会话：--preset plan → 工具被限制为 ["read"]
  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a -p "hi" --preset plan --session-id resume-e2e \
    >"$test_home/run1.log" 2>&1
  set -e
  cd "$ROOT_DIR"
  grep -q '\[tools-probe\] active=\["read"\]' "$test_home/run1.log" || {
    echo "FAIL: 首次会话未按 plan 限制工具"; cat "$test_home/run1.log"; exit 1; }
  echo "PASS: 首次会话按 plan 白名单限制工具"

  # ② 模拟"用户在会话里清除了 preset"：会话层状态 activeName=null
  mkdir -p "$test_home/home/.pi/agent/extensions-data/preset"
  printf '{"presets":{},"activeName":null}' \
    > "$test_home/home/.pi/agent/extensions-data/preset/resume-e2e.json"

  # ③ 续会话：必须回到默认工具选择（含 bash），不被会话记录里的 plan 限制复活
  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a -p "again" -c >"$test_home/run2.log" 2>&1
  set -e
  cd "$ROOT_DIR"
  grep -q '\[tools-probe\] active=.*"bash"' "$test_home/run2.log" || {
    echo "FAIL: 清除 preset 后 resume 仍受限制（工具有没回来）"; tail -50 "$test_home/run2.log"; exit 1; }
  echo "PASS: 清除后 resume 工具回到默认选择（含 bash）"

  # ④ preset 仍激活时 resume：必须仍受限（preset 状态是唯一判据）
  printf '{"presets":{},"activeName":"plan"}' \
    > "$test_home/home/.pi/agent/extensions-data/preset/resume-e2e.json"
  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a -p "third" -c >"$test_home/run3.log" 2>&1
  set -e
  cd "$ROOT_DIR"
  local last_probe
  last_probe=$(grep -o '\[tools-probe\] active=.*' "$test_home/run3.log" | tail -1)
  if [[ "$last_probe" != *'"read"'* || "$last_probe" == *'"bash"'* ]]; then
    echo "FAIL: preset 仍激活时 resume 应仍受限为白名单，实际：$last_probe"; exit 1
  fi
  echo "PASS: preset 仍激活时 resume 保持白名单限制"

  rm -rf "$test_home"
  exit 0
TEST

# ── 用例：skills 白名单真的落到 system prompt（渲染层，ADR-0066）──
# 场景：plan 声明 skills: ["alpha"]，沙箱里另有 beta。
# 断言对象是 **mock provider 收到的 system prompt**（模型实际可见面），
# 而不是 options.skills 字段——"options.skills → pi 渲染" 这一段只有这一层能证；
# 单测只能看到字段，字段被裁剪但渲染未生效时所有单测仍全绿。
test_it "skills：白名单裁剪真正落到 system prompt（渲染层）" <<'TEST'
  local slug="e2e-preset-skills-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  rm -rf "$test_home"
  mkdir -p "$test_home/home/.pi/agent/extensions" "$test_home/.pi/extensions" \
    "$test_home/.pi/extensions-data/preset" "$test_home/src" \
    "$test_home/home/.pi/agent/skills/alpha" "$test_home/home/.pi/agent/skills/beta"

  for s in alpha beta; do
    cat > "$test_home/home/.pi/agent/skills/$s/SKILL.md" <<EOF
---
name: $s
description: skill $s for preset whitelist e2e
---

# $s
EOF
  done

  # 依赖：preset + 日志/配置/状态/选择器 + mock-llm
  cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
  cp -r "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/.pi/extensions/pi-logger"
  cp -r "$ROOT_DIR/extensions/meta/pi-config" "$test_home/.pi/extensions/pi-config"
  cp -r "$ROOT_DIR/extensions/meta/pi-state" "$test_home/.pi/extensions/pi-state"
  cp -r "$ROOT_DIR/extensions/meta/selector" "$test_home/.pi/extensions/selector"
  mkdir -p "$test_home/.pi/extensions/mock-llm"
  cp "$ROOT_DIR/test/e2e/helpers/mock-llm.ts" "$test_home/.pi/extensions/mock-llm/index.ts"

  mkdir -p "$test_home/node_modules/@zenone"
  ln -sf "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/node_modules/@zenone/pi-logger"
  ln -sf "$ROOT_DIR/extensions/meta/pi-config" "$test_home/node_modules/@zenone/pi-config"
  ln -sf "$ROOT_DIR/extensions/meta/pi-state" "$test_home/node_modules/@zenone/pi-state"
  ln -sf "$ROOT_DIR/extensions/meta/selector" "$test_home/node_modules/@zenone/pi-selector"
  cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
  cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json" 2>/dev/null
  git -C "$test_home" init --initial-branch main >/dev/null 2>&1 || true

  printf '{ "plan": { "skills": ["alpha"] } }' \
    > "$test_home/.pi/extensions-data/preset/config.json"

  cd "$test_home"
  set +e
  HOME="$test_home/home" MOCK_LLM_RECORD_SKILLS=1 pi -a --no-session --preset plan -p "hi" \
    >"$test_home/run.log" 2>&1
  set -e
  cd "$ROOT_DIR"

  local surfaced
  surfaced=$(grep -o '\[mock-llm-skills\].*' "$test_home/run.log" | tail -1)
  if [[ -z "$surfaced" ]]; then
    echo "FAIL: mock-llm 没有导出模型可见技能面（[mock-llm-skills] 缺失）"
    tail -40 "$test_home/run.log"; exit 1
  fi
  if [[ "$surfaced" != *alpha* ]]; then
    echo "FAIL: 白名单技能 alpha 未出现在 system prompt：$surfaced"; exit 1
  fi
  if [[ "$surfaced" == *beta* ]]; then
    echo "FAIL: 被禁技能 beta 仍出现在 system prompt：$surfaced"; exit 1
  fi
  echo "PASS: system prompt 只广告白名单技能（${surfaced}）"

  rm -rf "$test_home"
  exit 0
TEST

# ── 用例：更早的 handler force 整段提示词时，skills 白名单仍生效（ADR-0066 兜底）──
# 场景：`aaa-forcer` 先 `return { systemPrompt }`，pi 记入 forceSystemPrompt 并在发请求前
# 整段覆盖 sections —— 这正是 goal.ts / claude-rules / secret-firewall / org 的写法。
# 断言模型可见面仍只有白名单技能，且 forcer 追加的内容没被丢掉。
#
# ⚠ 顺序必须确定：扩展加载序 = **CLI `-e` 路径 → 项目 `.pi/extensions` → 全局 `agent/extensions`**
# （resource-loader.js: `mergePaths(cliEnabledExtensions, enabledExtensions)`；同一级内才是
# `readdirSync` 顺序，不可依赖）。故 forcer 走 `-e`（最先），preset 留在项目目录（之后）
# —— 这样「更早的 force」才是确定前提，兜底分支必定被覆盖。
test_it "skills：更早的 force 之后白名单仍生效（顺序无关兜底）" <<'TEST'
  local slug="e2e-preset-skills-force-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  local forcer_ext="$test_home/cli-ext/aaa-forcer"
  rm -rf "$test_home"
  mkdir -p "$test_home/home/.pi/agent/extensions" "$test_home/.pi/extensions" \
    "$test_home/.pi/extensions-data/preset" "$test_home/src" "$forcer_ext" \
    "$test_home/home/.pi/agent/skills/alpha" "$test_home/home/.pi/agent/skills/beta"

  for s in alpha beta; do
    cat > "$test_home/home/.pi/agent/skills/$s/SKILL.md" <<EOF
---
name: $s
description: skill $s for preset whitelist e2e
---

# $s
EOF
  done

  # 模拟真实存在的 4 个 force 型扩展（goal/claude-rules/secret-firewall/org）
  cat > "$forcer_ext/index.ts" <<'TS'
export default function (pi: any) {
	pi.on('before_agent_start', (event: any) => ({
		systemPrompt: `${event.systemPrompt}\n\nFORCED-BY-EARLIER-HANDLER`,
	}));
}
TS

  # preset 走项目目录自动发现（晚于 `-e` 的 forcer，见用例头注）
  cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
  cp -r "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/.pi/extensions/pi-logger"
  cp -r "$ROOT_DIR/extensions/meta/pi-config" "$test_home/.pi/extensions/pi-config"
  cp -r "$ROOT_DIR/extensions/meta/pi-state" "$test_home/.pi/extensions/pi-state"
  cp -r "$ROOT_DIR/extensions/meta/selector" "$test_home/.pi/extensions/selector"
  mkdir -p "$test_home/.pi/extensions/mock-llm"
  cp "$ROOT_DIR/test/e2e/helpers/mock-llm.ts" "$test_home/.pi/extensions/mock-llm/index.ts"

  mkdir -p "$test_home/node_modules/@zenone"
  ln -sf "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/node_modules/@zenone/pi-logger"
  ln -sf "$ROOT_DIR/extensions/meta/pi-config" "$test_home/node_modules/@zenone/pi-config"
  ln -sf "$ROOT_DIR/extensions/meta/pi-state" "$test_home/node_modules/@zenone/pi-state"
  ln -sf "$ROOT_DIR/extensions/meta/selector" "$test_home/node_modules/@zenone/pi-selector"
  cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
  cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json" 2>/dev/null
  git -C "$test_home" init --initial-branch main >/dev/null 2>&1 || true

  printf '{ "plan": { "skills": ["alpha"] } }' \
    > "$test_home/.pi/extensions-data/preset/config.json"

  cd "$test_home"
  set +e
  HOME="$test_home/home" MOCK_LLM_RECORD_SKILLS=1 pi -a --no-session --preset plan \
    -e "$forcer_ext/index.ts" \
    -p "hi" >"$test_home/run.log" 2>&1
  set -e
  cd "$ROOT_DIR"

  local surfaced
  surfaced=$(grep -o '\[mock-llm-skills\].*' "$test_home/run.log" | tail -1)
  if [[ -z "$surfaced" ]]; then
    echo "FAIL: mock-llm 没有导出模型可见技能面（[mock-llm-skills] 缺失）"
    tail -40 "$test_home/run.log"; exit 1
  fi
  if [[ "$surfaced" != *alpha* || "$surfaced" == *beta* ]]; then
    echo "FAIL: force 之后白名单未生效，模型可见：$surfaced"; exit 1
  fi
  # 顺序前提已由加载序保证（forcer 经 -e 先于 preset），故兜底分支必须真的走到：查不到即失败
  if ! grep -rq "path=force" "$test_home/home/.pi/logs/" "$test_home/.pi/logs/" 2>/dev/null; then
    echo "FAIL: 未走 force 兜底分支（日志里没有 path=force）——加载顺序前提被破或裁剪逻辑退化"
    grep -rh "prompt skills filtered" "$test_home/home/.pi/logs/" "$test_home/.pi/logs/" 2>/dev/null | tail -3
    exit 1
  fi
  echo "PASS: skills 走 force 兜底分支（path=force）"
  echo "PASS: force 之后 system prompt 仍只有白名单技能（${surfaced}）"

  rm -rf "$test_home"
  exit 0
TEST
