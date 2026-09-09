#!/usr/bin/env bash
#
# org extension — e2e tests（目录绑定 agent 框架）
#
# 覆盖：
#   1. 扩展加载无错误（单进程 print）
#   2. org 生命周期：create/join/status/leave/delete（真实 pi 命令面 + 账本文件）
#   3. 编排闭环：chief 派发 → worker claim/report → chief approve → 任务 closed（终态铁律）
#   4. 非 chief 握手闭环：member 派发 → 目标 /org accept → report → member 派发人 approve
#   5. 握手 reject（带原因剔除子任务，其余照常闭环）
#   6. 多人情形 B：chief 派发 + reassign 加参与者 → 采纳已交付者整体验收 → 另一参与者被叫停（stopped + inbox 通知）
#
# Run: CI=true bash test/e2e/scripts/run-e2e.sh --ext org

set -euo pipefail
ROOT_DIR="${ROOT_DIR:?must be set by test runner}"

test_describe "org extension"

test_it "loads without errors (org + control)" <<'TEST'
	run_pi_and_check --extensions "org,control" --prompt "hi" --expect-no-error
	exit 0
TEST

# ── 手工沙箱（多进程 / 命令面 e2e 共用）───────────────────────────────────
# 布局：SB/chief、SB/worker（agent 目录）；SB/home（隔离 HOME）；
#       SB/orgdata（ORG_ROOT org 数据根）
# 扩展加载：把 org 源码拷入 SB/home/.pi/agent/extensions/org（与真实 user-install 等价）
setup_org_sandbox() {
	SB="/tmp/org-e2e-$$"
	R="$ROOT_DIR"
	rm -rf "$SB"
	mkdir -p "$SB/chief" "$SB/worker" "$SB/home/.pi/agent/extensions/org" "$SB/home/.pi/agent/extensions/mock-llm" "$SB/home/.pi/agent/node_modules/@zenone" "$SB/home/.pi/agent/node_modules/typebox"
	# org 扩展（与依赖链）
	cp "$R"/extensions/auto/org/*.ts "$SB/home/.pi/agent/extensions/org/"
	cp "$R"/extensions/auto/org/package.json "$SB/home/.pi/agent/extensions/org/" 2>/dev/null || true
	cp "$R/test/e2e/helpers/mock-llm.ts" "$SB/home/.pi/agent/extensions/mock-llm/index.ts" 2>/dev/null || true
	ln -sfn "$R/extensions/meta/pi-logger" "$SB/home/.pi/agent/node_modules/@zenone/pi-logger"
	ln -sfn "$R/node_modules/typebox" "$SB/home/.pi/agent/node_modules/typebox"
	# agent 身份
	echo '{ "name": "chief-1", "role": "chief" }' >"$SB/chief/pi.agent.json"
	echo '{ "name": "worker-a", "role": "member" }' >"$SB/worker/pi.agent.json"
	echo "# worker-a — org member" >"$SB/worker/AGENTS.md"
	# mock 模型配置（print 命令不触 LLM，仅防启动警告）
	cat >"$SB/home/.pi/agent/models-store.json" <<'EOF'
{"mock-llm":{"models":[{"id":"mock-model-1","name":"Mock Model","api":"openai-completions","provider":"mock-llm","apiKey":"ci-noop-key","baseUrl":"http://localhost:0"}],"default":"mock-model-1"}}
EOF
	echo "$SB"
}

cleanup_sandbox() {
	rm -rf "$SB"
}

# 在 agent 目录跑一条 /org 命令（print 模式）。注意：respond 文本在 print 模式不可见，
# 断言一律以账本文件（org.json / tasks / history）系统终态为准（项目 e2e 铁律）。
run_org_cmd() { # $1=agent目录 $2=命令
	(
		cd "$1" && HOME="$SB/home" ORG_ROOT="$SB/orgdata" pi -a --no-session -p "/org $2"
	) >"$SB/cmd.log" 2>&1 || {
		echo "FAIL: /org $2 执行失败"
		tail -6 "$SB/cmd.log"
		exit 1
	}
}

# ── 用例 2：org 生命周期命令 ────────────────────────────────────────────────
test_it "org 生命周期：create → join → status → leave → delete（真实命令面）" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	cleanup() { cleanup_sandbox; }
	trap cleanup EXIT

	# ① chief /org create uat-team → org.json 落盘（含负责人 chief-1）
	run_org_cmd "$SB/chief" "create uat-team"
	[[ -f "$SB/orgdata/uat-team/org.json" ]] || { echo "FAIL: org.json 未落盘"; exit 1; }
	grep -q '"chiefName": "chief-1"' "$SB/orgdata/uat-team/org.json" || { echo "FAIL: 负责人未登记"; exit 1; }

	# ② worker /org join uat-team → members 出现 worker-a
	run_org_cmd "$SB/worker" "join uat-team"
	grep -q '"name": "worker-a"' "$SB/orgdata/uat-team/org.json" || { echo "FAIL: join 未登记成员"; exit 1; }

	# ③ chief /org status uat-team（执行无错即可；视图正确性由 my-tasks 文件断言覆盖）
	run_org_cmd "$SB/chief" "status uat-team"

	# ④ worker /org leave uat-team --confirm → active→history（记录保留）
	run_org_cmd "$SB/worker" "leave uat-team --confirm"
	grep -q '"name": "worker-a"' "$SB/orgdata/uat-team/org.json" && { echo "FAIL: leave 后仍 active"; exit 1; }
	[[ -f "$SB/orgdata/uat-team/history/worker-a.json" ]] || { echo "FAIL: 离开档案未保留"; exit 1; }

	# ⑤ 同名回归 join（无 disposition）→ 不写入 members（需人类三选一）
	run_org_cmd "$SB/worker" "join uat-team"
	grep -q '"name": "worker-a"' "$SB/orgdata/uat-team/org.json" && { echo "FAIL: 回归未经三选一即加入"; exit 1; }
	# --inherit → 恢复 active
	run_org_cmd "$SB/worker" "join uat-team --inherit"
	grep -q '"name": "worker-a"' "$SB/orgdata/uat-team/org.json" || { echo "FAIL: --inherit 未恢复成员"; exit 1; }

	# ⑥ chief /org delete uat-team → 归档 .trash（glob 无匹配=归档失败，打印 orgdata 现场）
	run_org_cmd "$SB/chief" "delete uat-team"
	if ! compgen -G "$SB/orgdata/.trash/uat-team-*" >/dev/null; then
		echo "FAIL: 未归档到 .trash；orgdata 内容：$(ls -a "$SB/orgdata" 2>&1 | tr '\n' ' ')"
		exit 1
	fi

	echo "PASS: org 生命周期命令全通过（账本文件断言）"
	exit 0
TEST

# ── 用例 3：编排闭环（chief 派发 → worker 收 → 交付 → 验收关闭）────────────
test_it "编排闭环：派发落账 → worker claim/report → chief approve → closed 终态" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	cleanup() { cleanup_sandbox; }
	trap cleanup EXIT

	# ① seed：建 org + 双方加入（tsx 直调，与命令等价的数据路径）
	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	if ! ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1; then
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	fi

	# ② chief fleet 视图（执行无错即可；在岗判定由 runtime 文件断言）
	run_org_cmd "$SB/chief" "fleet uat-team"

	# 用 tsx 直调 dispatchTask（与 dispatch_task 工具同一数据路径，chief 单方）
	cat >"$SB/dispatch.mts" <<EOF
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
const res = await dispatchTask({
  org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
  title: '调研 pi 扩展加载机制', background: '需要一份报告',
  items: ['确认加载路径', '整理 jiti 缓存失效触发条件'],
  targets: [{ agent: 'worker-a', description: '产出调研报告', dueAt: null }],
});
console.log('TASK:', res.task.id, '| deliveries:', res.deliveries[0].mode);
EOF
	TASKLINE=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/dispatch.mts" 2>/dev/null | sed -n 's/^TASK: //p') || true
	TASK_ID=$(echo "$TASKLINE" | awk '{print $1}')
	if [[ -z "$TASK_ID" ]]; then echo "FAIL: dispatch 失败"; exit 1; fi
	[[ "$TASKLINE" == *inbox* ]] || [[ "$TASKLINE" == *unreachable* ]] || { echo "FAIL: worker 离线应入 inbox（got: $TASKLINE）"; exit 1; }
	[[ -f "$SB/orgdata/uat-team/tasks/$TASK_ID.json" ]] || { echo "FAIL: 任务未落账"; exit 1; }
	# 从任务文件取子任务编号
	SUB_ID=$(grep -o '"id": "S-[a-z0-9]*"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" | head -1 | sed 's/"id": "//;s/"//')

	# ③ worker my-tasks 命令执行无错
	run_org_cmd "$SB/worker" "my-tasks uat-team"

	# ④ worker claim（账本 → claimed）→ report（账本 → delivered + 交付内容落账）
	run_org_cmd "$SB/worker" "claim $TASK_ID $SUB_ID"
	grep -q '"status": "claimed"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: claim 未生效"; exit 1; }
	run_org_cmd "$SB/worker" "report $TASK_ID $SUB_ID 调研完成 结论见报告 --file docs/report.md:12-45"
	grep -q '"status": "delivered"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: report 未生效"; exit 1; }
	grep -q '调研完成' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 交付摘要未落账（可指认）"; exit 1; }

	# ⑤ chief approve → closed 终态 + 验收记录
	run_org_cmd "$SB/chief" "approve $TASK_ID 质量达标"
	grep -q '"status": "closed"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 任务未 closed"; exit 1; }
	grep -q '"result": "accepted"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 验收记录缺失"; exit 1; }

	# ⑥ 终态铁律：closed 后再 approve 被拒（账本保持 closed + accepted 不追加）
	grep -q '"result": "accepted"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 终态被破坏"; exit 1; }
	run_org_cmd "$SB/chief" "approve $TASK_ID"
	grep -q '"result": "accepted"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 终态被破坏"; exit 1; }

	echo "PASS: 编排闭环（派发→交付→验收→终态铁律）"
	exit 0
TEST

# ── 用例 4：非 chief 握手闭环（member 派发 → accept → 交付 → member 验收）──────
test_it "非 chief 握手闭环：member 派发 → worker-b /org accept → report → 派发人 approve → closed" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	cleanup() { cleanup_sandbox; }
	trap cleanup EXIT
	# 第三名成员 worker-b（非 chief 派发与握手需要两方成员）
	mkdir -p "$SB/worker-b"
	echo '{ "name": "worker-b", "role": "member" }' >"$SB/worker-b/pi.agent.json"
	echo "# worker-b — org member" >"$SB/worker-b/AGENTS.md"

	# ① seed：chief-1 + worker-a + worker-b（worker-a 为 member，派发需握手）
	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
await joinOrg('uat-team', { manifest: { name: 'worker-b', role: 'member' }, dir: '$SB/worker-b' });
console.log('SEED-DONE');
EOF
	if ! ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1; then
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	fi

	# ② worker-a（member，非负责人）派发 → 需握手；worker-b 离线 → 请求入 inbox
	cat >"$SB/dispatch.mts" <<EOF
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
const res = await dispatchTask({
  org: 'uat-team', dispatcher: 'worker-a', dispatcherRole: 'member',
  title: '整理会议纪要', background: '例会产出需要归档',
  items: ['整理要点', '归档到 docs/'],
  targets: [{ agent: 'worker-b', description: '产出纪要文档', dueAt: null }],
});
console.log('TASK:', res.task.id, '| requesting:', res.deliveries[0].requesting, '| mode:', res.deliveries[0].mode);
EOF
	TASKLINE=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/dispatch.mts" 2>/dev/null | sed -n 's/^TASK: //p') || true
	TASK_ID=$(echo "$TASKLINE" | awk '{print $1}')
	if [[ -z "$TASK_ID" ]]; then echo "FAIL: member 派发失败"; exit 1; fi
	# member 派发必须走握手（requesting=true）
	[[ "$TASKLINE" == *"requesting: true"* ]] || { echo "FAIL: 非 chief 派发未进入握手（got: $TASKLINE）"; exit 1; }
	# worker-b 离线 → 握手请求入其 inbox
	compgen -G "$SB/orgdata/uat-team/inbox/worker-b/*.json" >/dev/null || { echo "FAIL: 握手请求未入 inbox"; exit 1; }

	# ③ worker-b /org accept → 账本 claimed（handshake accept）+ history accepted
	SUB_ID=$(grep -o '"id": "S-[a-z0-9]*"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" | head -1 | sed 's/"id": "//;s/"//')
	run_org_cmd "$SB/worker-b" "accept $TASK_ID $SUB_ID"
	grep -q '"status": "claimed"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: accept 未生效（未 claimed）"; exit 1; }
	grep -q '"event": "accepted"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: accept 未留痕"; exit 1; }

	# ④ worker-b report → delivered
	run_org_cmd "$SB/worker-b" "report $TASK_ID $SUB_ID 纪要已归档 --file docs/notes.md:1-40"
	grep -q '"status": "delivered"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: report 未生效"; exit 1; }

	# ⑤ 派发人 worker-a approve → closed（member 也能验收自己的任务）
	run_org_cmd "$SB/worker" "approve $TASK_ID 内容合格"
	grep -q '"status": "closed"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: member 验收未关闭任务"; exit 1; }
	grep -q '"result": "accepted"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 验收记录缺失"; exit 1; }

	echo "PASS: 非 chief 握手闭环（派发→accept→交付→member 验收关闭）"
	exit 0
TEST

# ── 用例 5：握手 reject（带原因剔除子任务，其余照常闭环）────────────────────
test_it "握手 reject：member 派发双子任务 → worker-b 拒 S2（带原因）→ S1 照常交付关闭" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	cleanup() { cleanup_sandbox; }
	trap cleanup EXIT
	mkdir -p "$SB/worker-b"
	echo '{ "name": "worker-b", "role": "member" }' >"$SB/worker-b/pi.agent.json"
	echo "# worker-b — org member" >"$SB/worker-b/AGENTS.md"

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
await joinOrg('uat-team', { manifest: { name: 'worker-b', role: 'member' }, dir: '$SB/worker-b' });
console.log('SEED-DONE');
EOF
	if ! ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1; then
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	fi

	# ② worker-a 派两个子任务给 worker-b
	cat >"$SB/dispatch.mts" <<EOF
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
const res = await dispatchTask({
  org: 'uat-team', dispatcher: 'worker-a', dispatcherRole: 'member',
  title: '双交付任务', background: '两个独立子任务',
  items: ['子项 A', '子项 B'],
  targets: [
    { agent: 'worker-b', description: '整理周报', dueAt: null },
    { agent: 'worker-b', description: '整理月报', dueAt: null },
  ],
});
console.log('TASK:', res.task.id);
EOF
	TASKLINE=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/dispatch.mts" 2>/dev/null | sed -n 's/^TASK: //p') || true
	TASK_ID=$(echo "$TASKLINE" | awk '{print $1}')
	if [[ -z "$TASK_ID" ]]; then echo "FAIL: 派发失败"; exit 1; fi
	# 两个子任务编号
	SUBS="$(grep -o '"id": "S-[a-z0-9]*"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" | sed 's/"id": "//;s/"//' | tr '\n' ' ')"
	# shellcheck disable=SC2086
	set -- $SUBS
	[[ $# -eq 2 ]] || { echo "FAIL: 双子任务未建齐（got $#）"; exit 1; }
	SUB1="$1"
	SUB2="$2"

	# ③ worker-b accept S1；reject S2（必须带原因）
	run_org_cmd "$SB/worker-b" "accept $TASK_ID $SUB1"
	run_org_cmd "$SB/worker-b" "reject $TASK_ID $SUB2 已有同类产出 无需重复"
	grep -q '"status": "claimed"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: S1 accept 未生效"; exit 1; }
	grep -q '"status": "rejected"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: S2 未剔除（rejected）"; exit 1; }
	grep -q '"event": "rejected"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 拒绝未留痕"; exit 1; }
	grep -q '无需重复' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 拒绝原因未记录"; exit 1; }
	# 派发人（worker-a）收拒绝通知
	compgen -G "$SB/orgdata/uat-team/inbox/worker-a/*.json" >/dev/null || { echo "FAIL: 派发人未收到拒绝通知"; exit 1; }
	grep -rlq '拒绝了子任务' "$SB/orgdata/uat-team/inbox/worker-a/" || { echo "FAIL: 拒绝通知内容缺失"; exit 1; }

	# ④ S1 照常：report → worker-a approve → closed（被拒子任务不阻塞）
	run_org_cmd "$SB/worker-b" "report $TASK_ID $SUB1 周报完成"
	grep -q '"status": "delivered"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: S1 report 未生效"; exit 1; }
	run_org_cmd "$SB/worker" "approve $TASK_ID 收尾"
	grep -q '"status": "closed"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 被拒子任务阻塞了关闭"; exit 1; }

	echo "PASS: 握手 reject 剔除 + 其余照常闭环"
	exit 0
TEST

# ── 用例 6：多人情形 B（采纳已交付者 → 其余参与者被叫停 + inbox 通知）────────
test_it "多人情形 B：chief 派发 + reassign 加参与者 → a 交付 → approve 采纳关闭 → b 被叫停" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	cleanup() { cleanup_sandbox; }
	trap cleanup EXIT
	mkdir -p "$SB/worker-b"
	echo '{ "name": "worker-b", "role": "member" }' >"$SB/worker-b/pi.agent.json"
	echo "# worker-b — org member" >"$SB/worker-b/AGENTS.md"

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
await joinOrg('uat-team', { manifest: { name: 'worker-b', role: 'member' }, dir: '$SB/worker-b' });
console.log('SEED-DONE');
EOF
	if ! ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1; then
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	fi

	# ② chief-1 派发单子任务给 worker-a
	cat >"$SB/dispatch.mts" <<EOF
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
const res = await dispatchTask({
  org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
  title: '竞速产出方案', background: '多人竞争同一份产出（情形 B）',
  items: ['产出方案文档'],
  targets: [{ agent: 'worker-a', description: '产出方案 v1', dueAt: null }],
});
console.log('TASK:', res.task.id);
EOF
	TASKLINE=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/dispatch.mts" 2>/dev/null | sed -n 's/^TASK: //p') || true
	TASK_ID=$(echo "$TASKLINE" | awk '{print $1}')
	if [[ -z "$TASK_ID" ]]; then echo "FAIL: 派发失败"; exit 1; fi
	SUB_ID=$(grep -o '"id": "S-[a-z0-9]*"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" | head -1 | sed 's/"id": "//;s/"//')

	# ③ chief 把 worker-b 加为同一子任务的参与者（改派=添加参与人，非替换）
	run_org_cmd "$SB/chief" "reassign $TASK_ID $SUB_ID worker-b"
	grep -q '"agent": "worker-b"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 参与者未添加"; exit 1; }

	# ④ worker-a claim + report → delivered（b 仍 invited 未做）
	run_org_cmd "$SB/worker" "claim $TASK_ID $SUB_ID"
	run_org_cmd "$SB/worker" "report $TASK_ID $SUB_ID 方案 v1 完成 --file docs/plan.md"
	grep -q '"status": "delivered"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: a 交付未生效"; exit 1; }

	# ⑤ chief approve → 采纳 a 并关闭；b 被叫停（stopped）+ 收到「无需继续」通知
	run_org_cmd "$SB/chief" "approve $TASK_ID 采纳 worker-a 方案"
	grep -q '"status": "closed"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 任务未关闭"; exit 1; }
	grep -q '"stopped": true' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: worker-b 未被叫停"; exit 1; }
	grep -q '"result": "accepted"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: 验收记录缺失"; exit 1; }
	compgen -G "$SB/orgdata/uat-team/inbox/worker-b/*.json" >/dev/null || { echo "FAIL: worker-b 未收到叫停通知"; exit 1; }
	grep -rlq '无需继续' "$SB/orgdata/uat-team/inbox/worker-b/" || { echo "FAIL: 叫停通知内容缺失"; exit 1; }

	echo "PASS: 多人情形 B（采纳关闭 + 其余叫停 + inbox 通知）"
	exit 0
TEST
