#!/usr/bin/env bash
# =============================================================================
# offline.sh — pi 插件体系离线迁移工具
#
#   pack     在源机器（macOS）执行：把 pi 运行时 + 用户插件体系打包成单个 bundle
#   restore  在目标机器（Linux，离线）执行：解压 bundle、重建链接、自检
#
# 用法:
#   bash scripts/offline.sh pack [选项]
#   bash scripts/offline.sh restore <bundle.tar.gz> [选项]
#
# pack 选项:
#   -o, --output FILE       bundle 输出路径（默认 ./offline-bundle-<日期>.tar.gz）
#   --with-project          附带项目 .pi/ 目录（本项目开发用，约 900M）
#   --with-repo             附带仓库源码 + node_modules（离线继续开发扩展用，约 550M）
#   --with-node             下载 linux-<arch> 版 node 运行时进 bundle（目标机无 node 时用）
#   --arch ARCH             目标 linux 架构：x64（默认）/ arm64
#   --keep-sessions         保留会话历史 ~/.pi/agent/sessions（默认排除，720M）
#   --keep-auth             保留 auth.json（默认排除，含 API 密钥）
#   --skip-extra-download   跳过缺失平台二进制下载（源机有网时默认下载）
#   --staging DIR           指定 staging 目录（默认 mktemp -d，结束后清理）
#   --keep-staging          保留 staging 目录（调试用）
#
# restore 选项:
#   --pi-prefix DIR         pi 运行时安装位置（默认 $HOME/.local/share/pi-runtime）
#   --bin-dir DIR           pi 可执行软链目录（默认 $HOME/.local/bin）
#   --agent-dir DIR         agent 用户目录（默认 $HOME/.pi/agent）
#   --force                 目标目录已存在时备份后覆盖（默认 abort）
#   --no-model-check        跳过模型配置检查
#   --smoke                 启动 pi 做冒烟自检（较慢）
#
# 示例:
#   bash scripts/offline.sh pack --with-node -o ~/pi-offline-bundle.tar.gz
#   bash scripts/offline.sh restore pi-offline-bundle.tar.gz --smoke
# =============================================================================

set -uo pipefail

# ──────────────────────────── 基础工具 ────────────────────────────
C_RED='\033[0;31m'
C_YEL='\033[0;33m'
C_GRN='\033[0;32m'
C_CYN='\033[0;36m'
C_RST='\033[0m'
info() { printf "${C_CYN}[offline]${C_RST} %s\n" "$*"; }
ok() { printf "${C_GRN}[offline]${C_RST} %s\n" "$*"; }
warn() { printf "${C_YEL}[offline][warn]${C_RST} %s\n" "$*" >&2; }
fail() {
  printf "${C_RED}[offline][error]${C_RST} %s\n" "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少必需命令: $1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

usage() {
  cat <<'EOF'
用法:
  bash scripts/offline.sh pack [选项]       # 源机（macOS，有网）打包
  bash scripts/offline.sh restore <bundle> [选项]  # 目标机（Linux，离线）恢复

pack 选项:
  -o, --output FILE       bundle 输出路径
  --with-project          附带项目 .pi/ 目录（约 900M）
  --with-repo             附带仓库源码 + node_modules（离线开发扩展用）
  --with-node             附带 node 运行时（架构由 --arch 决定）
  --keep-sessions         保留会话历史（默认排除）
  --keep-auth             保留 auth.json（默认排除，含密钥）
  --skip-extra-download   跳过缺失平台二进制下载

restore 选项:
  --pi-prefix DIR         pi 安装位置（默认 ~/.local/share/pi-runtime）
  --bin-dir DIR           pi 软链目录（默认 ~/.local/bin）
  --agent-dir DIR         agent 目录（默认 ~/.pi/agent）
  --force                 目标已存在时备份后覆盖
  --no-model-check        跳过模型配置检查
  --smoke                 启动 pi 冒烟自检
EOF
}

# ──────────────────────────── 常量 ────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${HOME}/.pi/agent"
PI_BIN="$(command -v pi 2>/dev/null || true)"
NODE_REQ="22.19.0"
ARCH="x64" # 目标 linux 架构（x64 / arm64），pack 时可用 --arch 覆盖

# ──────────────────────────── pack ────────────────────────────
cmd_pack() {
  local OUTPUT="" WITH_PROJECT=0 WITH_REPO=0 WITH_NODE=0 KEEP_SESSIONS=0 KEEP_AUTH=0 \
    SKIP_DL=0 STAGING="" KEEP_STAGING=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
    -o | --output)
      OUTPUT="$2"
      shift 2
      ;;
    --with-project)
      WITH_PROJECT=1
      shift
      ;;
    --with-repo)
      WITH_REPO=1
      shift
      ;;
    --with-node)
      WITH_NODE=1
      shift
      ;;
    --arch)
      ARCH="$2"
      [[ "$ARCH" == "x64" || "$ARCH" == "arm64" ]] || fail "不支持的架构: ${ARCH}（仅支持 x64 / arm64）"
      shift 2
      ;;
    --keep-sessions)
      KEEP_SESSIONS=1
      shift
      ;;
    --keep-auth)
      KEEP_AUTH=1
      shift
      ;;
    --skip-extra-download)
      SKIP_DL=1
      shift
      ;;
    --staging)
      STAGING="$2"
      shift 2
      ;;
    --keep-staging)
      KEEP_STAGING=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "未知参数: $1（pack 命令）" ;;
    esac
  done

  [[ -n "$PI_BIN" ]] || fail "未找到 pi 命令（需要先在源机安装 pi 并确保可用）"
  require_cmd node
  require_cmd npm
  require_cmd tar
  require_cmd rsync

  local NODE_VER="$(node -v | sed 's/^v//')"
  info "源机平台: $(uname -s)-$(uname -m) | node $NODE_VER"
  info "pi: $PI_BIN"

  local PI_PKG_DIR="$(node -e '
    const fs=require("fs"),path=require("path");
    let p=process.argv[1];
    try { p=fs.realpathSync(p); } catch(e){}
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) p=path.dirname(p);
    while (p && p!=="/") {
      if (fs.existsSync(path.join(p,"package.json"))) { console.log(p); process.exit(0); }
      p=path.dirname(p);
    }
    process.exit(1);
  ' "$PI_BIN" 2>/dev/null || true)"
  [[ -f "${PI_PKG_DIR:-}/package.json" ]] || fail "无法定位 pi 主包目录（找到: ${PI_PKG_DIR:-空}）"

  [[ -d "$AGENT_DIR" ]] || fail "未找到用户插件目录: ${AGENT_DIR}（~/.pi/agent 不存在）"

  # ── 1. staging 准备 ──
  if [[ -z "$STAGING" ]]; then
    STAGING="$(mktemp -d /tmp/pi-offline-XXXXXX)"
    local STAGING_TMP=1
  fi
  mkdir -p "$STAGING/pi" "$STAGING/agent" "$STAGING/offline-tgz"
  info "staging: $STAGING"

  # ── 2. pi 运行时 ──
  info "收集 pi 运行时 ($(du -sh "$PI_PKG_DIR" 2>/dev/null | cut -f1)) ..."
  cp -a "$PI_PKG_DIR/." "$STAGING/pi/"
  rm -rf "$STAGING/pi/node_modules/.cache" 2>/dev/null || true

  # ── 3. agent 用户目录 ──
  info "收集 ~/.pi/agent 用户目录 ..."
  local EXCLUDES=(sessions tmp state bin fff chat compact-backups cache .cache)
  [[ "$KEEP_SESSIONS" == 1 ]] && EXCLUDES=(tmp state bin fff chat compact-backups cache .cache)
  local EXC_ARGS=()
  local d
  for d in "${EXCLUDES[@]}"; do EXC_ARGS+=(--exclude="$d"); done
  rsync -a "${EXC_ARGS[@]}" "$AGENT_DIR/" "$STAGING/agent/" || fail "复制 agent 目录失败"
  # 排除日志
  find "$STAGING/agent" -maxdepth 2 -name "*.log" -delete 2>/dev/null || true
  rm -f "$STAGING/agent/pi-crash.log" 2>/dev/null || true
  # 默认排除 auth.json
  if [[ "$KEEP_AUTH" != 1 && -f "$STAGING/agent/auth.json" ]]; then
    rm -f "$STAGING/agent/auth.json"
    warn "已排除 auth.json（含密钥）；如需保留请用 --keep-auth"
  fi

  # ── 4. @zenone 本地包链接处理 ──
  #    IN-AGENT 链接  → 记 LINK_MAP，restore 时重建（指向 agent/extensions/ 内）
  #    外部源码可用包 → 解析内容进 agent-vendor/，restore 时放 agent/vendor/ 并重建链接
  #    外部不可用包   → 记 SKIPPED（dist 未构建 / 无 package.json）
  local LINK_MAP="" VENDOR_MAP="" SKIPPED_EXT=""
  local ZDIR="$AGENT_DIR/node_modules/@zenone"
  if [[ -d "$ZDIR" ]]; then
    mkdir -p "$STAGING/agent-vendor"
    local link
    for link in "$ZDIR"/*; do
      [[ -L "$link" ]] || continue
      local name="$(basename "$link")"
      local target="$(readlink "$link")"
      local real="$(cd "$(dirname "$link")" && cd "$(dirname "$target")" 2>/dev/null && pwd)/$(basename "$target")"
      [[ -n "$real" && -d "$real" ]] || {
        SKIPPED_EXT+="$name|broken-link"$'\n'
        continue
      }
      if [[ "$real" == "$AGENT_DIR/extensions/"* ]]; then
        local rel="${real#"$AGENT_DIR/"}"
        LINK_MAP+="$name|$rel"$'\n'
      elif [[ -f "$real/package.json" ]]; then
        if link_target_usable "$real"; then
          info "  外部源码可用包 → vendor: @zenone/$name"
          mkdir -p "$STAGING/agent-vendor/$name"
          cp -aL "$real/." "$STAGING/agent-vendor/$name/" 2>/dev/null || cp -aL "$real" "$STAGING/agent-vendor/$name"
          rm -rf "$STAGING/agent-vendor/$name/node_modules/.cache" 2>/dev/null || true
          VENDOR_MAP+="$name"$'\n'
        else
          SKIPPED_EXT+="$name|unbuilt-dist"$'\n'
        fi
      else
        SKIPPED_EXT+="$name|no-package"$'\n'
      fi
    done
  fi
  # 移除 staging 内的 @zenone 链接（restore 时重建）
  rm -rf "$STAGING/agent/node_modules/@zenone" 2>/dev/null || true
  if [[ -n "$SKIPPED_EXT" ]]; then
    warn "以下本地包不可用，未包含（restore 后引用它们的扩展可能加载失败）:"
    echo "$SKIPPED_EXT" | sed '/^$/d' | sed 's/|/: /' | sed 's/^/    - @zenone\//'
  fi

  # ── 5. 缺失平台二进制（Linux 目标机补位） ──
  if [[ "$SKIP_DL" != 1 ]]; then
    info "下载 Linux(${ARCH}) 平台二进制（源机有网时）..."
    local AST_GREP_PKG="@ast-grep/napi-linux-${ARCH}-gnu"
    local FFI_RS_PKG="@yuuang/ffi-rs-linux-${ARCH}-gnu"
    download_platform_pkg "$AST_GREP_PKG" "$STAGING/offline-tgz" || true
    download_platform_pkg "$FFI_RS_PKG" "$STAGING/offline-tgz" || true
  else
    info "跳过平台二进制下载（--skip-extra-download）"
  fi

  # ── 6. 可选组件 ──
  local COMPONENTS="pi,agent"
  if [[ "$WITH_PROJECT" == 1 ]]; then
    [[ -d "$REPO_ROOT/.pi" ]] || fail "项目 .pi/ 不存在"
    info "收集项目 .pi/ ..."
    cp -a "$REPO_ROOT/.pi/." "$STAGING/project/" 2>/dev/null || {
      mkdir -p "$STAGING/project"
      cp -a "$REPO_ROOT/.pi/." "$STAGING/project/"
    }
    rm -rf "$STAGING/project/tmp" "$STAGING/project/logs" 2>/dev/null || true
    COMPONENTS+=",project"
  fi
  if [[ "$WITH_REPO" == 1 ]]; then
    info "收集仓库源码 + node_modules ..."
    mkdir -p "$STAGING/repo"
    cp -a "$REPO_ROOT/." "$STAGING/repo/" 2>/dev/null || true
    rm -rf "$STAGING/repo/.git" "$STAGING/repo/node_modules/.cache" "$STAGING/repo/.ruff_cache" 2>/dev/null || true
    COMPONENTS+=",repo"
  fi
  if [[ "$WITH_NODE" == 1 ]]; then
    info "下载 linux-${ARCH} node v$NODE_VER ..."
    download_linux_node "$NODE_VER" "$STAGING/node-linux"
    COMPONENTS+=",node-linux"
  fi

  # ── 7. manifest ──
  info "生成 manifest ..."
  local TS="$(date +%Y-%m-%dT%H:%M:%S%z)"
  local SRC_PLAT="$(uname -s)-$(uname -m)"
  {
    echo "BUNDLE_VERSION=1.0.0"
    echo "CREATED_AT='$TS'"
    echo "SOURCE_PLATFORM='$SRC_PLAT'"
    echo "SOURCE_NODE='$NODE_VER'"
    echo "NODE_REQUIRED='$NODE_REQ'"
    echo "PI_PKG_VERSION='$(node -e "console.log(require('$STAGING/pi/package.json').version)" 2>/dev/null || echo unknown)'"
    echo "COMPONENTS='$COMPONENTS'"
    echo "TARGET_ARCH='$ARCH'"
    echo "# AGENT_LINKS_BEGIN"
    printf '%s' "$LINK_MAP" | sed '/^$/d' | sed 's/^/# /'
    echo "# AGENT_LINKS_END"
    echo "# VENDOR_LINKS_BEGIN"
    printf '%s' "$VENDOR_MAP" | sed '/^$/d' | sed 's/^/# /'
    echo "# VENDOR_LINKS_END"
    echo "# SKIPPED_EXT_BEGIN"
    printf '%s' "$SKIPPED_EXT" | sed '/^$/d' | sed 's/^/# /'
    echo "# SKIPPED_EXT_END"
  } >"$STAGING/manifest.sh"
  # JSON 副本（供报告/人工查阅）
  node -e '
    const fs=require("fs");
    const t=fs.readFileSync(process.argv[1],"utf8");
    const g=(s)=>{const m=t.match(new RegExp(s+"=(.*)"));return m?m[1].replace(/^\x27|\x27$/g,""):""};
    const sec=(a,b)=>{const m=t.match(new RegExp(a+"\\n([\\s\\S]*?)\\n"+b));return m?m[1].split("\n").filter(l=>l.startsWith("# ")).map(l=>l.slice(2)):[]};
    const j={tool:"nano-pi-agent-creator offline bundle",version:g("BUNDLE_VERSION"),createdAt:g("CREATED_AT"),
      sourcePlatform:g("SOURCE_PLATFORM"),sourceNode:g("SOURCE_NODE"),nodeRequired:g("NODE_REQUIRED"),
      piVersion:g("PI_PKG_VERSION"),components:g("COMPONENTS").split(","),targetArch:g("TARGET_ARCH"),
      agentLinks:sec("AGENT_LINKS_BEGIN","AGENT_LINKS_END").map(l=>l.split("|")),
      vendorLinks:sec("VENDOR_LINKS_BEGIN","VENDOR_LINKS_END"),
      skippedExternal:sec("SKIPPED_EXT_BEGIN","SKIPPED_EXT_END")};
    fs.writeFileSync(process.argv[1].replace(/manifest.sh$/,"manifest.json"),JSON.stringify(j,null,2));
  ' "$STAGING/manifest.sh" 2>/dev/null || true

  # ── 8. 打包 ──
  [[ -z "$OUTPUT" ]] && OUTPUT="${REPO_ROOT}/offline-bundle-$(date +%Y%m%d-%H%M%S).tar.gz"
  info "打包 → $OUTPUT ..."
  tar -czf "$OUTPUT" -C "$STAGING" .
  local SH="$(sha256_of "$OUTPUT")"
  echo "$SH  $OUTPUT" >"${OUTPUT}.sha256"
  ok "打包完成: $OUTPUT"
  ok "SHA256: $SH"
  echo "------------------------------------------------------------"
  echo "bundle 组成: $COMPONENTS"
  echo "bundle 大小: $(du -h "$OUTPUT" | cut -f1)（解压后约 $(du -sh "$STAGING" | cut -f1)）"
  [[ -n "$SKIPPED_EXT" ]] && echo "未包含的本地包（原因）: $(echo "$SKIPPED_EXT" | sed '/^$/d' | tr '\n' ' ')"
  echo "目标机恢复: 拷贝 bundle + sha256 文件过去，执行"
  echo "    bash scripts/offline.sh restore ${OUTPUT##*/}"
  echo "------------------------------------------------------------"
  if [[ "${STAGING_TMP:-0}" == 1 && "$KEEP_STAGING" != 1 ]]; then
    rm -rf "$STAGING"
    info "staging 已清理（--keep-staging 可保留）"
  fi
}

# 判断扩展包是否"源码可直接用"（有非 dist 入口，或 dist 已构建）
link_target_usable() {
  node -e '
    const fs=require("fs"),path=require("path");
    const d=process.argv[1];
    try {
      const pkg=JSON.parse(fs.readFileSync(path.join(d,"package.json"),"utf8"));
      const entries=[...(pkg.pi&&pkg.pi.extensions?pkg.pi.extensions:[])];
      if (pkg.main) entries.push(pkg.main);
      if (pkg.exports) {
        const v=typeof pkg.exports==="string"?[pkg.exports]
          :Object.values(pkg.exports).map(x=>typeof x==="string"?x:(x&&(x.import||x.default))||"").filter(Boolean);
        entries.push(...v);
      }
      const ok=entries.filter(Boolean).some(m => {
        const mm=m.replace(/^\.\//,"");
        return !mm.startsWith("dist/") || fs.existsSync(path.join(d,mm));
      });
      process.exit(ok?0:1);
    } catch(e){ process.exit(1); }
  ' "$1" 2>/dev/null
}

download_platform_pkg() {
  local pkg="$1" dest="$2"
  local ver
  ver="$(npm view "$pkg" version 2>/dev/null)" || {
    warn "无法查询 $pkg 版本（网络？），跳过"
    return 1
  }
  info "  npm pack $pkg@$ver ..."
  (cd "$dest" && npm pack "$pkg@$ver" --silent >/dev/null 2>&1) || {
    warn "下载 $pkg 失败，跳过"
    return 1
  }
  ok "  $pkg@$ver 已收录"
}

download_linux_node() {
  local ver="$1" dest="$2"
  require_cmd curl
  mkdir -p "$dest"
  local url="https://nodejs.org/dist/v$ver/node-v$ver-linux-${ARCH}.tar.xz"
  info "  $url"
  curl -fsSL "$url" -o "$dest/node-linux-${ARCH}.tar.xz" || {
    warn "node 下载失败（网络？），跳过 --with-node"
    rm -rf "$dest"
    return 1
  }
  ok "  node v$ver linux-${ARCH} 已收录 ($(du -h "$dest/node-linux-${ARCH}.tar.xz" | cut -f1))"
}

# ──────────────────────────── restore ────────────────────────────
cmd_restore() {
  local BUNDLE="" PI_PREFIX="${HOME}/.local/share/pi-runtime" BIN_DIR="${HOME}/.local/bin" \
    AGENT_DEST="${HOME}/.pi/agent" FORCE=0 MODEL_CHECK=1 SMOKE=0
  [[ $# -gt 0 ]] || {
    usage
    fail "restore 需要 bundle 参数"
  }
  BUNDLE="$1"
  shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --pi-prefix)
      PI_PREFIX="$2"
      shift 2
      ;;
    --bin-dir)
      BIN_DIR="$2"
      shift 2
      ;;
    --agent-dir)
      AGENT_DEST="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-model-check)
      MODEL_CHECK=0
      shift
      ;;
    --smoke)
      SMOKE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "未知参数: $1（restore 命令）" ;;
    esac
  done

  [[ -f "$BUNDLE" ]] || fail "bundle 不存在: $BUNDLE"
  require_cmd tar
  # 完整性校验（bundle + .sha256 一并传输；缺失时明确告警）
  local SHFILE="${BUNDLE}.sha256"
  if [[ -f "$SHFILE" ]]; then
    local EXPECT_SHA="$(awk '{print $1}' "$SHFILE" | head -1)"
    local ACTUAL_SHA="$(sha256_of "$BUNDLE")"
    [[ -n "$EXPECT_SHA" ]] || fail "SHA256 文件为空: ${SHFILE}"
    [[ "$EXPECT_SHA" == "$ACTUAL_SHA" ]] || fail "bundle SHA256 校验失败（可能损坏或被篡改）: 期望 ${EXPECT_SHA} / 实际 ${ACTUAL_SHA}"
    ok "bundle SHA256 校验通过: ${ACTUAL_SHA}"
  else
    warn "未找到 ${SHFILE}，跳过完整性校验（建议 pack 时连同 .sha256 一并拷贝）"
  fi

  local TMP="$(mktemp -d /tmp/pi-restore-XXXXXX)"
  info "解压 bundle ..."
  tar -xzf "$BUNDLE" -C "$TMP" || fail "解压失败（bundle 损坏？）"
  [[ -f "$TMP/manifest.sh" ]] || fail "bundle 缺少 manifest.sh，不是有效的 offline bundle"
  source "$TMP/manifest.sh"
  info "bundle: pi ${PI_PKG_VERSION}（源 ${SOURCE_PLATFORM} / node ${SOURCE_NODE}），组件: $COMPONENTS"

  # ── 0. node 检查 ──
  local NODE_CMD="node"
  if ! command -v node >/dev/null 2>&1; then
    if [[ -d "$TMP/node-linux" && -f "$TMP/node-linux/node-linux-${TARGET_ARCH}.tar.xz" ]]; then
      info "未找到 node，从 bundle 安装 linux-${TARGET_ARCH} node ..."
      install_node_from_bundle "$TMP/node-linux/node-linux-${TARGET_ARCH}.tar.xz" "$PI_PREFIX/node" "$BIN_DIR" "$TARGET_ARCH"
      NODE_CMD="$BIN_DIR/node"
    else
      fail "目标机没有 node（要求 >= ${NODE_REQ}）。请在目标机安装 node，或 pack 时加 --with-node"
    fi
  else
    local NV="$("$NODE_CMD" -v | sed 's/^v//')"
    if [[ "$(printf '%s\n' "$NV" "$NODE_REQ" | sort -V | head -1)" != "$NODE_REQ" ]]; then
      warn "node 版本 $NV 低于要求 ${NODE_REQ}（pi 要求 >= ${NODE_REQ}）；bundle 内含 --with-node 时可自动安装"
    else
      ok "node $NV 满足要求"
    fi
  fi

  # ── 1. pi 运行时 ──
  local PI_DEST="$PI_PREFIX/pi-coding-agent"
  install_dir "$TMP/pi" "$PI_DEST" "pi 运行时"
  mkdir -p "$BIN_DIR"
  # pi wrapper：默认启用 pi 内置离线模式（PI_OFFLINE=1），阻止启动时联网同步第三方插件。
  # 已安装的 npm/git 插件仍会正常加载（版本匹配走本地比较）；如需联网可 PI_OFFLINE=0 pi ... 覆盖。
  cat >"$BIN_DIR/pi" <<EOF
#!/usr/bin/env bash
export PI_OFFLINE="\${PI_OFFLINE:-1}"
if [[ -x "$BIN_DIR/node" ]]; then
  export PATH="$BIN_DIR:\$PATH"
fi
exec "$PI_DEST/dist/bundle/cli.js" "\$@"
EOF
  chmod +x "$BIN_DIR/pi"
  ok "pi 已安装: $BIN_DIR/pi（wrapper，内置离线模式 PI_OFFLINE=1）"
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    warn "请把 $BIN_DIR 加入 PATH:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc"
  fi

  # ── 2. agent 用户目录 ──
  install_dir "$TMP/agent" "$AGENT_DEST" "agent 用户目录 (~/.pi/agent)"
  # vendor 外部源码包（restore 后放 agent/vendor/，不在扩展发现路径）
  if [[ -d "$TMP/agent-vendor" && -n "$(ls -A "$TMP/agent-vendor" 2>/dev/null)" ]]; then
    install_dir "$TMP/agent-vendor" "$AGENT_DEST/vendor" "外部源码包 (agent/vendor)"
  fi
  rebuild_agent_links "$AGENT_DEST" || true
  rewrite_agent_package_json "$AGENT_DEST" || true

  # ── 3. 可选组件 ──
  if [[ "$COMPONENTS" == *"project"* && -d "$TMP/project" ]]; then
    install_dir "$TMP/project" "$PWD/.pi" "项目 .pi/"
  fi
  if [[ "$COMPONENTS" == *"repo"* && -d "$TMP/repo" ]]; then
    install_dir "$TMP/repo" "$PWD/pi-source" "仓库源码"
    ok "仓库源码已放到 $PWD/pi-source（含 node_modules，可离线开发扩展）"
  fi

  # ── 4. 平台二进制修复 ──
  fix_platform_bins "$TMP/offline-tgz" "$AGENT_DEST" "$TARGET_ARCH" || true

  # ── 5. 模型配置检查 ──
  [[ "$MODEL_CHECK" == 1 ]] && model_check "$AGENT_DEST/models.json" "$NODE_CMD"

  # ── 6. 自检 ──
  verify_install "$BIN_DIR/pi" "$AGENT_DEST" "$SMOKE"

  rm -rf "$TMP"
  ok "restore 完成！"
  echo "------------------------------------------------------------"
  echo "下一步:"
  echo "  1. export PATH=\"$BIN_DIR:\$PATH\"（若尚未加入）"
  echo "  2. 配置离线模型: 编辑 $AGENT_DEST/models.json（见上方提示）"
  echo "  3. 运行 pi 验证: pi"
  echo "说明:"
  echo "  - $BIN_DIR/pi 是 wrapper，默认已设 PI_OFFLINE=1（pi 内置离线模式，"
  echo "    启动时不联网同步第三方插件，已安装的 npm/git 插件仍正常加载）"
  echo "  - 如需临时联网更新插件: PI_OFFLINE=0 pi ..."
  echo "------------------------------------------------------------"
}

install_dir() {
  local src="$1" dst="$2" label="$3"
  if [[ -e "$dst" ]]; then
    if [[ "$FORCE" == 1 ]]; then
      local bak="${dst}.bak-$(date +%Y%m%d-%H%M%S)"
      warn "目标 $dst 已存在，备份到 $bak 后覆盖（--force）"
      mv "$dst" "$bak"
    else
      fail "目标 $dst 已存在。请用 --force 覆盖，或先移走旧目录"
    fi
  fi
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst" || fail "复制 $label 失败"
  ok "$label → $dst"
}

rebuild_agent_links() {
  local dest="$1"
  local zdir="$dest/node_modules/@zenone"
  mkdir -p "$zdir"
  # IN-AGENT 链接 → 指向 agent/extensions/ 内
  local links="$(sed -n '/^# AGENT_LINKS_BEGIN$/,/^# AGENT_LINKS_END$/p' "$TMP/manifest.sh" | sed '1d;$d' | sed '/^$/d' | sed 's/^# //')"
  local n rel
  while IFS='|' read -r n rel; do
    [[ -n "$n" ]] || continue
    rm -f "$zdir/$n"
    ln -s "../../$rel" "$zdir/$n"
    ok "链接: @zenone/$n -> $rel"
  done <<<"$links"
  # vendor 链接 → 指向 agent/vendor/ 内
  local vlinks="$(sed -n '/^# VENDOR_LINKS_BEGIN$/,/^# VENDOR_LINKS_END$/p' "$TMP/manifest.sh" | sed '1d;$d' | sed '/^$/d' | sed 's/^# //')"
  if [[ -n "$vlinks" ]]; then
    local v
    while IFS= read -r v; do
      [[ -n "$v" ]] || continue
      rm -f "$zdir/$v"
      ln -s "../../vendor/$v" "$zdir/$v"
      ok "链接(vendor): @zenone/$v -> vendor/$v"
    done <<<"$vlinks"
  fi
}

rewrite_agent_package_json() {
  local dest="$1"
  local pj="$dest/package.json"
  [[ -f "$pj" ]] || return 0
  node -e '
    const fs=require("fs"),path=require("path");
    const p=process.argv[1], d=process.argv[2];
    const j=JSON.parse(fs.readFileSync(p,"utf8"));
    let changed=false, removed=[];
    if (j.dependencies) {
      for (const [k,v] of Object.entries(j.dependencies)) {
        if (typeof v!=="string" || !v.startsWith("/")) continue;
        const base=v.split("/").pop();
        let target=null;
        if (fs.existsSync(path.join(d,"vendor",base))) target="./vendor/"+base;
        else if (fs.existsSync(path.join(d,"extensions",base))) target="./extensions/"+base;
        if (target) { j.dependencies[k]=target; changed=true; }
        else { delete j.dependencies[k]; removed.push(k); }
      }
    }
    if (changed||removed.length) {
      fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
      if (changed) console.log("    已重写 package.json file: 依赖为相对路径");
      if (removed.length) console.log("    已移除失效依赖: "+removed.join(", "));
    }
  ' "$pj" "$dest" 2>/dev/null || warn "package.json 重写失败（不影响运行，可手动处理）"
}

install_node_from_bundle() {
  local tarball="$1" prefix="$2" bindir="$3" arch="$4"
  mkdir -p "$prefix"
  tar -xJf "$tarball" -C "$prefix" || fail "node 解压失败"
  local d="$(ls -d "$prefix"/node-v*-linux-${arch} 2>/dev/null | head -1)"
  [[ -n "$d" ]] || fail "node 解压结构异常"
  mkdir -p "$bindir"
  ln -sfn "$d/bin/node" "$bindir/node"
  ln -sfn "$d/bin/npm" "$bindir/npm" 2>/dev/null || true
  ok "node 已安装到 $prefix/node（$bindir/node）"
}

fix_platform_bins() {
  local tgzdir="$1" agent_dest="$2" arch="${3:-x64}"
  [[ -d "$tgzdir" ]] || return 0
  local npm_nm="$agent_dest/npm/node_modules"
  local f base pkg_name target
  for f in "$tgzdir"/*.tgz; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    case "$base" in
    ast-grep-*)
      pkg_name="@ast-grep/napi-linux-${arch}-gnu"
      target="$npm_nm/@ast-grep/napi-linux-${arch}-gnu"
      ;;
    yuuang-ffi-rs-*)
      pkg_name="@yuuang/ffi-rs-linux-${arch}-gnu"
      target="$npm_nm/@yuuang/ffi-rs-linux-${arch}-gnu"
      ;;
    *) continue ;;
    esac
    if [[ -e "$target" ]]; then
      ok "平台包已存在: $pkg_name"
      continue
    fi
    mkdir -p "$(dirname "$target")"
    tar -xzf "$f" -C "$(dirname "$target")" 2>/dev/null
    mv "$(dirname "$target")/package" "$target" 2>/dev/null
    ok "已补装 Linux 平台包: $pkg_name"
  done
  # 提示 darwin-only 包（Linux 下相关插件功能降级）
  local p
  for p in @ast-grep/napi-darwin-arm64 @ast-grep/cli-darwin-arm64 @yuuang/ffi-rs-darwin-arm64 node-pty; do
    if [[ -e "$npm_nm/$p" ]]; then
      warn "检测到 darwin-only 包 ${p}（Linux 下不可用，相关插件功能降级；如已补装对应 linux 包可忽略）"
    fi
  done
}

model_check() {
  local mf="$1" node_cmd="$2"
  [[ -f "$mf" ]] || {
    warn "未找到 models.json，请手动配置模型"
    return 0
  }
  "$node_cmd" -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const prov=j.providers||{};
    const names=Object.keys(prov);
    const localish=names.filter(n=>{
      const u=(prov[n].baseUrl||"").toLowerCase();
      return u.includes("localhost")||u.includes("127.0.0.1")||u.includes("192.168.")||u.includes("10.")||u.includes("ollama")||u.includes("lmstudio");
    });
    if (localish.length) { console.log("OK  检测到疑似本地/内网 provider: "+localish.join(", ")); }
    else { console.log("WARN 当前 providers 均非本地: "+names.join(", ")); console.log("    离线环境需配置本地模型（如 ollama），示例："); console.log("    providers.ollama = { api: \"openai-completions\", baseUrl: \"http://localhost:11434/v1\", apiKey: \"ollama\", models: [...] }"); }
  ' "$mf" 2>/dev/null || warn "models.json 解析失败，请手动检查模型配置"
}

verify_install() {
  local pi_bin="$1" agent_dest="$2" smoke="$3"
  info "自检 ..."
  local out
  out="$("$pi_bin" --version 2>&1)" && ok "pi 版本: $out" || warn "pi --version 失败: $out"
  local n_ext=0
  [[ -d "$agent_dest/extensions" ]] && n_ext="$(find "$agent_dest/extensions" -maxdepth 1 \( -name "*.ts" -o -type d \) 2>/dev/null | wc -l | tr -d ' ')"
  ok "agent extensions 数量: ${n_ext}（$agent_dest/extensions）"
  local n_links=0
  [[ -d "$agent_dest/node_modules/@zenone" ]] && n_links="$(find "$agent_dest/node_modules/@zenone" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')"
  ok "@zenone 本地包链接: $n_links 个"
  if [[ "$smoke" == 1 ]]; then
    info "冒烟自检: pi -ne --no-session（无扩展模式，验证 pi 本体可启动）..."
    "$pi_bin" -ne --no-session -p "say ok" >/dev/null 2>&1 && ok "冒烟通过" || warn "冒烟失败（无扩展模式）— 请查看输出排查"
  fi
}

# ──────────────────────────── 入口 ────────────────────────────
case "${1:-}" in
pack)
  shift
  cmd_pack "$@"
  ;;
restore)
  shift
  cmd_restore "$@"
  ;;
-h | --help | help) usage ;;
*)
  usage
  fail "未知命令: ${1:-（空）}。支持 pack / restore"
  ;;
esac
