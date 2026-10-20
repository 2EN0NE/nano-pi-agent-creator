#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# bench-run 技能的 e2e 自检：守护 bench/ 工具链的契约行为
# ──────────────────────────────────────────────────────────────────────────────
# 覆盖三类无 pi、无 LLM 的纯 bash 契约（见测试分析发现 P1/P2）：
#   1. preflight.sh  —— 缺依赖时 fail-fast + 聚合报告（ADR-0056 承诺的 e2e 覆盖）
#   2. find-extension.sh —— 四级解析与优先级（ADR-0057 抽取的单一真源）
#   3. run-matrix.sh --pilot —— 先导门的调用集合 / 不跑 analyze / resume 命令
#
# 实现方式：把 preflight.sh / find-extension.sh / run-matrix.sh 复制进临时目录，
# 用 stub（pi / git / run-cell / analyze）驱动，构造确定性的「缺依赖 / 坏配置」夹具。
# 不启动 pi、不调用 LLM、不改动真实仓库。

test_describe "bench-run tooling"

BENCH_SRC="$ROOT_DIR/bench"
BASH_BIN="$(command -v bash)"

# 物理路径的临时目录：macOS 的 /var → /private/var 软链接会让路径字符串比对失败，
# 而 find-extension.sh 内部用 `cd && pwd` 取物理路径。
_tmpdir() {
  local d
  d=$(mktemp -d)
  (cd "$d" && pwd)
}

# 隔离 PATH 的 bin 目录：只放 preflight 真正会执行/探测的命令 + pi/git stub。
# 这样「缺 go」等工具链断言与宿主是否装了 go 无关，也让测试不依赖真实 pi 安装。
_mk_isolated_bin() {
  local dir="$1" c p
  mkdir -p "$dir"
  for c in bash python3 dirname sed head; do
    p=$(command -v "$c" 2>/dev/null) && ln -s "$p" "$dir/$c"
  done
  for c in pi git; do
    printf '#!/bin/sh\nexit 0\n' >"$dir/$c"
    chmod +x "$dir/$c"
  done
}

# 假 bench/repo 树（preflight 的 REPO_ROOT = bench/..）。默认不含 @zenone 假包。
_mk_fake_repo() {
  local root="$1"
  mkdir -p "$root/bench/.cache" "$root/home/.pi/agent"
  cp "$BENCH_SRC/preflight.sh" "$root/bench/preflight.sh"
  cat >"$root/bench/arms.json" <<'JSON'
{"baseline": [], "arms": {"none": {"triggerTools": []}}}
JSON
}

# 能解析 bash-timeout / known 的 find-extension stub（其余一律 exit 1）。
# 注意：config 臂名 plugin-<name> 去掉前缀后就是插件名（plugin-known → known）。
_write_stub_find_extension() {
  local root="$1"
  cat >"$root/bench/find-extension.sh" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  bash-timeout|known) echo "/stub/${1}.ts"; exit 0 ;;
  *) exit 1 ;;
esac
SH
  chmod +x "$root/bench/find-extension.sh"
}

_mk_zenone() {
  local root="$1"
  mkdir -p "$root/node_modules/@zenone/pi-logger" "$root/node_modules/@zenone/pi-config"
}

_mk_model_store() {
  local home="$1"
  mkdir -p "$home/.pi/agent"
  printf '{"m": {"models": [{"id": "x"}]}}\n' >"$home/.pi/agent/models-store.json"
}

# 运行 preflight：结果写入 PF_RC / PF_OUT / PF_ERR（供断言读取）。
# PF_MODEL 可临时覆盖（如 PF_MODEL="" _run_preflight ... 造「未指定模型」）。
PF_MODEL="m/x"
_run_preflight() {
  local bin="$1" root="$2"
  shift 2
  PF_RC=0
  PF_OUT=$(PATH="$bin" BENCH_HOME="$root/home" BENCH_MODEL="$PF_MODEL" \
    "$BASH_BIN" "$root/bench/preflight.sh" "$@" 2>"$root/pf.err") || PF_RC=$?
  # shellcheck disable=SC2034  # 供 eval 的用例体读取（shellcheck 看不到 eval 内部的引用）
  PF_ERR=$(cat "$root/pf.err")
}

# ── 用例 1：find-extension.sh 四级解析与优先级 ──
test_it "find-extension resolves the 4 levels with correct precedence" <<'TEST'
  root=$(_tmpdir)
  mkdir -p "$root/bench" "$root/extensions/cat/dir-ext" "$root/extensions/cat/dup" \
    "$root/test/helpers" "$root/home/.pi/agent/npm/node_modules/npmpkg"
  cp "$BENCH_SRC/find-extension.sh" "$root/bench/find-extension.sh"
  : >"$root/extensions/cat/dir-ext/index.ts"
  : >"$root/extensions/cat/file-ext.ts"
  : >"$root/extensions/cat/dup.ts"          # 同名单文件
  : >"$root/extensions/cat/dup/index.ts"    # 与目录式同名 → 目录式优先
  : >"$root/test/helpers/helper-ext.ts"
  printf '{"pi": {"extensions": ["./main.js"]}}\n' \
    >"$root/home/.pi/agent/npm/node_modules/npmpkg/package.json"
  : >"$root/home/.pi/agent/npm/node_modules/npmpkg/main.js"

  fail=""
  got=$(HOME="$root/home" "$BASH_BIN" "$root/bench/find-extension.sh" dir-ext 2>/dev/null)
  # 目录式返回目录本身（pi 自行解析 <dir>/index.ts；见 pi formatExtensionDisplayPath）
  [ "$got" = "$root/extensions/cat/dir-ext" ] || fail="$fail level1(dir)"
  got=$(HOME="$root/home" "$BASH_BIN" "$root/bench/find-extension.sh" file-ext 2>/dev/null)
  [ "$got" = "$root/extensions/cat/file-ext.ts" ] || fail="$fail level2(file)"
  got=$(HOME="$root/home" "$BASH_BIN" "$root/bench/find-extension.sh" dup 2>/dev/null)
  [ "$got" = "$root/extensions/cat/dup" ] || fail="$fail precedence(dir>file)"
  got=$(HOME="$root/home" "$BASH_BIN" "$root/bench/find-extension.sh" helper-ext 2>/dev/null)
  [ "$got" = "$root/test/helpers/helper-ext.ts" ] || fail="$fail level3(test-helper)"
  got=$(HOME="$root/home" "$BASH_BIN" "$root/bench/find-extension.sh" npmpkg 2>/dev/null)
  [ "$got" = "$root/home/.pi/agent/npm/node_modules/npmpkg/main.js" ] || fail="$fail level4(npm)"
  HOME="$root/home" "$BASH_BIN" "$root/bench/find-extension.sh" nope-xyz >/dev/null 2>&1
  [ $? -eq 1 ] || fail="$fail not-found(exit1)"

  rm -rf "$root"
  if [ -n "$fail" ]; then echo "find-extension failures:$fail"; exit 1; fi
  exit 0
TEST

# ── 用例 2：preflight 缺 @zenone → exit 2 且聚合列出两个包 ──
test_it "preflight fail-fast lists all missing @zenone packages" <<'TEST'
  root=$(_tmpdir)
  _mk_fake_repo "$root"
  _mk_isolated_bin "$root/bin"
  _mk_model_store "$root/home"
  _run_preflight "$root/bin" "$root" --arms none
  rc=$PF_RC err=$PF_ERR
  rm -rf "$root"
  [ "$rc" -eq 2 ] || { echo "expected exit 2, got $rc"; echo "$err"; exit 1; }
  echo "$err" | grep -q "@zenone/pi-logger" || { echo "missing pi-logger problem"; echo "$err"; exit 1; }
  echo "$err" | grep -q "@zenone/pi-config" || { echo "missing pi-config problem"; echo "$err"; exit 1; }
  exit 0
TEST

# ── 用例 3：preflight 模型缺失 / 模型库损坏 / 模型不在库 ──
test_it "preflight reports missing or invalid model store" <<'TEST'
  root=$(_tmpdir)
  _mk_fake_repo "$root"
  _mk_isolated_bin "$root/bin"
  _mk_zenone "$root"
  fail=""

  # 3a 模型库不存在
  _run_preflight "$root/bin" "$root" --arms none
  [ "$PF_RC" -eq 2 ] || fail="$fail missing-store(exit)"
  echo "$PF_ERR" | grep -q "找不到模型库" || fail="$fail missing-store(msg)"

  # 3b 模型库 JSON 损坏 → 必须报「读取或解析失败」，不得误报「模型不存在」
  mkdir -p "$root/home/.pi/agent"
  printf '{not json' >"$root/home/.pi/agent/models-store.json"
  _run_preflight "$root/bin" "$root" --arms none
  [ "$PF_RC" -eq 2 ] || fail="$fail invalid-store(exit)"
  echo "$PF_ERR" | grep -q "读取或解析失败" || fail="$fail invalid-store(msg)"

  # 3c 模型库合法但无该模型
  printf '{"m": {"models": [{"id": "y"}]}}\n' >"$root/home/.pi/agent/models-store.json"
  _run_preflight "$root/bin" "$root" --arms none
  echo "$PF_ERR" | grep -q "模型 m/x 不在" || fail="$fail absent-model(msg)"

  # 3d 未指定模型
  PF_MODEL="" _run_preflight "$root/bin" "$root" --arms none
  echo "$PF_ERR" | grep -q "未指定模型" || fail="$fail no-model(msg)"

  # 3e 模型标识格式非法（无 <provider>/）
  PF_MODEL="no-slash" _run_preflight "$root/bin" "$root" --arms none
  [ "$PF_RC" -eq 2 ] || fail="$fail malformed-model(exit)"
  echo "$PF_ERR" | grep -q "格式非法" || fail="$fail malformed-model(msg)"

  rm -rf "$root"
  if [ -n "$fail" ]; then echo "model-store failures:$fail"; exit 1; fi
  exit 0
TEST

# ── 用例 4：preflight 缺 go（language=go 的工具链映射，PATH 隔离保证确定性）──
test_it "preflight reports missing go toolchain for a go task" <<'TEST'
  root=$(_tmpdir)
  _mk_fake_repo "$root"
  _mk_isolated_bin "$root/bin"
  _mk_model_store "$root/home"
  _mk_zenone "$root"
  mkdir -p "$root/tasks/go-task"
  # 值换行的格式化 JSON——逐行 sed 正则会把 language 读空并误报「缺 language 字段」
  printf '{\n  "slug": "go-task",\n  "language":\n    "go"\n}\n' >"$root/tasks/go-task/task.json"

  _run_preflight "$root/bin" "$root" --arms none "$root/tasks/go-task"
  rc=$PF_RC err=$PF_ERR
  rm -rf "$root"
  [ "$rc" -eq 2 ] || { echo "expected exit 2, got $rc"; echo "$err"; exit 1; }
  echo "$err" | grep -q "缺少命令 go" || { echo "missing go problem"; echo "$err"; exit 1; }
  exit 0
TEST

# ── 用例 5：preflight 未登记语言 / 缺 task.json ──
test_it "preflight rejects unregistered language and missing task.json" <<'TEST'
  root=$(_tmpdir)
  _mk_fake_repo "$root"
  _mk_isolated_bin "$root/bin"
  _mk_model_store "$root/home"
  _mk_zenone "$root"
  mkdir -p "$root/tasks/cobol-task" "$root/tasks/nojson" "$root/tasks/badjson"
  printf '{"slug": "cobol-task", "language": "cobol"}\n' >"$root/tasks/cobol-task/task.json"
  printf '{oops' >"$root/tasks/badjson/task.json"

  _run_preflight "$root/bin" "$root" --arms none "$root/tasks/cobol-task" "$root/tasks/nojson" "$root/tasks/badjson"
  rc=$PF_RC err=$PF_ERR
  rm -rf "$root"
  [ "$rc" -eq 2 ] || { echo "expected exit 2, got $rc"; exit 1; }
  echo "$err" | grep -q "未登记" || { echo "missing unregistered-language problem"; echo "$err"; exit 1; }
  echo "$err" | grep -q "任务定义缺失" || { echo "missing task.json problem"; echo "$err"; exit 1; }
  echo "$err" | grep -q "任务定义解析失败" || { echo "missing malformed-task.json problem"; echo "$err"; exit 1; }
  exit 0
TEST

# ── 用例 6：preflight 聚合报告——一次列全所有问题（不是首个即退）──
test_it "preflight aggregates multiple problems in one run" <<'TEST'
  root=$(_tmpdir)
  _mk_fake_repo "$root"
  _mk_isolated_bin "$root/bin"
  # 不建 @zenone、不建 models-store，再加一个未登记语言任务 → 至少 3 类问题
  mkdir -p "$root/tasks/cobol-task"
  printf '{"slug": "cobol-task", "language": "cobol"}\n' >"$root/tasks/cobol-task/task.json"

  _run_preflight "$root/bin" "$root" --arms none "$root/tasks/cobol-task"
  rc=$PF_RC err=$PF_ERR
  rm -rf "$root"
  [ "$rc" -eq 2 ] || { echo "expected exit 2, got $rc"; exit 1; }
  echo "$err" | grep -q "@zenone/pi-logger" || { echo "missing @zenone problem"; echo "$err"; exit 1; }
  echo "$err" | grep -q "找不到模型库" || { echo "missing model-store problem"; echo "$err"; exit 1; }
  echo "$err" | grep -q "未登记" || { echo "missing language problem"; echo "$err"; exit 1; }
  exit 0
TEST

# ── 用例 7：preflight 臂校验——已登记 + 可解析通过；未登记 / 解析不到 fail-fast ──
test_it "preflight validates config arms against the registry" <<'TEST'
  root=$(_tmpdir)
  _mk_fake_repo "$root"
  _mk_isolated_bin "$root/bin"
  _mk_model_store "$root/home"
  _mk_zenone "$root"
  _write_stub_find_extension "$root"
  cat >"$root/bench/arms.json" <<'JSON'
{"baseline": ["bash-timeout"],
 "arms": {"none": {"triggerTools": []},
          "plugin-known": {"triggerTools": []},
          "plugin-missing": {"triggerTools": []}}}
JSON
  fail=""

  _run_preflight "$root/bin" "$root" --arms none,plugin-known
  [ "$PF_RC" -eq 0 ] || fail="$fail known-arm(exit=$PF_RC)"
  echo "$PF_OUT" | grep -q "前置检查通过" || fail="$fail known-arm(pass-msg)"

  _run_preflight "$root/bin" "$root" --arms plugin-nope
  [ "$PF_RC" -eq 2 ] || fail="$fail unregistered-arm(exit)"
  echo "$PF_ERR" | grep -q "未注册" || fail="$fail unregistered-arm(msg)"

  _run_preflight "$root/bin" "$root" --arms plugin-missing
  [ "$PF_RC" -eq 2 ] || fail="$fail unresolved-arm(exit)"
  echo "$PF_ERR" | grep -q "插件未找到" || fail="$fail unresolved-arm(msg)"

  rm -rf "$root"
  if [ -n "$fail" ]; then echo "arm-validation failures:$fail"; exit 1; fi
  exit 0
TEST

# ── 用例 8：run-matrix.sh --pilot 先导门（stub 驱动，断言调用集合 / 不跑 analyze / resume）──
_pilot_root() {
  local root
  root=$(_tmpdir)
  mkdir -p "$root/bench/tasks/t1" "$root/bench/tasks/t2"
  cp "$BENCH_SRC/run-matrix.sh" "$root/bench/run-matrix.sh"
  cp "$BENCH_SRC/progress.py" "$root/bench/progress.py"
  chmod +x "$root/bench/progress.py"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$root/bench/preflight.sh"
  chmod +x "$root/bench/preflight.sh"
  cat >"$root/bench/run-cell.sh" <<'SH'
#!/usr/bin/env bash
echo "$(basename "$1")|${2}|${3}" >>"${STUB_RUNCELL_LOG}"
exit "${STUB_RUNCELL_EXIT:-0}"
SH
  chmod +x "$root/bench/run-cell.sh"
  cat >"$root/bench/analyze.py" <<'PY'
import os
with open(os.environ["STUB_ANALYZE_LOG"], "a") as fh:
    fh.write("called\n")
PY
  : >"$root/bench/tasks/t1/task.json"
  : >"$root/bench/tasks/t2/task.json"
  echo "$root"
}

test_it "run-matrix --pilot runs one cell per arm on the first task only" <<'TEST'
  root=$(_pilot_root)
  export STUB_RUNCELL_LOG="$root/runcell.log"
  export STUB_ANALYZE_LOG="$root/analyze.log"
  : >"$STUB_RUNCELL_LOG"
  rm -f "$STUB_ANALYZE_LOG"

  "$BASH_BIN" "$root/bench/run-matrix.sh" \
    --tasks t1,t2 --configs none,plugin-x --reps 2 --model stub/model --pilot \
    >"$root/stdout.log" 2>&1
  rc=$?

  run_dir=$(ls -d "$root/bench/results"/*/ 2>/dev/null | head -1)
  # tee 经进程替换写 run.log，退出后可能尚未 flush：轮询等待
  i=0
  while [ "$i" -lt 10 ] && ! grep -q -- "--resume" "$run_dir/run.log" 2>/dev/null; do
    sleep 0.3
    i=$((i + 1))
  done

  fail=""
  [ "$rc" -eq 0 ] || fail="$fail exit=$rc"
  # 调用集合恰为 {none,plugin-x} × t1 × rep0（无 t2、无 rep1）
  [ "$(wc -l <"$STUB_RUNCELL_LOG" | tr -d ' ')" = "2" ] || fail="$fail cell-count=$(wc -l <"$STUB_RUNCELL_LOG")"
  grep -q '^t1|none|0$' "$STUB_RUNCELL_LOG" || fail="$fail cell(none,t1,0)"
  grep -q '^t1|plugin-x|0$' "$STUB_RUNCELL_LOG" || fail="$fail cell(plugin-x,t1,0)"
  # pilot 不跑 analyze
  [ ! -f "$STUB_ANALYZE_LOG" ] || fail="$fail analyze-was-called"
  # manifest 写全量配置，先导 cell 之后可被 --resume 复用
  grep -q '"tasks": "t1,t2"' "$run_dir/manifest.json" || fail="$fail manifest-tasks"
  grep -q '"reps": 2' "$run_dir/manifest.json" || fail="$fail manifest-reps"
  # 打印可复用的 resume 命令
  grep -q "pilot 通过" "$run_dir/run.log" || fail="$fail pilot-pass-msg"
  grep -q -- "--resume" "$run_dir/run.log" || fail="$fail resume-command"

  unset STUB_RUNCELL_LOG STUB_ANALYZE_LOG
  rm -rf "$root"
  if [ -n "$fail" ]; then echo "pilot failures:$fail"; exit 1; fi
  exit 0
TEST

test_it "run-matrix --pilot exits non-zero when a pilot cell fails" <<'TEST'
  root=$(_pilot_root)
  export STUB_RUNCELL_LOG="$root/runcell.log"
  export STUB_ANALYZE_LOG="$root/analyze.log"
  : >"$STUB_RUNCELL_LOG"
  rm -f "$STUB_ANALYZE_LOG"
  export STUB_RUNCELL_EXIT=1

  "$BASH_BIN" "$root/bench/run-matrix.sh" \
    --tasks t1 --configs none --reps 1 --model stub/model --pilot \
    >"$root/stdout.log" 2>&1
  rc=$?

  run_dir=$(ls -d "$root/bench/results"/*/ 2>/dev/null | head -1)
  i=0
  while [ "$i" -lt 10 ] && ! grep -q "pilot 完成但" "$run_dir/run.log" 2>/dev/null; do
    sleep 0.3
    i=$((i + 1))
  done

  fail=""
  [ "$rc" -eq 1 ] || fail="$fail exit=$rc"
  grep -q "pilot 完成但" "$run_dir/run.log" || fail="$fail failure-msg"
  [ ! -f "$STUB_ANALYZE_LOG" ] || fail="$fail analyze-was-called"

  unset STUB_RUNCELL_LOG STUB_ANALYZE_LOG STUB_RUNCELL_EXIT
  rm -rf "$root"
  if [ -n "$fail" ]; then echo "pilot-failure failures:$fail"; exit 1; fi
  exit 0
TEST
