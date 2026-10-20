#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# message-time — expect TUI 端到端测试（真实 pi，仅 mock LLM）
#
# 用例 1（实时）：发一条消息 → user 提交时刻 + assistant 首 token 时刻各注入一行
#                 `[HH:MM:SS]`，且必须**紧邻在对应消息文本之上**（不是别处出现）。
# 用例 2（回放）：真实跑一轮产出真实会话文件 → 仅改写 message.timestamp 为确定的老
#                 时间 → `pi -a --session <fixture>` 恢复 → 断言三段式日期形态：
#                 跨年 `[YYYY-MM-DD HH:MM:SS]`、同年非今日 `[MM-DD HH:MM:SS]`。
#
# 反假绿：两侧消息本体（用户文本 / mock 回复）必须真的渲染出来。
# ──────────────────────────────────────────────────────────────────────────────

# 抽取视口文本并清除 strip_ansi 未处理干净的残片。
# 注意：extract_visible_text 的管道里没有 tr -d（那行在 extract_viewport_snapshots 中），
# 且去空行在控制符剥离之前，因此 `ESC BEL`（OSC-8 链接终止符）这类纯控制符会残留成
# “非空行”，打断「注记行 → 空行 → 正文」的相邻关系。这里按 harness 同款字符集补一次。
visible_text_clean() {
  local file="$1"
  extract_visible_text "$file" |
    tr -d '\000-\010\016-\037' |
    sed -E 's/\]8;;//g; s/\]11;\?//g' |
    sed -E 's/[[:space:]]+$//' |
    grep -v '^$'
}

# 断言：<file> 中存在一行「独立时间注记」（匹配 <regex>），其紧邻下一行包含 <needle>。
# extract_visible_text 已剥离 ANSI 与空行，故「注记 → 空行 → 正文」在此表现为相邻行。
assert_time_line_above() {
  local file="$1" regex="$2" needle="$3"
  if grep -A1 -E "$regex" "$file" 2>/dev/null | grep -F "$needle" >/dev/null 2>&1; then
    echo "PASS: time line /$regex/ directly above '$needle'"
    return 0
  fi
  echo "FAIL: no time line matching /$regex/ directly above '$needle'"
  return 1
}

test_describe "message-time extension (expect TUI mode)"

test_it "expect: user and assistant each carry a [HH:MM:SS] line above their text" <<'TEST'
  tui_expect_test "message-time" '
    send "user-msg-alpha\r"
    # 状态驱动：等 mock 回复真的渲染出来（固定 sleep 在负载下会假阴性）
    expect { -re {Mock LLM is ready\.} { } timeout { send_error "no mock reply\n"; exit 124 } }
    sleep 1
  ' 30

  txt="$TUI_TEST_HOME/visible.txt"
  visible_text_clean "$TUI_OUTPUT_FILE" > "$txt"
  # 反假绿 + 加载证据：两侧消息本体真的渲染出来，且 pi 启动清单里确实有这个扩展
  grep -qF "message-time.ts" "$txt" || { echo "FAIL: extension not listed in startup [Extensions]"; exit 1; }
  grep -qF "user-msg-alpha" "$txt" || { echo "FAIL: user message not rendered"; exit 1; }
  grep -qF "Mock LLM is ready." "$txt" || { echo "FAIL: assistant reply not rendered"; exit 1; }

  # 今日形态必须是短格式（无日期），且各自紧邻对应消息之上
  assert_time_line_above "$txt" '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]$' "user-msg-alpha" || exit 1
  assert_time_line_above "$txt" '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]$' "Mock LLM is ready." || exit 1

  tui_cleanup
TEST

test_it "expect: replaying an old session renders dated forms (cross-year + same-year)" <<'TEST'
  # ① 真实跑一轮，拿到真实 pi 产出的会话文件（不伪造会话 schema）
  tui_expect_test "message-time" '
    send "replay-fixture-alpha\r"
    expect { -re {Mock LLM is ready\.} { } timeout { send_error "no mock reply\n"; exit 124 } }
    sleep 1
  ' 30

  phase1_home="$TUI_TEST_HOME"
  sessions_dir="$phase1_home/home/.pi/agent/sessions"
  session_file=$(find "$sessions_dir" -name '*.jsonl' -type f 2>/dev/null | head -1)
  [[ -n "$session_file" ]] || {
    echo "FAIL: phase-1 session file not found under $sessions_dir"
    exit 1
  }

  # ② 复制为 fixture，仅改写 message.timestamp 为确定的老时间，并输出期望渲染串
  #    user      → 去年 12-31 14:23:05（跨年 → 带年份）
  #    assistant → 今年 01-01 08:30:00（同年非今日 → 带月日；今天恰为 1/1 时用 1/2）
  fixture="$TUI_TEST_HOME/replay-fixture.jsonl"
  expected=$(python3 - "$session_file" "$fixture" <<'PY'
import datetime, json, sys, time

src, dst = sys.argv[1], sys.argv[2]
now = datetime.datetime.now()
cross = datetime.datetime(now.year - 1, 12, 31, 14, 23, 5)
same = datetime.datetime(now.year, 1, 2 if (now.month, now.day) == (1, 1) else 1, 8, 30, 0)

def to_ms(dt):
    return int(time.mktime(dt.timetuple())) * 1000 + dt.microsecond // 1000

out = []
for line in open(src, encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    entry = json.loads(line)
    msg = entry.get("message")
    if isinstance(msg, dict) and msg.get("role") in ("user", "assistant"):
        dt = cross if msg["role"] == "user" else same
        ms = to_ms(dt)
        msg["timestamp"] = ms
        entry["timestamp"] = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.000Z"
        )
    out.append(json.dumps(entry, ensure_ascii=False))
open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
print("%s|%s" % (cross.strftime("%Y-%m-%d %H:%M:%S"), same.strftime("%m-%d %H:%M:%S")))
PY
  )
  exp_user="${expected%%|*}"   # 跨年：YYYY-MM-DD HH:MM:SS
  exp_asm="${expected##*|}"    # 同年非今日：MM-DD HH:MM:SS
  [[ -n "$exp_user" && -n "$exp_asm" ]] || { echo "FAIL: fixture expected strings empty"; exit 1; }

  # ③ 恢复该会话（真实 pi，仅 mock LLM），断言历史重绘走了同一条渲染路径
  tui_expect_test "message-time" '
    # 状态驱动：等历史消息重绘完成再断言时间注记
    expect { -re {replay-fixture-alpha} { } timeout { send_error "replayed session not rendered\n"; exit 124 } }
    sleep 1
  ' 30 "" "" "" "--session $fixture"

  txt="$TUI_TEST_HOME/visible.txt"
  visible_text_clean "$TUI_OUTPUT_FILE" > "$txt"

  grep -qF "replay-fixture-alpha" "$txt" || { echo "FAIL: replayed user message not rendered"; exit 1; }
  grep -qF "Mock LLM is ready." "$txt" || { echo "FAIL: replayed assistant reply not rendered"; exit 1; }

  assert_time_line_above "$txt" "^\\[${exp_user}\\]$" "replay-fixture-alpha" || exit 1
  assert_time_line_above "$txt" "^\\[${exp_asm}\\]$" "Mock LLM is ready." || exit 1

  tui_cleanup
TEST
