#!/usr/bin/env -S uv run --script
"""\
Analyze Pi session files to extract extension-development knowledge.

Usage:
  uv run .pi/skills/extract-pi-knowledge/analyze.py \\
      --session-dir ~/.pi/agent/sessions/--project-path--

Output:
  1. Session summary (user messages, branch points)
  2. Failure patterns (consecutive fix-verify loops)
  3. Tree branch analysis (where conversation forked)
  4. Extractable knowledge suggestions
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

# ── Pattern detection ──────────────────────────────────────────

ERROR_KEYWORDS = [
    "错误", "不工作", "失败", "没触发", "wrong", "error", "fail",
    "bug", "问题", "不对", "issue", "doesn't", "isn't", "didn't",
    "crash", "警告", "warning", "为什么", "卡住",
]

RETRY_PATTERNS = [
    "修复", "fix", "改", "修正", "check", "检查", "try", "尝试",
]


def parse_session(filepath: str) -> list[dict]:
    """Parse a JSONL session file into a list of entries."""
    entries = []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def get_message_text(entry: dict) -> str:
    """Extract text content from a message entry."""
    msg = entry.get("message", {})
    content = msg.get("content", "")
    if isinstance(content, list):
        return " ".join(
            c.get("text", "") for c in content if c.get("type") == "text"
        )
    return str(content)


def analyze_file(filepath: str) -> dict:
    """Analyze a single session file."""
    entries = parse_session(filepath)
    if not entries:
        return {"file": filepath, "error": "empty or invalid"}

    # Entry map for tree analysis
    entry_map = {e.get("id"): e for e in entries if e.get("id")}

    # Build parent-child relationships
    children_of = defaultdict(list)
    for e in entries:
        pid = e.get("parentId")
        eid = e.get("id")
        if pid and eid:
            children_of[pid].append(eid)

    # Extract user messages
    user_messages = []
    assistant_errors = []
    for e in entries:
        if e.get("type") != "message":
            continue
        msg = e.get("message", {})
        role = msg.get("role")
        if role == "user":
            text = get_message_text(e)
            if text.strip():
                user_messages.append(text)
        elif role == "assistant":
            text = get_message_text(e)
            if any(kw in text.lower() for kw in ["error", "fail", "warning"]):
                assistant_errors.append(text[:300])

    # Find branch points (forks)
    branch_points = []
    for pid, kids in children_of.items():
        if len(kids) >= 2:
            parent = entry_map.get(pid, {})
            kids_detail = []
            for kid_id in kids:
                kid = entry_map.get(kid_id, {})
                ktype = kid.get("type", "")
                if ktype == "message":
                    kid_role = kid.get("message", {}).get("role", "")
                    kids_detail.append(f"{ktype}/{kid_role}")
                elif ktype == "branch_summary":
                    kids_detail.append(f"{ktype} (tree fork → branch)")
                else:
                    kids_detail.append(ktype)
            branch_points.append({
                "parent_type": parent.get("type", "unknown"),
                "children": kids_detail,
            })

    # Find failure patterns: consecutive user messages with error keywords
    failure_patterns = []
    for i, msg in enumerate(user_messages):
        if any(kw in msg.lower() for kw in ERROR_KEYWORDS):
            # Get context (previous user message for comparison)
            prev = user_messages[i - 1] if i > 0 else ""
            is_retry = any(kw in prev.lower() for kw in RETRY_PATTERNS) if prev else False
            failure_patterns.append({
                "message": msg[:200],
                "is_retry_after_fix": is_retry,
                "index": i,
            })

    # Detect fix-verify cycles (3+ user msgs in retry sequence)
    fix_cycles = []
    cycle_start = None
    for i, fp in enumerate(failure_patterns):
        if i < 2:
            continue
        # Check if we have 3 consecutive patterns
        if (failure_patterns[i-2]["is_retry_after_fix"] and
            failure_patterns[i-1]["is_retry_after_fix"] and
            fp["is_retry_after_fix"]):
            if cycle_start is None:
                cycle_start = i - 2
        else:
            if cycle_start is not None and i - cycle_start >= 3:
                fix_cycles.append({
                    "start": cycle_start,
                    "end": i,
                    "messages": [failure_patterns[j]["message"][:100] for j in range(cycle_start, i)],
                })
            cycle_start = None

    return {
        "file": os.path.basename(filepath),
        "entry_count": len(entries),
        "user_count": len(user_messages),
        "branch_points": branch_points,
        "failure_patterns": failure_patterns[:20],  # limit
        "fix_cycles": fix_cycles,
    }


def suggest_knowledge(results: list[dict]) -> list[str]:
    """Generate knowledge suggestions from analysis results."""
    suggestions = []

    # Check for auth-related failures
    auth_patterns = [r for r in results if any(
        "api key" in fp["message"].lower() or "auth" in fp["message"].lower()
        for fp in r.get("failure_patterns", [])
    )]
    if auth_patterns:
        suggestions.append(
            "Auth 失效模式 detected: complete() 不走 ModelRegistry. "
            "修复详见 AGENTS.md 中 'complete() Auth 解析绕过 ModelRegistry'"
        )

    # Check for compaction/isIdle failures
    idle_patterns = [r for r in results if any(
        "idle" in fp["message"].lower() or "触发" in fp["message"]
        for fp in r.get("failure_patterns", [])
    )]
    if idle_patterns:
        suggestions.append(
            "isIdle/timing 失效模式 detected: agent_end 时 isIdle() 仍可能 false. "
            "修复详见 AGENTS.md 中 'isIdle() 的时机限制'"
        )

    # Check for /reload state loss
    reload_patterns = [r for r in results if any(
        "reload" in fp["message"].lower() for fp in r.get("failure_patterns", [])
    )]
    if reload_patterns:
        suggestions.append(
            "/reload 后状态丢失 detected: 需使用 os.homedir() + 确定路径，"
            "不能用 import.meta.url. 详见 AGENTS.md"
        )

    # Check for persistent session config
    session_config = [r for r in results if any(
        "session" in fp["message"].lower() and "配置" in fp["message"]
        for fp in r.get("failure_patterns", [])
    )]
    if session_config:
        suggestions.append(
            "Session 配置未持久化 detected: /reload 后恢复到默认值. "
            "需用 <sessionId>.json 方式按会话 ID 保存配置"
        )

    # Check for sendUserMessage timing issues
    send_msg = [r for r in results if any(
        "话术" in fp["message"] or "sendUserMessage" in fp["message"] or "auto-continue" in fp["message"].lower()
        for fp in r.get("failure_patterns", [])
    )]
    if send_msg:
        suggestions.append(
            "sendUserMessage 时序问题 detected: session_compact 时 agent 已断开. "
            "修复详见 AGENTS.md 中 'sendUserMessage() 限制'"
        )

    return suggestions


def main():
    parser = argparse.ArgumentParser(description="Analyze Pi session files for extension knowledge")
    parser.add_argument("--session-dir", "-d", required=True, help="Path to session directory")
    parser.add_argument("--output", "-o", choices=["summary", "json"], default="summary",
                        help="Output format")
    args = parser.parse_args()

    if not os.path.isdir(args.session_dir):
        print(f"Error: {args.session_dir} not found", file=sys.stderr)
        sys.exit(1)

    files = sorted([
        os.path.join(args.session_dir, f)
        for f in os.listdir(args.session_dir)
        if f.endswith(".jsonl")
    ])

    if not files:
        print("No session files found", file=sys.stderr)
        sys.exit(1)

    # Sort by file size (largest first - most content)
    files.sort(key=os.path.getsize, reverse=True)

    if args.output == "json":
        results = [analyze_file(f) for f in files]
        print(json.dumps({
            "session_dir": args.session_dir,
            "files_analyzed": len(files),
            "sessions": results,
            "suggestions": suggest_knowledge(results),
        }, ensure_ascii=False, indent=2))
        return

    # ── Summary output ──
    print(f"\n{'='*60}")
    print(f"Pi Session Knowledge Extraction")
    print(f"Directory: {args.session_dir}")
    print(f"Sessions found: {len(files)}")
    print(f"{'='*60}")

    long_enough = [f for f in files if os.path.getsize(f) > 500]
    print(f"\nSignificant sessions (>{'500'} bytes): {len(long_enough)}")

    results = []
    for fpath in files:
        result = analyze_file(fpath)
        results.append(result)
        if result.get("entry_count", 0) < 5:
            continue

        print(f"\n─── {result['file']} ───")
        print(f"  Entries: {result['entry_count']} | User messages: {result['user_count']}")

        if result["branch_points"]:
            print(f"  🌿 Branch points ({len(result['branch_points'])}):")
            for bp in result["branch_points"]:
                print(f"     Parent({bp['parent_type']}) → children: {', '.join(bp['children'])}")

        if result["failure_patterns"]:
            print(f"  ⚠️  Failure patterns ({len(result['failure_patterns'])}):")
            for fp in result["failure_patterns"][:8]:
                marker = "🔄" if fp["is_retry_after_fix"] else "⚠️"
                print(f"     {marker} {fp['message'][:120]}")

        if result["fix_cycles"]:
            print(f"  🔁 Fix-verify cycles ({len(result['fix_cycles'])}):")
            for fc in result["fix_cycles"]:
                print(f"     Messages: {fc['messages']}")
        print()

    # ── Knowledge suggestions ──
    print(f"\n{'='*60}")
    print("Extractable Knowledge Suggestions")
    print(f"{'='*60}")
    suggestions = suggest_knowledge(results)
    if not suggestions:
        print("  No specific patterns detected. Manual review recommended.")
    else:
        for s in suggestions:
            print(f"  📝 {s}")

    print(f"\n{'='*60}")
    print("Done.")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
