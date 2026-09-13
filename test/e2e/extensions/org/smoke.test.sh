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
#   7. 成员生命周期：唤醒(tmux) → 在线投递 → 幂等 → 睡眠(落 last-session) → 再唤醒续接同会话
#   8. 在岗门控 + 在岗简报：工具/技能可见面与简报注入都受在岗约束（ADR-0041/0042）
#   9. 告知通道：未在岗 / 非成员的告知**不进 LLM 上下文**，只走状态栏（ADR-0047；人类可见面见 tui-expect）
#  10. 多 agent 全自主闭环：A 派发 → B 认领/交付 → A 验收 → closed（ADR-0045 D2，双进程 + 脚本化 mock）
#  15. 成员启动参数：join 写初值 → 唤醒后真实进程命令行带上（ADR-0051）
#  16. 唤醒即接手：睡眠成员的 inbox 待办在唤醒后被自己领走（ADR-0054 D3/D11）
#  17. 串行执行约束：排队上限拒收 + 逾期标记与通知派发人 + 紧急插话可达（ADR-0055 D3/D4/D6）
#  18. 成员动态跨进程：真实 control 的 get_history 可取回 + 不可达降级（ADR-0052 D1/D2/D8）
#  19. 硬抢占（abort）与重试：真实停在跑的轮次 + 会话不被破坏 + 重投（ADR-0053 D1/D5）
#  20. 在岗自愈：运行期落 inbox 被消化并触发，且无待办不白烧（ADR-0054 D4/D5/D11）
#  21. 取消两态：未领取直接撤销 / 已领取须处理人同意（consent-cancel）
#  22. 返工环（真实成员）：交付→打回→再领再交→验收 closed（waiting_accept/returned/rejected_returned/round）
#  23. 执行槽生命周期（真实成员）：一次只做一件 → 交付释放 → 取消后放行（ADR-0055 D1/D2 回归）
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
	# 技能随扩展目录分发（pi.skills 已移除，改由 resources_discover 仅在岗贡献）
	cp -R "$R/extensions/auto/org/skills" "$SB/home/.pi/agent/extensions/org/" 2>/dev/null || true
	cp "$R/test/e2e/helpers/mock-llm.ts" "$SB/home/.pi/agent/extensions/mock-llm/index.ts" 2>/dev/null || true
	ln -sfn "$R/extensions/meta/pi-logger" "$SB/home/.pi/agent/node_modules/@zenone/pi-logger"
	# 界面偏好走 @zenone/pi-config（用户级；ADR-0048）→ 沙箱必须链接该本地包
	ln -sfn "$R/extensions/meta/pi-config" "$SB/home/.pi/agent/node_modules/@zenone/pi-config"
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
	if [[ "${ORG_E2E_KEEP:-}" == "1" ]]; then
		echo "KEEP-SANDBOX: $SB"
		return 0
	fi
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

# 唤醒类用例失败时把现场打出来（只看"没带参数"无法判断是没起来还是读错了进程）
dump_wake_state() { # $1=SB $2=session $3=pid
	echo "--- tmux panes ---"
	tmux list-panes -t "$2" -F '#{pane_pid} dead=#{pane_dead} cmd=#{pane_current_command}' 2>&1 | head -3
	echo "--- ps（pane_pid）---"
	ps -o pid,ppid,command= -p "${3:-0}" 2>/dev/null | head -3
	echo "--- ps（子进程）---"
	for c in $(pgrep -P "${3:-0}" 2>/dev/null | head -5); do ps -o pid,ppid,command= -p "$c"; done
	echo "--- pane 内容（尾部）---"
	tmux capture-pane -p -t "$2" 2>&1 | tail -12
	echo "--- 唤醒/启动相关日志 ---"
	grep -rh "唤醒\|成员进程\|启动参数" "$1/home/.pi/logs" "$1/chief/.pi/logs" 2>/dev/null | tail -8
}

# 开启某组织的「自动唤醒」开关（/org wake 的前置门禁）。
# 这是**测试前置**、不是被测行为：被测的是"唤醒真的把进程拉起来且活着"，
# 所以开关用 tsx 直接置位，避免"打开关"的动作混进断言。
seed_autowake() { # $1=SB $2=org
	cat >"$1/autowake.mts" <<EOF
import { setAutoWake } from '$ROOT_DIR/extensions/auto/org/orgstore.ts';
await setAutoWake('$2', true);
EOF
	(
		cd "$1/chief" &&
			HOME="$1/home" ORG_ROOT="$1/orgdata" npx --prefix "$ROOT_DIR" tsx "$1/autowake.mts"
	) >"$1/autowake.log" 2>&1 || {
		echo "FAIL: 开启自动唤醒失败"
		tail -5 "$1/autowake.log"
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
	[[ "$TASKLINE" == *inbox* ]] || [[ "$TASKLINE" == *unreachable* ]] || { echo "FAIL: worker 离线应入 inbox（got: ${TASKLINE}）"; exit 1; }
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
	[[ "$TASKLINE" == *"requesting: true"* ]] || { echo "FAIL: 非 chief 派发未进入握手（got: ${TASKLINE}）"; exit 1; }
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

	# ④ S1 照常：report（命令面缺省子任务号 → 回退名下唯一进行中的 S1）→ worker-a approve → closed
	run_org_cmd "$SB/worker-b" "report $TASK_ID 周报完成"
	grep -q '"status": "delivered"' "$SB/orgdata/uat-team/tasks/$TASK_ID.json" || { echo "FAIL: S1 report（缺省子任务号）未生效"; exit 1; }
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

# ── 用例 7：成员生命周期（真实 tmux + 真实 pi + 真实控制 socket）─────────────
test_it "成员生命周期：唤醒(tmux) → 在线投递 → 幂等 → 睡眠(落 last-session) → 再唤醒续接同会话" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 唤醒路径已由 vitest 的 tmux 原语测试覆盖（newDetachedSession/hasSession/killSession）"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	SESSION="org-uat-team-worker-a"
	cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	# 成员进程需要控制 socket（由 control 扩展按 --session-control 创建）——沙箱必须也放它
	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	if ! ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1; then
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	fi

	cat >"$SB/life.mts" <<EOF
import { stopMember, wakeMember, waitForOnline, readLastSession } from '$R/extensions/auto/org/lifecycle.ts';
import { readRuntime } from '$R/extensions/auto/org/presence.ts';
import { deliverMessage } from '$R/extensions/auto/org/dispatch.ts';
const ORG = 'uat-team', self = '$SB/chief';
const say = (k: string, v: unknown) => console.log('STEP', k, JSON.stringify(v));
say('wake1', await wakeMember(ORG, 'worker-a', { selfDir: self }));
say('online1', await waitForOnline(ORG, 'worker-a', 40000));
const rt1 = await readRuntime(ORG, 'worker-a');
say('runtime1', { pid: rt1?.pid, sessionId: rt1?.sessionId });
say('deliver1', await deliverMessage(ORG, 'worker-a', 'e2e: 在岗确认'));
say('wake2', await wakeMember(ORG, 'worker-a', { selfDir: self }));
say('stop', await stopMember(ORG, 'worker-a', { selfDir: self }));
say('lastsession', await readLastSession(ORG, 'worker-a'));
say('wake3', await wakeMember(ORG, 'worker-a', { selfDir: self }));
say('online3', await waitForOnline(ORG, 'worker-a', 40000));
say('session3', (await readRuntime(ORG, 'worker-a'))?.sessionId ?? null);
say('stop_final', await stopMember(ORG, 'worker-a', { selfDir: self }));
EOF
	LOG="$SB/life.log"
	if ! ORG_ROOT="$SB/orgdata" HOME="$SB/home" npx --prefix "$R" tsx "$SB/life.mts" >"$LOG" 2>&1; then
		echo "FAIL: 生命周期链路执行失败"; tail -25 "$LOG"; exit 1
	fi
	step() { sed -n "s/^STEP $1 //p" "$LOG" | tail -1; }

	# ① 人类唤醒 → 成员在岗（socket 可连）
	[[ "$(step online1)" == "true" ]] || { echo "FAIL: 唤醒后未在岗（$(step online1)）"; tail -20 "$LOG"; exit 1; }
	# ② 在岗即可经控制 socket 投递（不经 inbox）
	[[ "$(step deliver1)" == '"online"' ]] || { echo "FAIL: 在线投递未走控制 socket（$(step deliver1)）"; exit 1; }
	# ③ 幂等：重复唤醒跳过（不重复拉起进程）
	grep -q '"skipped":"online"' <<<"$(step wake2)" || { echo "FAIL: 重复唤醒未幂等跳过（$(step wake2)）"; exit 1; }
	# ④ 睡眠：杀前落 last-session；停后 runtime 清空、tmux 会话关闭
	grep -q '"stopped":true' <<<"$(step stop)" || { echo "FAIL: 睡眠未成功（$(step stop)）"; exit 1; }
	SID1=$(sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' <<<"$(step lastsession)")
	[[ -n "$SID1" ]] || { echo "FAIL: 睡眠未落 last-session"; exit 1; }
	[[ ! -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] || { echo "FAIL: 睡眠后 runtime 仍残留"; exit 1; }
	tmux has-session -t "$SESSION" 2>/dev/null && { echo "FAIL: 睡眠后 tmux 会话仍在"; exit 1; }
	# ⑤ 再次唤醒 → 续接**同一个会话**（--session-id 生效）
	SID2=$(sed -n 's/^"\(.*\)"$/\1/p' <<<"$(step session3)")
	[[ "$(step online3)" == "true" ]] || { echo "FAIL: 二次唤醒未在岗"; exit 1; }
	[[ -n "$SID2" && "$SID1" == "$SID2" ]] || {
		echo "FAIL: 唤醒未续接上次会话（last=$SID1 vs now=${SID2}）"; exit 1
	}
	echo "PASS: 成员生命周期全链路（唤醒→在线投递→幂等→睡眠→续接唤醒；会话 ${SID1}）"
	exit 0
TEST

# 解析探针 jsonl 的**首条**记录并按 JS 表达式断言（obj = 该记录）。
# 记录形如 { tools, skillNames, systemPrompt, prompt }。
assert_surface() { # $1=jsonl $2=表达式
	node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8").trim().split("\n")[0]);process.exit(eval(process.argv[2])?0:1)' "$1" "$2"
}

# 从单一事实来源 `capability.ts` 抽出 org 工具名单（与真实注册比对，防「新增工具忘同步常量」的漂移）
org_tool_names() {
	sed -n '/export const ORG_TOOL_NAMES/,/\]/p' "$ROOT_DIR/extensions/auto/org/capability.ts" |
		grep -o "'[a-z_]*'" | tr -d "'" | tr '\n' ' '
}

# 断言探针首条记录里的 org 工具集合 === 给定名单（空格分隔）
assert_org_tools() { # $1=jsonl $2=期望列表
	node -e '
const fs=require("fs");
const expected=process.argv[2].split(/\s+/).filter(Boolean).sort();
const rec=JSON.parse(fs.readFileSync(process.argv[1],"utf8").trim().split("\n")[0]);
const actual=(rec.tools||[]).filter((t)=>t.startsWith("org_")||t==="dispatch_task").sort();
if(JSON.stringify(actual)!==JSON.stringify(expected)){
  console.error("  expected:",JSON.stringify(expected));
  console.error("  actual:  ",JSON.stringify(actual));
  process.exit(1);
}' "$1" "$2"
}

# 断言 jsonl 里**任一** context 记录的 contextText 含某子串（成员消息 / 发送者头断言用）。
# 用"任一条"而非"首条"：context 记录每轮 LLM 请求都会追加一条。
context_contains() { # $1=jsonl $2=子串
	node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean);
const hit=lines.some(l=>{try{const o=JSON.parse(l);return typeof o.contextText==="string"&&o.contextText.includes(process.argv[2])}catch{return false}});
process.exit(hit?0:1)' "$1" "$2"
}

# ── 用例 7：在岗门控（ADR-0041 D1/D2）──────────────────────────────────────
# 未带 --session-control 的 pi 不是该成员的在岗进程：不写 runtime、org 工具对 LLM 不可见。
# 断言手段：llm-surface-dump 探针在 agent_start 抓 ctx.getSystemPrompt()（最终系统提示）+ 激活工具 + 已加载技能 + 用户轮次文本。
test_it "在岗门控 + 在岗简报：工具/技能可见面与简报注入都受在岗约束" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	cleanup() { cleanup_sandbox; }
	trap cleanup EXIT

	# control（socket）+ llm-surface-dump（LLM 可见面探针）
	mkdir -p "$SB/home/.pi/agent/extensions/control" "$SB/home/.pi/agent/extensions/llm-surface-dump"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true
	cp "$R/test/e2e/helpers/llm-surface-dump.ts" "$SB/home/.pi/agent/extensions/llm-surface-dump/index.ts"

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	if ! ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1; then
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	fi

	# ① 未带 flag：无 runtime、payload 中无 org 工具
	(cd "$SB/worker" && LLM_SURFACE_DUMP_FILE="$SB/off.jsonl" HOME="$SB/home" ORG_ROOT="$SB/orgdata" \
		pi -a --no-session -p "hi") >"$SB/off.log" 2>&1 || true
	[[ ! -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] || { echo "FAIL: 未带 flag 却写了在岗注册"; exit 1; }
	[[ -s "$SB/off.jsonl" ]] || { echo "FAIL: 探针未抓到 provider payload"; tail -10 "$SB/off.log"; exit 1; }
	grep -q 'dispatch_task' "$SB/off.jsonl" && { echo "FAIL: 未带 flag 时 org 工具对 LLM 可见"; exit 1; }
	grep -q 'org_wake' "$SB/off.jsonl" && { echo "FAIL: 未带 flag 时 org_wake 对 LLM 可见"; exit 1; }
	assert_org_tools "$SB/off.jsonl" "" || { echo "FAIL: 未在岗却注册了 org 工具"; exit 1; }
	grep -q 'org_wake' "$SB/off.jsonl" && { echo "FAIL: 未带 flag 时 org_wake 对 LLM 可见"; exit 1; }
	assert_org_tools "$SB/off.jsonl" "" || { echo "FAIL: 未在岗却注册了 org 工具"; exit 1; }
	# 技能同样门控：未在岗看不到任何 org 技能
	if ! assert_surface "$SB/off.jsonl" '!r.skillNames.some(n=>n.startsWith("org-"))'; then
		echo "FAIL: 未在岗却看到 org 技能"; node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8").trim().split("\n")[0]);console.log("  skillNames=",JSON.stringify(r.skillNames))' "$SB/off.jsonl"; exit 1
	fi
	# 简报也不该出现：静态块不在系统提示、动态块不在用户轮次
	assert_surface "$SB/off.jsonl" '!r.systemPrompt.includes("[org 在岗简报]")' || { echo "FAIL: 未在岗却有静态简报"; exit 1; }
	assert_surface "$SB/off.jsonl" '!r.prompt.includes("[org]")' || { echo "FAIL: 未在岗却有动态简报"; exit 1; }

	# ② 带 flag：写在岗注册、payload 中 org 工具可见
	(cd "$SB/worker" && LLM_SURFACE_DUMP_FILE="$SB/on.jsonl" HOME="$SB/home" ORG_ROOT="$SB/orgdata" \
		pi -a --no-session --session-control -p "hi") >"$SB/on.log" 2>&1 || true
	[[ -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] || { echo "FAIL: 带 flag 未写在岗注册"; tail -10 "$SB/on.log"; exit 1; }
	grep -q 'dispatch_task' "$SB/on.jsonl" || { echo "FAIL: 带 flag 时 org 工具仍不可见"; tail -5 "$SB/on.jsonl"; exit 1; }
	# 真实注册集合 === ORG_TOOL_NAMES（capability.ts 单一事实来源）：新增工具忘同步常量即此处 FAIL
	assert_org_tools "$SB/on.jsonl" "$(org_tool_names)" || {
		echo "FAIL: 在岗工具集合与 ORG_TOOL_NAMES 漂移（index.ts 注册 / 活动集 / 常量不一致）"
		exit 1
	}
	# 真实注册集合 === ORG_TOOL_NAMES（capability.ts 单一事实来源）：新增工具忘同步常量即此处 FAIL
	assert_org_tools "$SB/on.jsonl" "$(org_tool_names)" || {
		echo "FAIL: 在岗工具集合与 ORG_TOOL_NAMES 漂移（index.ts 注册 / 活动集 / 常量三者不一致）"; exit 1
	}

	# 技能：按角色贡献——成员拿到 org-member（+org-recover），拿不到 org-chief
	assert_surface "$SB/on.jsonl" 'r.skillNames.includes("org-member")' || { echo "FAIL: 在岗成员技能里没有 org-member"; exit 1; }
	assert_surface "$SB/on.jsonl" '!r.skillNames.includes("org-chief")' || { echo "FAIL: 成员不该拿到 org-chief"; exit 1; }

	# 静态简报：系统提示里含定位 + 组织背景 + 角色指路
	assert_surface "$SB/on.jsonl" 'r.systemPrompt.includes("[org 在岗简报]")' || { echo "FAIL: 系统提示缺静态简报"; exit 1; }
	assert_surface "$SB/on.jsonl" 'r.systemPrompt.includes("uat-team / 成员（worker-a）")' || { echo "FAIL: 静态简报缺定位"; exit 1; }

	# 动态简报：追在用户轮次尾部（名字+状态+计数，不含简介）
	assert_surface "$SB/on.jsonl" 'r.prompt.includes("[org] uat-team · 我：成员 worker-a")' || { echo "FAIL: 用户轮次尾部缺动态简报"; exit 1; }
	assert_surface "$SB/on.jsonl" 'r.prompt.includes("在岗（") && r.prompt.includes("未结：我派")' || { echo "FAIL: 动态简报内容不完整"; exit 1; }

	echo "PASS: 在岗门控（runtime 落盘 + LLM 可见面）"
	exit 0
TEST

# ── 用例 9：告知通道（ADR-0047 D1/D2 → 保护 ADR-0046 D5）───────────────────
# 曾经的 `org-off-duty` 卡片会被 pi 的 convertToLlm 转成 role:"user"，此后**每一轮**
# 都带着这条系统告知进上下文。现在改为状态栏常驻告知：模型上下文里**不应再有**它。
# 人类可见面（状态栏三态文案）由 tui-expect.smoke.test.sh 覆盖（print 模式无 UI）。
test_it "未在岗 / 非成员的告知不进 LLM 上下文（只走状态栏）" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	cleanup() { cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control" "$SB/home/.pi/agent/extensions/llm-surface-dump"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true
	cp "$R/test/e2e/helpers/llm-surface-dump.ts" "$SB/home/.pi/agent/extensions/llm-surface-dump/index.ts"

	# 非成员目录
	mkdir -p "$SB/outsider"
	echo '{ "name": "outsider", "role": "member" }' >"$SB/outsider/pi.agent.json"

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	if ! ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1; then
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	fi

	# ① 成员目录但未在岗：探针必须抓到上下文（脚本有效），且其中**没有**未在岗告知
	(cd "$SB/worker" && LLM_SURFACE_DUMP_FILE="$SB/member.jsonl" HOME="$SB/home" ORG_ROOT="$SB/orgdata" \
		pi -a --no-session -p "hi") >"$SB/member.log" 2>&1 || true
	[[ -s "$SB/member.jsonl" ]] || { echo "FAIL: 探针未抓到上下文（成员目录）"; tail -10 "$SB/member.log"; exit 1; }
	if context_contains "$SB/member.jsonl" "未在岗"; then
		echo "FAIL: 未在岗告知污染了 LLM 上下文（应只走状态栏，ADR-0047）"; exit 1
	fi
	if grep -q 'org-off-duty' "$SB/member.jsonl"; then
		echo "FAIL: 上下文里仍有 org-off-duty 自定义消息"; exit 1
	fi

	# ② 非成员目录：同样不给模型塞告知（人的可见性由状态栏承担）
	(cd "$SB/outsider" && LLM_SURFACE_DUMP_FILE="$SB/outsider.jsonl" HOME="$SB/home" ORG_ROOT="$SB/orgdata" \
		pi -a --no-session -p "hi") >"$SB/outsider.log" 2>&1 || true
	[[ -s "$SB/outsider.jsonl" ]] || { echo "FAIL: 探针未抓到上下文（非成员目录）"; exit 1; }
	if context_contains "$SB/outsider.jsonl" "未加入任何 org"; then
		echo "FAIL: 非成员告知污染了 LLM 上下文（应只走状态栏，ADR-0047）"; exit 1
	fi

	echo "PASS: 告知通道（未在岗 / 非成员都不进上下文）"
	exit 0
TEST

# ── 用例 10：多 agent **全自主**闭环（ADR-0045 L3，本 ADR 的核心）─────────────
# 两个**真实 pi 进程**（tmux、--session-control、各自 cwd 为成员），mock-LLM 按脚本注入
# 工具调用；人类只对 A 发**一条**指令。验证 A2–A5：派发 / 认领 / 交付 / 验收都由
# **agent 自主决策**（而非测试脚本直调函数）。
# 断言一律落**账本 + 模型可见面**，不 grep 屏幕文本；多进程一律轮询到条件。
test_it "全自主闭环：A(chief) 派发 → B(worker) 认领+交付 → A 验收 → 账本 closed" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 全自主闭环需要真实多进程 PTY"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	SA="org-auto-chief"
	SW="org-auto-worker"
	cleanup() {
		tmux kill-session -t "$SA" 2>/dev/null || true
		tmux kill-session -t "$SW" 2>/dev/null || true
		cleanup_sandbox
	}
	trap cleanup EXIT

	# control（socket）+ llm-surface-dump（模型可见面探针）
	mkdir -p "$SB/home/.pi/agent/extensions/control" "$SB/home/.pi/agent/extensions/llm-surface-dump"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true
	cp "$R/test/e2e/helpers/llm-surface-dump.ts" "$SB/home/.pi/agent/extensions/llm-surface-dump/index.ts"

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	if ! ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1; then
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	fi

	# A 的剧本：派发 → 收尾 → （收到交付通知后）验收 → 收尾
	A_SCRIPT='[{"tool":"dispatch_task","args":{"org":"uat-team","title":"自主闭环 e2e","background":"验证 agent 自主闭环","items":["写一句话"],"targets":[{"agent":"worker-a","description":"写一句话"}]}},{"text":"已派发，等待交付。"},{"tool":"org_review","args":{"taskId":"{{taskId}}","result":"accepted","note":"自主验收"}},{"text":"已验收关闭。"}]'
	# B 的剧本：认领 → 交付 → 收尾（同一条 turn 内连续两次工具调用）
	B_SCRIPT='[{"tool":"org_claim","args":{"taskId":"{{taskId}}"}},{"tool":"org_report","args":{"taskId":"{{taskId}}","summary":"已完成：一句话。"}},{"text":"已交付。"}]'

	# 注意：**不能**把 stdout 重定向到文件——`pi -a` 是 TUI，需要 PTY；
	# 重定向会让它失去 TTY 并立即退出（tmux.ts 顶部记录过这条实测）。
	start_agent() { # $1=tmux 会话名 $2=工作目录 $3=脚本 $4=探针输出
		tmux new-session -d -s "$1" -c "$2" \
			"env HOME=$SB/home ORG_ROOT=$SB/orgdata MOCK_LLM_TOOL_SCRIPT='$3' LLM_SURFACE_DUMP_FILE=$4 pi -a --session-control"
	}
	dump_pane() { # $1=会话名：失败取证（TUI 画面）
		echo "--- pane $1 ---"
		tmux capture-pane -p -t "$1" 2>/dev/null | tail -25 || true
	}
	start_agent "$SA" "$SB/chief" "$A_SCRIPT" "$SB/a.jsonl"
	start_agent "$SW" "$SB/worker" "$B_SCRIPT" "$SB/b.jsonl"

	wait_runtime() { # $1=成员名：等它写在岗注册
		for _ in $(seq 1 160); do
			[[ -f "$SB/orgdata/uat-team/runtime/$1.json" ]] && return 0
			sleep 0.5
		done
		return 1
	}
	wait_runtime chief-1 || { echo "FAIL: chief 未在岗"; dump_pane "$SA"; exit 1; }
	wait_runtime worker-a || { echo "FAIL: worker-a 未在岗"; dump_pane "$SW"; exit 1; }

	# 人类：只发一条指令
	tmux send-keys -t "$SA" "把任务派给 worker-a：写一句话" Enter

	# 轮询账本直到 closed（断言口径 = 账本，不看屏幕）
	TASKDIR="$SB/orgdata/uat-team/tasks"
	STATE=""
	for _ in $(seq 1 300); do
		F=$(ls "$TASKDIR"/*.json 2>/dev/null | head -1 || true)
		if [[ -n "$F" ]]; then
			STATE=$(node -e 'const t=require(process.argv[1]);process.stdout.write(String(t.status)+" "+t.history.map(h=>h.event).join(","))' "$F" 2>/dev/null || echo "")
			[[ "$STATE" == closed* ]] && break
		fi
		sleep 0.5
	done

	if [[ "$STATE" != closed* ]]; then
		echo "FAIL: 任务未到 closed（当前：${STATE:-无账本}）"
		echo "--- A 模型可见面 ---"; tail -2 "$SB/a.jsonl" 2>/dev/null || true
		dump_pane "$SA"
		dump_pane "$SW"
		exit 1
	fi

	# 自主性断言：四个事件都由 agent 决策产生（而非脚本直调）
	for ev in dispatched claimed delivered; do
		grep -q "$ev" <<<"$STATE" || { echo "FAIL: 账本缺少 ${ev}（${STATE}）"; exit 1; }
	done

	# ADR-0044：成员消息带发送者头，且对**模型可见**（B 收到时、A 收到交付通知时）
	context_contains "$SB/b.jsonl" "<sender_info>" || { echo "FAIL: B 未收到带发送者头的成员消息"; exit 1; }
	context_contains "$SB/b.jsonl" "chief-1" || { echo "FAIL: 发送者头未标出 chief-1"; exit 1; }
	context_contains "$SB/a.jsonl" "<sender_info>" || { echo "FAIL: A 未收到带发送者头的成员消息"; exit 1; }

	echo "PASS: 全自主闭环（账本 ${STATE}）"
	exit 0
TEST

# ── 用例 11（ADR-0048 E3）：唤醒门禁关 — 显式唤醒被拒 + 派活只落 inbox + 不拉起进程 ──
# 断言口径：账本 / 模型可见面（tool result 文案）/ 资源终态（无 runtime、无 tmux 会话）。
# 不依赖 tmux（门禁关本就不该拉起任何进程）。
test_it "唤醒门禁关（ADR-0048 E3）：agent 调 org_wake 被拒并据实告知 + 派活只落 inbox（不拉起）" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	trap 'cleanup_sandbox' EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control" "$SB/home/.pi/agent/extensions/llm-surface-dump"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true
	cp "$R/test/e2e/helpers/llm-surface-dump.ts" "$SB/home/.pi/agent/extensions/llm-surface-dump/index.ts"

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1 || {
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	}

	# ① 门禁关（autoWake 缺省）：在岗负责人的 agent 调 org_wake → 工具返回拒绝文案（不静默）
	SCRIPT='[{"tool":"org_wake","args":{"member":"worker-a"}},{"text":"门禁关，需人处理。"}]'
	(cd "$SB/chief" && HOME="$SB/home" ORG_ROOT="$SB/orgdata" \
		MOCK_LLM_TOOL_SCRIPT="$SCRIPT" LLM_SURFACE_DUMP_FILE="$SB/chief.jsonl" \
		pi -a --no-session --session-control -p "叫醒 worker-a") >"$SB/chief.log" 2>&1 || true
	[[ -s "$SB/chief.jsonl" ]] || { echo "FAIL: 探针未抓到可见面"; tail -10 "$SB/chief.log"; exit 1; }
	# 拒绝要"据实告知"：门禁原因 + 两条出路都进入模型可见面
	context_contains "$SB/chief.jsonl" "自动唤醒" || { echo "FAIL: 拒绝文案未进模型可见面（静默失败）"; exit 1; }
	context_contains "$SB/chief.jsonl" "设置页" || { echo "FAIL: 拒绝文案未给出出路"; exit 1; }
	# 资源终态：未被拉起
	[[ ! -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] || { echo "FAIL: 门禁关却用了在岗注册"; exit 1; }
	if command -v tmux >/dev/null 2>&1; then
		tmux has-session -t org-uat-team-worker-a 2>/dev/null && {
			echo "FAIL: 门禁关却拉起了 tmux 会话"; tmux kill-session -t org-uat-team-worker-a 2>/dev/null || true; exit 1
		}
	fi

	# ② 门禁关时派活：任务落账 + 只投 inbox（不拉起）
	cat >"$SB/dispatch.mts" <<EOF
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
const res = await dispatchTask({
  org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
  title: 'e2e 门禁关派活', background: '门禁关闭时任务不丢', items: ['写一句'],
  targets: [{ agent: 'worker-a', description: '写一句' }],
});
console.log('MODE', JSON.stringify(res.deliveries.map((d) => d.mode)));
EOF
	DISPATCH_OUT=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/dispatch.mts" 2>&1) || {
		echo "FAIL: 派发失败"; echo "$DISPATCH_OUT"; exit 1
	}
	grep -q '"inbox"' <<<"$DISPATCH_OUT" || { echo "FAIL: 门禁关派活未落 inbox（got: ${DISPATCH_OUT}）"; exit 1; }
	compgen -G "$SB/orgdata/uat-team/tasks/*.json" >/dev/null || { echo "FAIL: 任务未落账"; exit 1; }
	compgen -G "$SB/orgdata/uat-team/inbox/worker-a/*.json" >/dev/null || { echo "FAIL: inbox 无兜底记录"; exit 1; }
	[[ ! -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] || { echo "FAIL: 派活把睡眠成员拉起了（门禁关不应唤醒）"; exit 1; }

	echo "PASS: 门禁关（显式唤醒被拒 + 派活只落 inbox + 未拉起）"
	exit 0
TEST

# ── 用例 12（ADR-0048 E2）：显式唤醒 → 后续派活在线送达 ──
test_it "唤醒门禁开（ADR-0048 E2）：agent 显式唤醒拉起成员 → 后续派活在线送达（不经 inbox）" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 唤醒需要 tmux 承载成员终端"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	SESSION="org-e2-chief"
	cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; tmux kill-session -t org-uat-team-worker-a 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg, setAutoWake } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
await setAutoWake('uat-team', true); // 门禁开（ADR-0048 D1）
console.log('SEED-DONE');
EOF
	ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1 || {
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	}

	# 剧本：显式唤醒 → 紧接着派活（送达形态由 dispatch 结果与 inbox 终态断定）
	SCRIPT='[{"tool":"org_wake","args":{"member":"worker-a"}},{"tool":"dispatch_task","args":{"org":"uat-team","title":"e2e 显式唤醒后派活","background":"验证显式唤醒链路","items":["写一句"],"targets":[{"agent":"worker-a","description":"写一句"}]}},{"text":"已唤醒并派发。"}]'
	tmux new-session -d -s "$SESSION" -c "$SB/chief" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata MOCK_LLM_TOOL_SCRIPT='$SCRIPT' pi -a --session-control"

	# TUI 模式下 agent 需要人类指令才开跑（与用例 010 同构）；等 chief 在岗再发指令
	for _ in $(seq 1 160); do
		[[ -f "$SB/orgdata/uat-team/runtime/chief-1.json" ]] && break
		sleep 0.5
	done
	[[ -f "$SB/orgdata/uat-team/runtime/chief-1.json" ]] || {
		echo "FAIL: chief 未上岗（控制 socket 未注册）"
		tmux capture-pane -p -t "$SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}
	tmux send-keys -t "$SESSION" "叫醒 worker-a，然后把任务派给他" Enter

	# 等成员被显式唤醒拉起（真 tmux 会话 + runtime 注册）
	for _ in $(seq 1 160); do
		[[ -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] && break
		sleep 0.5
	done
	[[ -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] || {
		echo "FAIL: 显式唤醒未拉起成员"; tmux capture-pane -p -t "$SESSION" 2>/dev/null | tail -20 || true; exit 1
	}
	# 后续派活在线送达：若走在线投递则无 inbox 兜底记录（有 runtime 却落 inbox = 送达失败）
	for _ in $(seq 1 120); do
		compgen -G "$SB/orgdata/uat-team/tasks/*.json" >/dev/null && break
		sleep 0.5
	done
	compgen -G "$SB/orgdata/uat-team/tasks/*.json" >/dev/null || { echo "FAIL: 派活未落账"; exit 1; }
	[[ ! -d "$SB/orgdata/uat-team/inbox/worker-a" || -z "$(ls -A "$SB/orgdata/uat-team/inbox/worker-a" 2>/dev/null)" ]] || {
		echo "FAIL: 成员已在岗，任务却落了 inbox（在线送达失败）"; exit 1
	}
	echo "PASS: 显式唤醒（E2）→ 后续派活在线送达"
	exit 0
TEST

# ── 用例 13（ADR-0048 E1）：门禁开 + 派活 → 自动唤醒 + 被唤醒成员自主交付 + 验收闭环 ──
# 成员进程由「派活时的自动唤醒」拉起（测试**不**预先启动它），脚本经成员目录的
# `.mock-llm-script.json` 提供（唤醒只传 PATH/HOME/ORG_ROOT，无法注入 env）。
test_it "自动唤醒（ADR-0048 E1）：门禁开 + 派活 → 自动拉起睡眠成员 → 成员自主认领/交付 → 验收 closed" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 自动唤醒需要 tmux 承载成员终端"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	SESSION="org-e1-chief"
	cleanup() {
		tmux kill-session -t "$SESSION" 2>/dev/null || true
		tmux kill-session -t org-uat-team-worker-a 2>/dev/null || true
		cleanup_sandbox
	}
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control" "$SB/home/.pi/agent/extensions/llm-surface-dump"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true
	cp "$R/test/e2e/helpers/llm-surface-dump.ts" "$SB/home/.pi/agent/extensions/llm-surface-dump/index.ts"

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg, setAutoWake } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
await setAutoWake('uat-team', true); // 门禁开（ADR-0048 D1）
console.log('SEED-DONE');
EOF
	ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1 || {
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	}

	# 被唤醒成员的剧本（放成员目录；唤醒只传 PATH/HOME/ORG_ROOT）
	cat >"$SB/worker/.mock-llm-script.json" <<'EOF'
[{"tool":"org_claim","args":{"taskId":"{{taskId}}"}},{"tool":"org_report","args":{"taskId":"{{taskId}}","summary":"已完成：一句话。"}},{"text":"已交付。"}]
EOF

	# 负责人剧本：派活（触发自动唤醒）→ 收尾 → 收到交付通知后自主验收
	A_SCRIPT='[{"tool":"dispatch_task","args":{"org":"uat-team","title":"自动唤醒 e2e","background":"验证派活自动唤醒链路","items":["写一句话"],"targets":[{"agent":"worker-a","description":"写一句话"}]}},{"text":"已派发，等待交付。"},{"tool":"org_review","args":{"taskId":"{{taskId}}","result":"accepted","note":"自动验收"}},{"text":"已验收关闭。"}]'
	tmux new-session -d -s "$SESSION" -c "$SB/chief" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata MOCK_LLM_TOOL_SCRIPT='$A_SCRIPT' pi -a --session-control"

	# 人类只发一条指令（agent 自主性的前提：其余动作都由 agent 决策）
	for _ in $(seq 1 160); do
		[[ -f "$SB/orgdata/uat-team/runtime/chief-1.json" ]] && break
		sleep 0.5
	done
	[[ -f "$SB/orgdata/uat-team/runtime/chief-1.json" ]] || {
		echo "FAIL: chief 未上岗"
		tmux capture-pane -p -t "$SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}
	tmux send-keys -t "$SESSION" "把任务派给 worker-a：写一句话" Enter

	TASKDIR="$SB/orgdata/uat-team/tasks"
	STATE=""
	for _ in $(seq 1 400); do
		F=$(ls "$TASKDIR"/*.json 2>/dev/null | head -1 || true)
		if [[ -n "$F" ]]; then
			STATE=$(node -e 'const t=require(process.argv[1]);process.stdout.write(String(t.status)+" "+t.history.map(h=>h.event).join(","))' "$F" 2>/dev/null || echo "")
			[[ "$STATE" == closed* ]] && break
		fi
		sleep 0.5
	done
	[[ "$STATE" == closed* ]] || {
		echo "FAIL: 自动唤醒闭环未到 closed（当前：${STATE:-无账本}）"
		tmux capture-pane -p -t "$SESSION" 2>/dev/null | tail -15 || true
		tmux capture-pane -p -t org-uat-team-worker-a 2>/dev/null | tail -15 || true
		exit 1
	}
	# 目标进程确为「被唤醒拉起」：有 runtime 且（成员会话存在）——测试从未预先启动它
	[[ -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] || { echo "FAIL: 成员未被自动唤醒拉起"; exit 1; }
	for ev in dispatched claimed delivered; do
		grep -q "$ev" <<<"$STATE" || { echo "FAIL: 账本缺少 ${ev}（${STATE}）"; exit 1; }
	done
	echo "PASS: 自动唤醒闭环（${STATE}）"
	exit 0
TEST

# ── 用例 14：跨扩展防护（preset × org）——动态注册的 org 工具不被 preset 的工具集吞掉 ──
# 回归背景（2026-09-13 真实 UAT）：preset 应用工具集时**整体覆写** `pi.setActiveTools()`，
# 把后注册的 org 工具（含 `org_wake`）静默丢掉 → agent 调 `org_wake` 报 "Tool org_wake not found"，
# 而 org 侧日志毫无痕迹（调用根本没到扩展）。org 自身 e2e 只加载 org+control 且 HOME 隔离，
# **结构上**看不到这类跨扩展干扰 —— 本用例补的就是这一层。
test_it "跨扩展防护（preset × org）：preset 应用工具集后 org 工具不被吞掉（回归 org_wake not found）" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	trap 'cleanup_sandbox' EXIT

	# 同时加载：control（socket）+ preset（干扰源/防护对象）+ 探针
	mkdir -p "$SB/home/.pi/agent/extensions/control" \
		"$SB/home/.pi/agent/extensions/llm-surface-dump" \
		"$SB/home/.pi/agent/extensions/preset"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true
	cp "$R"/extensions/meta/preset/*.ts "$SB/home/.pi/agent/extensions/preset/"
	# preset 依赖仓库内本地包（@zenone/pi-state 等）+ 仓库内相对模块 src/
	for pkg in "$R"/node_modules/@zenone/*/; do
		ln -sfn "$pkg" "$SB/home/.pi/agent/node_modules/@zenone/$(basename "$pkg")"
	done
	mkdir -p "$SB/home/.pi/src"
	cp -R "$R/src/." "$SB/home/.pi/src/"
	cp "$R/test/e2e/helpers/llm-surface-dump.ts" "$SB/home/.pi/agent/extensions/llm-surface-dump/index.ts"
	# 日志扩展：本用例要断言"唤醒/派活决策留痕"（ADR-0048 D7），无它则沙箱不写日志
	cp -R "$R/extensions/meta/pi-logger" "$SB/home/.pi/agent/extensions/pi-logger"
	rm -rf "$SB/home/.pi/agent/extensions/pi-logger/node_modules"

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1 || {
		echo "FAIL: seed 组织失败"; cat "$SB/seed.log"; exit 1
	}

	# 剧本：① org_fleet（历史上这一调用会触发 preset 应用工具集 → 整体覆写）
	#       ② org_wake（门禁关 → 应得**拒绝文案**；若被吞则报 not found）
	#       ③ dispatch_task（门禁关 → 应落 inbox，不拉起）
	SCRIPT='[{"tool":"org_fleet","args":{"org":"uat-team"}},{"tool":"org_wake","args":{"member":"worker-a"}},{"tool":"dispatch_task","args":{"org":"uat-team","title":"跨扩展防护 e2e","background":"preset 同时加载时 org 工具仍可用","items":["写一句"],"targets":[{"agent":"worker-a","description":"写一句"}]}},{"text":"已尝试唤醒并派发。"}]'
	(cd "$SB/chief" && HOME="$SB/home" ORG_ROOT="$SB/orgdata" \
		MOCK_LLM_TOOL_SCRIPT="$SCRIPT" LLM_SURFACE_DUMP_FILE="$SB/chief.jsonl" \
		pi -a --no-session --session-control -p "先看成员，再叫醒 worker-a，然后派活") >"$SB/chief.log" 2>&1 || true

	[[ -s "$SB/chief.jsonl" ]] || { echo "FAIL: 探针未抓到可见面"; tail -10 "$SB/chief.log"; exit 1; }

	# ① 直接回归断言：org_wake 绝不能被吞（这条就是那次 UAT 的现场症状）
	if grep -q "Tool org_wake not found" "$SB/chief.log" "$SB/chief.jsonl" 2>/dev/null; then
		echo "FAIL: org_wake 被 preset 吞掉（UAT 症状复现）"
		grep -m3 "org_wake" "$SB/chief.log" 2>/dev/null | sed 's/^/    /' || true
		exit 1
	fi

	# ② 三个不同的 org 工具都真的执行到了（fleet / wake / dispatch）
	context_contains "$SB/chief.jsonl" 'org「uat-team」' || { echo "FAIL: org_fleet 结果未进入可见面"; exit 1; }
	context_contains "$SB/chief.jsonl" "自动唤醒" || { echo "FAIL: org_wake 调用未到达工具（无拒绝文案）"; exit 1; }
	context_contains "$SB/chief.jsonl" "设置页" || { echo "FAIL: 拒绝文案未给出出路"; exit 1; }

	# ③ 视图一致（跨轮）：凡探针报告了 tools 的轮次，org 工具集合恒 === ORG_TOOL_NAMES
	echo "  [diag] prober tools: $(grep -o '"tools":\[[^]]*\]' "$SB/chief.jsonl" | head -1)"
	node -e '
const fs=require("fs");
const expected=process.argv[2].split(/\s+/).filter(Boolean).sort();
const lines=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean);
let checked=0,bad=0;
for(const l of lines){
  const rec=JSON.parse(l);
  if(!Array.isArray(rec.tools)) continue;
  checked++;
  const actual=rec.tools.filter((t)=>t.startsWith("org_")||t==="dispatch_task").sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected)){ bad++; console.error("  actual:",JSON.stringify(actual)); }
}
if(checked===0||bad){ console.error("  checked:",checked); console.error("  expected:",JSON.stringify(expected)); process.exit(1); }
' "$SB/chief.jsonl" "$(org_tool_names)" || { echo "FAIL: preset 应用后 org 工具集合漂移（视图不一致）"; exit 1; }

	# ④ 旅程关键动作仍可用：派活真的发生（工具结果进可见面）+ 落账 + 门禁关只投 inbox（不拉起）
	#    注意：不用 `ls glob | head`（pipefail 下无匹配会静默中断，掩盖真实失败）
	any_file() { # $1=glob；有任一匹配则 0
		local f
		for f in $1; do [[ -e "$f" ]] && return 0; done
		return 1
	}
	context_contains "$SB/chief.jsonl" "M-" || {
		echo "FAIL: 派活工具结果未进可见面（未派发）"
		echo "--- chief.log 尾部 ---"; tail -15 "$SB/chief.log" 2>/dev/null || true
		exit 1
	}
	any_file "$SB/orgdata/uat-team/tasks/*.json" || {
		echo "FAIL: 派活未落账（工具被吞导致未派发）"
		echo "--- tasks 目录 ---"; ls -la "$SB/orgdata/uat-team/tasks" 2>&1 | head -5
		exit 1
	}
	any_file "$SB/orgdata/uat-team/inbox/worker-a/*.json" || {
		echo "FAIL: 门禁关时派活未落 inbox（任务会丢）"
		echo "--- inbox 目录 ---"; ls -la "$SB/orgdata/uat-team/inbox/worker-a" 2>&1 | head -5
		exit 1
	}
	[[ ! -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] || { echo "FAIL: 门禁关却拉起了进程"; exit 1; }

	# ⑤ 留痕（ADR-0048 D7）：派活"未自动唤醒"必须留痕（排障不靠"日志缺失"反推）
	LOG=""
	for f in "$SB/chief/.pi/logs"/org_*.log; do [[ -e "$f" ]] && LOG="$f"; done
	[[ -n "$LOG" ]] || { echo "FAIL: 未生成 org 日志"; ls -la "$SB/chief/.pi/logs" 2>&1 | head -5; exit 1; }
	grep -q "派活未自动唤醒" "$LOG" || { echo "FAIL: 派活未唤醒决策未留痕"; tail -12 "$LOG"; exit 1; }

	echo "PASS: preset 同时加载时 org 工具不被吞（三工具可用 + 视图一致 + 派活落 inbox + 留痕齐备）"
	exit 0
TEST

# ── 用例 15：成员启动参数（ADR-0051 + 审查 06/07）───────────────────────────
# ① 真实命令面 /org create + /org join → 成员记录带上插件配置的初值（默认 --no-permission-gate）
# ② 真实 **pi 进程**执行 /org wake → 被拉起进程命令行带该参数，且**活着**
#    06 起唤醒会先校验"起来没有"：只断言 argv 会把"启动即崩"判成通过（旧用例的教训），
#    故这里必须断言存活；沙箱里装上该参数的注册者 permission-gate，走"目标环境认识它"的正路。
test_it "成员启动参数：join 写初值 → 真实唤醒后进程存活且命令行带上（真实 tmux + 真实 pi）" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 验证「唤醒进程命令行」需要真实 tmux 会话"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	SESSION="org-uat-team-worker-a"
	cleanup() {
		tmux kill-session -t "$SESSION" 2>/dev/null || true
		cleanup_sandbox
	}
	trap cleanup EXIT

	# ① 命令面建组织 + 加入（生产路径：join 时写启动参数初值）
	run_org_cmd "$SB/chief" "create uat-team"
	run_org_cmd "$SB/worker" "join uat-team"
	if ! grep -q '"launchArgs": "--no-permission-gate"' "$SB/orgdata/uat-team/org.json"; then
		echo "FAIL: join 未把启动参数初值写进成员记录"
		head -30 "$SB/orgdata/uat-team/org.json"
		exit 1
	fi

	# ② 让沙箱"认识"这两个参数——它们都由**扩展**注册，不是 pi 内置：
	#    · --session-control 由 control 注册（成员要建控制 socket，本就得有它）
	#    · --no-permission-gate 由 permission-gate 注册；真插件会 import 仓库内的 src/tui
	#      （搬进沙箱就加载不起来），故这里放一个**只注册同名 flag 的桩**。
	#      本用例测的是"参数被识别 → 进程带着它活着"，不是插件内部行为。
	mkdir -p "$SB/home/.pi/agent/extensions/control" "$SB/home/.pi/agent/extensions/flag-stub"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true
	cat >"$SB/home/.pi/agent/extensions/flag-stub/index.ts" <<'STUB'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// 与真 permission-gate 同形的注册（同名/同类型），让目标环境"认识"这个参数
export default function (pi: ExtensionAPI) {
	pi.registerFlag('no-permission-gate', {
		description: '完全禁用权限门（e2e 桩）',
		type: 'boolean',
		default: false,
	});
	// 探针：把"该参数确实到了成员进程"落成文件。
	// 为何不 grep 进程命令行：真实 pi 启动器会把进程标题改成 `pi`，
	// `ps -o command=` 读不到参数（实测），tmux 的 pane_current_command 也只显示 node。
	pi.on('session_start', async () => {
		if (pi.getFlag('no-permission-gate') === true && process.env.ORG_ROOT) {
			writeFileSync(join(process.env.ORG_ROOT, 'flag-seen.txt'), 'yes');
		}
	});
}
STUB
	seed_autowake "$SB" uat-team

	# ③ 真实 pi 进程触发唤醒（/org wake 内部走的就是看板/工具/自动唤醒共用的 wakeMember）
	# 唤醒结果走"面向人的通知通道"（ADR-0047 D1），print 模式不落 stdout——故这里
	# 断言**产物**（会话 + 进程 argv + 存活），不 grep 命令输出。
	run_org_cmd "$SB/chief" "wake worker-a"

	# ④ 取该 tmux 会话里真实进程的命令行。注意有竞态：pane 起来后 shell 需要一点时间才
	#    exec 成真正的 pi，故轮询到 argv 里出现固定启动项为止（否则会读到半启动的进程）。
	pid=""; cmds=""
	for _ in $(seq 1 60); do
		pid="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1 || true)"
		if [[ -n "$pid" ]]; then
			cmds="$(ps -o command= -p "$pid" 2>/dev/null || true)"
			for child in $(pgrep -P "$pid" 2>/dev/null || true); do
				cmds="$cmds
$(ps -o command= -p "$child" 2>/dev/null || true)"
			done
			echo "$cmds" | grep -q -- "--session-control" && break
		fi
		sleep 0.25
	done
	[[ -n "$pid" ]] || { echo "FAIL: 未取到 tmux 会话进程 pid"; exit 1; }
	echo "[diag] pane ps 读到的命令行（真实 pi 会改标题，仅供参考）：$cmds"

	# ⑤ 参数真的到了成员进程（行为证据，比 grep 命令行更强）
	for _ in $(seq 1 40); do
		[[ -f "$SB/orgdata/flag-seen.txt" ]] && break
		sleep 0.25
	done
	if [[ ! -f "$SB/orgdata/flag-seen.txt" ]]; then
		dump_wake_state "$SB" "$SESSION" "$pid"
		echo "FAIL: 成员进程没有看到 --no-permission-gate（桩探针未落文件）"
		exit 1
	fi

	# ⑥ 固定启动项也在：成员在岗 = 控制 socket 已注册（runtime 记录出现）
	for _ in $(seq 1 60); do
		[[ -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]] && break
		sleep 0.25
	done
	if [[ ! -f "$SB/orgdata/uat-team/runtime/worker-a.json" ]]; then
		dump_wake_state "$SB" "$SESSION" "$pid"
		echo "FAIL: 成员未在岗（runtime 未注册）——固定启动项 --session-control 可能没生效"
		exit 1
	fi

	# ⑦ **存活断言**（06 的关键缺口：只查 argv 会放过"启动即崩"）
	sleep 3
	if ! tmux has-session -t "$SESSION" 2>/dev/null; then
		echo "FAIL: 唤醒后 3 秒内成员会话已消失（启动即崩）"
		exit 1
	fi
	echo "PASS: join 写初值 + 真实 pi 唤醒 + 参数到达进程 + 在岗 + 存活"
	exit 0
TEST

# ── 用例 16：目标环境不认识该参数 → 降级重试并留痕（ADR-0051 审查 07）────────
# 沙箱**不装** permission-gate：`--no-permission-gate` 是未知选项，pi 会当场退出（实测 1.6–2.3s）。
# 期望：唤醒去掉该参数重试一次，成员最终活着；降级事实留痕（不静默、不写回成员记录）。
test_it "成员启动参数：目标环境不认识时去掉该参数重试并留痕，成员仍能起来" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 验证「降级重试」需要真实 tmux 会话"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	SESSION="org-uat-team-worker-a"
	cleanup() {
		tmux kill-session -t "$SESSION" 2>/dev/null || true
		cleanup_sandbox
	}
	trap cleanup EXIT

	run_org_cmd "$SB/chief" "create uat-team"
	run_org_cmd "$SB/worker" "join uat-team"
	# 成员要能活着在岗，--session-control 必须被认识（control 注册它）；
	# 而 --no-permission-gate 故意**不**注册——本用例要的正是"目标环境不认识它"。
	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true
	seed_autowake "$SB" uat-team

	run_org_cmd "$SB/chief" "wake worker-a"

	# 等"降级重试后的真实进程"出现（第一版的会话已被 06 的校验杀掉，这里是第二个会话）
	pid=""; cmds=""
	for _ in $(seq 1 80); do
		pid="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1 || true)"
		if [[ -n "$pid" ]]; then
			cmds="$(ps -o command= -p "$pid" 2>/dev/null || true)"
			for child in $(pgrep -P "$pid" 2>/dev/null || true); do
				cmds="$cmds
$(ps -o command= -p "$child" 2>/dev/null || true)"
			done
			echo "$cmds" | grep -q -- "--session-control" && break
		fi
		sleep 0.25
	done
	[[ -n "$pid" ]] || {
		echo "FAIL: 降级后仍未拉起成员"
		echo "--- /org wake 输出 ---"
		tail -12 "$SB/cmd.log"
		echo "--- runtime 目录（在岗记录）---"
		ls -la "$SB/orgdata/uat-team/runtime" 2>/dev/null || echo "(无)"
		echo "--- 会话列表 ---"
		tmux ls 2>&1 | head -5
		echo "--- pi 日志 ---"
		find "$SB" -path '*logs*' -name '*.log' 2>/dev/null | head -5
		exit 1
	}
	# 降级的行为证据：若没降级，成员会被未知选项当场打死（06 校验会杀掉会话）——
	# 因此"会话还在 + 3 秒后仍活着"本身就证明去掉参数的重试发生了。
	sleep 3
	if ! tmux has-session -t "$SESSION" 2>/dev/null; then
		echo "FAIL: 降级重试后成员仍未能存活"
		exit 1
	fi
	# 降级必须留痕（人能看到"参数被忽略"，而不是静默改行为）
	if ! grep -rq "不被目标环境识别" "$SB" 2>/dev/null; then
		echo "FAIL: 降级未留痕（沙箱内找不到「不被目标环境识别」）"
		echo "--- 沙箱内 logs 目录 ---"
		find "$SB" -type d -name logs 2>/dev/null | head -5
		echo "--- 沙箱内 .log 文件 ---"
		find "$SB" -name '*.log' 2>/dev/null | head -8
		echo "--- /org wake 输出 ---"
		tail -12 "$SB/cmd.log"
		exit 1
	fi
	# 成员记录不被改写（降级只影响本次拉起）
	if ! grep -q '"launchArgs": "--no-permission-gate"' "$SB/orgdata/uat-team/org.json"; then
		echo "FAIL: 降级不应改写成员记录"
		exit 1
	fi
	echo "PASS: 未知参数 → 降级重试 + 留痕 + 成员存活 + 记录未改"
	exit 0
TEST

# ── 用例 16：唤醒即接手（ADR-0054 `D3`/`D11`）────────────────────────────────
# 回归背景（2026-09-14 真实 UAT）：把一个任务改派给**睡眠**成员（落 inbox），随后唤醒它——
# 成员进程起来了、任务却永远停在「待领取」：上岗补投用的是 `triggerTurn:false`（只显示不触发），
# 而 `takeInbox` 只在 session_start 跑一次（先删后注入）。修好后：上线补投**先注入成功再删除**，
# 且有可执行内容时**起一轮** → 成员自己就把活接走（不需要任何人事后再投递一次）。
test_it "唤醒即接手：睡眠成员的 inbox 待办在唤醒后被自己领走（ADR-0054 D3/D11）" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	WAKE_SESSION="org-e2e-wake-$$"
	cleanup() { tmux kill-session -t "$WAKE_SESSION" 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	# 成员剧本（放成员目录，唤醒进程读 cwd）：领活 → 交付。任务号由 {{taskId}} 从收到的消息里填。
	cat >"$SB/worker/.mock-llm-script.json" <<'EOF'
[{"tool":"org_claim","args":{"taskId":"{{taskId}}"}},{"tool":"org_report","args":{"taskId":"{{taskId}}","summary":"已完成：一句话。"}},{"text":"已交付。"}]
EOF

	# 预置：organ + 任务（invited）+ 向**睡眠**成员投递（必然落 inbox；测试不预先启动任何成员进程）
	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
const res = await dispatchTask({
  org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
  title: '唤醒即接手 e2e', background: '验证上线补投会触发一轮',
  items: ['写一句话'],
  targets: [{ agent: 'worker-a', description: '写一句话' }],
});
console.log('SEED ' + res.task.id + ' ' + res.deliveries.map((d) => d.mode).join(','));
EOF
	SEED_OUT="$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" 2>&1)" || {
		echo "FAIL: seed 失败"; echo "$SEED_OUT"; exit 1
	}
	TASK_ID="$(sed -n 's/^SEED \([^ ]*\).*/\1/p' <<<"$SEED_OUT")"
	[[ -n "$TASK_ID" ]] || { echo "FAIL: 未取到任务号（${SEED_OUT}）"; exit 1; }
	INBOX="$SB/orgdata/uat-team/inbox/worker-a"
	[[ -n "$(ls -A "$INBOX" 2>/dev/null)" ]] || { echo "FAIL: 未在岗投递应落 inbox"; exit 1; }

	# 唤醒（等价于人在看板按 w / /org wake）：自己目录里起在岗进程
	tmux new-session -d -s "$WAKE_SESSION" -c "$SB/worker" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata pi -a --session-control"

	STATE=""
	for _ in $(seq 1 240); do
		F="$SB/orgdata/uat-team/tasks/$TASK_ID.json"
		if [[ -f "$F" ]]; then
			STATE=$(node -e 'const t=require(process.argv[1]);process.stdout.write(t.status+" "+t.subTasks[0].assignees[0].status+" "+t.history.map(h=>h.event).join(","))' "$F" 2>/dev/null || echo "")
			# 认领（=上线补投真的触发了一轮）即达成；交付则更强
			[[ "$STATE" == *claimed* || "$STATE" == *delivered* ]] && break
		fi
		sleep 0.5
	done
	[[ "$STATE" == *claimed* || "$STATE" == *delivered* ]] || {
		echo "FAIL: 唤醒后未自行接手（当前：${STATE:-无账本}）"
		tmux capture-pane -p -t "$WAKE_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}
	# D11：注入成功后必须把 inbox 清掉（否则会反复触发）
	for _ in $(seq 1 20); do
		[[ -z "$(ls -A "$INBOX" 2>/dev/null)" ]] && break
		sleep 0.5
	done
	[[ -z "$(ls -A "$INBOX" 2>/dev/null)" ]] || { echo "FAIL: 注入成功后 inbox 未清空"; exit 1; }

	echo "PASS: 唤醒即接手（${STATE}）"
	exit 0
TEST

# ── 用例 17：串行执行的约束（ADR-0055）────────────────────────────────────
# 一条真实链路同时验证：
#   ① 排队上限（D4）：队列满时派发**被拒**且账本零改动；
#   ② 逾期（D3）：过期未结任务由巡检**标记**并写入历史（不自动回落），
#      且把 `[evt:overdue:...]` **通知给派发人**（派发人 ≠ 巡检者时才发，故另造一条他人派发的逾期任务）；
#   ③ 显式抢占（D6）工具面可用：紧急事项真的落进了目标成员的 inbox（插话路径）。
test_it "串行执行约束：排队上限拒收 + 逾期标记与通知派发人 + 紧急插话可达（ADR-0055 D3/D4/D6）" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	SERIAL_SESSION="org-e2e-serial-$$"
	cleanup() { tmux kill-session -t "$SERIAL_SESSION" 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	# 预置：3 条 invited 任务（= 默认上限 3，目标 worker-a），其中第一条**已过期**；
	# 外加一条**派发人是睡眠成员**的逾期任务 —— 用于断言「逾期通知派发人」这半边：
	# 派发人恰为巡检者本人时该通知被刻意跳过（不自扰），所以必须另造一条才能测到。
	mkdir -p "$SB/worker-b"
	echo '{ "name": "worker-b", "role": "member" }' >"$SB/worker-b/pi.agent.json"
	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
await joinOrg('uat-team', { manifest: { name: 'worker-b', role: 'member' }, dir: '$SB/worker-b' });
const past = new Date(Date.now() - 3600_000).toISOString();
for (let i = 1; i <= 3; i++) {
  await dispatchTask({
    org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
    title: '排队任务 ' + i, background: 'bg', items: ['a'],
    dueAt: i === 1 ? past : null,
    targets: [{ agent: 'worker-a', description: '子任务 ' + i }],
  });
}
// ④ 派发人 = 睡眠的 worker-a（≠ 巡检者 chief-1）：巡检必须把 [evt:overdue:...] 发给它（落 inbox）
await dispatchTask({
  org: 'uat-team', dispatcher: 'worker-a', dispatcherRole: 'member',
  title: '他人逾期通知', background: 'bg', items: ['a'],
  dueAt: past,
  targets: [{ agent: 'worker-b', description: '子任务 b' }],
});
console.log('SEED-DONE');
EOF
	ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1 || {
		echo "FAIL: seed 失败"; cat "$SB/seed.log"; exit 1
	}
	TASKDIR="$SB/orgdata/uat-team/tasks"
	BEFORE=$(ls "$TASKDIR"/*.json | wc -l | tr -d ' ')
	[[ "$BEFORE" == "4" ]] || { echo "FAIL: 预置任务数应为 4（实际 ${BEFORE}）"; exit 1; }

	# 负责人剧本：再派一条（应被**拒收**）→ 对睡眠成员发一条紧急插话（应落 inbox）
	A_SCRIPT='[{"tool":"dispatch_task","args":{"org":"uat-team","title":"超限任务","background":"bg","items":["a"],"targets":[{"agent":"worker-a","description":"超限"}]}},{"tool":"org_urgent","args":{"member":"worker-a","message":"紧急：先看这个"}},{"text":"结束。"}]'
	tmux new-session -d -s "$SERIAL_SESSION" -c "$SB/chief" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata MOCK_LLM_TOOL_SCRIPT='$A_SCRIPT' pi -a --session-control"

	# 等负责人上岗，再发一条消息触发轮次（mock 剧本按轮次顺序回放）
	for _ in $(seq 1 160); do
		[[ -f "$SB/orgdata/uat-team/runtime/chief-1.json" ]] && break
		sleep 0.5
	done
	[[ -f "$SB/orgdata/uat-team/runtime/chief-1.json" ]] || {
		echo "FAIL: 负责人未上岗"
		tmux capture-pane -p -t "$SERIAL_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}
	tmux send-keys -t "$SERIAL_SESSION" "按脚本执行" Enter

	# 等负责人跑完脚本：以**会话记录**（工具返回落盘）为据，TUI 面板抓取不可靠
	REFUSED=""
	for _ in $(seq 1 240); do
		REFUSED=$(grep -rl "队列已达上限" "$SB/home/.pi/agent/sessions" 2>/dev/null | head -1 || true)
		[[ -n "$REFUSED" ]] && break
		sleep 0.5
	done

	# ① 排队上限：拒绝理由落进会话（工具真的跑了并被拒）+ 账本零改动
	[[ -n "$REFUSED" ]] || {
		echo "FAIL: 未见拒收理由（队列已达上限）——超限派发可能没被拒"
		tmux capture-pane -p -t "$SERIAL_SESSION" 2>/dev/null | tail -25 || true
		exit 1
	}
	AFTER=$(ls "$TASKDIR"/*.json | wc -l | tr -d ' ')
	[[ "$AFTER" == "$BEFORE" ]] || { echo "FAIL: 超限派发不应改动账本（$BEFORE → ${AFTER}）"; exit 1; }

	# ③ 紧急插话：消息真的落进目标成员的 inbox（工具面 → 投递链路可用）
	INBOX="$SB/orgdata/uat-team/inbox/worker-a"
	found=""
	for _ in $(seq 1 60); do
		if grep -rqs "紧急" "$INBOX" 2>/dev/null; then found=1; break; fi
		sleep 0.5
	done
	[[ -n "$found" ]] || { echo "FAIL: 紧急插话未落进成员 inbox"; ls -A "$INBOX" 2>/dev/null || true; exit 1; }

	# ② 逾期：巡检（每 15 拍 × 4s）标记过期任务 → 历史出现 overdue
	OVERDUE=""
	for _ in $(seq 1 300); do
		# 账本是 JSON.stringify(data, null, 2) 的**美化**格式 → 用 node 断言，别用裸 grep
		OVERDUE=$(node -e '
const fs=require("fs");
const dir=process.argv[1];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  const t=JSON.parse(fs.readFileSync(dir+"/"+f,"utf8"));
  if ((t.history||[]).some((h)=>h.event==="overdue")) { console.log(dir+"/"+f); break; }
}' "$TASKDIR" 2>/dev/null || true)
		[[ -n "$OVERDUE" ]] && break
		sleep 0.5
	done
	[[ -n "$OVERDUE" ]] || {
		echo "FAIL: 过期任务未被标记（巡检未生效）"
		tmux capture-pane -p -t "$SERIAL_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}
	# 不自动回落：参与者仍为 invited（去向由派发人决定）
	node -e 'const t=require(process.argv[1]);const a=t.subTasks[0].assignees[0];if(a.status!=="invited"){console.error("FAIL: 逾期不应改动参与者状态（"+a.status+"）");process.exit(1)}' "$OVERDUE" || exit 1

	# ②b 逾期**通知派发人**（ADR-0055 `D3` 的后半句）：派发人（睡眠的 worker-a）的 inbox 里
	#     应出现 `[evt:overdue:<task>:<sub>:<agent>]`。此前无人断言这半边——派发人恰为巡检者
	#     本人时通知被刻意跳过，只有另造一条"他人派发"的逾期任务才测得到。
	INBOX_DISP="$SB/orgdata/uat-team/inbox/worker-a"
	NOTIFIED=""
	for _ in $(seq 1 120); do
		if grep -rqs "evt:overdue:" "$INBOX_DISP" 2>/dev/null; then NOTIFIED=1; break; fi
		sleep 0.5
	done
	[[ -n "$NOTIFIED" ]] || {
		echo "FAIL: 逾期未通知派发人（inbox 无 evt:overdue）"
		ls -A "$INBOX_DISP" 2>/dev/null || true
		tmux capture-pane -p -t "$SERIAL_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}

	echo "PASS: 串行执行三约束（排队拒收 + 逾期标记与通知派发人 + 紧急插话已达 inbox）"
	exit 0
TEST

# ── 用例 18：成员动态跨进程（ADR-0052 D1/D2/D4/D8）──────────────────────────
# 回归背景：`get_history` 是 org「看见成员在干什么」的唯一通道，此前只有两侧的
# 单测（control 侧纯函数 + org 侧假 socket），真实进程间的协议（命令名/载荷匹配，
# 以及 `rpcCall` 的 `msg.command === command.type` 校验）从未在真机上验证过。
# 本用例：真实成员跑一轮 → 用生产代码 `fetchActivity` 跨进程取回其事件行；
# 再对不可达 socket 断言"降级但不抛错"（观测失败不得升级为状态或动作，D2/D8）。
test_it "成员动态跨进程：真实 control 的 get_history 可取回 + 不可达降级（ADR-0052 D1/D2/D8）" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 跨进程成员动态需要真实成员进程"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	ACT_SESSION="org-e2e-act-$$"
	cleanup() { tmux kill-session -t "$ACT_SESSION" 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1 || {
		echo "FAIL: seed 失败"; cat "$SB/seed.log"; exit 1
	}

	# 成员剧本：纯文本，跑一轮即在会话分支里留下可观测的事件
	cat >"$SB/worker/.mock-llm-script.json" <<'EOF'
[{"text":"正在改 applyTools 覆写（成员动态 e2e）"}]
EOF

	tmux new-session -d -s "$ACT_SESSION" -c "$SB/worker" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata pi -a --session-control"

	# 等成员上岗（runtime 里出现 control socket）
	RT="$SB/orgdata/uat-team/runtime/worker-a.json"
	for _ in $(seq 1 200); do
		node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null && break
		sleep 0.5
	done
	node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null || {
		echo "FAIL: 成员未上岗或无 control socket"
		tmux capture-pane -p -t "$ACT_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}

	# 用**生产代码**跨进程取动态（真实 socket + 真实 control handler）：
	# 成功路径 + 不可达路径一次跑完
	cat >"$SB/activity.mts" <<EOF
import { readJson } from '$R/extensions/auto/org/util.ts';
import { fetchActivity } from '$R/extensions/auto/org/activity.ts';
const rt = await readJson<{ socketPath?: string }>('$RT');
const ok = rt?.socketPath ? await fetchActivity(rt.socketPath, 10) : { ok: false, reason: 'unreachable' };
if (ok.ok) {
  console.log('ACT-OK ' + ok.entries.length + ' ' + ok.entries.map((e) => e.text).join(' | '));
} else {
  console.log('ACT-FAIL ' + ok.reason);
}
const bad = await fetchActivity('$SB/no-such-socket.sock', 10);
console.log('ACT-BAD ' + (bad.ok ? 'ok' : bad.reason));
EOF

	# 触发成员跑一轮：走**生产投递通道**（control `send`）而非 tmux 键盘——
	# runtime 出现时 TUI 未必已就绪，`send-keys` 会丢键（实测）；投递通道与真实派活同款。
	cat >"$SB/prompt.mts" <<EOF
import { deliverMessage } from '$R/extensions/auto/org/dispatch.ts';
let mode = 'unreachable';
for (let i = 0; i < 40; i++) {
  mode = await deliverMessage('uat-team', 'worker-a', '说一句话', { sender: 'chief-1' });
  if (mode === 'online') break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('PROMPT ' + mode);
EOF
	P_MODE="$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/prompt.mts" 2>&1 | grep '^PROMPT ' || true)"
	grep -q 'PROMPT online' <<<"$P_MODE" || {
		echo "FAIL: 投递未在线送达（${P_MODE:-无输出}）"
		tmux capture-pane -p -t "$ACT_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}

	ACT=""
	for _ in $(seq 1 120); do
		ACT=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/activity.mts" 2>&1 | grep '^ACT-' || true)
		grep -q "applyTools" <<<"$ACT" && break
		sleep 0.5
	done

	[[ "$ACT" == ACT-OK* ]] || {
		echo "FAIL: 跨进程取动态失败（${ACT:-无输出}）"
		tmux capture-pane -p -t "$ACT_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}
	grep -q "applyTools" <<<"$ACT" || { echo "FAIL: 动态未含成员文本（${ACT}）"; exit 1; }
	grep -q "ACT-BAD unreachable" <<<"$ACT" || {
		echo "FAIL: 不可达 socket 应降级为 unreachable（${ACT}）"; exit 1
	}

	echo "PASS: 成员动态跨进程可取 + 不可达降级（${ACT}）"
	exit 0
TEST

# ── 用例 19：硬抢占（abort）与重试（ADR-0053 D1/D5、ADR-0055 D6/D7）──────────
# 回归背景：中断此前只有 mock 掉 `interruptMember` 的单测；"真的把当前轮停住、
# 进程/会话未被破坏、随后还能继续干活"从未在真机上验证（ADR-0053 验证 2）。
# 本用例构造一个**真实在跑**的长轮（bash sleep 25），断言中断在远早于 sleep
# 自然结束前把轮次停掉（证明是 abort 生效，而非"跑完了"），且进程存活；
# 随后 `retrySubTask` 重投并落 `retried` 历史（ADR-0053 D5）。
test_it "硬抢占：中断真实在跑的轮次 + 会话不被破坏 + 重试重投（ADR-0053 D1/D5）" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 硬抢占需要真实成员进程"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	PRE_SESSION="org-e2e-preempt-$$"
	cleanup() { tmux kill-session -t "$PRE_SESSION" 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	# 预置：组织 + 一条派给 worker-a 的任务（睡眠成员 → 落 inbox）
	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
const r = await dispatchTask({
  org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
  title: '中断 e2e', background: '验证硬抢占', items: ['写一句话'],
  targets: [{ agent: 'worker-a', description: '写一句话' }],
});
console.log('SEED ' + r.task.id + ' ' + r.task.subTasks[0].id);
EOF
	SEED_OUT="$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" 2>&1)" || {
		echo "FAIL: seed 失败"; echo "$SEED_OUT"; exit 1
	}
	TASK_ID="$(sed -n 's/^SEED \([^ ]*\) .*/\1/p' <<<"$SEED_OUT")"
	SUB_ID="$(sed -n 's/^SEED [^ ]* \([^ ]*\)$/\1/p' <<<"$SEED_OUT")"
	[[ -n "$TASK_ID" && -n "$SUB_ID" ]] || { echo "FAIL: 未取到任务号（${SEED_OUT}）"; exit 1; }

	# 成员剧本：第一轮**长工具**（sleep 20 后落一个标记文件）→ 既给我们一个真实
	# 在跑的窗口，又提供"是否真被中断"的无竞态证据：被中断则标记永不出现。
	cat >"$SB/worker/.mock-llm-script.json" <<EOF
[{"tool":"bash","args":{"command":"sleep 20 && touch $SB/natural.done"}},{"text":"sleep 结束"}]
EOF

	tmux new-session -d -s "$PRE_SESSION" -c "$SB/worker" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata pi -a --session-control"

	RT="$SB/orgdata/uat-team/runtime/worker-a.json"
	for _ in $(seq 1 200); do
		node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null && break
		sleep 0.5
	done
	node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null || {
		echo "FAIL: 成员未上岗（无法构造在跑状态）"
		tmux capture-pane -p -t "$PRE_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}

	# 等它真的在跑（上线补投触发 → bash sleep 25 → busy=true）
	BUSY=""
	for _ in $(seq 1 60); do
		BUSY=$(node -e 'try{console.log(require(process.argv[1]).busy)}catch{console.log("?")}' "$RT" 2>/dev/null || echo "?")
		[[ "$BUSY" == "true" ]] && break
		sleep 0.5
	done
	[[ "$BUSY" == "true" ]] || {
		echo "FAIL: 未能构造「成员正在跑」的状态"
		tmux capture-pane -p -t "$PRE_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}

	# 生产代码发起硬抢占（先占用执行槽，抢占才会落 interrupted 历史）
	cat >"$SB/preempt.mts" <<EOF
import { claimSlot } from '$R/extensions/auto/org/slot.ts';
import { preemptMember } from '$R/extensions/auto/org/preempt.ts';
import { readTask } from '$R/extensions/auto/org/task.ts';
await claimSlot('uat-team', 'worker-a', { taskId: '$TASK_ID', subTaskId: '$SUB_ID' });
const res = await preemptMember('uat-team', 'worker-a', '紧急：停手改做这个', { hard: true, by: 'chief-1' });
console.log('PREEMPT level=' + res.level + ' interrupted=' + res.interrupted + ' delivery=' + res.delivery);
const t = await readTask('uat-team', '$TASK_ID');
console.log('HIST ' + (t?.history ?? []).map((h) => h.event).join(','));
EOF

	P_OUT="$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/preempt.mts" 2>&1)" || true
	grep -q 'PREEMPT level=abort interrupted=true delivery=online' <<<"$P_OUT" || {
		echo "FAIL: 硬抢占未按预期生效（${P_OUT}）"
		tmux capture-pane -p -t "$PRE_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}
	grep -q 'HIST .*interrupted' <<<"$P_OUT" || {
		echo "FAIL: 抢占未落 interrupted 历史（${P_OUT}）"; exit 1
	}

	# 断言"真的被停住"：工具被中断后，sleep 之后的标记文件永不出现。
	# 等待超过 sleep 20s 的自然完成点，若中断没生效，标记会在 ~20s 时出现。
	sleep 22
	[[ ! -e "$SB/natural.done" ]] || {
		echo "FAIL: 长工具自然跑完了（标记文件出现）——abort 未真正停住当前轮"
		tmux capture-pane -p -t "$PRE_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}

	# 会话未破坏：进程与 tmux 会话都还在
	tmux has-session -t "$PRE_SESSION" 2>/dev/null || { echo "FAIL: 中断把成员进程也杀了（应只停轮次）"; exit 1; }
	PID=$(node -e 'try{console.log(require(process.argv[1]).pid)}catch{}' "$RT" 2>/dev/null || echo "")
	[[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null || { echo "FAIL: 成员进程已死（应保留）"; exit 1; }

	# 重试：把任务重新投递给同一参与者（不改状态、落 retried 历史）
	cat >"$SB/retry.mts" <<EOF
import { retrySubTask } from '$R/extensions/auto/org/dispatch.ts';
import { readTask } from '$R/extensions/auto/org/task.ts';
const r = await retrySubTask('uat-team', '$TASK_ID', '$SUB_ID', 'worker-a', { by: 'chief-1', note: '上次中断' });
console.log('RETRY ok=' + r.ok + ' msg=' + r.message);
const t = await readTask('uat-team', '$TASK_ID');
console.log('HIST2 ' + (t?.history ?? []).map((h) => h.event).join(','));
EOF
	R_OUT="$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/retry.mts" 2>&1)" || true
	grep -q 'RETRY ok=true' <<<"$R_OUT" || { echo "FAIL: 重试被拒（${R_OUT}）"; exit 1; }
	grep -q 'HIST2 .*retried' <<<"$R_OUT" || { echo "FAIL: 重试未落 retried 历史（${R_OUT}）"; exit 1; }

	# 会话确实还能干活：中断后成员照常处理了后续消息（脚本下一步的文本可见）
	cat >"$SB/activity.mts" <<EOF
import { readJson } from '$R/extensions/auto/org/util.ts';
import { fetchActivity } from '$R/extensions/auto/org/activity.ts';
const rt = await readJson<{ socketPath?: string }>('$RT');
const ok = rt?.socketPath ? await fetchActivity(rt.socketPath, 10) : { ok: false, reason: 'unreachable' };
console.log('ACT-' + (ok.ok ? 'OK ' + ok.entries.map((e) => e.text).join(' | ') : 'FAIL ' + ok.reason));
EOF
	ACT=""
	for _ in $(seq 1 60); do
		ACT=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/activity.mts" 2>&1 | grep '^ACT-' || true)
		grep -q "sleep 结束" <<<"$ACT" && break
		sleep 0.5
	done
	grep -q "sleep 结束" <<<"$ACT" || {
		echo "FAIL: 中断后成员未能继续处理消息（${ACT:-无输出}）"
		tmux capture-pane -p -t "$PRE_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}

	echo "PASS: 硬抢占真停住长工具（标记未出现）+ 进程存活 + 重试重投 + 会话可继续"
	exit 0
TEST

# ── 用例 20：在岗自愈触发（ADR-0054 D4/D5/D11）────────────────────────────
# 回归背景：`selfHealInbox` 是运行期唯一的 inbox 消化者（旧实现 takeInbox 只在
# session_start 跑一次），此前只覆盖了 `hasFreshInbox` 原语；"已上岗后落 inbox
# 会在下一拍被消化并起一轮"以及"无待办不白烧一轮 LLM"（ADR-0054 验证 2/3）都没测。
test_it "在岗自愈：运行期落 inbox 被消化并触发 + 无待办不白烧（ADR-0054 D4/D5/D11）" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 环境无 tmux —— 在岗自愈需要真实成员进程"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	HEAL_SESSION="org-e2e-heal-$$"
	cleanup() { tmux kill-session -t "$HEAL_SESSION" 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	# 只建组织、不派任何任务：收件箱为空 → 上线不应触发任何轮次
	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
console.log('SEED-DONE');
EOF
	ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" >"$SB/seed.log" 2>&1 || {
		echo "FAIL: seed 失败"; cat "$SB/seed.log"; exit 1
	}

	# 剧本：被自愈注入的内容会触发一轮，模型按此文本回应（注入内容本身是
	# `customType` 的 custom 消息，不进 get_history 的 message 条目，故以**回应**为观测点）
	cat >"$SB/worker/.mock-llm-script.json" <<'EOF'
[{"text":"已处理自愈投递"}]
EOF

	tmux new-session -d -s "$HEAL_SESSION" -c "$SB/worker" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata pi -a --session-control"

	RT="$SB/orgdata/uat-team/runtime/worker-a.json"
	for _ in $(seq 1 200); do
		node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null && break
		sleep 0.5
	done
	node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null || {
		echo "FAIL: 成员未上岗"
		tmux capture-pane -p -t "$HEAL_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}

	cat >"$SB/activity.mts" <<EOF
import { readJson } from '$R/extensions/auto/org/util.ts';
import { fetchActivity } from '$R/extensions/auto/org/activity.ts';
const rt = await readJson<{ socketPath?: string }>('$RT');
const ok = rt?.socketPath ? await fetchActivity(rt.socketPath, 10) : { ok: false, reason: 'unreachable' };
console.log('ACT-' + (ok.ok ? 'OK ' + ok.entries.length + ' ' + ok.entries.map((e) => e.text).join(' | ') : 'FAIL ' + ok.reason));
EOF

	# ① 不白烧：宽限期（15s）过后、无待办时不应出现任何轮次（entries=0）
	sleep 20
	ACT0=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/activity.mts" 2>&1 | grep '^ACT-' || true)
	grep -q '^ACT-OK 0' <<<"$ACT0" || {
		echo "FAIL: 无待办却触发了轮次（${ACT0}）"
		tmux capture-pane -p -t "$HEAL_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}

	# ② 自愈：直接往 inbox 落盘（模拟启动窗口/运行期落盘，不经任何在线投递）
	INBOX="$SB/orgdata/uat-team/inbox/worker-a"
	mkdir -p "$INBOX"
	node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ at: new Date().toISOString(), message: "[evt:heal-1] 自愈投递：请接手" }))' "$INBOX/msg-heal-1.json"

	HEALED=""
	for _ in $(seq 1 120); do
		ACT1=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/activity.mts" 2>&1 | grep '^ACT-' || true)
		if grep -q '已处理自愈投递' <<<"$ACT1"; then HEALED=1; break; fi
		sleep 0.5
	done
	[[ -n "$HEALED" ]] || {
		echo "FAIL: 运行期落 inbox 的内容未被自愈消化（无对应轮次）"
		echo "  最后动态：${ACT1:-无}"
		tmux capture-pane -p -t "$HEAL_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}

	# D11：注入成功才删 → inbox 应被清空（否则会被反复触发）
	for _ in $(seq 1 20); do
		[[ -z "$(ls -A "$INBOX" 2>/dev/null)" ]] && break
		sleep 0.5
	done
	[[ -z "$(ls -A "$INBOX" 2>/dev/null)" ]] || {
		echo "FAIL: 注入成功后 inbox 未清空"; exit 1
	}

	echo "PASS: 在岗自愈消化 inbox（无待办不触发）"
	exit 0
TEST

# ── 用例 21：取消两态 + 同意取消（此前无 e2e：cancelled_closed / consent-cancel）────
test_it "取消两态：未领取直接撤销 / 已领取须处理人同意（consent-cancel）" <<'TEST'
	set -euo pipefail
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	cleanup() { cleanup_sandbox; }
	trap cleanup EXIT

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
for (const n of [1, 2]) {
  const res = await dispatchTask({
    org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
    title: '待取消任务 ' + n, background: 'bg', items: ['a'],
    targets: [{ agent: 'worker-a', description: '子任务 ' + n }],
  });
  console.log('TASK' + n + ': ' + res.task.id);
}
EOF
	SEED=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" 2>/dev/null) || {
		echo "FAIL: seed 失败"
		exit 1
	}
	T1=$(sed -n 's/^TASK1: //p' <<<"$SEED")
	T2=$(sed -n 's/^TASK2: //p' <<<"$SEED")
	[[ -n "$T1" && -n "$T2" ]] || { echo "FAIL: 未取到任务号"; exit 1; }
	F1="$SB/orgdata/uat-team/tasks/$T1.json"
	F2="$SB/orgdata/uat-team/tasks/$T2.json"
	S2=$(grep -o '"id": "S-[a-z0-9]*"' "$F2" | head -1 | sed 's/"id": "//;s/"//')

	# ① 无人领取 → 派发人直接撤销：参与者 cancelled + 任务 closed + cancelled_closed
	run_org_cmd "$SB/chief" "cancel $T1 需求变更"
	grep -q '"event": "cancelled_closed"' "$F1" || { echo "FAIL: 缺 cancelled_closed 事件"; exit 1; }
	grep -q '"status": "cancelled"' "$F1" || { echo "FAIL: 参与者未标记 cancelled"; exit 1; }
	grep -q '"status": "closed"' "$F1" || { echo "FAIL: 取消后任务应为 closed"; exit 1; }

	# ② 已领取 → 派发人取消**被拒**（需处理人同意）：账本零改动
	run_org_cmd "$SB/worker" "claim $T2 $S2"
	grep -q '"status": "claimed"' "$F2" || { echo "FAIL: claim 未生效"; exit 1; }
	run_org_cmd "$SB/chief" "cancel $T2 计划调整"
	grep -q '"status": "claimed"' "$F2" || { echo "FAIL: 已领取任务不应被直接取消"; exit 1; }
	if grep -q '"event": "cancelled_closed"' "$F2"; then
		echo "FAIL: 已领取任务被直接取消（缺同意环节）"
		exit 1
	fi

	# ③ 非处理人不能代同意（派发人自己跑 consent-cancel 应被拒）
	run_org_cmd "$SB/chief" "consent-cancel $T2"
	if grep -q '"event": "cancelled_closed"' "$F2"; then
		echo "FAIL: 非处理人也能同意取消"
		exit 1
	fi

	# ④ 处理人同意 → 取消生效，且事件只落一次
	run_org_cmd "$SB/worker" "consent-cancel $T2"
	grep -q '"event": "cancelled_closed"' "$F2" || { echo "FAIL: 同意后未取消"; exit 1; }
	grep -q '"status": "cancelled"' "$F2" || { echo "FAIL: 参与者未标记 cancelled"; exit 1; }
	grep -q '"status": "closed"' "$F2" || { echo "FAIL: 取消后任务应为 closed"; exit 1; }
	[[ "$(grep -c '"event": "cancelled_closed"' "$F2")" == "1" ]] || {
		echo "FAIL: cancelled_closed 事件重复"
		exit 1
	}

	echo "PASS: 取消两态（未领取直接撤销 / 已领取需同意）"
	exit 0
TEST

# ── 用例 22：返工环（真实成员进程；waiting_accept / returned / rejected_returned）──
# 回归背景：**打回-返工-再交付**整条链路此前没有任何 e2e（只有 claim 时拒接的 reject）。
# 状态位：交付后任务态 waiting_accept → 打回后参与者 returned + 任务聚合回 in_progress
#         + acceptance.round=1 → 再领（returned 可领）→ 再交 → 验收 closed + round=2。
# 用真实成员进程（同进程 claim/report，槽语义与生产一致），外部动作由测试方执行。
test_it "返工环（真实成员）：交付→派发人打回→再领再交→验收 closed" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 无 tmux（返工环需要真实成员进程）"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	REWORK_SESSION="org-e2e-rework-$$"
	cleanup() { tmux kill-session -t "$REWORK_SESSION" 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
const res = await dispatchTask({
  org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
  title: '返工用例', background: 'bg', items: ['产出方案'],
  targets: [{ agent: 'worker-a', description: '方案 + 风险章节' }],
});
console.log('TASK: ' + res.task.id);
EOF
	SEED=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" 2>/dev/null) || {
		echo "FAIL: seed 失败"
		exit 1
	}
	TASK_ID=$(sed -n 's/^TASK: //p' <<<"$SEED")
	[[ -n "$TASK_ID" ]] || { echo "FAIL: 未取到任务号"; exit 1; }
	F="$SB/orgdata/uat-team/tasks/$TASK_ID.json"
	SUB=$(grep -o '"id": "S-[a-z0-9]*"' "$F" | head -1 | sed 's/"id": "//;s/"//')

	# 成员剧本：第一轮 领+交 →（测试方打回）→ 第二轮 再领+再交
	cat >"$SB/worker/.mock-llm-script.json" <<EOF
[{"tool":"org_claim","args":{"taskId":"$TASK_ID","subTaskId":"$SUB"}},
 {"tool":"org_report","args":{"taskId":"$TASK_ID","subTaskId":"$SUB","summary":"初稿完成：骨架 + 数据"}},
 {"text":"第一轮交付完成。"},
 {"tool":"org_claim","args":{"taskId":"$TASK_ID","subTaskId":"$SUB"}},
 {"tool":"org_report","args":{"taskId":"$TASK_ID","subTaskId":"$SUB","summary":"已补风险章节并自检"}},
 {"text":"返工完成。"}]
EOF

	tmux new-session -d -s "$REWORK_SESSION" -c "$SB/worker" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata pi -a --session-control"

	RT="$SB/orgdata/uat-team/runtime/worker-a.json"
	for _ in $(seq 1 200); do
		node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null && break
		sleep 0.5
	done
	node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null || {
		echo "FAIL: 成员未上岗"
		tmux capture-pane -p -t "$REWORK_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}

	# 走生产投递通道驱动成员跑一轮（tmux send-keys 在 TUI 未就绪时会丢键）
	drive_member() { # $1=提示语
		# 只投一次：成员忙时 `deliverMessage` 自身会落 inbox（其上线/自愈消化），
		# 若在此重试会造成**重复投递**→成员被连灌多轮（实测导致剧本越轮跑完）
		cat >"$SB/prompt.mts" <<EOF
import { deliverMessage } from '$R/extensions/auto/org/dispatch.ts';
const mode = await deliverMessage('uat-team', 'worker-a', '$1', { sender: 'chief-1' });
console.log('PROMPT ' + mode);
EOF
		ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/prompt.mts" >/dev/null 2>&1 || true
	}
	# 账本是美化 JSON：任务态用 node 断言（别用裸 grep 猜缩进）
	task_status() { node -e 'try{console.log(require(process.argv[1]).status)}catch{console.log("?")}' "$F" 2>/dev/null; }
	wait_status() { # $1=期望态 $2=拍数（0.5s/拍）
		for _ in $(seq 1 "$2"); do
			[[ "$(task_status)" == "$1" ]] && return 0
			sleep 0.5
		done
		return 1
	}

	# 第一轮：**由上线补投驱动**（成员在岗时消化派发消息 → 跑剧本前 3 步），
	# 这里不再补发 prompt——多一次注入会让剧本提前进入第二段（实测）
	wait_status waiting_accept 240 || {
		echo "FAIL: 首轮交付后任务态应为 waiting_accept（实际 $(task_status)）"
		tmux capture-pane -p -t "$REWORK_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}
	grep -q '"status": "delivered"' "$F" || { echo "FAIL: 参与者未 delivered"; exit 1; }

	# 派发人打回（必须带原因）→ returned + rejected_returned + round=1 + 聚合回 in_progress
	run_org_cmd "$SB/chief" "return $TASK_ID 缺风险章节，请补齐"
	grep -q '"status": "returned"' "$F" || { echo "FAIL: 打回后参与者态应为 returned"; exit 1; }
	grep -q '"event": "rejected_returned"' "$F" || { echo "FAIL: 缺 rejected_returned 事件"; exit 1; }
	grep -q '"round": 1' "$F" || { echo "FAIL: 打回轮次未 +1"; exit 1; }
	[[ "$(task_status)" == "in_progress" ]] || {
		echo "FAIL: 打回后任务应聚合回 in_progress（实际 $(task_status)）"
		exit 1
	}
	grep -q '缺风险章节' "$F" || { echo "FAIL: 打回原因未落账（不可指认）"; exit 1; }

	# 返工轮：returned 可再领 → 再交 → 第二次 delivered
	drive_member "继续返工"
	SECOND=""
	for _ in $(seq 1 240); do
		SECOND=$(node -e '
const t=require(process.argv[1]);
const n=(t.history||[]).filter((h)=>h.event==="delivered").length;
if (n>=2) console.log(String(n));' "$F" 2>/dev/null || true)
		[[ -n "$SECOND" ]] && break
		sleep 0.5
	done
	[[ -n "$SECOND" ]] || {
		echo "FAIL: 返工后未出现第二次交付（returned 无法再领？）"
		tmux capture-pane -p -t "$REWORK_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}
	wait_status waiting_accept 120 || { echo "FAIL: 二次交付后任务态应为 waiting_accept"; exit 1; }

	# 验收通过 → 终态 + 轮次 2
	run_org_cmd "$SB/chief" "approve $TASK_ID 通过"
	grep -q '"status": "closed"' "$F" || { echo "FAIL: 未 closed"; exit 1; }
	grep -q '"result": "accepted"' "$F" || { echo "FAIL: 缺验收记录"; exit 1; }
	grep -q '"round": 2' "$F" || { echo "FAIL: 验收轮次应为 2"; exit 1; }

	echo "PASS: 返工环（waiting_accept → returned → 再交付 → closed）"
	exit 0
TEST

# ── 用例 23：执行槽生命周期（真实成员进程；ADR-0055 D1/D2 回归）────────────────
# 回归背景：槽「占住不放」曾让成员永久卡在"一次只做一件"（P1）。本用例在**真实成员进程**里
# 跑完整生命周期：占槽 → 领第二件被拒（账本零改动）→ 交付释放 → 领第二件成功
# → 外部取消+同意 → **失效槽被识别并释放** → 领第三件成功。
test_it "执行槽生命周期（真实成员）：一次只做一件 → 交付释放 → 取消后放行" <<'TEST'
	set -euo pipefail
	if ! command -v tmux >/dev/null 2>&1; then
		echo "SKIP: 无 tmux（槽语义需要真实成员进程）"
		exit 0
	fi
	SB="$(setup_org_sandbox)"
	R="$ROOT_DIR"
	SLOT_SESSION="org-e2e-slot-$$"
	cleanup() { tmux kill-session -t "$SLOT_SESSION" 2>/dev/null || true; cleanup_sandbox; }
	trap cleanup EXIT

	mkdir -p "$SB/home/.pi/agent/extensions/control"
	cp "$R"/extensions/auto/control/*.ts "$SB/home/.pi/agent/extensions/control/"
	cp "$R"/extensions/auto/control/package.json "$SB/home/.pi/agent/extensions/control/" 2>/dev/null || true

	cat >"$SB/seed.mts" <<EOF
import { createOrg, joinOrg } from '$R/extensions/auto/org/orgstore.ts';
import { dispatchTask } from '$R/extensions/auto/org/dispatch.ts';
await createOrg('uat-team', { name: 'chief-1', dir: '$SB/chief' });
await joinOrg('uat-team', { manifest: { name: 'worker-a', role: 'member' }, dir: '$SB/worker' });
for (const n of [1, 2, 3]) {
  const res = await dispatchTask({
    org: 'uat-team', dispatcher: 'chief-1', dispatcherRole: 'chief',
    title: '槽用例任务 ' + n, background: 'bg', items: ['a'],
    targets: [{ agent: 'worker-a', description: '子任务 ' + n }],
  });
  console.log('TASK' + n + ': ' + res.id + ':' + res.task.id);
}
EOF
	SEED=$(ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/seed.mts" 2>/dev/null) || {
		echo "FAIL: seed 失败"
		exit 1
	}
	T1=$(sed -n 's/^TASK1: [^:]*://p' <<<"$SEED")
	T2=$(sed -n 's/^TASK2: [^:]*://p' <<<"$SEED")
	T3=$(sed -n 's/^TASK3: [^:]*://p' <<<"$SEED")
	[[ -n "$T1" && -n "$T2" && -n "$T3" ]] || { echo "FAIL: 未取到任务号"; exit 1; }
	TD="$SB/orgdata/uat-team/tasks"
	F1="$TD/$T1.json"
	F2="$TD/$T2.json"
	SLOT="$SB/orgdata/uat-team/slots/worker-a.json"
	sub_of() { grep -o '"id": "S-[a-z0-9]*"' "$1" | head -1 | sed 's/"id": "//;s/"//'; }
	S1=$(sub_of "$F1")
	S2=$(sub_of "$F2")
	S3=$(sub_of "$TD/$T3.json")

	# 成员剧本（3 轮 prompt 驱动）：
	#   ① 领 T1（占槽）② 领 T2（应被拒）③ 文本
	#   ④ 交 T1（释放槽）⑤ 领 T2（成功）⑥ 文本
	#   ⑦ 领 T3（此时 T2 已被取消 → 失效槽须被识别释放）⑧ 文本
	cat >"$SB/worker/.mock-llm-script.json" <<EOF
[{"tool":"org_claim","args":{"taskId":"$T1","subTaskId":"$S1"}},
 {"tool":"org_claim","args":{"taskId":"$T2","subTaskId":"$S2"}},
 {"text":"第一轮结束。"},
 {"tool":"org_report","args":{"taskId":"$T1","subTaskId":"$S1","summary":"T1 初稿"}},
 {"tool":"org_claim","args":{"taskId":"$T2","subTaskId":"$S2"}},
 {"text":"第二轮结束。"},
 {"tool":"org_claim","args":{"taskId":"$T3","subTaskId":"$S3"}},
 {"text":"第三轮结束。"}]
EOF

	tmux new-session -d -s "$SLOT_SESSION" -c "$SB/worker" \
		"env HOME=$SB/home ORG_ROOT=$SB/orgdata pi -a --session-control"

	RT="$SB/orgdata/uat-team/runtime/worker-a.json"
	for _ in $(seq 1 200); do
		node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null && break
		sleep 0.5
	done
	node -e 'const r=require(process.argv[1]);process.exit(r.socketPath?0:1)' "$RT" 2>/dev/null || {
		echo "FAIL: 成员未上岗"
		tmux capture-pane -p -t "$SLOT_SESSION" 2>/dev/null | tail -20 || true
		exit 1
	}

	drive_member() { # $1=提示语
		# 只投一次：成员忙时 `deliverMessage` 自身会落 inbox（其上线/自愈消化），
		# 若在此重试会造成**重复投递**→成员被连灌多轮（实测导致剧本越轮跑完）
		cat >"$SB/prompt.mts" <<EOF
import { deliverMessage } from '$R/extensions/auto/org/dispatch.ts';
const mode = await deliverMessage('uat-team', 'worker-a', '$1', { sender: 'chief-1' });
console.log('PROMPT ' + mode);
EOF
		ORG_ROOT="$SB/orgdata" npx --prefix "$R" tsx "$SB/prompt.mts" >/dev/null 2>&1 || true
	}
	slot_task() { node -e 'try{console.log(require(process.argv[1]).taskId)}catch{console.log("-")}' "$SLOT" 2>/dev/null; }
	assignee_status() { # $1=任务文件
		node -e 'const t=require(process.argv[1]);console.log(t.subTasks[0].assignees[0].status)' "$1" 2>/dev/null
	}
	wait_assignee() { # $1=任务文件 $2=期望态 $3=拍数
		for _ in $(seq 1 "$3"); do
			[[ "$(assignee_status "$1")" == "$2" ]] && return 0
			sleep 0.5
		done
		return 1
	}

	# 第一轮：领 T1 成功 → 再领 T2 应被拒（槽占用 + 账本零改动）
	# 同样由**上线补投**（3 条派发消息合并注入）驱动剧本前 3 步
	wait_assignee "$F1" claimed 240 || {
		echo "FAIL: T1 未被领取（实际 $(assignee_status "$F1")）"
		tmux capture-pane -p -t "$SLOT_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}
	[[ "$(slot_task)" == "$T1" ]] || { echo "FAIL: 槽未指向 T1（实际 $(slot_task)）"; exit 1; }
	# 给被拒那次工具调用留出落地时间，再断言"账本零改动"
	for _ in $(seq 1 30); do
		[[ "$(assignee_status "$F2")" == "invited" ]] || break
		sleep 0.5
	done
	[[ "$(assignee_status "$F2")" == "invited" ]] || {
		echo "FAIL: 槽被占时不应能领第二件（T2=$(assignee_status "$F2")）"
		exit 1
	}
	[[ "$(slot_task)" == "$T1" ]] || { echo "FAIL: 被拒后槽应仍指向 T1（实际 $(slot_task)）"; exit 1; }

	# 第二轮：交付 T1 →（槽释放）→ 领 T2 成功
	# 交付与"领 T2"在同一轮剧本里先后发生，故**不**断言中间态"槽为空"（观测会与下一步竞态）；
	# 能领到 T2 本身就是"槽已被释放"的行为证明（否则领取会被拒：一次只做一件）。
	drive_member "第二轮"
	wait_assignee "$F1" delivered 180 || { echo "FAIL: T1 未交付"; exit 1; }
	wait_assignee "$F2" claimed 180 || {
		echo "FAIL: 交付释放后应能领到 T2（实际 $(assignee_status "$F2")）"
		tmux capture-pane -p -t "$SLOT_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}

	# 外部：取消 T2（已领取 → 需处理人同意）
	run_org_cmd "$SB/chief" "cancel $T2 计划调整"
	run_org_cmd "$SB/worker" "consent-cancel $T2"
	grep -q '"status": "cancelled"' "$F2" || { echo "FAIL: T2 未被取消"; exit 1; }
	[[ "$(slot_task)" == "$T2" ]] || {
		echo "FAIL: 取消不直接删槽（应由认领侧识别失效；实际 $(slot_task)）"
		exit 1
	}

	# 第三轮：T2 已被取消 → 失效槽必须被识别释放 → 领 T3 成功（P1 回归点）
	drive_member "第三轮"
	wait_assignee "$TD/$T3.json" claimed 180 || {
		echo "FAIL: 取消后成员仍被失效槽挡住（T3=$(assignee_status "$TD/$T3.json")）"
		tmux capture-pane -p -t "$SLOT_SESSION" 2>/dev/null | tail -15 || true
		exit 1
	}

	echo "PASS: 执行槽生命周期（占槽拒第二件 → 交付释放 → 取消后放行）"
	exit 0
TEST
