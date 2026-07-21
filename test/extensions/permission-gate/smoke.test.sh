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

	# 拷贝 mock-llm（test/extensions/permission-gate/helpers/mock-llm.ts → index.ts）
	mkdir -p "$test_home/.pi/extensions/mock-llm"
	cp "$ROOT_DIR/test/extensions/permission-gate/helpers/mock-llm.ts" \
		"$test_home/.pi/extensions/mock-llm/index.ts"

	# pi-logger 配置
	if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" \
			"$test_home/.pi/pi-logger.json"
	fi

	# node_modules 本地包链接
	mkdir -p "$test_home/node_modules/@zenone"
	if [[ ! -e "$test_home/node_modules/@zenone/pi-logger" ]]; then
		ln -sf "$ROOT_DIR/extensions/meta/pi-logger" \
			"$test_home/node_modules/@zenone/pi-logger"
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

# ── 场景 1：动态策略自动放行（阈值极高） ──
test_it "dynamic policy auto-approves when within thresholds" <<'TEST'
  local slug="e2e-pg-dp1-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" auto_approve

  run_pi "$test_home" "clean up the temp directory" || true

  dump_perm_logs "$test_home"

  # 验证：日志中应出现 "Auto-approved"
  local log_dir="$test_home/.pi/logs"
  if grep -q "Auto-approved" "$log_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: Auto-approved found in permission-gate log"
  else
    echo "FAIL: Auto-approved NOT found in permission-gate log"
    echo "Expected: log should contain 'Auto-approved (sameCommand)' or similar"
    exit 1
  fi

  # 验证：approvals.json 有记录
  local approvals_file="$test_home/home/.pi/agent/extensions-data/permission-gate/approvals.json"
  if [[ -f "$approvals_file" ]]; then
    echo "PASS: approvals.json created"
    local entry_count
    entry_count=$(python3 -c "import json; d=json.load(open('$approvals_file')); entries=list(d['projects'].values())[0]['entries']; print(len(entries))" 2>/dev/null)
    if [[ "$entry_count" -ge 1 ]]; then
      echo "PASS: approvals.json has $entry_count entries"
      # 验证字段完整性
      python3 -c "
import json
d=json.load(open('$approvals_file'))
e=list(d['projects'].values())[0]['entries'][0]
assert 'ts' in e, 'missing ts'
assert 'cmd' in e, 'missing cmd'
assert 'tool' in e, 'missing tool'
assert 'dir' in e, 'missing dir'
assert 'dim' in e, 'missing dim'
assert 'action' in e, 'missing action'
assert e['action'] == 'auto', f'expected auto, got {e[\"action\"]}'
assert 'rm' in e['tool'], f'expected rm tool, got {e[\"tool\"]}'
print('PASS: entry fields complete, action=' + e['action'] + ', tool=' + e['tool'] + ', dim=' + str(e['dim']))
" 2>/dev/null || {
      echo "FAIL: entry fields incomplete"
      exit 1
    }
    else
      echo "FAIL: approvals.json has no entries"
      exit 1
    fi
  else
    echo "FAIL: approvals.json NOT created at $approvals_file"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 5：blocked 记录持久化（含 action='blocked'） ──
test_it "blocked commands write action=blocked to approvals.json" <<'TEST'
  local slug="e2e-pg-dp5-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" threshold_exceeded

  # 第一次运行：block
  run_pi "$test_home" "clean up the temp directory" || true

  # 第二次运行：再次 block（累计 2 条 blocked）
  echo "=== Run 2 ==="
  run_pi "$test_home" "do it" || true

  dump_perm_logs "$test_home"

  # 验证 approvals.json 中 blocked 条目
  local approvals_file="$test_home/home/.pi/agent/extensions-data/permission-gate/approvals.json"
  if [[ -f "$approvals_file" ]]; then
    python3 -c "
import json
d=json.load(open('$approvals_file'))
entries=list(d['projects'].values())[0]['entries']
assert len(entries) >= 1, f'expected >=1 entries, got {len(entries)}'

# 检查所有条目都有 action='blocked'
for e in entries:
    assert e['action'] == 'blocked', f'expected blocked, got {e[\"action\"]}'
    assert 'ts' in e, 'missing ts'
    assert 'cmd' in e, 'missing cmd'
    assert 'tool' in e, 'missing tool'
    assert 'dir' in e, 'missing dir'
    assert 'dim' in e, 'missing dim'

print(f'PASS: {len(entries)} blocked entries validated')
" 2>/dev/null || {
      echo "FAIL: blocked entries validation failed"
      python3 -c "import json; print(json.dumps(json.load(open('$approvals_file')), indent=2))" 2>/dev/null
      exit 1
    }
  else
    echo "FAIL: approvals.json not found"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 6：策略计数一致性（widget 基础数据与 approvals.json 派生一致） ──
test_it "strategy counts from approvals.json match _counts derivation" <<'TEST'
  local slug="e2e-pg-dp6-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" auto_approve

  # 运行 3 次，生成 3 条 auto 记录
  for i in 1 2 3; do
    echo "=== Run $i ==="
    run_pi "$test_home" "clean up the temp directory" || true
  done

  dump_perm_logs "$test_home"

  # Python 验证：从 approvals.json 重建 counts 并验证维度数量
  local approvals_file="$test_home/home/.pi/agent/extensions-data/permission-gate/approvals.json"
  if [[ -f "$approvals_file" ]]; then
    python3 -c "
import json, hashlib

d=json.load(open('$approvals_file'))
entries=list(d['projects'].values())[0]['entries']
print(f'Total entries: {len(entries)}')

# 重建 counts（与 deriveCounts 逻辑一致）
counts={}
for e in entries:
    if e.get('action') == 'blocked':
        continue
    # cmd key
    norm = e['cmd'].strip().replace('\n',' ').replace('  ',' ')
    ch = hashlib.sha256(norm.encode()).hexdigest()[:16]
    ck = f'cmd:{ch}'
    counts[ck] = counts.get(ck, 0) + 1
    # tool key
    tk = f\"tool:{e['tool']}\"
    counts[tk] = counts.get(tk, 0) + 1
    # dir key
    dk = f\"dir:{e['dir']}\"
    counts[dk] = counts.get(dk, 0) + 1

cmd_keys = [k for k in counts if k.startswith('cmd:')]
tool_keys = [k for k in counts if k.startswith('tool:')]
dir_keys = [k for k in counts if k.startswith('dir:')]
print(f'Derived strategy counts: cmd={len(cmd_keys)}, tool={len(tool_keys)}, dir={len(dir_keys)}')

# 验证：3 次相同命令 → 最少 1 个 cmd key（相同命令只产生一个 key）
assert len(cmd_keys) >= 1, f'expected >=1 cmd key, got {len(cmd_keys)}'
assert len(tool_keys) >= 1, f'expected >=1 tool key, got {len(tool_keys)}'
assert len(dir_keys) >= 1, f'expected >=1 dir key, got {len(dir_keys)}'

# 验证：cmd key 计数应该 = 3（因为 3 次都匹配同一命令）
cmd_count = sum(counts[k] for k in cmd_keys)
assert cmd_count == 3, f'expected cmd count=3, got {cmd_count}'
print(f'PASS: cmd keys={len(cmd_keys)}, total cmd count={cmd_count}')
print(f'PASS: strategy summary consistent')
" 2>/dev/null || {
      echo "FAIL: strategy summary validation failed"
      python3 -c "import json; print(json.dumps(json.load(open('$approvals_file')), indent=2))" 2>/dev/null
      exit 1
    }
  else
    echo "FAIL: approvals.json not found"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 4：审批记录跨 session 累积 ──
test_it "approval records accumulate across repeated pi invocations" <<'TEST'
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

  # 验证 approvals.json 有 2 条记录
  local approvals_file="$test_home/home/.pi/agent/extensions-data/permission-gate/approvals.json"
  if [[ -f "$approvals_file" ]]; then
    local entry_count
    entry_count=$(python3 -c "import json; d=json.load(open('$approvals_file')); entries=list(d['projects'].values())[0]['entries']; print(len(entries))" 2>/dev/null)
    if [[ "$entry_count" -eq 2 ]]; then
      echo "PASS: approvals.json has $entry_count entries (accumulated)"
    else
      echo "FAIL: expected 2 entries, got $entry_count"
      python3 -c "import json; print(json.dumps(json.load(open('$approvals_file')), indent=2))" 2>/dev/null
      exit 1
    fi

    # 验证两条记录都有正确字段
    python3 -c "
import json
d=json.load(open('$approvals_file'))
entries=list(d['projects'].values())[0]['entries']
assert len(entries) == 2, f'expected 2 entries, got {len(entries)}'
for i, e in enumerate(entries):
    for field in ('ts','cmd','tool','dir','dim','action'):
        assert field in e, f'entry {i} missing {field}'
    assert e['action'] == 'auto', f'entry {i} action={e[\"action\"]}'
    assert 'rm' in e['tool'], f'entry {i} tool={e[\"tool\"]}'
# 两条记录时间戳应不同（或至少不同或有先后）
if entries[0]['ts'] != entries[1]['ts']:
    print('PASS: two entries have distinct timestamps')
else:
    print('WARN: same timestamp (unrealistic but not a bug)')
print('PASS: both entries valid')
" 2>/dev/null || {
      echo "FAIL: entry validation failed"
      exit 1
    }

    # 验证 tool:rm 的累积计数
    python3 -c "
import json
d=json.load(open('$approvals_file'))
entries=list(d['projects'].values())[0]['entries']
tool_rm_count=sum(1 for e in entries if e['tool']=='rm')
assert tool_rm_count == 2, f'expected tool:rm count=2, got {tool_rm_count}'
print(f'PASS: tool:rm accumulated to {tool_rm_count}')
" 2>/dev/null || {
      echo "FAIL: tool count accumulation check failed"
      exit 1
    }

  else
    echo "FAIL: approvals.json not found"
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
