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
#   bash test/scripts/run-e2e.sh --ext permission-gate
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
  esac
}

# ====================================================================
# Helper: 在隔离沙箱中运行 pi
# ====================================================================
run_pi() {
  local test_home="$1"
  local prompt="${2:-hi}"

  local stdout_file="$test_home/pi-stdout.log"

  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a --no-session -p "$prompt" \
    >"$stdout_file" 2>&1
  local ec=$?
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

  # 验证：首次危险命令计数未达阈值 → block（no-UI，decision=deny）
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
e = [x for x in entries if x.get('decision') == 'deny'][0]
for field in ('id','ts','tool','command','tier','decision','projectKey'):
    assert field in e, f'missing {field}'
print('PASS: audit entry decision=deny (blocked, not graduated)')
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

# ── 场景 5：blocked 记录持久化（decision='deny'） ──
test_it "blocked commands write decision=deny to audit log" <<'TEST'
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

# 检查所有条目都是 decision='deny'
for e in entries:
    assert e['decision'] == 'deny', f'expected deny, got {e[\"decision\"]}'
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
deny = [e for e in entries if e.get('decision') == 'deny']
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
deny = [e for e in entries if e.get('decision') == 'deny']
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
deny_entries = [e for e in entries if e.get('decision') == 'deny']
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
