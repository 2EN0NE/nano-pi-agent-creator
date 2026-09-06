#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# sync-to-local-pi 端到端测试
# ──────────────────────────────────────────────────────────────────────────────

test_describe "sync-to-local-pi tool"

# ══════════════════════════════════════════════════════════════════════════════
# 辅助函数
# ══════════════════════════════════════════════════════════════════════════════

SYNC_SCRIPT="$ROOT_DIR/scripts/sync-to-local-pi.ts"

# 清理测试目录
clean_test_dir() {
  rm -rf "$ROOT_DIR/.pi/test"
}

# ══════════════════════════════════════════════════════════════════════════════
# 用例
# ══════════════════════════════════════════════════════════════════════════════

# ── 用例 1：--help 输出包含两种模式说明 ──
test_it "--help shows both profile and inline modes" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --help 2>&1)
  [[ "$output" == *"Profile mode"* ]] || { echo "Missing 'Profile mode'"; exit 1; }
  [[ "$output" == *"Inline mode"* ]] || { echo "Missing 'Inline mode'"; exit 1; }
  [[ "$output" == *"--ext"* ]] || { echo "Missing '--ext'"; exit 1; }
  [[ "$output" == *"--target"* ]] || { echo "Missing '--target'"; exit 1; }
TEST

# ── 用例 2：dry-run 内联模式同步单个扩展 ──
test_it "dry-run inline mode syncs pi-logger extension" <<'TEST'
  clean_test_dir
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --ext pi-logger --target ./.pi/test 2>&1)
  [[ "$output" == *"DRY RUN"* ]] || { echo "Missing dry run indicator"; exit 1; }
  [[ "$output" == *"pi-logger"* ]] || { echo "Missing pi-logger in output"; exit 1; }
  # dry-run 不应创建文件
  [[ -d "$ROOT_DIR/.pi/test" ]] && { echo "Dry run created files"; exit 1; }
  echo "Verified: dry-run did not write files"
TEST

# ── 用例 3：内联模式实际同步扩展到 .pi/test ──
test_it "inline mode actually syncs extension to .pi/test" <<'TEST'
  clean_test_dir
  npx tsx "$SYNC_SCRIPT" --ext pi-logger --target ./.pi/test 2>&1
  # pi-logger 是目录扩展（有 index.ts）
  [[ -f "$ROOT_DIR/.pi/test/extensions/pi-logger/index.ts" ]] || { echo "pi-logger/index.ts not found"; exit 1; }
  [[ -f "$ROOT_DIR/.pi/test/extensions/pi-logger/package.json" ]] || { echo "pi-logger/package.json not found"; exit 1; }
  echo "Verified: pi-logger synced correctly"
  clean_test_dir
TEST

# ── 用例 4：内联模式同步文件扩展（.ts 文件） ──
test_it "inline mode syncs single-file extension" <<'TEST'
  clean_test_dir
  npx tsx "$SYNC_SCRIPT" --ext review --target ./.pi/test 2>&1
  [[ -f "$ROOT_DIR/.pi/test/extensions/review.ts" ]] || { echo "review.ts not found"; exit 1; }
  echo "Verified: review.ts synced correctly"
  clean_test_dir
TEST

# ── 用例 5：内联模式同步主题 ──
test_it "inline mode syncs theme" <<'TEST'
  clean_test_dir
  npx tsx "$SYNC_SCRIPT" --theme nightowl --target ./.pi/test 2>&1
  [[ -f "$ROOT_DIR/.pi/test/themes/nightowl.json" ]] || { echo "nightowl.json not found"; exit 1; }
  echo "Verified: nightowl.json synced correctly"
  clean_test_dir
TEST

# ── 用例 6：Profile 模式同步（project dry-run） ──
test_it "profile mode project dry-run lists resources" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --profile project 2>&1)
  [[ "$output" == *"extensions/"* ]] || { echo "Missing extensions listing"; exit 1; }
  [[ "$output" == *"skills/"* ]] || { echo "Missing skills listing"; exit 1; }
  [[ "$output" == *"themes/"* ]] || { echo "Missing themes listing"; exit 1; }
TEST

# ── 用例 7：内联模式多资源同步 ──
test_it "inline mode syncs multiple extensions" <<'TEST'
  clean_test_dir
  npx tsx "$SYNC_SCRIPT" --ext pi-logger --ext review --theme nightowl --target ./.pi/test 2>&1
  [[ -d "$ROOT_DIR/.pi/test/extensions/pi-logger" ]] || { echo "pi-logger missing"; exit 1; }
  [[ -f "$ROOT_DIR/.pi/test/extensions/review.ts" ]] || { echo "review.ts missing"; exit 1; }
  [[ -f "$ROOT_DIR/.pi/test/themes/nightowl.json" ]] || { echo "nightowl.json missing"; exit 1; }
  echo "Verified: all 3 resources synced"
  clean_test_dir
TEST

# ── 用例 8：内联模式 missing --target 应报错 ──
test_it "inline mode without --target reports error" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --ext pi-logger 2>&1)
  [[ "$output" == *"Error:"* && "$output" == *"--target"* ]] || { echo "Missing --target error"; exit 1; }
TEST

# ── 用例 9：内联模式 missing resource args 应报错 ──
test_it "inline mode without --ext/--skill/--theme/--prompt reports error" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --target ./.pi/test 2>&1)
  [[ "$output" == *"Error:"* ]] || { echo "Missing error for empty resources"; exit 1; }
TEST

# ── 用例 10：日志文件生成 [REVIEW] ──
test_it "sync generates log file [REVIEW]" <<'TEST'
  clean_test_dir
  npx tsx "$SYNC_SCRIPT" --ext pi-logger --target ./.pi/test 2>&1
  [[ -f "$ROOT_DIR/scripts/sync-to-local-pi.log" ]] || { echo "Log file not found"; exit 1; }
  log_line=$(grep "pi-logger" "$ROOT_DIR/scripts/sync-to-local-pi.log" | tail -1)
  echo "Log line: $log_line"
  clean_test_dir
  mark_for_review "验证日志是否包含 [NEW] 或 [UPDATE] 标记及正确的时间戳格式"
TEST

# ── 用例 11：profile 模式 --all 列出所有 profile ──
test_it "profile mode --all lists all profiles" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --all 2>&1)
  [[ "$output" == *"ALL ("* ]] || { echo "Missing ALL indicator"; exit 1; }
  [[ "$output" == *"user-install"* ]] || { echo "Missing user-install"; exit 1; }
  [[ "$output" == *"project"* ]] || { echo "Missing project"; exit 1; }
TEST

# ── 用例 12：默认 Profile 为 full-project ──
test_it "default profile is user-install" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run 2>&1)
  # 使用 bash 字符串匹配代替 echo|grep -q 管道，避免 pipefail 下 SIGPIPE 导致 141 退出码
  [[ "$output" == *"user-install"* ]] || { echo "Default profile not user-install"; exit 1; }
  [[ "$output" == *".pi/agent"* ]] || { echo "Default target not .pi/agent"; exit 1; }
TEST

# ── 用例 13：内联模式 --exclude 未对外暴露（需通过 profile 使用） ──
test_it "profile mode exclude excludes specified resource" <<'TEST'
  # user-install 排除了 sandbox
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --profile user-install 2>&1)
  [[ "$output" == *"extensions/ ("* ]] || { echo "Missing extensions count"; exit 1; }
  # sandbox 不应出现在 user-install 中
  [[ "$output" == *"sandbox"* ]] && { echo "sandbox should be excluded from user-install"; exit 1; }
  echo "Verified: sandbox excluded"
TEST

# ── 用例 14：内嵌技能随扩展同步（ADR-0022） ──
test_it "inline syncs embedded skill declared via pi.skills" <<'TEST'
  clean_test_dir
  npx tsx "$SYNC_SCRIPT" --ext pi-logger --target ./.pi/test 2>&1
  # pi-logger 的 package.json 声明 pi.skills: ["./skills"]，其下 skills/pi-logger/SKILL.md
  # 应随扩展一起同步到目标 skills/ 目录，无需在 sync-profiles.yaml 中再列一遍
  [[ -f "$ROOT_DIR/.pi/test/skills/pi-logger/SKILL.md" ]] || { echo "pi-logger embedded skill not synced"; exit 1; }
  echo "Verified: embedded skill synced to target skills/"
  clean_test_dir
TEST

# ── 用例 15：默认安全模式保留 stale（不加 --purge 不删除） ──
test_it "default sync keeps stale files (no --purge)" <<'TEST'
  clean_test_dir
  # 预置一个不在本次同步范围内的 stale 扩展目录
  mkdir -p "$ROOT_DIR/.pi/test/extensions/stale-ext"
  echo 'stale' > "$ROOT_DIR/.pi/test/extensions/stale-ext/index.ts"
  npx tsx "$SYNC_SCRIPT" --ext pi-logger --target ./.pi/test 2>&1
  [[ -f "$ROOT_DIR/.pi/test/extensions/stale-ext/index.ts" ]] || { echo "stale file was deleted without --purge"; exit 1; }
  [[ -f "$ROOT_DIR/.pi/test/extensions/pi-logger/index.ts" ]] || { echo "synced resource missing"; exit 1; }
  echo "Verified: stale kept by default"
  clean_test_dir
TEST

# ── 用例 16：--purge 删除 stale、保留本次同步资源 ──
test_it "--purge deletes stale files not in sync set" <<'TEST'
  clean_test_dir
  mkdir -p "$ROOT_DIR/.pi/test/extensions/stale-ext"
  echo 'stale' > "$ROOT_DIR/.pi/test/extensions/stale-ext/index.ts"
  npx tsx "$SYNC_SCRIPT" --ext pi-logger --target ./.pi/test --purge 2>&1
  [[ ! -e "$ROOT_DIR/.pi/test/extensions/stale-ext" ]] || { echo "stale file survived --purge"; exit 1; }
  [[ -f "$ROOT_DIR/.pi/test/extensions/pi-logger/index.ts" ]] || { echo "synced resource missing after purge"; exit 1; }
  echo "Verified: --purge removed stale, kept synced"
  clean_test_dir
TEST

# ── 用例 17：--dry-run --purge 不落盘删除 ──
test_it "--dry-run --purge does not delete stale files" <<'TEST'
  clean_test_dir
  mkdir -p "$ROOT_DIR/.pi/test/extensions/stale-ext"
  echo 'stale' > "$ROOT_DIR/.pi/test/extensions/stale-ext/index.ts"
  npx tsx "$SYNC_SCRIPT" --dry-run --ext pi-logger --target ./.pi/test --purge 2>&1
  [[ -f "$ROOT_DIR/.pi/test/extensions/stale-ext/index.ts" ]] || { echo "dry-run --purge deleted stale file"; exit 1; }
  echo "Verified: dry-run --purge did not delete"
  clean_test_dir
TEST

# ── 用例 18：--purge 指向 ~/.pi/agent 被安全护栏拒绝 ──
test_it "--purge against ~/.pi/agent is refused by safety guard" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --ext pi-logger --target ~/.pi/agent --purge 2>&1)
  rc=$?
  [[ $rc -ne 0 ]] || { echo "Expected non-zero exit when --purge targets ~/.pi/agent"; exit 1; }
  [[ "$output" == *"Refusing --purge"* ]] || { echo "Missing refusal message"; exit 1; }
  echo "Verified: --purge against ~/.pi/agent refused"
TEST

# ── 用例 19：--purge 保留 PROTECTED_EXTERNAL（herdr-agent-state） ──
test_it "--purge preserves PROTECTED_EXTERNAL (herdr-agent-state)" <<'TEST'
  clean_test_dir
  # 预置第三方集成（herdr 安装的扩展，非本仓库 sync 源），--purge 应跳过删除
  mkdir -p "$ROOT_DIR/.pi/test/extensions/herdr-agent-state"
  echo 'herdr' > "$ROOT_DIR/.pi/test/extensions/herdr-agent-state/index.ts"
  npx tsx "$SYNC_SCRIPT" --ext pi-logger --target ./.pi/test --purge 2>&1
  [[ -f "$ROOT_DIR/.pi/test/extensions/herdr-agent-state/index.ts" ]] || { echo "PROTECTED_EXTERNAL herdr-agent-state deleted by --purge"; exit 1; }
  [[ -f "$ROOT_DIR/.pi/test/extensions/pi-logger/index.ts" ]] || { echo "synced resource missing after purge"; exit 1; }
  echo "Verified: --purge preserved herdr-agent-state"
  clean_test_dir
TEST

# ── 用例 20：profile 模式默认剪枝受管资产（无需 --purge，ADR-0037） ──
test_it "profile mode prunes managed assets by default (no --purge)" <<'TEST'
  tmp_root=$(mktemp -d)
  target="$tmp_root/target"
  cfg="$tmp_root/sync-profiles.yaml"
  mkdir -p "$target/extensions/edit"
  echo 'managed' > "$target/extensions/edit/index.ts"
  mkdir -p "$target/extensions/third-party-ext"
  echo 'third' > "$target/extensions/third-party-ext/index.ts"

  cat > "$cfg" <<YAML
profiles:
  prune-test:
    target: '$target'
    extensions: ['quit']
    skills: []
    themes: []
    prompts: []
YAML

  "$ROOT_DIR/node_modules/.bin/tsx" "$SYNC_SCRIPT" --config "$cfg" --profile prune-test 2>&1
  # edit 是本仓库源清单里的受管资产（extensions/accuracy/edit），但不在 prune-test 清单 → 默认剪枝删除
  [[ ! -e "$target/extensions/edit" ]] || { echo "managed asset 'edit' survived default prune"; exit 1; }
  # third-party-ext 不在源清单 → 默认保留
  [[ -f "$target/extensions/third-party-ext/index.ts" ]] || { echo "third-party asset deleted by default"; exit 1; }
  # quit 应正常同步
  [[ -f "$target/extensions/quit.ts" ]] || { echo "quit.ts not synced"; exit 1; }
  echo "Verified: managed pruned, third-party kept, in-profile synced"
  rm -rf "$tmp_root"
TEST

# ── 用例 21：--purge 全量镜像删除第三方资产（profile 模式，ADR-0037） ──
test_it "--purge deletes third-party assets too (profile mode)" <<'TEST'
  tmp_root=$(mktemp -d)
  target="$tmp_root/target"
  cfg="$tmp_root/sync-profiles.yaml"
  mkdir -p "$target/extensions/edit"
  echo 'managed' > "$target/extensions/edit/index.ts"
  mkdir -p "$target/extensions/third-party-ext"
  echo 'third' > "$target/extensions/third-party-ext/index.ts"

  cat > "$cfg" <<YAML
profiles:
  prune-test:
    target: '$target'
    extensions: ['quit']
    skills: []
    themes: []
    prompts: []
YAML

  "$ROOT_DIR/node_modules/.bin/tsx" "$SYNC_SCRIPT" --config "$cfg" --profile prune-test --purge 2>&1
  [[ ! -e "$target/extensions/edit" ]] || { echo "managed asset 'edit' survived --purge"; exit 1; }
  [[ ! -e "$target/extensions/third-party-ext" ]] || { echo "third-party asset survived --purge"; exit 1; }
  [[ -f "$target/extensions/quit.ts" ]] || { echo "quit.ts not synced"; exit 1; }
  echo "Verified: --purge removed managed + third-party"
  rm -rf "$tmp_root"
TEST

# ── 用例 22：非 TTY 配置重置降级为全保留（ADR-0037） ──
test_it "non-TTY config reset falls back to keep-all" <<'TEST'
  tmp_root=$(mktemp -d)
  target="$tmp_root/target"
  cfg="$tmp_root/sync-profiles.yaml"
  mkdir -p "$target/extensions"
  # 预置不同内容的 quit.ts 使 sync 判定为 UPDATE
  echo 'old' > "$target/extensions/quit.ts"
  # 预置 quit 的 pi-config profile
  mkdir -p "$target/extensions-data/quit"
  echo '{"k":"v"}' > "$target/extensions-data/quit/config.json"

  cat > "$cfg" <<YAML
profiles:
  reset-test:
    target: '$target'
    extensions: ['quit']
    skills: []
    themes: []
    prompts: []
YAML

  # stdin 从 /dev/null → 非 TTY → interactiveMultiSelect 降级为全保留
  output=$("$ROOT_DIR/node_modules/.bin/tsx" "$SYNC_SCRIPT" --config "$cfg" --profile reset-test < /dev/null 2>&1)
  [[ -f "$target/extensions-data/quit/config.json" ]] || { echo "config.json deleted in non-TTY"; exit 1; }
  [[ "$output" == *"Non-interactive environment"* ]] || { echo "Missing non-interactive WARN"; exit 1; }
  echo "Verified: non-TTY kept config.json"
  rm -rf "$tmp_root"
TEST

# ── 用例 23：形态冲突残留清理（同名单文件 vs 目录，ADR-0037） ──
test_it "profile mode removes form-conflict residue (single-file vs directory)" <<'TEST'
  tmp_root=$(mktemp -d)
  target="$tmp_root/target"
  cfg="$tmp_root/sync-profiles.yaml"
  mkdir -p "$target/extensions"
  # 预置旧版单文件 review.ts（review 已重构为目录扩展，源里是目录 → 形态冲突残留）
  echo 'old-single-file' > "$target/extensions/review.ts"

  cat > "$cfg" <<YAML
profiles:
  form-test:
    target: '$target'
    extensions: ['review']
    skills: []
    themes: []
    prompts: []
YAML

  "$ROOT_DIR/node_modules/.bin/tsx" "$SYNC_SCRIPT" --config "$cfg" --profile form-test 2>&1
  [[ ! -e "$target/extensions/review.ts" ]] || { echo "review.ts residue survived form-conflict cleanup"; exit 1; }
  [[ -f "$target/extensions/review/index.ts" ]] || { echo "review/ dir not synced"; exit 1; }
  echo "Verified: review.ts residue removed, review/ dir synced"
  rm -rf "$tmp_root"
TEST

# ── 用例 24：内联模式同样清理形态冲突残留 ──
test_it "inline mode also removes form-conflict residue" <<'TEST'
  clean_test_dir
  mkdir -p "$ROOT_DIR/.pi/test/extensions"
  echo 'old' > "$ROOT_DIR/.pi/test/extensions/review.ts"
  "$ROOT_DIR/node_modules/.bin/tsx" "$SYNC_SCRIPT" --ext review --target ./.pi/test 2>&1
  [[ ! -e "$ROOT_DIR/.pi/test/extensions/review.ts" ]] || { echo "review.ts residue survived inline form-conflict cleanup"; exit 1; }
  [[ -f "$ROOT_DIR/.pi/test/extensions/review/index.ts" ]] || { echo "review/ dir not synced (inline)"; exit 1; }
  echo "Verified: inline form-conflict cleanup"
  clean_test_dir
TEST
