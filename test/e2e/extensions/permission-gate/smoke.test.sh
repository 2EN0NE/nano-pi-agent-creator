#!/usr/bin/env bash
#
# smoke.test.sh — permission-gate 动态策略 e2e 测试
#
# 使用 mock-llm 辅助扩展（test/extensions/permission-gate/helpers/mock-llm.ts）
# 来模拟 LLM 生成危险 bash 命令（rm -rf），无需真实 API Key。
#
# 关键设计：
#   - mock-llm 默认回复包含 fauxToolCall('bash', { command: 'rm -rf /tmp/...' })
#   - 触发 permission-gate 的 ToolCallEvent 拦截
#   - 在 no-UI 模式下，dynamic policy auto-approve 放行，否则 block
#
# 运行：
#   bash test/e2e/scripts/run-e2e.sh --ext permission-gate
#

set -euo pipefail
ROOT_DIR="${ROOT_DIR:?must be set by test runner}"

# ====================================================================
# Helper: 搭建隔离测试沙箱
# ====================================================================
setup_sandbox() {
  local test_home="$1"
  local scenario="$2"
  shift 2 || true

  local home_dir="$test_home/home"
  mkdir -p "$home_dir/.pi/agent/extensions" \
    "$test_home/.pi/extensions" \
    "$test_home/.pi/logs" \
    "$test_home/.pi/extensions-data/permission-gate"

  # 拷贝 pi-logger
  cp -r "$ROOT_DIR/extensions/meta/pi-logger" \
    "$test_home/.pi/extensions/pi-logger"

  # 拷贝 permission-gate
  cp -r "$ROOT_DIR/extensions/security/permission-gate" \
    "$test_home/.pi/extensions/permission-gate"

  # 拷贝 mock-llm（test/e2e/extensions/permission-gate/helpers/mock-llm.ts → index.ts）
  mkdir -p "$test_home/.pi/extensions/mock-llm"
  cp "$ROOT_DIR/test/e2e/extensions/permission-gate/helpers/mock-llm.ts" \
    "$test_home/.pi/extensions/mock-llm/index.ts"

  # 远端豁免场景：`--unattended-confirm` 由 selector 扩展注册（flag 的唯一注册者），
  # 再装一个「通道模拟器」在 session_start 时 arm()（ADR-0068 D4：许可 ≠ 生效）
  case "$scenario" in
  unattended_*)
    cp -r "$ROOT_DIR/extensions/meta/selector" \
      "$test_home/.pi/extensions/selector"
    mkdir -p "$test_home/.pi/extensions/arm-channel"
    cp "$ROOT_DIR/test/e2e/extensions/permission-gate/helpers/arm-channel.ts" \
      "$test_home/.pi/extensions/arm-channel/index.ts"
    ;;
  esac

  # pi-logger 配置
  if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
    cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" \
      "$test_home/.pi/pi-logger.json"
  fi

  # node_modules 本地包链接（pi-logger / pi-config / pi-state / pi-selector）
  mkdir -p "$test_home/node_modules/@zenone"
  for pkg in pi-logger pi-config pi-state; do
    local src_dir="$ROOT_DIR/extensions/meta/$pkg"
    if [[ -d "$src_dir" ]] && [[ ! -e "$test_home/node_modules/@zenone/$pkg" ]]; then
      ln -sf "$src_dir" "$test_home/node_modules/@zenone/$pkg"
    fi
  done
  # pi-selector 目录名是 selector（包名 pi-selector）
  if [[ -d "$ROOT_DIR/extensions/meta/selector" ]] &&
    [[ ! -e "$test_home/node_modules/@zenone/pi-selector" ]]; then
    ln -sf "$ROOT_DIR/extensions/meta/selector" \
      "$test_home/node_modules/@zenone/pi-selector"
  fi

  # tree-sitter npm 依赖（bash-parser 动态 import + WASM 解析）
  for pkg in web-tree-sitter tree-sitter-bash; do
    if [[ -d "$ROOT_DIR/node_modules/$pkg" ]] && [[ ! -e "$test_home/node_modules/$pkg" ]]; then
      ln -sf "$ROOT_DIR/node_modules/$pkg" "$test_home/node_modules/$pkg"
    fi
  done

  # 拷贝共享 TUI 辅助模块（src/tui/），供 import '../../../src/tui/helpers.js' 的扩展在沙箱内解析
  if [[ -d "$ROOT_DIR/src/tui" ]]; then
    mkdir -p "$test_home/src"
    cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
  fi

  # 初始化 git
  if ! git -C "$test_home" rev-parse --git-dir &>/dev/null; then
    git -C "$test_home" init --initial-branch main &>/dev/null || true
  fi

  # 写入项目级 permission-gate 配置（场景不同，配置不同）
  write_config "$test_home" "$scenario"
}

write_config() {
  local test_home="$1"
  local scenario="$2"
  local config_file="$test_home/.pi/extensions-data/permission-gate/config.json"

  case "$scenario" in
  auto_approve)
    # 阈值足够高 → 自动放行
    cat >"$config_file" <<'JSON'
{
  "enabled": true,
  "dynamicPolicyEnabled": true,
  "dynamicPolicy": {
    "scope": ".",
    "thresholds": {
      "sameCommand": 999,
      "sameTool": 999,
      "sameFolder": 999
    }
  },
  "patterns": [
    "\\brm\\s+(-rf?|--recursive)"
  ],
  "approvalCounts": {}
}
JSON
    ;;
  threshold_exceeded)
    # 阈值 0 → 立即超限 → block（no-UI 模式）
    cat >"$config_file" <<'JSON'
{
  "enabled": true,
  "dynamicPolicyEnabled": true,
  "dynamicPolicy": {
    "scope": ".",
    "thresholds": {
      "sameCommand": 0,
      "sameTool": 0,
      "sameFolder": 0
    }
  },
  "patterns": [
    "\\brm\\s+(-rf?|--recursive)"
  ],
  "approvalCounts": {}
}
JSON
    ;;
  out_of_scope)
    # scope 指向不相关目录 → 不自动放行
    cat >"$config_file" <<'JSON'
{
  "enabled": true,
  "dynamicPolicyEnabled": true,
  "dynamicPolicy": {
    "scope": "/tmp/nonexistent-scope-for-testing",
    "thresholds": {
      "sameCommand": 999,
      "sameTool": 999,
      "sameFolder": 999
    }
  },
  "patterns": [
    "\\brm\\s+(-rf?|--recursive)"
  ],
  "approvalCounts": {}
}
JSON
    ;;
  unattended_*)
    # 远端豁免场景：动态策略关掉，保证危险命令一定走到「需要确认」这条路径，
    # 从而验证的是 armed 分支（而不是 graduated/阈值自动放行）
    cat >"$config_file" <<'JSON'
{
  "enabled": true,
  "dynamicPolicyEnabled": false,
  "patterns": [
    { "pattern": "\\brm\\s+(-rf?|--recursive)", "tier": "critical" }
  ]
}
JSON
    ;;
  esac
}

# ====================================================================
# Helper: 在隔离沙箱中运行 pi
# ====================================================================
run_pi() {
  local test_home="$1"
  local prompt="${2:-hi}"
  local extra_args="${3:-}"
  local timeout_seconds="${RUN_PI_TIMEOUT:-120}"

  local stdout_file="$test_home/pi-stdout.log"

  cd "$test_home"
  set +e
  if command -v timeout >/dev/null 2>&1; then
    # Linux（CI）有 GNU timeout
    HOME="$test_home/home" timeout "$timeout_seconds" \
      pi -a --no-session $extra_args -p "$prompt" >"$stdout_file" 2>&1
    local ec=$?
  else
    # macOS 无 GNU timeout：background + wait + kill 兜底
    HOME="$test_home/home" pi -a --no-session $extra_args -p "$prompt" \
      >"$stdout_file" 2>&1 &
    local pid=$!
    local waited=0
    while kill -0 "$pid" 2>/dev/null && ((waited < timeout_seconds)); do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "  [run_pi TIMEOUT] pi 超过 ${timeout_seconds}s，强制终止"
      kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      local ec=124
    else
      wait "$pid"
      local ec=$?
    fi
  fi
  set -e
  cd "$ROOT_DIR"

  echo "=== pi exit code: $ec ==="
  return $ec
}

# ====================================================================
# Helper: 输出权限相关日志
# ====================================================================
dump_perm_logs() {
  local test_home="$1"
  local log_dir="$test_home/.pi/logs"

  echo "=== PERMISSION-GATE LOG ==="
  if [[ -d "$log_dir" ]]; then
    for f in "$log_dir"/permission-gate*.log; do
      if [[ -f "$f" ]]; then
        cat "$f"
      fi
    done
  fi
  echo "=== STDOUT (last 40 lines) ==="
  tail -40 "$test_home/pi-stdout.log" 2>/dev/null || echo "(no stdout)"
}

# ====================================================================
test_describe "permission-gate dynamic policy (mock-llm)"

# ── 场景 1：动态策略未达阈值 → 拦截（graduated 语义） ──
test_it "dynamic policy blocks first dangerous command (not graduated)" <<'TEST'
  local slug="e2e-pg-dp1-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" auto_approve

  run_pi "$test_home" "clean up the temp directory" || true

  dump_perm_logs "$test_home"

  # 验证：首次危险命令计数未达阈值 → block（no-UI，decision=blocked-no-ui）
  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  if [[ -d "$audit_dir" ]]; then
    python3 -c "
import json, glob
files = glob.glob('$audit_dir/*.jsonl')
entries = []
for f in files:
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
assert len(entries) >= 1, f'expected >=1 audit entries, got {len(entries)}'
e = [x for x in entries if x.get('decision') == 'blocked-no-ui'][0]
for field in ('id','ts','tool','command','tier','decision','projectKey'):
    assert field in e, f'missing {field}'
print('PASS: audit entry decision=blocked-no-ui (blocked, not graduated)')
" 2>/dev/null || {
      echo "FAIL: expected deny (blocked) audit entry, not auto-approved"
      exit 1
    }
  else
    echo "FAIL: audit dir NOT created at $audit_dir"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 5：blocked 记录持久化（decision='blocked-no-ui'） ──
test_it "blocked commands write decision=blocked-no-ui to audit log" <<'TEST'
  local slug="e2e-pg-dp5-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" threshold_exceeded

  # 第一次运行：block
  run_pi "$test_home" "clean up the temp directory" || true

  # 第二次运行：再次 block（累计 2 条 denied）
  echo "=== Run 2 ==="
  run_pi "$test_home" "do it" || true

  dump_perm_logs "$test_home"

  # 验证 audit JSONL 中 deny 条目
  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  if [[ -d "$audit_dir" ]]; then
    python3 -c "
import json, glob
files = glob.glob('$audit_dir/*.jsonl')
entries = []
for f in files:
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
assert len(entries) >= 1, f'expected >=1 entries, got {len(entries)}'

# 检查所有条目都是 decision='blocked-no-ui'
for e in entries:
    assert e['decision'] == 'blocked-no-ui', f'expected deny, got {e[\"decision\"]}'
    assert 'ts' in e, 'missing ts'
    assert 'command' in e, 'missing command'
    assert 'tool' in e, 'missing tool'
    # UX3 溯源字段：项目路径 + 会话 ID（新记录应写入）
    assert e.get('projectPath'), f'missing projectPath in audit entry: {e.get(\"id\")}'
    assert e.get('sessionId'), f'missing sessionId in audit entry: {e.get(\"id\")}'

print(f'PASS: {len(entries)} deny entries validated (projectPath+sessionId present)')
" 2>/dev/null || {
      echo "FAIL: deny entries validation failed"
      exit 1
    }
  else
    echo "FAIL: audit dir not found"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 6：审计日志跨 session 累积 deny（append-only） ──
test_it "audit log accumulates deny entries across runs" <<'TEST'
  local slug="e2e-pg-dp6-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" auto_approve

  # 运行 3 次（print no-UI：首次未达 graduated 阈值 → deny），生成 3 条 deny 记录
  for i in 1 2 3; do
    echo "=== Run $i ==="
    run_pi "$test_home" "clean up the temp directory" || true
  done

  dump_perm_logs "$test_home"

  # Python 验证：audit JSONL 累积 3 条 deny 记录（append-only 跨 session）
  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  if [[ -d "$audit_dir" ]]; then
    python3 -c "
import json, glob
files = glob.glob('$audit_dir/*.jsonl')
entries = []
for f in files:
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
deny = [e for e in entries if e.get('decision') == 'blocked-no-ui']
print(f'Total audit entries: {len(entries)}, deny: {len(deny)}')

# 3 次相同命令 → 3 条 deny 记录（audit append-only 跨 session 累积）
assert len(deny) == 3, f'expected 3 deny entries, got {len(deny)}'
assert all(e.get('projectKey') for e in deny), 'missing projectKey'
print('PASS: 3 deny entries accumulated, projectKey present')
" 2>/dev/null || {
      echo "FAIL: audit accumulation validation failed"
      exit 1
    }
  else
    echo "FAIL: audit dir not found"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 4：审计记录跨 session 累积 deny ──
test_it "blocked records accumulate across repeated pi invocations" <<'TEST'
  local slug="e2e-pg-dp4-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" auto_approve

  # 第一次运行
  echo "=== Run 1 ==="
  run_pi "$test_home" "clean up the temp directory" || true

  # 第二次运行（同一 sandbox，记录应累积）
  echo "=== Run 2 ==="
  run_pi "$test_home" "do it again" || true

  dump_perm_logs "$test_home"

  # 验证 audit JSONL 跨 session 累积 2 条 deny 记录
  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  if [[ -d "$audit_dir" ]]; then
    python3 -c "
import json, glob
files = glob.glob('$audit_dir/*.jsonl')
entries = []
for f in files:
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
deny = [e for e in entries if e.get('decision') == 'blocked-no-ui']
assert len(deny) == 2, f'expected 2 deny entries, got {len(deny)}'
for e in deny:
    for field in ('ts','command','tool','decision','projectKey'):
        assert field in e, f'missing {field}'
    assert e['tool'] == 'bash', f'expected bash tool, got {e[\"tool\"]}'
assert deny[0]['ts'] != deny[1]['ts'], 'expected distinct timestamps'
print('PASS: 2 deny entries accumulated with distinct timestamps')
" 2>/dev/null || {
      echo "FAIL: accumulation validation failed"
      exit 1
    }
  else
    echo "FAIL: audit dir not found"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 2：动态策略阈值超限 → block（no-UI） ──
test_it "dynamic policy blocks when all thresholds exceeded" <<'TEST'
  local slug="e2e-pg-dp2-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" threshold_exceeded

  run_pi "$test_home" "clean up the temp directory" || true
  local ecode=$?

  dump_perm_logs "$test_home"

  # 验证：日志中应出现 "all thresholds exceeded"
  local log_dir="$test_home/.pi/logs"
  if grep -q "all thresholds exceeded" "$log_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 'all thresholds exceeded' found in log"
  else
    echo "FAIL: 'all thresholds exceeded' NOT found"
    exit 1
  fi

  # 验证：stdout 中应有 block 消息（no-UI 模式）
  if grep -q "Blocked" "$test_home/pi-stdout.log" 2>/dev/null; then
    echo "PASS: Block message found in stdout"
  else
    echo "WARN: No explicit 'Blocked' in stdout (may appear differently)"
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 3：不在 scope 内 → fall through ──
test_it "dynamic policy skips when not in scope" <<'TEST'
  local slug="e2e-pg-dp3-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" out_of_scope

  run_pi "$test_home" "clean up the temp directory" || true

  dump_perm_logs "$test_home"

  # 验证：日志中应出现 "not in scope"
  local log_dir="$test_home/.pi/logs"
  if grep -q "not in scope" "$log_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 'not in scope' found in log"
  else
    echo "FAIL: 'not in scope' NOT found"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 7：复合命令 deny 记录 originalCommand/subCommands ──
test_it "compound command deny records originalCommand and subCommands" <<'TEST'
  local slug="e2e-pg-dp7-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" auto_approve

  # 修改沙箱中的 mock-llm/index.ts，将单命令替换为复合命令
  # 使用相对路径 ./compound-test 确保在 scope 内
  # 便携式跨平台 sed：sed -i.bak + 清理 .bak（macOS BSD sed 与 Linux GNU sed 兼容）
  local mock_file="$test_home/.pi/extensions/mock-llm/index.ts"
  sed -i.bak "s|rm -rf ./permission-gate-test-target|rm -rf ./compound-test \&\& echo done|g" \
    "$mock_file"
  rm -f "$mock_file.bak"

  # 确认替换成功
  if grep -q "rm -rf ./compound-test && echo done" "$mock_file" 2>/dev/null; then
    echo "PASS: mock-llm updated with compound command"
  else
    echo "FAIL: mock-llm NOT updated"
    exit 1
  fi

  run_pi "$test_home" "clean up the temp directory" || true

  dump_perm_logs "$test_home"

  # 验证 audit JSONL 的 originalCommand/subCommands（复合命令整条 deny）
  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  if [[ ! -d "$audit_dir" ]]; then
    echo "FAIL: audit dir NOT created"
    exit 1
  fi

  python3 -c "
import json, glob
files = glob.glob('$audit_dir/*.jsonl')
entries = []
for f in files:
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))

# 1. 验证有 1 条 deny 记录（echo done 不危险，rm -rf 未达 graduated 阈值 → 整条 deny）
deny_entries = [e for e in entries if e.get('decision') == 'blocked-no-ui']
assert len(deny_entries) == 1, f'expected 1 deny entry, got {len(deny_entries)}'
e = deny_entries[0]

# 2. originalCommand 存在且等于完整复合命令
expected_orig = 'rm -rf ./compound-test && echo done'
assert e.get('originalCommand') == expected_orig, \
    f'originalCommand mismatch: {e.get(\"originalCommand\")!r} != {expected_orig!r}'
print(f'PASS: originalCommand = {e.get(\"originalCommand\")!r}')

# 3. subCommands 存在且是数组
assert isinstance(e.get('subCommands'), list), 'subCommands should be list'
expected_subs = ['rm -rf ./compound-test', 'echo done']
assert e['subCommands'] == expected_subs, \
    f'subCommands mismatch: {e[\"subCommands\"]} != {expected_subs}'
print(f'PASS: subCommands = {e[\"subCommands\"]}')

print('PASS: all compound command checks passed')
" 2>/dev/null || {
    echo "FAIL: Python validation failed"
    exit 1
  }

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ══════════════════════════════════════════════════════════════════════
# 提升 / 出处条件（Ticket 04 / ADR-0039 补充 + ADR-0040）
#
# 真实场景：**同一条命令形状**因「目标是否由本会话创建」而得到不同决策。
# 判定链：cwd 与目标各自被某个根覆盖 → 阈值（tool:rm ≥ 3）→ 出处条件。
# ══════════════════════════════════════════════════════════════════════

# 提升场景沙箱：复用既有沙箱搭建，再换用按命令序列驱动的 mock-llm + 条件根配置。
# $2 = scope JSON（调用方已展开绝对路径）
setup_promotion_sandbox() {
  local test_home="$1"
  local scope_json="$2"
  setup_sandbox "$test_home" auto_approve

  cp "$ROOT_DIR/test/e2e/extensions/permission-gate/helpers/mock-llm-promotion.ts" \
    "$test_home/.pi/extensions/mock-llm/index.ts"

  cat >"$test_home/.pi/extensions-data/permission-gate/config.json" <<JSON
{
  "enabled": true,
  "dynamicPolicyEnabled": true,
  "dynamicPolicy": {
    "scope": $scope_json,
    "thresholds": { "sameCommand": 999, "sameTool": 3, "sameFolder": 999 }
  },
  "patterns": ["\\\\brm\\\\s+(-rf?|--recursive)"]
}
JSON

  # 预置计数：no-UI 下不会有人工批准累加；等价于「真实用户早已批准过 rm 若干次」
  cat >"$test_home/.pi/extensions-data/permission-gate/state.json" <<'JSON'
{ "counts": { "tool:rm": 3 } }
JSON
}

# ── 场景 A：条件根 + 目标由**本会话**创建 → 自动放行 ──
test_it "范围出处条件：本会话创建的临时目录 → 自动放行" <<'TEST'
  local slug="e2e-pg-prov-yes-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  local mine="/tmp/pg-e2e-$$-mine"
  mkdir -p "$test_home"

  setup_promotion_sandbox "$test_home" \
    "[{\"root\":\"$test_home\"},{\"root\":\"/tmp\",\"requireSessionProvenance\":true}]"

  # 真实施工序列：先创建（账本登记），再删除
  PG_E2E_COMMANDS="mkdir -p $mine;;rm -rf $mine" \
    run_pi "$test_home" "clean up my temp dir" || true

  dump_perm_logs "$test_home"

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  if [[ -d "$audit_dir" ]]; then
    python3 -c "
import json, glob
entries = []
for f in glob.glob('$audit_dir/*.jsonl'):
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
rm_entries = [e for e in entries if 'rm -rf' in (e.get('originalCommand') or '')]
assert rm_entries, f'expected an rm audit entry, got {[e.get(\"decision\") for e in entries]}'
d = rm_entries[-1]['decision']
assert d == 'auto', f'本会话创建的临时目录应自动放行，实际 decision={d}'
print('PASS: 本会话创建的 /tmp 目标 → auto（条件满足 + 工具阈值已达）')
" 2>/dev/null || {
      echo "FAIL: 本会话创建的临时目录未被自动放行"
      exit 1
    }
  else
    echo "FAIL: audit dir NOT created at $audit_dir"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 B：条件根 + 目标**非**本会话创建 → 仍被拦截（唯一护栏） ──
test_it "范围出处条件：非本会话创建的 /tmp 目标 → 仍被拦截" <<'TEST'
  local slug="e2e-pg-prov-no-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  local mine="/tmp/pg-e2e-$$-mine2"
  local foreign="/tmp/pg-e2e-$$-foreign"
  mkdir -p "$test_home"

  setup_promotion_sandbox "$test_home" \
    "[{\"root\":\"$test_home\"},{\"root\":\"/tmp\",\"requireSessionProvenance\":true}]"

  PG_E2E_COMMANDS="mkdir -p $mine;;rm -rf $foreign" \
    run_pi "$test_home" "delete the foreign dir" || true

  dump_perm_logs "$test_home"

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  if [[ -d "$audit_dir" ]]; then
    python3 -c "
import json, glob
entries = []
for f in glob.glob('$audit_dir/*.jsonl'):
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
foreign = [e for e in entries if '$foreign' in (e.get('originalCommand') or '')]
assert foreign, 'no audit entry for the foreign target'
assert foreign[-1]['decision'] == 'blocked-no-ui', f'应被拦截，实际 {foreign[-1][\"decision\"]}'
print('PASS: 非本会话创建的 /tmp 目标 → blocked（条件不满足，失败即拒绝）')
" 2>/dev/null || {
      echo "FAIL: 非本会话创建的 /tmp 目标未被拦截"
      exit 1
    }
  else
    echo "FAIL: audit dir NOT created at $audit_dir"
    exit 1
  fi

  # 判定原因可观测（Ticket 04 验收项）
  if grep -q "出处条件" "$test_home/.pi/logs"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 日志记录了「出处条件不满足」的判定原因"
  else
    echo "FAIL: 日志未记录出处条件判定原因"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 C：对照 —— 不挂条件时同一个外部目标会被自动放行 ──
test_it "对照：不挂条件时同一个外部 /tmp 目标被自动放行（证明条件是唯一护栏）" <<'TEST'
  local slug="e2e-pg-prov-ctl-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  local foreign="/tmp/pg-e2e-$$-ctl-foreign"
  mkdir -p "$test_home"

  # 同一个根，但**不挂**出处条件
  setup_promotion_sandbox "$test_home" \
    "[{\"root\":\"$test_home\"},{\"root\":\"/tmp\"}]"

  PG_E2E_COMMANDS="rm -rf $foreign" run_pi "$test_home" "delete it" || true

  dump_perm_logs "$test_home"

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  if [[ -d "$audit_dir" ]]; then
    python3 -c "
import json, glob
entries = []
for f in glob.glob('$audit_dir/*.jsonl'):
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
foreign = [e for e in entries if '$foreign' in (e.get('originalCommand') or '')]
assert foreign, 'no audit entry for the target'
d = foreign[-1]['decision']
assert d == 'auto', f'不挂条件时应自动放行，实际 decision={d}'
print('PASS: 不挂条件 → auto（同一条命令，差别只在条件）')
" 2>/dev/null || {
      echo "FAIL: 不挂条件时未自动放行"
      exit 1
    }
  else
    echo "FAIL: audit dir NOT created at $audit_dir"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 远端豁免模式（ADR-0068）：真实 pi + 真实审计落盘
#
# 许可（--unattended-confirm）与生效（arm）分离：arm-channel 辅助扩展在 session_start
# 调用 arm('e2e-channel')，permission-gate 的 armed 分支才生效。
# ====================================================================

# ── 场景 7：armed + cwd 内目标 → 自动放行并写 allowed-unattended ──
test_it "unattended: cwd 内 rm -rf 自动放行（审计 allowed-unattended）" <<'TEST'
  local slug="e2e-pg-un1-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" unattended_exempt

  # 目标必须真实存在：断言「命令真的执行了」（目录被删掉），而不只是审计写了什么
  mkdir -p "$test_home/.scratch/tmp"
  touch "$test_home/.scratch/tmp/probe.txt"

  export PG_E2E_DANGEROUS_COMMAND="rm -rf .scratch/tmp"
  run_pi "$test_home" "clean up the scratch dir" "--unattended-confirm" || true
  unset PG_E2E_DANGEROUS_COMMAND

  dump_perm_logs "$test_home"

  if [[ -d "$test_home/.scratch/tmp" ]]; then
    echo "FAIL: armed 下 cwd 内 rm -rf 未被执行（目标仍存在）"
    exit 1
  fi
  echo "PASS: 目标目录已删除（命令真的执行）"

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  local logs_dir="$test_home/.pi/logs"
  python3 -c "
import json, glob
files = glob.glob('$audit_dir/*.jsonl')
entries = []
for f in files:
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
hits = [e for e in entries if e.get('originalCommand') == 'rm -rf .scratch/tmp']
assert hits, f'no audit entry for the exempted command (got {[e.get(\"originalCommand\") for e in entries]})'
e = hits[-1]
assert e['decision'] == 'allowed-unattended', f'expected allowed-unattended, got {e[\"decision\"]}'
assert e['tier'] == 'critical', f'expected tier preserved, got {e[\"tier\"]}'
assert e['reasons'], 'reasons must be preserved'
print('PASS: 审计 decision=allowed-unattended，tier/reasons 保留')
" || {
      echo "FAIL: allowed-unattended 审计校验失败"
      echo "--- audit dump ---"
      cat "$audit_dir"/*.jsonl 2>/dev/null || echo "(no audit file at $audit_dir)"
      exit 1
    }

  if grep -q "Unattended exempt" "$logs_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 日志记录了 Unattended exempt"
  else
    echo "FAIL: 未找到 Unattended exempt 日志"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 8：armed + cwd 外目标 → 拒绝（denyCause=unattended）且不执行 ──
test_it "unattended: cwd 外 rm -rf 被拒（denyCause=unattended）且未执行" <<'TEST'
  local slug="e2e-pg-un2-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  local outside="/tmp/pg-unattended-outside-$$"
  rm -rf "$outside"
  mkdir -p "$outside"
  touch "$outside/keep.txt"

  mkdir -p "$test_home"
  setup_sandbox "$test_home" unattended_deny

  export PG_E2E_DANGEROUS_COMMAND="rm -rf $outside"
  run_pi "$test_home" "clean up the outside dir" "--unattended-confirm" || true
  unset PG_E2E_DANGEROUS_COMMAND

  dump_perm_logs "$test_home"

  if [[ -f "$outside/keep.txt" ]]; then
    echo "PASS: cwd 外目标未被删除（拒绝真的生效）"
  else
    echo "FAIL: cwd 外目标被删除，豁免越界"
    rm -rf "$outside"
    exit 1
  fi
  rm -rf "$outside"

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  local logs_dir="$test_home/.pi/logs"
  python3 -c "
import json, glob
files = glob.glob('$audit_dir/*.jsonl')
entries = []
for f in files:
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
target = 'rm -rf $outside'
hits = [e for e in entries if e.get('originalCommand') == target]
assert hits, f'no audit entry for {target}'
e = hits[-1]
assert e['decision'] == 'deny', f'expected deny, got {e[\"decision\"]}'
assert e.get('denyCause') == 'unattended', f'expected denyCause=unattended, got {e.get(\"denyCause\")}'
print('PASS: 审计 decision=deny + denyCause=unattended')
" 2>/dev/null || {
      echo "FAIL: deny 审计校验失败"
      exit 1
    }

  if grep -q "Unattended deny (outside-cwd)" "$logs_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 日志记录了 Unattended deny (outside-cwd)"
  else
    echo "FAIL: 未找到 Unattended deny 日志（或失败类别不是 outside-cwd）"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 9：armed + 引号包裹的 cwd 外目标 → 拒绝（回归：引号曾绕过 cwd 判定）──
# 解析器给的参数是原文（保留引号），`resolve` 会把 `".."` / `"/x"` 当字面段 → 词法上像 cwd 内，
# 而 shell 执行时还原成 cwd 外。本用例走真实 pi + 真实 bash，断言目标未被删除。
test_it "unattended: 引号包裹的 cwd 外 rm -rf 被拒（引号不得绕过 cwd 判定）" <<'TEST'
  local slug="e2e-pg-un3-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  local outside="/tmp/pg-unattended-quoted-$$"
  rm -rf "$outside"
  mkdir -p "$outside"
  touch "$outside/keep.txt"

  mkdir -p "$test_home"
  setup_sandbox "$test_home" unattended_deny

  # 双引号包裹的绝对路径：shell 会原样还原成 cwd 外路径
  export PG_E2E_DANGEROUS_COMMAND="rm -rf \"$outside\""
  run_pi "$test_home" "clean up the outside dir" "--unattended-confirm" || true
  unset PG_E2E_DANGEROUS_COMMAND

  dump_perm_logs "$test_home"

  if [[ -f "$outside/keep.txt" ]]; then
    echo "PASS: 引号包裹的 cwd 外目标未被删除"
  else
    echo "FAIL: 引号绕过了 cwd 判定，cwd 外目标被删除"
    rm -rf "$outside"
    exit 1
  fi
  rm -rf "$outside"

  local logs_dir="$test_home/.pi/logs"
  if grep -q "Unattended deny (unresolvable-target)" "$logs_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 日志记录 Unattended deny (unresolvable-target)"
  else
    echo "FAIL: 未找到 unresolvable-target 拒绝日志（引号目标应判不可解析）"
    tail -10 "$logs_dir"/permission-gate*.log 2>/dev/null
    exit 1
  fi

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  python3 -c "
import json, glob
entries = []
for f in glob.glob('$audit_dir/*.jsonl'):
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
target = 'rm -rf \"$outside\"'
hits = [e for e in entries if e.get('originalCommand') == target]
assert hits, f'no audit entry for {target}'
assert hits[-1]['decision'] == 'deny', f'expected deny, got {hits[-1][\"decision\"]}'
assert hits[-1].get('denyCause') == 'unattended', 'expected denyCause=unattended'
print('PASS: 审计 decision=deny + denyCause=unattended')
" 2>/dev/null || {
      echo "FAIL: 引号目标的 deny 审计校验失败"
      exit 1
    }

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 10：armed + 字面目标里混入变量 → 拒绝（回归：解析器丢弃展开曾导致越界删除）──
# `rm -rf .scratch/tmp $DANGER`：解析器只把 `.scratch/tmp` 收进 arguments，`$DANGER` 不是 word
# 节点。若判定层把「没提取到」当成「命令里没有」，就会以「目标只有 .scratch/tmp」放行，
# 而 shell 实际把 $DANGER 展开成 cwd 外路径一起删。本用例走真实 pi + 真实 bash 断言未删除。
test_it "unattended: 字面目标混入变量被拒（\$VAR 不得从判定里消失）" <<'TEST'
  local slug="e2e-pg-un4-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  local outside="/tmp/pg-unattended-var-$$"
  rm -rf "$outside"
  mkdir -p "$outside"
  touch "$outside/keep.txt"

  mkdir -p "$test_home"
  setup_sandbox "$test_home" unattended_deny
  mkdir -p "$test_home/.scratch/tmp"

  export PG_E2E_DANGEROUS_COMMAND="rm -rf .scratch/tmp \$PG_OUTSIDE_DIR"
  export PG_OUTSIDE_DIR="$outside"
  run_pi "$test_home" "clean up the scratch dir" "--unattended-confirm" || true
  unset PG_E2E_DANGEROUS_COMMAND PG_OUTSIDE_DIR

  dump_perm_logs "$test_home"

  if [[ -f "$outside/keep.txt" ]]; then
    echo "PASS: 变量指向的 cwd 外目标未被删除"
  else
    echo "FAIL: \$VAR 被从判定里丢掉，cwd 外目标被删除"
    rm -rf "$outside"
    exit 1
  fi
  rm -rf "$outside"

  local logs_dir="$test_home/.pi/logs"
  if grep -q "Unattended deny (unresolvable-target)" "$logs_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 日志记录 Unattended deny (unresolvable-target)"
  else
    echo "FAIL: 未找到 unresolvable-target 拒绝日志（变量目标应判不可解析）"
    tail -10 "$logs_dir"/permission-gate*.log 2>/dev/null
    exit 1
  fi

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  python3 -c "
import json, glob
entries = []
for f in glob.glob('$audit_dir/*.jsonl'):
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
target = 'rm -rf .scratch/tmp \$PG_OUTSIDE_DIR'
hits = [e for e in entries if e.get('originalCommand') == target]
assert hits, f'no audit entry for {target}'
assert hits[-1]['decision'] == 'deny', f'expected deny, got {hits[-1][\"decision\"]}'
assert hits[-1].get('denyCause') == 'unattended', 'expected denyCause=unattended'
print('PASS: 审计 decision=deny + denyCause=unattended')
" 2>/dev/null || {
      echo "FAIL: 变量目标的 deny 审计校验失败"
      exit 1
    }

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 11：armed + 路径限定的 rm → 拒绝（回归：按 basename 认命令曾放行任意可执行文件）──
# 前置条件无需任何确认即可达成：`install -m 755 payload ./rm` 不命中任何内置 pattern；
# 若豁免把 `./rm` 当 coreutils 的 rm，随后的 `./rm -rf .scratch/tmp` 就会执行这段任意脚本并放行。
test_it "unattended: 路径限定的 ./rm 被拒（不按 basename 认命令）" <<'TEST'
  local slug="e2e-pg-un5-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" unattended_deny

  mkdir -p "$test_home/.scratch/tmp"
  # 假 rm：被真正执行就会留下 PWNED 标记（比「目标还在」更直接地证明它被执行过）
  printf '#!/bin/sh\ntouch "%s/PWNED"\n' "$test_home" >"$test_home/rm"
  chmod +x "$test_home/rm"

  export PG_E2E_DANGEROUS_COMMAND="./rm -rf .scratch/tmp"
  run_pi "$test_home" "clean up the scratch dir" "--unattended-confirm" || true
  unset PG_E2E_DANGEROUS_COMMAND

  dump_perm_logs "$test_home"

  if [[ -f "$test_home/PWNED" ]]; then
    echo "FAIL: ./rm 被当作可豁免的文件操作执行了（basename 判定回归）"
    exit 1
  fi
  echo "PASS: ./rm 未被当作可豁免的文件操作执行"

  if [[ -d "$test_home/.scratch/tmp" ]]; then
    echo "PASS: 目标目录仍在（命令未执行）"
  else
    echo "FAIL: 目标目录被删除，豁免越界"
    exit 1
  fi

  local logs_dir="$test_home/.pi/logs"
  if grep -q "Unattended deny (path-qualified-op)" "$logs_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 日志记录 Unattended deny (path-qualified-op)"
  else
    echo "FAIL: 未找到 path-qualified-op 拒绝日志"
    tail -10 "$logs_dir"/permission-gate*.log 2>/dev/null
    exit 1
  fi

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  python3 -c "
import json, glob
entries = []
for f in glob.glob('$audit_dir/*.jsonl'):
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
target = './rm -rf .scratch/tmp'
hits = [e for e in entries if e.get('originalCommand') == target]
assert hits, f'no audit entry for {target}'
assert hits[-1]['decision'] == 'deny', f'expected deny, got {hits[-1][\"decision\"]}'
assert hits[-1].get('denyCause') == 'unattended', 'expected denyCause=unattended'
print('PASS: 审计 decision=deny + denyCause=unattended')
" 2>/dev/null || {
      echo "FAIL: ./rm 的 deny 审计校验失败"
      exit 1
    }

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 12：armed + 任意层级的 .git → 拒绝（回归：只比对顶层 .git 曾放行嵌套仓库）──
# pi-rewind 按**目录名**剔除 .git/.pi（任意深度），嵌套仓库 / 子模块同样没有快照可恢复。
test_it "unattended: 嵌套 .git 被拒（任意层级无快照可回滚）" <<'TEST'
  local slug="e2e-pg-un6-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" unattended_deny

  # 嵌套仓库（子模块 / monorepo 子项目）的 .git：删掉即丢历史，且不在 pi-rewind 快照内
  mkdir -p "$test_home/packages/sub/.git"
  touch "$test_home/packages/sub/.git/HEAD"
  touch "$test_home/packages/sub/.git/keep-marker"

  export PG_E2E_DANGEROUS_COMMAND="rm -rf packages/sub/.git"
  run_pi "$test_home" "clean up the nested git dir" "--unattended-confirm" || true
  unset PG_E2E_DANGEROUS_COMMAND

  dump_perm_logs "$test_home"

  if [[ -f "$test_home/packages/sub/.git/keep-marker" ]]; then
    echo "PASS: 嵌套 .git 未被删除（拒绝真的生效）"
  else
    echo "FAIL: 嵌套 .git 被删除，豁免越界（不可回滚）"
    exit 1
  fi

  local logs_dir="$test_home/.pi/logs"
  if grep -q "Unattended deny (protected-internal)" "$logs_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 日志记录 Unattended deny (protected-internal)"
  else
    echo "FAIL: 未找到 protected-internal 拒绝日志"
    tail -10 "$logs_dir"/permission-gate*.log 2>/dev/null
    exit 1
  fi

  local audit_dir="$test_home/home/.pi/agent/extensions-data/permission-gate/audit"
  python3 -c "
import json, glob
entries = []
for f in glob.glob('$audit_dir/*.jsonl'):
    for line in open(f):
        if line.strip():
            entries.append(json.loads(line))
target = 'rm -rf packages/sub/.git'
hits = [e for e in entries if e.get('originalCommand') == target]
assert hits, f'no audit entry for {target}'
assert hits[-1]['decision'] == 'deny', f'expected deny, got {hits[-1][\"decision\"]}'
assert hits[-1].get('denyCause') == 'unattended', 'expected denyCause=unattended'
print('PASS: 审计 decision=deny + denyCause=unattended')
" 2>/dev/null || {
      echo "FAIL: 嵌套 .git 的 deny 审计校验失败"
      exit 1
    }

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST
