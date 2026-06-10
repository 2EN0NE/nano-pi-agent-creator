#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIRS=(commands extensions skills themes)
DRY_RUN=0
TARGET_MODE="project"

usage() {
  cat <<'EOF'
Usage: ./scripts/sync-to-local-pi.sh [--dry-run] [--target project|user|both]

Options:
  --dry-run         只预览要同步的目标，不写入文件
  --target project  默认值：同步到当前项目的 .pi/agents
  --target user     同步到 ~/.pi/agents
  --target both     同时同步到当前项目和用户目录
  -h, --help        显示此帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --target)
      TARGET_MODE="${2:-}"
      shift 2
      ;;
    --user|--home)
      TARGET_MODE="user"
      shift
      ;;
    --both)
      TARGET_MODE="both"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$TARGET_MODE" != "project" && "$TARGET_MODE" != "user" && "$TARGET_MODE" != "both" ]]; then
  echo "Invalid target mode: $TARGET_MODE" >&2
  usage >&2
  exit 1
fi

for resource_dir in "${RESOURCE_DIRS[@]}"; do
  if [[ ! -d "$ROOT_DIR/$resource_dir" ]]; then
    echo "Missing source directory: $ROOT_DIR/$resource_dir" >&2
    exit 1
  fi
 done

printf '同步目录：\n'
for resource_dir in "${RESOURCE_DIRS[@]}"; do
  printf '  - %s\n' "$resource_dir"
done

echo

TARGET_DIRS=()
if [[ "$TARGET_MODE" == "project" || "$TARGET_MODE" == "both" ]]; then
  TARGET_DIRS+=("$ROOT_DIR/.pi/agents")
fi
if [[ "$TARGET_MODE" == "user" || "$TARGET_MODE" == "both" ]]; then
  TARGET_DIRS+=("$HOME/.pi/agents")
fi

for target_dir in "${TARGET_DIRS[@]}"; do
  mkdir -p "$target_dir"

  for resource_dir in "${RESOURCE_DIRS[@]}"; do
    src_path="$ROOT_DIR/$resource_dir"
    dst_path="$target_dir/$resource_dir"

    if [[ $DRY_RUN -eq 1 ]]; then
      echo "[dry-run] $src_path -> $dst_path"
      continue
    fi

    rm -rf "$dst_path"
    cp -R "$src_path" "$dst_path"
    echo "已同步: $src_path -> $dst_path"
  done

done

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Dry run 完成；不会写入任何文件。"
else
  echo
  echo "本地同步完成。"
  for target_dir in "${TARGET_DIRS[@]}"; do
    echo "  - $target_dir"
  done
fi
