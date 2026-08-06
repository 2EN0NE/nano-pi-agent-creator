#!/usr/bin/env bash

test_describe "files extension (directory-based)"

# ══════════════════════════════════════════════════════════════════════════════
# 基础功能测试
# ══════════════════════════════════════════════════════════════════════════════

test_it "/files 命令产生正确日志输出" <<'TEST'
  run_pi_and_check     --extensions "pi-logger,files"     --prompt "/files"     --save-output

  if [[ -d "$PI_LOG_DIR" ]]; then
    files_log=$(ls "$PI_LOG_DIR"/files_*.log 2>/dev/null | head -1)
    if [[ -n "$files_log" ]]; then
      echo "=== files 日志内容 ==="
      cat "$files_log"
      grep -q "命令 /files 被调用" "$files_log" && echo "PASS: 日志包含 /files 命令调用" || echo "FAIL: 日志缺少 /files 命令调用"
      grep -q "被调用但当前不是交互模式" "$files_log" && echo "PASS: 日志包含非交互模式提示" || echo "FAIL: 日志缺少非交互模式提示"
    else
      echo "FAIL: 未找到 files_*.log"
      ls -la "$PI_LOG_DIR/"
      exit 1
    fi
  else
    echo "FAIL: 日志目录不存在"
    exit 1
  fi

  exit 0
TEST

test_it "/diff 命令产生正确日志输出" <<'TEST'
  run_pi_and_check     --extensions "pi-logger,files"     --prompt "/diff"     --save-output

  if [[ -d "$PI_LOG_DIR" ]]; then
    files_log=$(ls "$PI_LOG_DIR"/files_*.log 2>/dev/null | head -1)
    if [[ -n "$files_log" ]]; then
      echo "=== files 日志内容 ==="
      cat "$files_log"
      grep -q "命令 /diff 被调用" "$files_log" && echo "PASS: 日志包含 /diff 命令调用" || echo "FAIL: 日志缺少 /diff 命令调用"
      grep -q "被调用但当前不是交互模式" "$files_log" && echo "PASS: 日志包含非交互模式提示" || echo "FAIL: 日志缺少非交互模式提示"
    else
      echo "FAIL: 未找到 files_*.log"
      ls -la "$PI_LOG_DIR/"
      exit 1
    fi
  else
    echo "FAIL: 日志目录不存在"
    exit 1
  fi

  exit 0
TEST

test_it "/changes 命令产生正确日志输出" <<'TEST'
  run_pi_and_check     --extensions "pi-logger,files"     --prompt "/changes"     --save-output

  if [[ -d "$PI_LOG_DIR" ]]; then
    files_log=$(ls "$PI_LOG_DIR"/files_*.log 2>/dev/null | head -1)
    if [[ -n "$files_log" ]]; then
      echo "=== files 日志内容 ==="
      cat "$files_log"
      grep -q "命令 /changes 被调用" "$files_log" && echo "PASS: 日志包含 /changes 命令调用" || echo "FAIL: 日志缺少 /changes 命令调用"
    else
      echo "FAIL: 未找到 files_*.log"
      ls -la "$PI_LOG_DIR/"
      exit 1
    fi
  else
    echo "FAIL: 日志目录不存在"
    exit 1
  fi

  exit 0
TEST

test_it "/changes cls 命令产生正确日志输出" <<'TEST'
  run_pi_and_check     --extensions "pi-logger,files"     --prompt "/changes cls"     --save-output

  if [[ -d "$PI_LOG_DIR" ]]; then
    files_log=$(ls "$PI_LOG_DIR"/files_*.log 2>/dev/null | head -1)
    if [[ -n "$files_log" ]]; then
      echo "=== files 日志内容 ==="
      cat "$files_log"
      grep -q "变更记录被清空" "$files_log" && echo "PASS: 日志包含清空操作" || echo "FAIL: 日志缺少清空操作"
    else
      echo "FAIL: 未找到 files_*.log"
      ls -la "$PI_LOG_DIR/"
      exit 1
    fi
  else
    echo "FAIL: 日志目录不存在"
    exit 1
  fi

  exit 0
TEST

test_it "pi-logger 生命周期日志记录 files 扩展事件" <<'TEST'
  run_pi_and_check     --extensions "pi-logger,files"     --prompt "/files"     --save-output

  if [[ -d "$PI_LOG_DIR" ]]; then
    lifecycle_log=$(ls "$PI_LOG_DIR"/__lifecycle__*.log 2>/dev/null | head -1)
    files_log=$(ls "$PI_LOG_DIR"/files_*.log 2>/dev/null | head -1)

    echo "=== 生命周期日志 ==="
    [[ -n "$lifecycle_log" ]] && cat "$lifecycle_log" || echo "(无)"
    echo ""
    echo "=== files 日志 ==="
    [[ -n "$files_log" ]] && cat "$files_log" || echo "(无)"

    [[ -n "$files_log" ]] && echo "PASS: files 日志文件已生成" || echo "FAIL: files 日志文件未生成"
    [[ -n "$lifecycle_log" ]] && echo "PASS: 生命周期日志文件已生成" || echo "FAIL: 生命周期日志文件未生成"
  else
    echo "FAIL: 日志目录不存在"
    exit 1
  fi

  exit 0
TEST

test_it "快捷键和命令描述已中文化" <<'TEST'
  grep -q "浏览.*git 状态" "$ROOT_DIR/extensions/tui/files/index.ts" && \
    echo "PASS: /files 命令描述已中文化" || \
    echo "FAIL: /files 命令描述未中文化"

  grep -q "打开文件选择器" "$ROOT_DIR/extensions/tui/files/index.ts" && \
    echo "PASS: /diff 命令描述已中文化" || \
    echo "FAIL: /diff 命令描述未中文化"

  grep -q "浏览会话中引用的文件" "$ROOT_DIR/extensions/tui/files/index.ts" && \
    echo "PASS: ctrl+shift+o 描述已中文化" || \
    echo "FAIL: ctrl+shift+o 描述未中文化"

  grep -q "Finder.*显示" "$ROOT_DIR/extensions/tui/files/index.ts" && \
    echo "PASS: ctrl+shift+f 描述已中文化" || \
    echo "FAIL: ctrl+shift+f 描述未中文化"

  grep -q "Quick Look" "$ROOT_DIR/extensions/tui/files/index.ts" && \
    echo "PASS: ctrl+shift+r 描述已中文化" || \
    echo "FAIL: ctrl+shift+r 描述未中文化"

  grep -q "变更记录" "$ROOT_DIR/extensions/tui/files/index.ts" && \
    echo "PASS: /changes 命令描述已中文化" || \
    echo "FAIL: /changes 命令描述未中文化"

  exit 0
TEST

test_it "关键操作路径包含日志埋点" <<'TEST'
  echo "=== 日志埋点检查 ==="

  for module in "index.ts" "actions.ts" "scanner.ts" "recorder.ts" "ui.ts" "git.ts"; do
    log_count=$(grep -c "log\.\(info\|debug\|warn\|error\)" "$ROOT_DIR/extensions/tui/files/$module" 2>/dev/null)
    echo "$module: $log_count 处日志埋点"
    [[ $log_count -ge 2 ]] && echo "  PASS: 埋点充足" || echo "  WARN: 埋点较少"
  done

  exit 0
TEST

# ══════════════════════════════════════════════════════════════════════════════
# 多仓库支持专项测试（静态源码检查）
# ══════════════════════════════════════════════════════════════════════════════

test_it "源码包含多仓库发现函数 getAllGitRoots" <<'TEST'
  grep -q "getAllGitRoots" "$ROOT_DIR/extensions/tui/files/git.ts" && \
    echo "PASS: getAllGitRoots 函数存在" || \
    echo "FAIL: 未找到 getAllGitRoots"

  grep -q "\-maxdepth" "$ROOT_DIR/extensions/tui/files/git.ts" && \
    echo "PASS: 使用 find -maxdepth 发现 git 仓库" || \
    echo "FAIL: 未使用 find 发现模式"
  exit 0
TEST

test_it "源码包含子仓库文件归属查找函数 findGitRootForFile" <<'TEST'
  grep -q "findGitRootForFile" "$ROOT_DIR/extensions/tui/files/git.ts" && \
    echo "PASS: findGitRootForFile 函数存在" || \
    echo "FAIL: 未找到 findGitRootForFile"

  grep_count=$(grep -c "findGitRootForFile" "$ROOT_DIR/extensions/tui/files/git.ts")
  echo "findGitRootForFile 被引用 $grep_count 次"
  [[ $grep_count -ge 1 ]] && echo "PASS: findGitRootForFile 已定义" || \
    echo "FAIL: findGitRootForFile 未定义"
  exit 0
TEST

test_it "FileEntry 类型包含 gitRoot 字段" <<'TEST'
  grep -q "gitRoot?:" "$ROOT_DIR/extensions/tui/files/types.ts" && \
    echo "PASS: gitRoot 字段已定义" || \
    echo "FAIL: 未找到 gitRoot 字段"

  grep -q "existing.gitRoot \?\? data.gitRoot" "$ROOT_DIR/extensions/tui/files/scanner.ts" && \
    echo "PASS: upsertFile 合并 gitRoot 逻辑存在" || \
    echo "FAIL: upsertFile 缺少 gitRoot 合并"
  exit 0
TEST

test_it "formatDisplayPath 支持多仓库路径展示" <<'TEST'
  grep -q "formatDisplayPath.*gitRoot" "$ROOT_DIR/extensions/tui/files/scanner.ts" && \
    echo "PASS: formatDisplayPath 含 gitRoot 参数" || \
    echo "FAIL: formatDisplayPath 缺少 gitRoot 参数"

  grep -q "normalizedGitRoot !== normalizedCwd" "$ROOT_DIR/extensions/tui/files/scanner.ts" && \
    echo "PASS: 子仓库路径前缀判断存在" || \
    echo "FAIL: 缺少子仓库路径判断"
  exit 0
TEST

test_it "openDiff/runs 均使用文件级 gitRoot 而非全局变量" <<'TEST'
  grep -n "file\.gitRoot" "$ROOT_DIR/extensions/tui/files/actions.ts"
  count=$(grep -c "file\.gitRoot" "$ROOT_DIR/extensions/tui/files/actions.ts")
  echo ""
  echo "file.gitRoot 出现 $count 次"
  [[ $count -ge 2 ]] && echo "PASS: openDiff/runs 均使用文件级 gitRoot" || \
    echo "FAIL: 文件级 gitRoot 引用不足（需 >=2）"
  exit 0
TEST

# ══════════════════════════════════════════════════════════════════════════════
# 加载兼容性测试
# ══════════════════════════════════════════════════════════════════════════════

test_it "直接加载 files/index.ts 无报错" <<'TEST'
  rm -f "$ROOT_DIR/.pi/extensions/smoke.test.ts"
  cd "$ROOT_DIR"
  pi -a --no-session -e "$ROOT_DIR/extensions/tui/files/index.ts" -p "/files" 2>&1
  local exit_code=$?
  [[ $exit_code -eq 0 ]] && echo "PASS: 直接加载成功" || echo "FAIL: exit code=$exit_code"
  exit 0
TEST

test_it "直接加载后 /diff 命令可执行" <<'TEST'
  rm -f "$ROOT_DIR/.pi/extensions/smoke.test.ts"
  cd "$ROOT_DIR"
  pi -a --no-session -e "$ROOT_DIR/extensions/tui/files/index.ts" -p "/diff" 2>&1
  local exit_code=$?
  [[ $exit_code -eq 0 ]] && echo "PASS: /diff 直接加载成功" || echo "FAIL: exit code=$exit_code"
  exit 0
TEST

test_it "直接加载后 /changes 命令可执行" <<'TEST'
  rm -f "$ROOT_DIR/.pi/extensions/smoke.test.ts"
  cd "$ROOT_DIR"
  pi -a --no-session -e "$ROOT_DIR/extensions/tui/files/index.ts" -p "/changes" 2>&1
  local exit_code=$?
  [[ $exit_code -eq 0 ]] && echo "PASS: /changes 直接加载成功" || echo "FAIL: exit code=$exit_code"
  exit 0
TEST

test_it "多仓库环境中扩展可正常加载 [REVIEW]" <<'TEST'
  local multi_root="$ROOT_DIR/.pi/tmp/files-multi-test-$$"
  mkdir -p "$multi_root"

  cd "$multi_root"
  git init -q
  echo "main file content" > main.txt
  mkdir -p src
  echo "const a = 1;" > src/index.ts
  git add -A && git commit -q -m "init"

  mkdir -p sub-repo
  cd "$multi_root/sub-repo"
  git init -q
  echo "sub file content" > sub.txt
  git add -A && git commit -q -m "init"

  echo "=== 测试环境目录结构 ==="
  cd "$multi_root"
  find . -not -path './.git/*' -not -path './sub-repo/.git/*' -not -path '.' -not -path './sub-repo' | sort

  echo ""
  echo "=== git 仓库根目录列表 ==="
  find . -maxdepth 2 -name .git -type d | sed 's|/\.git$||'

  cd "$multi_root"
  pi -a --no-session -e "$ROOT_DIR/extensions/tui/files/index.ts" -p "/files" 2>&1
  local exit_code=$?

  echo ""
  echo "=== pi exit code: $exit_code ==="

  rm -rf "$multi_root"

  mark_for_review "验证：1) exit code 应为 0；2) 扩展加载成功，无语法/runtime 错误"
  exit 0
TEST
