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
  echo "$output" | grep -q "Profile mode" || { echo "Missing 'Profile mode'"; exit 1; }
  echo "$output" | grep -q "Inline mode" || { echo "Missing 'Inline mode'"; exit 1; }
  echo "$output" | grep -q "\-\-ext" || { echo "Missing '--ext'"; exit 1; }
  echo "$output" | grep -q "\-\-target" || { echo "Missing '--target'"; exit 1; }
TEST

# ── 用例 2：dry-run 内联模式同步单个扩展 ──
test_it "dry-run inline mode syncs pi-logger extension" <<'TEST'
  clean_test_dir
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --ext pi-logger --target ./.pi/test 2>&1)
  echo "$output" | grep -q "DRY RUN" || { echo "Missing dry run indicator"; exit 1; }
  echo "$output" | grep -q "pi-logger" || { echo "Missing pi-logger in output"; exit 1; }
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

# ── 用例 6：Profile 模式同步（full-project dry-run） ──
test_it "profile mode full-project dry-run lists all extensions" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --profile full-project 2>&1)
  echo "$output" | grep -q "extensions/" || { echo "Missing extensions listing"; exit 1; }
  echo "$output" | grep -q "skills/" || { echo "Missing skills listing"; exit 1; }
  echo "$output" | grep -q "themes/" || { echo "Missing themes listing"; exit 1; }
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
  echo "$output" | grep -q "Error:.*--target" || { echo "Missing --target error"; exit 1; }
TEST

# ── 用例 9：内联模式 missing resource args 应报错 ──
test_it "inline mode without --ext/--skill/--theme/--prompt reports error" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --target ./.pi/test 2>&1)
  echo "$output" | grep -q "Error:" || { echo "Missing error for empty resources"; exit 1; }
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
  echo "$output" | grep -q "ALL (" || { echo "Missing ALL indicator"; exit 1; }
  echo "$output" | grep -q "dev-test" || { echo "Missing dev-test"; exit 1; }
  echo "$output" | grep -q "user-install" || { echo "Missing user-install"; exit 1; }
  echo "$output" | grep -q "full-project" || { echo "Missing full-project"; exit 1; }
TEST

# ── 用例 12：默认 Profile 为 full-project ──
test_it "default profile is full-project" <<'TEST'
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run 2>&1)
  echo "$output" | grep -q "full-project" || { echo "Default profile not full-project"; exit 1; }
  echo "$output" | grep -q "No profile specified" || { echo "Missing default indicator"; exit 1; }
  echo "$output" | grep -q 'Target:.*\.pi' || { echo "Default target not .pi"; exit 1; }
TEST

# ── 用例 13：内联模式 --exclude 未对外暴露（需通过 profile 使用） ──
test_it "profile mode exclude excludes specified resource" <<'TEST'
  # user-install 排除了 sandbox
  output=$(npx tsx "$SYNC_SCRIPT" --dry-run --profile user-install 2>&1)
  echo "$output" | grep -q "extensions/ (" || { echo "Missing extensions count"; exit 1; }
  # sandbox 不应出现在 user-install 中
  echo "$output" | grep -q "sandbox" && { echo "sandbox should be excluded from user-install"; exit 1; }
  echo "Verified: sandbox excluded"
TEST
