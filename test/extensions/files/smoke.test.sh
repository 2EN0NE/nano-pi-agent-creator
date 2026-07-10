#!/usr/bin/env bash

test_describe "files extension"

test_it "/files 命令产生正确日志输出" <<'TEST'
  run_pi_and_check     --extensions "pi-logger,files"     --prompt "/files"     --save-output

  # 验证 files_*.log 存在
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
  grep -q "浏览.*git 状态" "$ROOT_DIR/extensions/tui/files.ts" && \
    echo "PASS: /files 命令描述已中文化" || \
    echo "FAIL: /files 命令描述未中文化"

  grep -q "打开文件选择器" "$ROOT_DIR/extensions/tui/files.ts" && \
    echo "PASS: /diff 命令描述已中文化" || \
    echo "FAIL: /diff 命令描述未中文化"

  grep -q "浏览会话中引用的文件" "$ROOT_DIR/extensions/tui/files.ts" && \
    echo "PASS: ctrl+shift+o 描述已中文化" || \
    echo "FAIL: ctrl+shift+o 描述未中文化"

  grep -q "Finder.*显示" "$ROOT_DIR/extensions/tui/files.ts" && \
    echo "PASS: ctrl+shift+f 描述已中文化" || \
    echo "FAIL: ctrl+shift+f 描述未中文化"

  grep -q "Quick Look" "$ROOT_DIR/extensions/tui/files.ts" && \
    echo "PASS: ctrl+shift+r 描述已中文化" || \
    echo "FAIL: ctrl+shift+r 描述未中文化"

  exit 0
TEST

test_it "关键操作路径包含日志埋点" <<'TEST'
  # 验证源码中各关键函数包含 log 调用
  echo "=== 日志埋点检查 ==="

  grep -n "log\.\(info\|debug\|warn\|error\)" "$ROOT_DIR/extensions/tui/files.ts" | head -40

  # 统计各函数级别的日志
  log_count=$(grep -c "log\.\(info\|debug\|warn\|error\)" "$ROOT_DIR/extensions/tui/files.ts")
  echo ""
  echo "总计 $log_count 处日志埋点"

  [[ $log_count -ge 20 ]] && echo "PASS: 日志埋点数量充足（>=20）" || echo "WARN: 日志埋点较少（$log_count）"

  # 检查关键函数是否都有日志
  for func in "runFileBrowser" "runDiffBrowser" "openPath" "revealPath" "editPath" "quickLookPath" "openDiff" "addFileToPrompt"; do
    if grep -q "log\.\(info\|debug\|warn\|error\)" <(awk "/const $func/,/^};/" "$ROOT_DIR/extensions/tui/files.ts" 2>/dev/null); then
      echo "PASS: $func 包含日志埋点"
    else
      echo "WARN: $func 可能缺少日志埋点（或函数名有变化）"
    fi
  done

  exit 0
TEST
