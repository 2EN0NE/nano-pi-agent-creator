#!/usr/bin/env bash
#
# pi 离线包安装器（随包分发；目标机执行，不依赖仓库 / npm / 网络）
#
#   bash install.sh pi-offline-<版本>-<arch>.tar.gz [选项]
#
# 语义见 docs/adr/0069-offline-bundle-source-install-and-degradation.md：
#   代码替换 · 配置备份后替换 · auth/models 与历史完全不读不写 · 失败项隔离不拖垮 pi
#
set -euo pipefail

TS="$(date +%Y%m%d-%H%M%S)"

PREFIX="${PI_OFFLINE_PREFIX:-$HOME/.local/share/pi-offline}"
AGENT_DIR="${PI_OFFLINE_AGENT_DIR:-$HOME/.pi/agent}"
BIN_DIR="${PI_OFFLINE_BIN:-$HOME/.local/bin}"
DRY_RUN=0
OVERWRITE_CONFIG=0
RESTORE_CONFIG=""
NO_PROBE=0
SKIP_TOOLS=0
SKIP_NATIVE=0
USE_BUNDLED_NODE=0
ALLOW_ARCH_MISMATCH=0
KEEP_STAGE=0
NODE_FROM_BUNDLE=0
MIN_NODE="22.19.0" # 兜底默认值；读到 manifest 后再以 manifest 为准
BUNDLE=""
REMOVE_LEGACY_RUNTIME=0
PRUNE_UNKNOWN_EXTS=0
# 旧版 restore（README/AGENTS 在 2026-10 之前一直教的那条路）的运行时落点
LEGACY_RUNTIME="$HOME/.local/share/pi-runtime"
# 本安装器要"备份后替换"的配置类资产（ADR-0069 D7/D8）
CONFIG_ITEMS="settings.json extensions-data skills themes prompts"

usage() {
	cat <<'EOF'
用法： bash install.sh <pi-offline-*.tar.gz> [选项]

选项：
  --prefix DIR            安装前缀（默认 ~/.local/share/pi-offline）
  --agent-dir DIR         pi agent 目录（默认 ~/.pi/agent）
  --bin-dir DIR           启动器目录（默认 ~/.local/bin）
  --dry-run               只校验 + 打印计划，不做任何改动（系统无 node，
                          或 node 版本低于包要求且带 --use-bundled-node
                          时会先自举包内 node）
  --overwrite-config      升级时不备份配置，直接替换
  --restore-config TS     从 ~/.pi/agent/.config-backup-TS 回填配置
  --no-probe              跳过加载探针（不推荐：会失去降级隔离）
  --skip-native           跳过原生包换血（调试用）
  --skip-tools            跳过 rg/fd 安装（调试用）
  --use-bundled-node      使用包内自带的 node（需要打包时 --with-node）
  --allow-arch-mismatch   允许目标架构与 bundle 不一致（几乎总是错的）
  --prune-unknown-extensions
                          把"不属本包提供"的既有扩展移入 extensions-disabled/（迁移旧机器用）
  --remove-legacy-runtime 安装成功后删除旧版 restore 的运行时 ~/.local/share/pi-runtime
  --keep-stage            保留解包中间目录（排障用）
  -h, --help              显示本帮助
EOF
}

say() { printf '[install] %s\n' "$*"; }
step() { printf '\n[install] === %s ===\n' "$*"; }
warn() { printf '[install] WARN  %s\n' "$*" >&2; }
die() {
	printf '[install] ERROR %s\n' "$*" >&2
	printf '\n安装失败。日志：%s\n' "${LOG:-<未创建>}" >&2
	exit 1
}
# 取值型参数（--prefix 等）缺值时必须给可读错误：`set -u` 下裸 "$2" 只会抛
# "line 74: $2: unbound variable"，分发安装器被当成"脚本坏了"。
need_value() {
	[ $# -ge 2 ] || die "$1 需要一个值（见 --help）"
}

while [ $# -gt 0 ]; do
	case "$1" in
	--prefix)
		need_value "$@"
		PREFIX="$2"
		shift 2
		;;
	--agent-dir)
		need_value "$@"
		AGENT_DIR="$2"
		shift 2
		;;
	--bin-dir)
		need_value "$@"
		BIN_DIR="$2"
		shift 2
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--overwrite-config)
		OVERWRITE_CONFIG=1
		shift
		;;
	--restore-config)
		need_value "$@"
		RESTORE_CONFIG="$2"
		shift 2
		;;
	--no-probe)
		NO_PROBE=1
		shift
		;;
	--skip-native)
		SKIP_NATIVE=1
		shift
		;;
	--skip-tools)
		SKIP_TOOLS=1
		shift
		;;
	--use-bundled-node)
		USE_BUNDLED_NODE=1
		shift
		;;
	--allow-arch-mismatch)
		ALLOW_ARCH_MISMATCH=1
		shift
		;;
	--prune-unknown-extensions)
		PRUNE_UNKNOWN_EXTS=1
		shift
		;;
	--remove-legacy-runtime)
		REMOVE_LEGACY_RUNTIME=1
		shift
		;;
	--keep-stage)
		KEEP_STAGE=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		die "未知选项：$1（--help 查看用法）"
		;;
	*)
		[ -z "$BUNDLE" ] || die "只能指定一个 bundle 文件"
		BUNDLE="$1"
		shift
		;;
esac
done
# ── 路径绝对化 ──────────────────────────────────────────────────────
# 启动器把这三个值原样写进脚本（含 PI_CODING_AGENT_DIR）。安装时按 cwd 解析相对路径、
# 之后从别的 cwd 启动 pi 就会指向另一个目录（pi 不会替它绝对化）——统一在这里定死。
abs_path() {
	case "$1" in
	"~") printf '%s' "$HOME" ;;
	# 别写 ${1#~/}：bash 3.2 会把模式里的 ~ 当 tilde 展开，剥不掉前缀，
	# 结果是 $HOME/~/... 这种"看着成功、实际装错位置"的路径。用子串切片最稳。
	"~/"*) printf '%s/%s' "$HOME" "${1:2}" ;;
	/*) printf '%s' "$1" ;;
	"~"*) die "不支持 ~<user> 形式的路径：$1（请写成绝对路径或 ~/…）" ;;
	*) printf '%s/%s' "$(pwd -P)" "$1" ;;
	esac
}
PREFIX="$(abs_path "$PREFIX")"
AGENT_DIR="$(abs_path "$AGENT_DIR")"
BIN_DIR="$(abs_path "$BIN_DIR")"
# ── --restore-config：只回填配置，不做其他事 ─────────────────────────
if [ -n "$RESTORE_CONFIG" ]; then
	SRC="$AGENT_DIR/.config-backup-$RESTORE_CONFIG"
	[ -d "$SRC" ] || die "找不到备份目录：$SRC"
	say "从备份回填配置：$SRC"
	for item in settings.json extensions-data skills themes prompts; do
		[ -e "$SRC/$item" ] || continue
		rm -rf "${AGENT_DIR:?}/$item"
		cp -a "$SRC/$item" "$AGENT_DIR/$item"
		say "  回填 $item"
	done
	say "完成。备份目录保留在 $SRC"
	exit 0
fi

[ -n "$BUNDLE" ] || {
	usage
	exit 1
}
[ -f "$BUNDLE" ] || die "找不到 bundle 文件：$BUNDLE"

# ── node 不可用（没有 / 版本过低）但包里带了 node：先 bootstrap，否则后面连 manifest 都读不了 ──
# 自举发生在读 manifest 之前，所以只能拿顶部兜底常量 MIN_NODE 判版本（读到 manifest 后会再核一次）。
# 注意：这一步只能用 tar/grep + 纯 shell（此时目标机上还没有能用的 node）。
node_satisfies() {
	# node_satisfies <node-bin> <min-version>
	local bin="$1" min="$2"
	"$bin" -e '
const need=process.argv[1].split(".").map(Number);
const cur=process.versions.node.split(".").map(Number);
for(let i=0;i<3;i++){ if((cur[i]||0)>(need[i]||0))process.exit(0); if((cur[i]||0)<(need[i]||0))process.exit(1); }
process.exit(0);' "$min" >/dev/null 2>&1
}

NEED_BUNDLED_NODE=0
if [ "$USE_BUNDLED_NODE" -eq 1 ]; then
	if ! command -v node >/dev/null 2>&1; then
		NEED_BUNDLED_NODE=1
	elif ! node_satisfies "$(command -v node)" "$MIN_NODE"; then
		# 目标机有 node 但版本太低（离线机的典型状态：node 18）：--use-bundled-node 必须真的生效，
		# 否则下面的版本检查只会 die 并再次让用户加这个 flag —— 无路可走。
		NEED_BUNDLED_NODE=1
	fi
fi
if [ "$NEED_BUNDLED_NODE" -eq 1 ]; then
	NODE_MEMBER="$(tar -tzf "$BUNDLE" 2>/dev/null | grep -m1 -E '^\./tools/[^/]+/node-v[0-9.]+-linux-[^/]+\.tar\.gz$' || true)"
	[ -n "$NODE_MEMBER" ] || die "目标机没有可用的 node（需要 >= ${MIN_NODE}），且 bundle 里没有 node 运行时。
  重新打包时加 --with-node，或用其它方式在目标机准备 Node >= ${MIN_NODE}。"
	NODE_STAGE="$PREFIX/.node-bootstrap"
	rm -rf "$NODE_STAGE"
	mkdir -p "$NODE_STAGE" || die "无法写入 $NODE_STAGE"
	say "目标机 node 缺失或低于 ${MIN_NODE}，改用包内 node（$(basename "$NODE_MEMBER")）"
	tar -xzf "$BUNDLE" -C "$NODE_STAGE" "$NODE_MEMBER" || die "从包里取出 node 失败"
	NODE_TGZ="$NODE_STAGE/${NODE_MEMBER#./}"
	mkdir -p "$PREFIX/node"
	tar -xzf "$NODE_TGZ" -C "$PREFIX/node" --strip-components=1 || die "node 解压失败（磁盘空间？）"
	rm -rf "$NODE_STAGE"
	NODE_BIN="$PREFIX/node/bin/node"
	[ -x "$NODE_BIN" ] || die "包内 node 不可执行：${NODE_BIN}（架构/glibc 不匹配？）"
	export PATH="$(dirname "$NODE_BIN"):$PATH"
	NODE_FROM_BUNDLE=1
	"$NODE_BIN" -e 'process.exit(0)' || die "包内 node 无法运行：${NODE_BIN}（多半是 glibc 太老，需要官方/unofficial 对应的 node 构建）"
fi

# ── 基础命令与 sha256 ───────────────────────────────────────────────
if command -v sha256sum >/dev/null 2>&1; then
	SHA256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
	SHA256="shasum -a 256"
elif command -v openssl >/dev/null 2>&1; then
	SHA256="openssl dgst -sha256 -r"
else
	die "没有可用的 sha256 工具（sha256sum / shasum / openssl 都没有）"
fi

command -v tar >/dev/null 2>&1 || die "缺少 tar"
command -v gzip >/dev/null 2>&1 || die "缺少 gzip"

# ── sha256 校验（有 .sha256 就硬门禁） ──────────────────────────────
# 无论有没有 sidecar，都实测一次：装完要把它记进 installed-bundle.json（D9）。
BUNDLE_SHA="$($SHA256 "$BUNDLE" | awk '{print $1}')"
[ -n "$BUNDLE_SHA" ] || die "无法计算 $BUNDLE 的 sha256"
if [ -f "$BUNDLE.sha256" ]; then
	EXPECT="$(awk '{print $1}' "$BUNDLE.sha256")"
	if [ "$EXPECT" != "$BUNDLE_SHA" ]; then
		die "sha256 不匹配！
  期望：$EXPECT
  实际：$BUNDLE_SHA
  说明：文件在传输中损坏，或被替换过。请重新拷贝 $BUNDLE 及其 .sha256"
	fi
	say "sha256 校验通过：$BUNDLE_SHA"
else
	warn "同目录没有 .sha256 文件 → 本次未经完整性校验就安装（强烈建议一并拷贝 .sha256）"
	warn "  bundle sha256 = ${BUNDLE_SHA}（已记入 installed-bundle.json，便于事后追溯）"
fi

# ── node：读 manifest / 跑探针都要它，先快速失败 ─────────────────────
# 放在这里（而不是等 preflight）是为了不把"没有 node"误报成"架构不一致"。
if ! command -v node >/dev/null 2>&1; then
	die "找不到 node（Node >= ${MIN_NODE} 必需）。
  两条路：
  1) 先给目标机装 node，然后重跑本脚本；
  2) 若打包时带了 node（pack --with-node），重跑时加 --use-bundled-node 自举。"
fi

# ── 从 tar 里直接读 manifest（dry-run 也能用） ───────────────────────
MANIFEST_TMP="$(mktemp "${TMPDIR:-/tmp}/pi-offline-manifest.XXXXXX")"
trap 'rm -f "$MANIFEST_TMP"' EXIT
tar -xzOf "$BUNDLE" ./manifest.json >"$MANIFEST_TMP" 2>/dev/null ||
	tar -xzOf "$BUNDLE" manifest.json >"$MANIFEST_TMP" 2>/dev/null ||
	die "bundle 里读不到 manifest.json（不是一个合法的离线包）"

mfield() { node -p "const m=JSON.parse(require('fs').readFileSync('$MANIFEST_TMP','utf8'));const v=$1;v===undefined?'':typeof v==='string'?v:JSON.stringify(v)"; }
mfail() { printf '[install] ERROR manifest.json 缺少或读不懂字段：%s\n' "$1" >&2; exit 1; }

BUNDLE_VERSION="$(mfield 'm.bundleVersion')" || mfail bundleVersion
PI_VERSION="$(mfield 'm.piVersion')" || mfail piVersion
BUNDLE_ARCH="$(mfield 'm.arch')" || mfail arch
LOCAL_DEV="$(mfield 'm.localDev')" || mfail localDev
MIN_NODE="$(mfield 'm.node && m.node.minVersion')" || mfail 'node.minVersion'
[ -n "$BUNDLE_VERSION" ] || mfail bundleVersion
[ -n "$BUNDLE_ARCH" ] || mfail arch
[ -n "$MIN_NODE" ] || MIN_NODE="22.19.0"

say "bundle 版本: $BUNDLE_VERSION (pi $PI_VERSION, arch $BUNDLE_ARCH)"

# ── preflight ───────────────────────────────────────────────────────
step "环境检查"
UNAME_M="$(uname -m)"
case "$UNAME_M" in
x86_64 | amd64) HOST_ARCH="x64" ;;
aarch64 | arm64) HOST_ARCH="arm64" ;;
*) HOST_ARCH="$UNAME_M" ;;
esac
say "目标机: $(uname -s) $UNAME_M (pi-offline arch: $HOST_ARCH)"

if [ "$LOCAL_DEV" != "true" ] && [ "$BUNDLE_ARCH" != "$HOST_ARCH" ]; then
	if [ "$ALLOW_ARCH_MISMATCH" -eq 1 ]; then
		warn "bundle 架构 $BUNDLE_ARCH 与本机 $HOST_ARCH 不一致（--allow-arch-mismatch）"
	else
		die "bundle 架构 $BUNDLE_ARCH 与本机 $HOST_ARCH 不一致。
  请用 --arch $HOST_ARCH 重新打包，或加 --allow-arch-mismatch（不推荐）"
	fi
fi

GLIBC="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
if [ -z "$GLIBC" ]; then
	GLIBC="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || true)"
fi
if [ -n "$GLIBC" ]; then
	say "glibc: $GLIBC"
	GLIBC_MAJOR="$(printf '%s' "$GLIBC" | cut -d. -f1)"
	GLIBC_MINOR="$(printf '%s' "$GLIBC" | cut -d. -f2)"
	if [ "$GLIBC_MAJOR" -lt 2 ] || { [ "$GLIBC_MAJOR" -eq 2 ] && [ "$GLIBC_MINOR" -lt 28 ]; }; then
		warn "glibc $GLIBC < 2.28：sharp 及其宿主插件（图像/视频相关）将不可用，"
		warn "  安装会继续，失败项由探针隔离。其余插件不受影响。"
	fi
else
	warn "取不到 glibc 版本（getconf / ldd 都失败），继续安装"
fi

# 原生包的 glibc 下限是 pack 阶段实测出来的：提前告诉用户哪项会降级，
# 而不是等安装完在探针报告里猜。
if [ "$LOCAL_DEV" != "true" ] && [ -n "$(mfield 'm.nativePackages.length')" ]; then
	node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const host=process.argv[2]||"";
const pv=(v)=>String(v||"").split(".").map(Number);
const cmp=(a,b)=>{const A=pv(a),B=pv(b);for(let i=0;i<Math.max(A.length,B.length);i++){const x=A[i]||0,y=B[i]||0;if(x!==y)return x-y}return 0};
const rows=[];
let degraded=0;
for (const p of m.nativePackages||[]) {
  if (p.status!=="ok") continue;
  const need = p.staticOnly ? "静态/无 glibc 依赖" : (p.maxGlibc ? `glibc >= ${p.maxGlibc}` : "未知");
  // 未知（源机读取失败）既不是 OK 也不是降级：不要给假的兼容承诺
  let verdict = p.staticOnly || p.maxGlibc ? "OK" : "??";
  if (host && p.maxGlibc && cmp(host,p.maxGlibc)<0) { verdict="降级"; degraded++; }
  rows.push(`  ${verdict==="OK"?"OK":verdict==="??"?"??":"!!"}  ${p.linuxName}  (${need})`);
}
if (rows.length===0) process.exit(1);
console.log(`原生包兼容性（目标机 glibc ${host||"未知"}）：`);
for(const r of rows) console.log(r);
if (degraded>0) console.log(`  → ${degraded} 项在当前 glibc 下不可用，安装会继续，相关插件由探针隔离`);
' "$MANIFEST_TMP" "$GLIBC" || true
fi

# node：包内自带（已自举）优先，否则目标机自带
NODE_BIN=""
if [ "$NODE_FROM_BUNDLE" -eq 1 ]; then
	NODE_BIN="$(command -v node)"
	[ -n "$NODE_BIN" ] || die "包内 node 解压后仍找不到可执行文件（$PREFIX/node/bin/node）"
	say "已使用包内 node：$NODE_BIN"
else
	NODE_BIN="$(command -v node || true)"
	if [ -z "$NODE_BIN" ]; then
		die "找不到 node。
  要求 Node >= ${MIN_NODE}。两条路：
  1) 先装 node（离线机需自行准备安装包），然后重跑本脚本；
  2) 若打包时带了 node（pack --with-node），加 --use-bundled-node 重跑。"
	fi
	say "node（目标机自带）：$NODE_BIN"
	if [ "$USE_BUNDLED_NODE" -eq 1 ]; then
		say "（目标机 node 已满足 ${MIN_NODE}，未启用包内 node）"
	fi
fi

NODE_VER="$("$NODE_BIN" -p 'process.versions.node')" || die "node 无法执行：$NODE_BIN"
say "node: $NODE_VER ($NODE_BIN)"
if ! node_satisfies "$NODE_BIN" "$MIN_NODE"; then
	if [ "$NODE_FROM_BUNDLE" -eq 1 ]; then
		die "包内 node 版本过低：$NODE_VER < ${MIN_NODE}。bundle 与目标机不匹配，请用更新的 node 重新打包。"
	fi
	die "node 版本过低：$NODE_VER < ${MIN_NODE}。请升级 node 后重跑（或用 --use-bundled-node）。"
fi

# 解包落在 $PREFIX，agent 目录可能在另一个分区：两边都要够大，取较小值判定。
avail_kb() { df -Pk "$1" 2>/dev/null | awk 'NR==2{print $4}'; }
NEED_KB=3145728
AVAIL_HOME="$(avail_kb "$HOME" || true)"
AVAIL_PREFIX="$(avail_kb "$(dirname "$PREFIX")" || true)"
AVAIL_KB="$AVAIL_HOME"
if [ -n "$AVAIL_PREFIX" ] && { [ -z "$AVAIL_KB" ] || [ "$AVAIL_PREFIX" -lt "$AVAIL_KB" ]; }; then
	AVAIL_KB="$AVAIL_PREFIX"
	AVAIL_WHERE="$(dirname "$PREFIX")"
else
	AVAIL_WHERE="$HOME"
fi
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt "$NEED_KB" ]; then
	die "$AVAIL_WHERE 所在分区可用空间不足：$((AVAIL_KB / 1024)) MB < 3072 MB。
  清理后重跑，或用 --prefix 指向更大的分区。"
fi
say "可用磁盘: $((AVAIL_KB / 1024)) MB（${AVAIL_WHERE}）"

if [ "$DRY_RUN" -eq 1 ]; then
	step "dry-run：以下动作会被执行"
	say "1. 解包到 $PREFIX/.install-$TS"
	say "2. 运行时 → $PREFIX/runtime（pi ${PI_VERSION}）"
	say "3. 依赖 → $AGENT_DIR/{node_modules,npm,git}"
	say "4. 配置 → $AGENT_DIR/{settings.json,extensions-data,skills,themes,prompts}"
	say "5. 扩展 → $AGENT_DIR/extensions（$(mfield 'm.extensions.length') 个，源码安装）"
	say "6. 工具 → $AGENT_DIR/bin/{rg,fd}；原生包换血"
	say "7. 探针 → $AGENT_DIR/load-report.json（失败项隔离到 extensions-disabled/）"
	say "8. 启动器 → $BIN_DIR/pi；PATH 块写入 ~/.bashrc"
	say "已存在的安装：$(if [ -f "$AGENT_DIR/installed-bundle.json" ]; then node -p "require('$AGENT_DIR/installed-bundle.json').bundleVersion" 2>/dev/null || echo '有'; else echo '无记录（旧版 restore 布局 / 手工安装 / 全新）'; fi)"
	say "已有配置：$(if [ -e "$AGENT_DIR/settings.json" ] || [ -e "$AGENT_DIR/extensions-data" ]; then echo '会先备份到 '"$AGENT_DIR"'/.config-backup-<ts>/ 再替换'; else echo '无（写 bundle 版本）'; fi)"
	say "旧运行时：$(if [ -d "$HOME/.local/share/pi-runtime" ]; then echo "$HOME/.local/share/pi-runtime（--remove-legacy-runtime 可在成功后清理）"; else echo '无'; fi)"
	say "dry-run 结束，未做任何改动。"
	exit 0
fi

# dry-run 之后才真正落地：--dry-run 承诺"不做任何改动"，所以目录与日志都放到这里
mkdir -p "$PREFIX" 2>/dev/null || die "无法写入安装前缀：${PREFIX}（确认目录权限）"
touch "$PREFIX/.write-test" 2>/dev/null || die "安装前缀不可写：$PREFIX"
rm -f "$PREFIX/.write-test"
mkdir -p "$AGENT_DIR/logs" || die "无法创建日志目录：${AGENT_DIR}/logs"
LOG="$AGENT_DIR/logs/offline-install-$TS.log"
# 全程留痕（ADR-0069 D13）：屏幕 + 日志
exec > >(tee -a "$LOG") 2>&1
say "bundle    : $BUNDLE"
say "安装前缀  : $PREFIX"
say "agent 目录: $AGENT_DIR"
say "启动器    : $BIN_DIR/pi"
say "日志      : $LOG"

# ── 解包 ────────────────────────────────────────────────────────────
step "解包"
STAGE="$PREFIX/.install-$TS"
rm -rf "$STAGE"
mkdir -p "$STAGE"
# 退出处置：成功才清理解包目录；失败时**保留**（排障），但必须明确告知它在哪、能删。
# 这里而不是 die() 里做：`set -e` 中断（如 mkdir 失败）不会走 die，同样会留下整个 payload。
cleanup_on_exit() {
	rm -f "$MANIFEST_TMP"
	if [ "${INSTALL_OK:-0}" -eq 1 ]; then
		if [ "${KEEP_STAGE:-0}" -eq 0 ]; then rm -rf "$STAGE"; fi
	else
		printf '[install] 解包目录保留（排障用，确认后可删除）：%s\n' "$STAGE" >&2
	fi
}
trap cleanup_on_exit EXIT
tar -xzf "$BUNDLE" -C "$STAGE" || die "解包失败（磁盘空间？）"
PAYLOAD="$STAGE"
[ -f "$PAYLOAD/manifest.json" ] || die "解包后没有 manifest.json"
cp "$PAYLOAD/manifest.json" "$MANIFEST_TMP"
say "解包到 $STAGE"

# 包内 node 已在 bootstrap 阶段解压并加入 PATH（见上方 NODE_FROM_BUNDLE）
if [ -n "$NODE_BIN" ]; then
	export PATH="$(dirname "$NODE_BIN"):$PATH"
fi

# ── 模式判定 + 配置备份 ─────────────────────────────────────────────
PREV_BUNDLE=""
MANAGED_EXT_JSON="[]"
MANAGED_SKILL_JSON="[]"
MANAGED_THEME_JSON="[]"
if [ -f "$AGENT_DIR/installed-bundle.json" ]; then
	PREV_BUNDLE="$(node -p "require('$AGENT_DIR/installed-bundle.json').bundleVersion" 2>/dev/null || echo unknown)"
	MANAGED_EXT_JSON="$(node -p "JSON.stringify(require('$AGENT_DIR/installed-bundle.json').managedExtensions||[])" 2>/dev/null || echo '[]')"
	MANAGED_SKILL_JSON="$(node -p "JSON.stringify(require('$AGENT_DIR/installed-bundle.json').managedSkills||[])" 2>/dev/null || echo '[]')"
	MANAGED_THEME_JSON="$(node -p "JSON.stringify(require('$AGENT_DIR/installed-bundle.json').managedThemes||[])" 2>/dev/null || echo '[]')"
fi

# 判据不能只看 installed-bundle.json：旧版 restore 布局（0.7x 老机器、README 在
# 2026-10 之前教的那条路）与手工装过 pi 的机器都没有这个文件，但它们的
# settings.json / extensions-data 同样会被整体替换——不备份就是不可逆的配置丢失。
EXISTING_CONFIG=0
for item in $CONFIG_ITEMS; do
	if [ -e "$AGENT_DIR/$item" ]; then EXISTING_CONFIG=1; fi
done
LEGACY_PRESENT=0
if [ -d "$LEGACY_RUNTIME" ]; then LEGACY_PRESENT=1; fi

BACKUP_NEEDED=0
if [ "$EXISTING_CONFIG" -eq 1 ]; then BACKUP_NEEDED=1; fi
if [ "$OVERWRITE_CONFIG" -eq 1 ]; then BACKUP_NEEDED=0; fi

if [ -n "$PREV_BUNDLE" ]; then
	step "升级安装：$PREV_BUNDLE → $BUNDLE_VERSION"
elif [ "$EXISTING_CONFIG" -eq 1 ]; then
	step "迁移安装：目标机已有配置 → 备份后替换"
	say "  没有安装包身份清单（installed-bundle.json）→ 判定为旧版 restore 布局或手工安装"
	if [ "$LEGACY_PRESENT" -eq 1 ]; then
		say "  旧运行时目录：${LEGACY_RUNTIME}（安装成功后可用 --remove-legacy-runtime 清理）"
	fi
	say "  既有扩展不会自动删除；本包不提供的那些会保留，必要时加 --prune-unknown-extensions"
else
	step "全新安装"
fi

BACKUP_DIR=""
if [ "$BACKUP_NEEDED" -eq 1 ]; then
	BACKUP_DIR="$AGENT_DIR/.config-backup-$TS"
	mkdir -p "$BACKUP_DIR"
	for item in $CONFIG_ITEMS; do
		if [ -e "$AGENT_DIR/$item" ]; then
			cp -a "$AGENT_DIR/$item" "$BACKUP_DIR/$item"
		fi
	done
	node -e '
const fs=require("fs");
const dir=process.argv[1];
const items=fs.readdirSync(dir);
fs.writeFileSync(dir+"/manifest.json",JSON.stringify({
  createdAt:new Date().toISOString(),
  fromBundle:process.argv[2],
  toBundle:process.argv[3],
  items,
  restoreWith:`bash install.sh --restore-config ${process.argv[4]}`,
},null,2)+"\n");
' "$BACKUP_DIR" "${PREV_BUNDLE:-legacy/manual}" "$BUNDLE_VERSION" "$TS"
	say "配置已备份到 $BACKUP_DIR"
elif [ "$OVERWRITE_CONFIG" -eq 1 ] && { [ -n "$PREV_BUNDLE" ] || [ "$EXISTING_CONFIG" -eq 1 ]; }; then
	warn "--overwrite-config：不备份配置，直接替换"
fi

# ── 运行时 ──────────────────────────────────────────────────────────
step "安装 pi 运行时 $PI_VERSION"
RUNTIME_DIR="$PREFIX/runtime"
rm -rf "$RUNTIME_DIR"
mv "$PAYLOAD/runtime" "$RUNTIME_DIR" || die "运行时安装失败（目标：${RUNTIME_DIR}）"
RUNTIME_CLI="$RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
[ -f "$RUNTIME_CLI" ] || die "运行时缺少入口：$RUNTIME_CLI"
say "运行时 → $RUNTIME_DIR"

# 启动器（绝对 node 路径 + 找不到时回落 PATH 里的 node）
mkdir -p "$BIN_DIR" || die "无法创建启动器目录：${BIN_DIR}（确认权限，或用 --bin-dir 指定可写目录）"
# 旧布局可能把 $BIN_DIR/pi 放成软链（指向旧运行时）：直接 cat > 会写穿软链，
# 结果是"启动器内容进了旧运行时、软链依然指向旧运行时"。必须先摘掉。
rm -f "$BIN_DIR/pi"
cat >"$BIN_DIR/pi" <<WRAPPER
#!/bin/sh
# 由 pi 离线包安装器生成（${BUNDLE_VERSION}，安装于 ${TS}）
# 语义：永远以离线模式启动（不联网同步第三方插件），运行时固定在这个前缀内。
if [ -z "\${PI_OFFLINE:-}" ]; then
  PI_OFFLINE=1
  export PI_OFFLINE
fi
# agent 目录可能不是默认的 ~/.pi/agent（--agent-dir / PI_OFFLINE_AGENT_DIR）：
# pi 靠 PI_CODING_AGENT_DIR 找 settings.json / extensions / node_modules，不传就会去读默认目录。
if [ -z "\${PI_CODING_AGENT_DIR:-}" ]; then
  PI_CODING_AGENT_DIR="$AGENT_DIR"
  export PI_CODING_AGENT_DIR
fi
NODE_BIN="$NODE_BIN"
if [ ! -x "\$NODE_BIN" ]; then
  NODE_BIN="\$(command -v node 2>/dev/null || true)"
fi
if [ -z "\$NODE_BIN" ]; then
  echo "pi: 找不到 node（离线包装在 ${NODE_BIN}）。请把 node 加回 PATH，或重跑安装器 --use-bundled-node。" >&2
  exit 127
fi
exec "\$NODE_BIN" "$RUNTIME_CLI" "\$@"
WRAPPER
chmod 755 "$BIN_DIR/pi"
say "启动器 → $BIN_DIR/pi"

# ── 依赖快照（代码类：整体替换） ────────────────────────────────────
step "安装依赖快照"
replace_dir() {
	# replace_dir <src> <dst> <label>
	local src="$1" dst="$2" label="$3"
	if [ ! -d "$src" ]; then
		warn "bundle 里没有 ${label}，跳过"
		return 0
	fi
	rm -rf "$dst.old"
	[ -d "$dst" ] && mv "$dst" "$dst.old"
	mkdir -p "$(dirname "$dst")"
	mv "$src" "$dst" || die "$label 安装失败"
	rm -rf "$dst.old"
	say "$label → $dst"
}
replace_dir "$PAYLOAD/deps/node_modules" "$AGENT_DIR/node_modules" "共享依赖 node_modules"
replace_dir "$PAYLOAD/deps/npm" "$AGENT_DIR/npm" "第三方插件 npm"
replace_dir "$PAYLOAD/deps/git" "$AGENT_DIR/git" "第三方插件 git"

# ── 配置（备份后替换） ──────────────────────────────────────────────
step "安装配置"
if [ -d "$PAYLOAD/config/skills" ]; then
	rm -rf "$AGENT_DIR/skills"
	cp -a "$PAYLOAD/config/skills" "$AGENT_DIR/skills"
	say "内嵌技能（第三方包贡献的）→ $AGENT_DIR/skills"
fi
if [ -d "$PAYLOAD/config/themes" ]; then
	rm -rf "$AGENT_DIR/themes"
	cp -a "$PAYLOAD/config/themes" "$AGENT_DIR/themes"
	say "主题 → $AGENT_DIR/themes"
fi
if [ -d "$PAYLOAD/config/prompts" ]; then
	rm -rf "$AGENT_DIR/prompts"
	cp -a "$PAYLOAD/config/prompts" "$AGENT_DIR/prompts"
fi
if [ -d "$PAYLOAD/config/extensions-data" ]; then
	rm -rf "$AGENT_DIR/extensions-data"
	cp -a "$PAYLOAD/config/extensions-data" "$AGENT_DIR/extensions-data"
	say "插件配置 extensions-data → $AGENT_DIR/extensions-data"
fi
if [ -f "$PAYLOAD/config/settings.json" ]; then
	cp "$PAYLOAD/config/settings.json" "$AGENT_DIR/settings.json"
	say "settings.json 已安装"
fi

# ── 共享模块（扩展用相对路径 import 它们，位置必须是 agent 目录的同级） ──
if [ -d "$PAYLOAD/source/src/tui" ]; then
	SHARED_PARENT="$(dirname "$AGENT_DIR")"
	mkdir -p "$SHARED_PARENT/src"
	rm -rf "$SHARED_PARENT/src/tui"
	cp -a "$PAYLOAD/source/src/tui" "$SHARED_PARENT/src/tui"
	say "共享模块 src/tui → $SHARED_PARENT/src/tui"
fi
# ── 扩展：源码安装 + 剪枝本工具管理过的旧条目 ────────────────────────
step "安装扩展（源码）"
EXT_DIR="$AGENT_DIR/extensions"
DISABLED_DIR="$AGENT_DIR/extensions-disabled"
mkdir -p "$EXT_DIR"

WANT_LIST="$STAGE/.want-extensions.txt"
node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write((m.extensions||[]).map(e=>[e.name,e.source,e.kind,e.entry||""].join("\t")).join("\n")+"\n");
' "$PAYLOAD/manifest.json" >"$WANT_LIST"

# 剪枝：上次安装记录里属于本工具管理、但新包已经不存在的扩展
printf '%s' "$MANAGED_EXT_JSON" >"$STAGE/.prev-ext.json"
node -e '
const fs=require("fs");
const prev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")||"[]");
const m=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const want=new Set((m.extensions||[]).map(e=>e.name));
process.stdout.write(prev.filter(n=>!want.has(n)).map(n=>n+"\n").join(""));
' "$STAGE/.prev-ext.json" "$PAYLOAD/manifest.json" >"$STAGE/.prune-ext.txt"
# 旧机器（0.7x / 旧 restore 布局）的扩展名可能与今天不同：它们不在 managed 清单里，
# 剪枝逻辑碰不到。这里把"本包不提供"的条目报出来，显式加 --prune-unknown-extensions
# 才移走（移入 extensions-disabled/，不删除）。
node -e '
const fs=require("fs"),path=require("path");
const extDir=process.argv[1];
const m=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const want=new Set((m.extensions||[]).map(e=>e.name));
const out=[];
for (const n of fs.readdirSync(extDir)) {
  const p=path.join(extDir,n);
  let st; try{st=fs.statSync(p)}catch{continue}
  if (st.isDirectory()) { if(!want.has(n)) out.push(n); continue; }
  const base=n.replace(/\.(ts|js|mjs)$/,"");
  if (base!==n && !want.has(base)) out.push(base);
}
process.stdout.write(out.join("\n")+"\n");
' "$EXT_DIR" "$PAYLOAD/manifest.json" >"$STAGE/.unknown-ext.txt"
UNKNOWN_COUNT="$(grep -c . "$STAGE/.unknown-ext.txt" || true)"
[ -n "$UNKNOWN_COUNT" ] || UNKNOWN_COUNT=0
if [ "$UNKNOWN_COUNT" -gt 0 ]; then
	warn "目标机有 $UNKNOWN_COUNT 个扩展不属本包提供（旧版本遗留）："
	head -20 "$STAGE/.unknown-ext.txt" | while IFS= read -r n; do warn "  - $n"; done
	if [ "$UNKNOWN_COUNT" -gt 20 ]; then warn "  …（其余 $((UNKNOWN_COUNT - 20)) 个略）"; fi
	if [ "$PRUNE_UNKNOWN_EXTS" -eq 1 ]; then
		mkdir -p "$DISABLED_DIR"
		while IFS= read -r n; do
			[ -n "$n" ] || continue
			for cand in "$EXT_DIR/$n" "$EXT_DIR/$n.ts" "$EXT_DIR/$n.js" "$EXT_DIR/$n.mjs"; do
				[ -e "$cand" ] || continue
				suffix=""
				case "$cand" in *.ts | *.js | *.mjs) suffix="${cand#"$EXT_DIR/$n"}" ;; esac
				mv "$cand" "$DISABLED_DIR/$n.unknown-$TS$suffix"
				say "  移动非本包扩展：$n → extensions-disabled/"
			done
		done <"$STAGE/.unknown-ext.txt"
	else
		warn "  保留在原地；要移走（不删除）请加 --prune-unknown-extensions 重跑"
	fi
fi

PRUNED=0
while IFS= read -r name; do
	[ -n "$name" ] || continue
	moved=0
	if [ -d "$EXT_DIR/$name" ]; then
		mkdir -p "$DISABLED_DIR"
		rm -rf "$DISABLED_DIR/$name.removed-$TS"
		mv "$EXT_DIR/$name" "$DISABLED_DIR/$name.removed-$TS"
		moved=1
	elif [ -f "$EXT_DIR/$name.ts" ]; then
		mkdir -p "$DISABLED_DIR"
		mv "$EXT_DIR/$name.ts" "$DISABLED_DIR/$name.removed-$TS.ts"
		moved=1
	fi
	if [ "$moved" -eq 1 ]; then
		PRUNED=$((PRUNED + 1))
		say "  剪枝已下架扩展：$name → extensions-disabled/"
	fi
done <"$STAGE/.prune-ext.txt"

INSTALLED=0
TAB="$(printf '\t')"
while IFS="$TAB" read -r name src kind _entry; do
	[ -n "$name" ] || continue
	case "$kind" in
	dir)
		rm -rf "$EXT_DIR/$name"
		cp -a "$PAYLOAD/source/$src" "$EXT_DIR/$name" || die "扩展安装失败：$name"
		;;
	file)
		case "$src" in
		*.ts) cp "$PAYLOAD/source/$src" "$EXT_DIR/$name.ts" ;;
		*.js) cp "$PAYLOAD/source/$src" "$EXT_DIR/$name.js" ;;
		*.mjs) cp "$PAYLOAD/source/$src" "$EXT_DIR/$name.mjs" ;;
		*) die "无法识别的扩展文件类型：$src" ;;
		esac
		;;
	*)
		die "manifest 里的扩展 $name 类型非法：$kind"
		;;
	esac
	INSTALLED=$((INSTALLED + 1))
done <"$WANT_LIST"
say "已安装扩展：$INSTALLED 个（剪枝 $PRUNED 个）"

# ── 技能 / 主题（源码覆盖内嵌 base） ────────────────────────────────
step "安装技能与主题（仓库源码）"
node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write((m.skills||[]).map(s=>[s.name,s.source].join("\t")).join("\n")+"\n");
' "$PAYLOAD/manifest.json" >"$STAGE/.want-skills.txt"
mkdir -p "$AGENT_DIR/skills"
SKILLS_INSTALLED=0
while IFS="$TAB" read -r name src; do
	[ -n "$name" ] || continue
	rm -rf "${AGENT_DIR:?}/skills/$name"
	cp -a "$PAYLOAD/source/$src" "$AGENT_DIR/skills/$name" || die "技能安装失败：$name"
	SKILLS_INSTALLED=$((SKILLS_INSTALLED + 1))
done <"$STAGE/.want-skills.txt"
say "已安装技能：$SKILLS_INSTALLED 个"

# 剪枝：上个包提供、新包已下架的技能/主题（与扩展剪枝对齐）。
# 只在配置已备份时执行——保证被删的东西一定能从 .config-backup-<ts>/ 捞回来。
PRUNED_SKILLS=0
PRUNED_THEMES=0
if [ -n "$BACKUP_DIR" ]; then
	printf '%s' "$MANAGED_SKILL_JSON" >"$STAGE/.prev-skills.json"
	printf '%s' "$MANAGED_THEME_JSON" >"$STAGE/.prev-themes.json"
	node -e '
const fs=require("fs");
const prev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")||"[]");
const m=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const want=new Set((m.skills||[]).map(s=>s.name));
process.stdout.write(prev.filter(n=>!want.has(n)).join("\n"));
' "$STAGE/.prev-skills.json" "$PAYLOAD/manifest.json" >"$STAGE/.prune-skills.txt"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		[ -d "$AGENT_DIR/skills/$name" ] || continue
		rm -rf "${AGENT_DIR:?}/skills/$name"
		PRUNED_SKILLS=$((PRUNED_SKILLS + 1))
		say "  剪枝已下架技能：${name}（备份中有）"
	done <"$STAGE/.prune-skills.txt"
	node -e '
const fs=require("fs");
const prev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")||"[]");
const m=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const want=new Set((m.themes||[]).map(t=>t.name));
process.stdout.write(prev.filter(n=>!want.has(n)).join("\n"));
' "$STAGE/.prev-themes.json" "$PAYLOAD/manifest.json" >"$STAGE/.prune-themes.txt"
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		[ -f "$AGENT_DIR/themes/$name.json" ] || continue
		rm -f "${AGENT_DIR:?}/themes/$name.json"
		PRUNED_THEMES=$((PRUNED_THEMES + 1))
		say "  剪枝已下架主题：${name}（备份中有）"
	done <"$STAGE/.prune-themes.txt"
fi

node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
process.stdout.write((m.themes||[]).map(t=>[t.name,t.source].join("\t")).join("\n")+"\n");
' "$PAYLOAD/manifest.json" >"$STAGE/.want-themes.txt"
mkdir -p "$AGENT_DIR/themes"
THEMES_INSTALLED=0
while IFS="$TAB" read -r name src; do
	[ -n "$name" ] || continue
	cp "$PAYLOAD/source/$src" "$AGENT_DIR/themes/$name.json"
	THEMES_INSTALLED=$((THEMES_INSTALLED + 1))
done <"$STAGE/.want-themes.txt"

# ── @zenone 链接 + agent/package.json ───────────────────────────────
step "重建本地包链接"
node -e '
const fs=require("fs"),path=require("path");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const agent=process.argv[2];
const nm=path.join(agent,"node_modules");
fs.mkdirSync(nm,{recursive:true});
const scope=path.join(nm,"@zenone");
fs.mkdirSync(scope,{recursive:true});
const pkgPath=path.join(agent,"package.json");
let pkg={private:true,type:"module",dependencies:{}};
try{pkg=JSON.parse(fs.readFileSync(pkgPath,"utf8"))}catch{}
pkg.private=true;pkg.type=pkg.type||"module";
pkg.dependencies=pkg.dependencies||{};
const wanted=new Map();
for(const l of m.zenoneLinks||[]){
  const short=l.name.split("/")[1];
  const target=path.join("..","..","extensions",l.dir);
  wanted.set(short,l.name);
  const link=path.join(scope,short);
  try{fs.rmSync(link,{recursive:true,force:true})}catch{}
  fs.symlinkSync(target,link,"dir");
  pkg.dependencies[l.name]="./extensions/"+l.dir;
}
// 清掉本工具管理过、但这次不再提供的链接（避免指向已剪枝目录）
for(const name of Object.keys(pkg.dependencies)){
  if(!name.startsWith("@zenone/"))continue;
  const short=name.split("/")[1];
  if(wanted.has(short))continue;
  const link=path.join(scope,short);
  try{fs.rmSync(link,{recursive:true,force:true})}catch{}
  delete pkg.dependencies[name];
}
fs.writeFileSync(pkgPath,JSON.stringify(pkg,null,2)+"\n");
process.stdout.write(String(wanted.size));
' "$PAYLOAD/manifest.json" "$AGENT_DIR" >"$STAGE/.links-count"
say "本地包链接：$(cat "$STAGE/.links-count") 个（@zenone/*）"

# ── 原生包换血 ──────────────────────────────────────────────────────
step "原生包换血"
node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const rows=[];
for(const p of m.nativePackages||[]) rows.push([p.name,p.root,p.linuxName||"",p.tarball||"",p.status||""].join("\t"));
process.stdout.write(rows.join("\n")+"\n");
' "$PAYLOAD/manifest.json" >"$STAGE/.native.txt"
NATIVE_OK=0
NATIVE_SKIP=0
while IFS="$TAB" read -r darwinName root linuxName tarball status; do
	[ -n "$darwinName" ] || continue
	if [ "$SKIP_NATIVE" -eq 1 ]; then
		NATIVE_SKIP=$((NATIVE_SKIP + 1))
		continue
	fi
	# 换血路径上：无论 linux 变体是否落位成功，darwin-only 目录都必须从目标机移除
	rm -rf "${AGENT_DIR:?}/$root/$darwinName"
	# 同一 linux 包的重复 darwin 副本：只删除，不重复解包
	if [ "$status" = "remove-only" ]; then
		NATIVE_SKIP=$((NATIVE_SKIP + 1))
		continue
	fi
	if [ -z "$linuxName" ] || [ -z "$tarball" ] || [ "$status" != "ok" ]; then
		warn "  $darwinName 没有可用的 linux 变体（相关插件会被探针隔离）"
		NATIVE_SKIP=$((NATIVE_SKIP + 1))
		continue
	fi
	TARBALL_PATH="$PAYLOAD/tools/$BUNDLE_ARCH/native/$tarball"
	if [ ! -f "$TARBALL_PATH" ]; then
		warn "  缺少 ${tarball}，跳过 $linuxName"
		NATIVE_SKIP=$((NATIVE_SKIP + 1))
		continue
	fi
	rm -rf "$STAGE/.native-tmp"
	mkdir -p "$STAGE/.native-tmp"
	tar -xzf "$TARBALL_PATH" -C "$STAGE/.native-tmp" || die "解包原生包失败：$tarball"
	TARGET="${AGENT_DIR:?}/$root/$linuxName"
	mkdir -p "$(dirname "$TARGET")"
	rm -rf "$TARGET"
	mv "$STAGE/.native-tmp/package" "$TARGET" || die "原生包落位失败：$linuxName"
	NATIVE_OK=$((NATIVE_OK + 1))
done <"$STAGE/.native.txt"
say "原生包：$NATIVE_OK 个已换血，$NATIVE_SKIP 个降级/跳过"

# node-pty（N-API 预编译，pack 阶段在 Linux 容器里编译）
NODE_PTY_STATUS="$(node -p "((JSON.parse(require('fs').readFileSync('$PAYLOAD/manifest.json','utf8')).nodePty)||{}).status||''")"
if [ "$NODE_PTY_STATUS" = "compiled" ] && [ "$SKIP_NATIVE" -eq 0 ]; then
	PTY_SRC="$(ls "$PAYLOAD"/tools/*/compiled/node-pty/prebuilds/linux-*/pty.node 2>/dev/null | head -1 || true)"
	if [ -n "$PTY_SRC" ] && [ -d "$AGENT_DIR/npm/node_modules/node-pty" ]; then
		PTY_DST_DIR="$AGENT_DIR/npm/node_modules/node-pty/prebuilds/linux-$BUNDLE_ARCH"
		mkdir -p "$PTY_DST_DIR"
		cp "$PTY_SRC" "$PTY_DST_DIR/pty.node"
		say "node-pty 预编译已安装"
	fi
fi

# ── 工具二进制 ──────────────────────────────────────────────────────
step "安装工具二进制（rg / fd）"
if [ "$LOCAL_DEV" = "true" ]; then
	say "local 模式：跳过 rg/fd（本机自测包）"
elif [ "$SKIP_TOOLS" -eq 1 ]; then
	warn "--skip-tools：未安装 rg/fd（pi 的 grep/find 在离线模式下不可用）"
else
	mkdir -p "$AGENT_DIR/bin"
	for tool in rg fd; do
		SRC="$PAYLOAD/tools/$BUNDLE_ARCH/$tool"
		[ -f "$SRC" ] || die "包里缺少工具二进制：${tool}（打包时 --skip-tools？）"
		cp "$SRC" "$AGENT_DIR/bin/$tool"
		chmod 755 "$AGENT_DIR/bin/$tool"
	done
	say "rg / fd → $AGENT_DIR/bin/"
fi

# ── 模型与凭据：只在缺失时写占位（升级绝不读不写） ──────────────────
step "模型与凭据"
if [ -f "$AGENT_DIR/models.json" ]; then
	say "models.json 已存在 → 完全保留"
else
	cat >"$AGENT_DIR/models.json" <<'MODELS'
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
MODELS
	say "已写入 models.json 占位模板（编辑它或在 pi 里 /model 选择模型）"
fi
if [ ! -f "$AGENT_DIR/auth.json" ]; then
	printf '{}\n' >"$AGENT_DIR/auth.json"
	say "已写入空的 auth.json（离线机请用 /login 或环境变量提供凭据）"
else
	say "auth.json 已存在 → 完全保留"
fi

# ── PATH（带标记块，幂等） ──────────────────────────────────────────
step "PATH 配置"
BASHRC="$HOME/.bashrc"
touch "$BASHRC"
node -e '
const fs=require("fs");
const file=process.argv[1], binDir=process.argv[2];
const START="# >>> pi-offline >>>";
const END="# <<< pi-offline <<<";
const block=[START,`# 由 pi 离线安装器维护；重装会替换本块，手动改动请放在块外`,`case ":$PATH:" in *":${binDir}:"*) ;; *) PATH="${binDir}:$PATH" ;; esac`,`export PATH`,END].join("\n");
let text="";
try{text=fs.readFileSync(file,"utf8")}catch{}
const re=/^# >>> pi-offline >>>[\s\S]*?^# <<< pi-offline <<<$/m;
if(re.test(text)) text=text.replace(re,block);
else text=(text.endsWith("\n")||text===""?text:text+"\n")+block+"\n";
fs.writeFileSync(file,text);
process.stdout.write(re.test(text)?"updated":"appended");
' "$BASHRC" "$BIN_DIR" >"$STAGE/.bashrc-state" || warn "写入 ~/.bashrc 失败（请手动把 $BIN_DIR 加进 PATH）"
say "$BIN_DIR 已写入 ~/.bashrc 标记块（$(cat "$STAGE/.bashrc-state" 2>/dev/null || echo skip)）"

# ── 加载探针 + 降级隔离 ─────────────────────────────────────────────
step "加载探针"
DISABLED_JSON="[]"
PROBE_OK="skipped"
if [ "$NO_PROBE" -eq 1 ]; then
	warn "--no-probe：跳过探针（无法验证插件可加载性）"
else
	cp "$PAYLOAD/probe.mjs" "$PREFIX/probe.mjs"
	# 上一次安装的报告必须先删掉：探针若异常退出，下面会把旧报告当成本次结论，
	# 甚至按旧失败清单再把扩展搬进 extensions-disabled/。
	rm -f "$AGENT_DIR/load-report.json"
	PROBE_EXTRA=""
	if [ "$LOCAL_DEV" = "true" ] || [ "$SKIP_TOOLS" -eq 1 ]; then PROBE_EXTRA="--skip-tools"; fi
	PROBE_RC=0
	node "$PREFIX/probe.mjs" --agent-dir "$AGENT_DIR" --runtime "$RUNTIME_DIR" --report "$AGENT_DIR/load-report.json" $PROBE_EXTRA >"$STAGE/probe.json" 2>"$STAGE/probe.err" || PROBE_RC=$?
	if [ "$PROBE_RC" -eq 2 ]; then
		# 退出码 2 = 探针判定"pi 运行时自身不可用"（别名/jiti 解析不到）。此时每个扩展都会
		# 失败，走隔离流程等于把整个安全栈静默下掉 —— 必须在这里中止。
		die "加载探针判定 pi 运行时不可用（bundle 与运行时布局不匹配，不是某个扩展坏了）：
$(cat "$STAGE/probe.err" 2>/dev/null || true)

隔离扩展解决不了这个问题：请用与 bundle 匹配的 pi 版本重新打包。

注意：本次已替换运行时/共享依赖/扩展代码，旧配置已进 .config-backup-*（可 --restore-config 回填），
但尚未写入 installed-bundle.json
（下次安装会按「旧版 restore 布局 / 手工安装」推断，且跳过一轮 managed 剪枝）。
重新打包并安装成功后即恢复正常。"
	elif [ "$PROBE_RC" -eq 0 ]; then
		PROBE_OK="ran"
	else
		PROBE_OK="probe-error"
		warn "探针运行异常（见 $STAGE/probe.err），继续安装"
	fi
	if [ "$PROBE_OK" = "ran" ] && [ -f "$AGENT_DIR/load-report.json" ]; then
		DISABLED_JSON="$(node -e '
const fs=require("fs");
const reportPath=process.argv[1], extDir=process.argv[2], disabledDir=process.argv[3], ts=process.argv[4];
const report=JSON.parse(fs.readFileSync(reportPath,"utf8"));
const disabled=[];
for (const f of report.extensionFailures||[]) {
  const name=f.name;
  const srcDir=extDir+"/"+name, srcFileTs=extDir+"/"+name+".ts", srcFileJs=extDir+"/"+name+".js", srcFileMjs=extDir+"/"+name+".mjs";
  let moved=false;
  try{
    if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) { fs.mkdirSync(disabledDir,{recursive:true}); const dst=disabledDir+"/"+name; fs.rmSync(dst,{recursive:true,force:true}); fs.renameSync(srcDir,dst); moved=true; }
    else if (fs.existsSync(srcFileTs)) { fs.mkdirSync(disabledDir,{recursive:true}); const dst=disabledDir+"/"+name+".ts"; fs.rmSync(dst,{force:true}); fs.renameSync(srcFileTs,dst); moved=true; }
    else if (fs.existsSync(srcFileJs)) { fs.mkdirSync(disabledDir,{recursive:true}); const dst=disabledDir+"/"+name+".js"; fs.rmSync(dst,{force:true}); fs.renameSync(srcFileJs,dst); moved=true; }
    else if (fs.existsSync(srcFileMjs)) { fs.mkdirSync(disabledDir,{recursive:true}); const dst=disabledDir+"/"+name+".mjs"; fs.rmSync(dst,{force:true}); fs.renameSync(srcFileMjs,dst); moved=true; }
  }catch(err){ f.moveError=String(err.message||err); }
  if (moved) disabled.push({name, reason: f.error||"加载失败", at: ts});
}
report.disabled=disabled;
report.disabledDir=disabledDir;
report.restoreHint="恢复某个被隔离的扩展：把 extensions-disabled/<name> 移回 extensions/<name>，修好原因后重跑安装器";
fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");
process.stdout.write(JSON.stringify(disabled));
' "$AGENT_DIR/load-report.json" "$EXT_DIR" "$DISABLED_DIR" "$TS")" || DISABLED_JSON="[]"
	fi
fi

# ── 包身份清单 ──────────────────────────────────────────────────────
step "记录安装身份"
node -e '
const fs=require("fs");
const [manifestPath,outPath,installedAt,prefix,agentDir,binDir,backupDir,bundleSha,prevBundle,migratedFrom,legacyRuntime]=process.argv.slice(1);
const m=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
const rec={
  bundleVersion:m.bundleVersion,
  piVersion:m.piVersion,
  repoCommit:m.repoCommit,
  // null = 未知（源机 git 不可用），不要折成 false——那是"干净工作区"的事实断言
  repoDirty: m.repoDirty === true || m.repoDirty === false ? m.repoDirty : null,
  arch:m.arch,
  localDev:!!m.localDev,
  createdAt:m.createdAt,
  sha256:bundleSha||null,
  installedAt,
  prefix, agentDir, binDir,
  backupDir: backupDir||null,
  replacedBundle: prevBundle||null,
  migratedFrom: migratedFrom||null,
  legacyRuntime: legacyRuntime||null,
  managedExtensions:(m.extensions||[]).map(e=>e.name),
  managedSkills:(m.skills||[]).map(s=>s.name),
  managedThemes:(m.themes||[]).map(t=>t.name),
  rollback:"拿上一版 bundle 重跑 install.sh（本文件记录了版本与 sha256，便于追溯）",
};
fs.writeFileSync(outPath,JSON.stringify(rec,null,2)+"\n");
' "$PAYLOAD/manifest.json" "$AGENT_DIR/installed-bundle.json" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	"$PREFIX" "$AGENT_DIR" "$BIN_DIR" "$BACKUP_DIR" "$BUNDLE_SHA" "$PREV_BUNDLE" \
	"$(if [ -z "$PREV_BUNDLE" ] && [ "$EXISTING_CONFIG" -eq 1 ]; then echo legacy/manual; fi)" \
	"$(if [ "$LEGACY_PRESENT" -eq 1 ]; then echo "$LEGACY_RUNTIME"; fi)" || die "写 installed-bundle.json 失败"
say "已记录 $AGENT_DIR/installed-bundle.json"

# ── 验收自检 ────────────────────────────────────────────────────────
step "验收自检"
PI_CLI_VERSION=""
if PI_CLI_VERSION="$("$BIN_DIR/pi" --version 2>&1)"; then
	say "pi --version : $PI_CLI_VERSION"
else
	die "启动器无法运行：$BIN_DIR/pi --version 失败
  输出：$PI_CLI_VERSION
  排查：$PREFIX/runtime 是否完整、node 是否仍可用"
fi
case "$PI_CLI_VERSION" in
*"$PI_VERSION"*) say "版本匹配期望（${PI_VERSION}）" ;;
*) warn "pi --version 输出与期望版本 $PI_VERSION 不同（可继续，但请核对）" ;;
esac

if [ "$PROBE_OK" = "ran" ]; then
	node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
console.log(`扩展 ${r.extensionCount} 个，加载失败 ${(r.extensionFailures||[]).length} 个；原生包失败 ${(r.nativeFailures||[]).length} 个；工具失败 ${(r.toolFailures||[]).length} 个`);
for(const f of r.extensionFailures||[]) console.log(`  [扩展] ${f.name}: ${String(f.error).slice(0,160)}`);
for(const f of r.nativeFailures||[]) console.log(`  [原生] ${f.name}: ${String(f.error).slice(0,160)}`);
for(const f of r.toolFailures||[]) console.log(`  [工具] ${f.name}: ${String(f.error).slice(0,160)}`);
' "$AGENT_DIR/load-report.json"
	if node -e '
const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
process.exit((r.nativeFailures||[]).length>0?0:1);' "$AGENT_DIR/load-report.json"; then
		warn "原生包失败不会被自动隔离：依赖它们的插件需人工核对（上面 [原生] 行）"
	fi
else
	warn "探针未完成（${PROBE_OK}）→ 本次安装没有可加载性证据，load-report.json 不反映本次结果"
fi

INSTALL_OK=1

# ── 旧版 restore 运行时：可选清理（不默认删，老机器上可能还有别的脚本在用它） ──
if [ "$LEGACY_PRESENT" -eq 1 ]; then
	if [ "$REMOVE_LEGACY_RUNTIME" -eq 1 ]; then
		# 旧安装可能在 $BIN_DIR 留下指向它的软链（node/npm 就是从包里解出来的）：
		# 目录一删就成悬空链接，之后 PATH 里的 node 会变成"能找到但执行失败"。
		for link in "$BIN_DIR"/*; do
			[ -L "$link" ] || continue
			case "$(readlink "$link")" in
			*"$LEGACY_RUNTIME"*)
				rm -f "$link"
				say "移除指向旧运行时的软链：$link"
				;;
			esac
		done
		rm -rf "${LEGACY_RUNTIME:?}"
		say "已删除旧运行时：$LEGACY_RUNTIME"
	else
		warn "旧运行时目录仍在：${LEGACY_RUNTIME}（约占 $(du -sh "$LEGACY_RUNTIME" 2>/dev/null | cut -f1)）"
		warn "  清理：重跑时加 --remove-legacy-runtime（会同时摘掉 $BIN_DIR 下指向它的软链）"
	fi
fi

step "完成"
printf '  bundle      : %s (pi %s, %s)\n' "$BUNDLE_VERSION" "$PI_VERSION" "$BUNDLE_ARCH"
printf '  运行时      : %s\n' "$RUNTIME_DIR"
printf '  agent       : %s\n' "$AGENT_DIR"
printf '  启动器      : %s/pi\n' "$BIN_DIR"
printf '  扩展        : %s 个（剪枝 %s 个）\n' "$INSTALLED" "$PRUNED"
printf '  技能/主题   : %s / %s 个（剪枝 %s / %s 个）\n' "$SKILLS_INSTALLED" "$THEMES_INSTALLED" "$PRUNED_SKILLS" "$PRUNED_THEMES"
printf '  隔离的扩展  : %s 个\n' "$(printf '%s' "$DISABLED_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')||'[]').length" 2>/dev/null || echo 0)"
[ -n "$BACKUP_DIR" ] && printf '  配置备份    : %s\n' "$BACKUP_DIR"
printf '  安装日志    : %s\n' "$LOG"
printf '  加载报告    : %s/load-report.json\n' "$AGENT_DIR"
printf '\n'
if [ -n "$BACKUP_DIR" ]; then
	printf '注意：本次是替换安装（升级/迁移），你的旧配置已备份到上面的目录；\n'
	printf '      如需回填：bash install.sh --restore-config %s\n' "$TS"
	printf '\n'
fi
if [ "$UNKNOWN_COUNT" -gt 0 ] && [ "$PRUNE_UNKNOWN_EXTS" -eq 0 ]; then
	printf '提示：有 %s 个扩展不属本包提供，仍保留在 %s/extensions/ 里；\n' "$UNKNOWN_COUNT" "$AGENT_DIR"
	printf '      若它们来自旧版本且与新 pi 不兼容，加 --prune-unknown-extensions 重跑可移入 extensions-disabled/。\n\n'
fi
printf '下一步：\n'
printf '  1) 新终端或 source ~/.bashrc（让 %s 进 PATH）\n' "$BIN_DIR"
printf '  2) pi --version 确认版本\n'
printf '  3) 配置模型：编辑 %s/models.json，或用 pi 里的 /model 选择\n' "$AGENT_DIR"
printf '  4) 若有被隔离的扩展：读 %s/load-report.json 的 disabled 段\n' "$AGENT_DIR"
printf '\n'
