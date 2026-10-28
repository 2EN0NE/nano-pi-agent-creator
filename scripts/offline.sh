#!/usr/bin/env bash
#
# 离线包打包器（源机执行；需要联网）
#
#   bash scripts/offline.sh pack [--arch x64|arm64|local] [-o DIR]
#
# 产物目录（默认 tmp/offline/）：
#   pi-offline-<bundleVersion>-<arch>.tar.gz
#   pi-offline-<bundleVersion>-<arch>.tar.gz.sha256
#   install.sh            ← 随包分发的独立安装器（拷到目标机）
#   README-安装说明.txt
#
# 决策与语义见 docs/adr/0069-offline-bundle-source-install-and-degradation.md
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/scripts/offline"
DEFAULT_OUT="$REPO_ROOT/tmp/offline"

# 老 Linux 上的 bash 可能是 3.2/4.2；打包机是 macOS（bash 3.2），这里统一不用 bash 4 特性。
say() { printf '[offline/pack] %s\n' "$*"; }
warn() { printf '[offline/pack] WARN  %s\n' "$*" >&2; }
die() {
	printf '[offline/pack] ERROR %s\n' "$*" >&2
	exit 1
}
# 取值型参数缺值时：`set -u` + 越界 `shift` 会让脚本 rc=1 且一个字节都不打印，
# 使用方只会看到"脚本坏了"。缺值必须显式报错。
need_value() {
	[ $# -ge 2 ] || die "$1 需要一个值（见 --help）"
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

usage() {
	# 只取文件头的注释块（第 15 行是 `set -euo pipefail`，不能进帮助）
	sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	cat <<'EOF'

额外选项：
  --with-node            额外下载 node 运行时进包（目标机没有 node 时用 --use-bundled-node 安装）
  --node-version VER     指定要下载的 node 版本（默认取当前 node 的 major 线的最新 LTS 版本号）
  --skip-tools           跳过 rg/fd 下载（仅调试用；下载失败默认是致命错误）
  --skip-verify          跳过下载内容的 sha256 校验（仅调试用，会失去来源可信性）
  --skip-native          跳过原生包下载（仅调试用）
  --keep-work            保留中间目录（调试用）
  -h, --help             显示本帮助
EOF
}

# ── 参数 ────────────────────────────────────────────────────────────
CMD="${1:-}"
[ "$CMD" = "pack" ] || {
	usage
	exit 1
}
shift || true

ARCH="x64"
OUT_DIR="$DEFAULT_OUT"
WITH_NODE=0
NODE_VERSION=""
SKIP_TOOLS=0
SKIP_NATIVE=0
SKIP_VERIFY=0
KEEP_WORK=0

while [ $# -gt 0 ]; do
	case "$1" in
	--arch)
		need_value "$@"
		ARCH="$2"
		shift 2
		;;
	-o | --out)
		need_value "$@"
		OUT_DIR="$2"
		shift 2
		;;
	--with-node)
		WITH_NODE=1
		shift
		;;
	--node-version)
		need_value "$@"
		NODE_VERSION="$2"
		shift 2
		;;
	--skip-tools)
		SKIP_TOOLS=1
		shift
		;;
	--skip-native)
		SKIP_NATIVE=1
		shift
		;;
	--skip-verify)
		SKIP_VERIFY=1
		shift
		;;
	--keep-work)
		KEEP_WORK=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "未知参数：$1（用 --help 查看用法）" ;;
	esac
done

case "$ARCH" in
x64 | arm64 | local) ;;
*) die "--arch 只能是 x64 / arm64 / local（收到：${ARCH}）" ;;
esac

# ── 0. 源机预检 ─────────────────────────────────────────────────────
need_cmd node
need_cmd npm
need_cmd tar
need_cmd git
if [ "$ARCH" != "local" ]; then
	need_cmd curl
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "源机 node 需要 >= 22（当前 $(node -v)）"

# ── 1. pi 运行时（钉仓库 devDependency 版本） ───────────────────────
PI_VERSION="$(node -p "String(require('$REPO_ROOT/package.json').devDependencies['@earendil-works/pi-coding-agent']||'').replace(/^[\\^~=v\\s]+/,'')")"
[ -n "$PI_VERSION" ] || die "package.json 里没有 @earendil-works/pi-coding-agent devDependency"
PI_RUNTIME_DIR="${PI_RUNTIME_DIR:-$HOME/.pi/agent/install/releases/$PI_VERSION}"
if [ ! -f "$PI_RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" ]; then
	die "找不到 pi 运行时 ${PI_VERSION}：
  $PI_RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js

修复：让源机的 pi 版本与仓库 devDependency 对齐，例如
  pi update            # 或重新执行官方安装脚本
  # 或显式指定运行时目录： PI_RUNTIME_DIR=/path/to/releases/$PI_VERSION bash scripts/offline.sh pack"
fi
ACTUAL_PI_VERSION="$(node -p "require('$PI_RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/package.json').version")"
[ "$ACTUAL_PI_VERSION" = "$PI_VERSION" ] || die "运行时版本 $ACTUAL_PI_VERSION 与仓库期望 $PI_VERSION 不一致（先对齐再打包）"
# 运行时自检（源机能发现的问题留在源机）：probe.mjs 的 jiti 别名映射硬编码了 pi 的
# dist 布局；布局一变，目标机上扩展会**全部**加载失败并被隔离（安装仍打印成功）。
say "校验运行时布局（探针别名映射）..."
node "$SCRIPT_DIR/probe.mjs" --preflight --runtime "$PI_RUNTIME_DIR" ||
	die "运行时预检失败：pi $PI_VERSION 的 dist 布局与 scripts/offline/probe.mjs 的 jiti 别名映射不匹配。
  修好探针映射后再打包（否则目标机上扩展会被整批隔离）。"

REPO_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
REPO_SHORT="$(printf '%s' "$REPO_COMMIT" | cut -c1-8)"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)" ]; then
	DIRTY="dirty"
	warn "工作区有未提交改动，bundle 标记为 dirty（便于追溯）"
else
	DIRTY="clean"
fi
DATE_TAG="$(date +%Y%m%d)"
BUNDLE_VERSION="pi$PI_VERSION-$REPO_SHORT-$DATE_TAG"
[ "$DIRTY" = "dirty" ] && BUNDLE_VERSION="$BUNDLE_VERSION-dirty"

mkdir -p "$OUT_DIR"
WORK="$OUT_DIR/.work-$BUNDLE_VERSION-$ARCH"
PAYLOAD="$WORK/payload"
rm -rf "$WORK"
mkdir -p "$PAYLOAD"

cleanup() {
	if [ "$KEEP_WORK" -eq 0 ]; then rm -rf "$WORK"; else say "中间目录保留：$WORK"; fi
}
trap cleanup EXIT

# ── 2. 复制工具函数 ─────────────────────────────────────────────────
copy_tree() {
	# copy_tree <src> <dst> [exclude...]
	local src="$1" dst="$2"
	shift 2
	mkdir -p "$dst"
	if command -v rsync >/dev/null 2>&1; then
		local args=()
		local e
		for e in "$@"; do args+=("--exclude=$e"); done
		# bash 3.2 + set -u：空数组不能直接用 "${args[@]}"，否则 unbound variable
		if [ ${#args[@]} -eq 0 ]; then
			rsync -a "$src/" "$dst/"
		else
			rsync -a "${args[@]}" "$src/" "$dst/"
		fi
	else
		# 没有 rsync 时不能退回到 `cp -R`：那会把 excludes 全部丢掉，
		# 把 node_modules/.cache、*.log 甚至指向源机路径的 @zenone 软链打进包。
		# 这里用 tar 管道（macOS bsdtar / GNU tar 都支持 --exclude），语义与 rsync 一致。
		local targs=(-cf -)
		local e
		for e in "$@"; do targs+=("--exclude=$e"); done
		(cd "$src" && tar "${targs[@]}" .) | (cd "$dst" && tar -xf -)
	fi
}

size_of() {
	du -sh "$1" 2>/dev/null | cut -f1 | tr -d ' '
}

# GitHub release 资产在部分网络下直连会超时；按候选链回退下载（镜像在前，直连兜底）。
fetch_first() {
	# fetch_first <dest> <url...>
	local dest="$1"
	shift
	local cand
	for cand in "$@"; do
		if curl -fsSL --max-time 900 "$cand" -o "$dest" 2>/dev/null && [ -s "$dest" ]; then
			return 0
		fi
	done
	return 1
}

fetch_text_first() {
	# fetch_text_first <url...> → stdout（用于取上游 checksum 清单）
	local cand
	for cand in "$@"; do
		if curl -fsSL --max-time 120 "$cand" 2>/dev/null; then return 0; fi
	done
	return 1
}

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# 校验下载内容的 sha256（fail-fast）。
# 必要性：二进制优先从第三方镜像（ghproxy/ghfast）取——镜像只保证"下载得到"，
# 不保证"和上游发布的一致"。离线机没有任何再校验的机会，所以来源必须在这里钉住。
verify_download() {
	# verify_download <file> <expected-hex|空> <label>
	local file="$1" expect="$2" label="$3" actual
	if [ "$SKIP_VERIFY" -eq 1 ]; then
		warn "  --skip-verify：跳过 $label 的 sha256 校验"
		return 0
	fi
	if [ -z "$expect" ]; then
		warn "  $label 上游未发布 sha256（无法校验来源，仅记录实测值）"
		return 0
	fi
	actual="$(sha256_of "$file")"
	[ "$actual" = "$expect" ] || die "$label sha256 不匹配：
  期望：$expect
  实际：$actual
  说明：镜像/直连返回的内容与上游发布的不一致，或传输损坏。"
	say "  $label sha256 校验通过"
}

# ripgrep 的 release 资产自带 <asset>.sha256
rg_expected_sha() {
	# rg_expected_sha <sha256-url...> → stdout 期望值（取不到则为空）
	local text
	text="$(fetch_text_first "$@" || true)"
	[ -n "$text" ] || return 0
	printf '%s' "$text" | awk '{print $1; exit}'
}

# node 的 dist 目录有 SHASUMS256.txt：`<hex>  <filename>`
node_expected_sha() {
	# node_expected_sha <shasums-url...> <filename>
	local file="${!#}" text
	local urls=("$@")
	unset "urls[$((${#urls[@]} - 1))]"
	text="$(fetch_text_first "${urls[@]}" || true)"
	[ -n "$text" ] || return 0
	printf '%s' "$text" | awk -v f="$file" '{n=$2; sub(/^\*/,"",n); if (n==f) {print $1; exit}}'
}

# ── 3. 运行时 ───────────────────────────────────────────────────────
say "复制 pi 运行时 $PI_VERSION ..."
copy_tree "$PI_RUNTIME_DIR" "$PAYLOAD/runtime" \
	"node_modules/.cache" "*.log" "node_modules/.package-lock.json"

# ── 4. 仓库源码（安装源） ───────────────────────────────────────────
say "复制仓库源码（extensions / skills / themes / prompts）..."
mkdir -p "$PAYLOAD/source"
copy_tree "$REPO_ROOT/extensions" "$PAYLOAD/source/extensions" \
	"node_modules" "*.tsbuildinfo" "test" "*.log"
if [ -d "$REPO_ROOT/skills" ]; then
	copy_tree "$REPO_ROOT/skills" "$PAYLOAD/source/skills" "node_modules" "*.log"
fi
if [ -d "$REPO_ROOT/themes" ]; then
	copy_tree "$REPO_ROOT/themes" "$PAYLOAD/source/themes"
fi
mkdir -p "$PAYLOAD/source/prompts"
# 共享模块：扩展用相对路径 import 仓库根的 src/tui/*.js，安装后需落在 dirname(agentDir)/src/tui
if [ -d "$REPO_ROOT/src/tui" ]; then
	mkdir -p "$PAYLOAD/source/src"
	copy_tree "$REPO_ROOT/src/tui" "$PAYLOAD/source/src/tui"
fi

# ── 5. 依赖快照 + 配置 ──────────────────────────────────────────────
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
[ -d "$AGENT_DIR" ] || die "找不到 agent 目录：$AGENT_DIR"
say "复制依赖快照（node_modules / npm / git）..."
mkdir -p "$PAYLOAD/deps"
if [ -d "$AGENT_DIR/node_modules" ]; then
	copy_tree "$AGENT_DIR/node_modules" "$PAYLOAD/deps/node_modules" \
		"@zenone" ".cache" "*.log"
fi
if [ -d "$AGENT_DIR/npm" ]; then
	copy_tree "$AGENT_DIR/npm" "$PAYLOAD/deps/npm" \
		"node_modules/.cache" ".cache" "*.log"
fi
if [ -d "$AGENT_DIR/git" ]; then
	copy_tree "$AGENT_DIR/git" "$PAYLOAD/deps/git" ".cache" "*.log"
fi

say "复制配置（settings.json / extensions-data / 内嵌技能）..."
mkdir -p "$PAYLOAD/config"
for f in settings.json; do
	[ -f "$AGENT_DIR/$f" ] && cp "$AGENT_DIR/$f" "$PAYLOAD/config/$f"
done
for d in extensions-data skills themes prompts; do
	if [ -d "$AGENT_DIR/$d" ]; then
		copy_tree "$AGENT_DIR/$d" "$PAYLOAD/config/$d" ".cache" "*.log"
	fi
done
[ -f "$AGENT_DIR/models.json" ] || warn "源机没有 models.json（目标机会写入占位模板）"

# ── 6. 清单（profile 是唯一事实来源） ───────────────────────────────
say "构建 manifest 骨架（解析 sync-profiles.yaml）..."
MANIFEST_RAW="$WORK/manifest-collect.json"
node "$SCRIPT_DIR/collect.mjs" --arch "$ARCH" --agent-dir "$AGENT_DIR" --out "$MANIFEST_RAW" \
	>/dev/null || die "collect.mjs 失败（见上方错误）"

# npm 包形态扩展（pi.extensions → dist）在 bundle 里补一个桥接入口：
# pi 的加载器在 dist 缺失时回退到同目录 index.ts，因此离线机不需要构建 dist。
node -e '
const fs=require("fs"),path=require("path");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const srcRoot=process.argv[2];
let bridged=0, ok=0, broken=[];
for (const e of m.extensions||[]) {
  if (e.kind!=="dir") continue;
  if (e.library) continue; // 纯库包（如 @zenone/pi-state）：pi 不加载它，只被其它扩展 import
  const dir=path.join(srcRoot,e.source);
  const declaredEntry=e.entry?path.join(dir,e.entry):null;
  if (declaredEntry && fs.existsSync(declaredEntry)) { ok++; continue; }
  const srcIndex=path.join(dir,"src","index.ts");
  if (fs.existsSync(srcIndex)) {
    fs.writeFileSync(path.join(dir,"index.ts"),"// Auto-generated by offline packer - do not edit\nexport { default } from \"./src/index.ts\";\n");
    bridged++;
  } else {
    broken.push(e.name);
  }
}
if (broken.length) {
  console.error(`[offline/pack] 以下扩展既无可用入口也无 src/index.ts，无法离线加载：${broken.join(", ")}`);
  process.exit(2);
}
process.stdout.write(`${bridged} 个桥接, ${ok} 个自带入口`);
' "$MANIFEST_RAW" "$PAYLOAD/source" >"$WORK/bridges" || die "扩展入口检查失败（见上方列表）"
say "扩展入口：$(cat "$WORK/bridges")"

# ── 7. 工具二进制（rg / fd，Linux 静态 musl） ────────────────────────
TOOLS_JSON="$WORK/tools.json"
printf '{}\n' >"$TOOLS_JSON"
if [ "$ARCH" = "local" ]; then
	say "local 模式：跳过 rg/fd 与原生包（本机自测用包）"
else
	[ "$SKIP_TOOLS" -eq 1 ] && warn "--skip-tools：不下载 rg/fd（目标机 grep/find 将不可用）"
	if [ "$SKIP_TOOLS" -eq 0 ]; then
		case "$ARCH" in
		x64) RUST_TARGET="x86_64-unknown-linux-musl" ;;
		arm64) RUST_TARGET="aarch64-unknown-linux-musl" ;;
		esac
		mkdir -p "$PAYLOAD/tools/$ARCH"
		say "下载 rg / fd（${RUST_TARGET}）..."

		RG_TAG="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/BurntSushi/ripgrep/releases/latest 2>/dev/null | sed 's#.*/tag/##' || true)"
		[ -n "$RG_TAG" ] || RG_TAG="14.1.1"
		FD_TAG="$(curl -fsSI -o /dev/null -w '%{redirect_url}' https://github.com/sharkdp/fd/releases/latest 2>/dev/null | sed 's#.*/tag/##' || true)"
		[ -n "$FD_TAG" ] || FD_TAG="v10.2.0"

		RG_TMP="$WORK/rg.tgz"
		FD_TMP="$WORK/fd.tgz"
		RG_URL="https://github.com/BurntSushi/ripgrep/releases/download/$RG_TAG/ripgrep-$RG_TAG-$RUST_TARGET.tar.gz"
		FD_URL="https://github.com/sharkdp/fd/releases/download/$FD_TAG/fd-$FD_TAG-$RUST_TARGET.tar.gz"
		fetch_first "$RG_TMP" "https://ghproxy.net/$RG_URL" "https://ghfast.top/$RG_URL" "$RG_URL" ||
			die "ripgrep 下载失败（$RG_TAG/${RUST_TARGET}），镜像与直连都不可用"
		fetch_first "$FD_TMP" "https://ghproxy.net/$FD_URL" "https://ghfast.top/$FD_URL" "$FD_URL" ||
			die "fd 下载失败（$FD_TAG/${RUST_TARGET}），镜像与直连都不可用"
		# 来源校验：ripgrep 发布 <asset>.sha256；fd 上游没有 per-asset sha256（实测 10.5.0 无），
		# 只能记录实测值 + 查 ELF 头。镜像链下"下载成功"不等于"内容可信"。
		RG_SHA="$(rg_expected_sha "https://ghproxy.net/$RG_URL.sha256" "https://ghfast.top/$RG_URL.sha256" "$RG_URL.sha256" || true)"
		verify_download "$RG_TMP" "$RG_SHA" "ripgrep $RG_TAG"
		verify_download "$FD_TMP" "" "fd $FD_TAG"
		mkdir -p "$WORK/rg" "$WORK/fd"
		tar -xzf "$RG_TMP" -C "$WORK/rg" --strip-components=1
		tar -xzf "$FD_TMP" -C "$WORK/fd" --strip-components=1
		for pair in "rg:$WORK/rg/rg" "fd:$WORK/fd/fd"; do
			name="${pair%%:*}"
			path="${pair#*:}"
			[ -f "$path" ] || die "$name 解包后找不到可执行文件"
			# 校验 ELF 头，避免把 macOS 二进制或 HTML 错误页打进包
			head -c 4 "$path" | od -An -tx1 | tr -d ' \n' | grep -q '^7f454c46$' ||
				die "$name 不是 ELF 可执行文件（下载内容异常）"
			cp "$path" "$PAYLOAD/tools/$ARCH/$name"
			chmod 755 "$PAYLOAD/tools/$ARCH/$name"
		done
		# 把实测 sha256 记进 manifest：上游没给校验和的项至少能事后追溯
		printf '{"rg":{"version":"%s","binarySha256":"%s","tarballSha256":"%s"},"fd":{"version":"%s","binarySha256":"%s","tarballSha256":"%s","upstreamSha256":"none"}}\n' \
			"$RG_TAG" "$(sha256_of "$PAYLOAD/tools/$ARCH/rg")" "$(sha256_of "$RG_TMP")" \
			"$FD_TAG" "$(sha256_of "$PAYLOAD/tools/$ARCH/fd")" "$(sha256_of "$FD_TMP")" >"$TOOLS_JSON"
		say "rg $RG_TAG / fd $FD_TAG 就绪"
	fi

	# ── 8. 原生包换血：按已装 darwin 版本下载 linux 变体 ──
	if [ "$SKIP_NATIVE" -eq 0 ]; then
		mkdir -p "$PAYLOAD/tools/$ARCH/native"
		node -e '
const fs=require("fs"),path=require("path"),{execFileSync}=require("child_process");
const manifest=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const dest=process.argv[2];
const out=[];
for (const p of manifest.nativePackages||[]) {
  if (p.strategy!=="npm-pack"||!p.linuxName) { out.push({...p,status:p.strategy==="remove-only"?"remove-only":"expected-degraded"}); continue; }
  const spec=`${p.linuxName}@${p.version}`;
  try {
    const stdout=execFileSync("npm",["pack",spec,"--pack-destination",dest],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
    const tarball=String(stdout).trim().split("\n").filter(Boolean).pop()||"";
    out.push({...p,spec,tarball,status:"ok"});
  } catch (err) {
    out.push({...p,spec,status:"failed",error:String(err.stderr||err.message).trim().split("\n")[0]});
  }
}
fs.writeFileSync(process.argv[3],JSON.stringify(out,null,2)+"\n");
' "$MANIFEST_RAW" "$PAYLOAD/tools/$ARCH/native" "$WORK/native.json" || die "原生包下载失败"

		node -e '
const n=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const bad=n.filter(x=>x.status!=="ok");
if(bad.length){console.error("[offline/pack] WARN 以下原生包未能取得 linux 变体（安装后由探针隔离对应插件）：");for(const b of bad)console.error(`  - ${b.name} (${b.version}) → ${b.linuxName||"无映射"}: ${b.error||b.status}`)}
const ok=n.filter(x=>x.status==="ok");console.error(`[offline/pack] 原生包换血：${ok.length} 个已就绪，${bad.length} 个降级`);
' "$WORK/native.json"

		say "测量原生包/工具的 glibc 下限（决定老机器上哪些功能会降级）..."
		if node "$SCRIPT_DIR/native-audit.mjs" "$WORK/native.json" "$PAYLOAD/tools/$ARCH/native" "$TOOLS_JSON" >"$WORK/glibc.txt" 2>&1; then
			while IFS= read -r line; do say "  $line"; done <"$WORK/glibc.txt"
		else
			warn "glibc 下限测量失败（不影响打包，安装时由探针兜底）"
		fi

		# node-pty 没有 linux 预编译；仅在本地已有 Linux node 镜像时尝试交叉编译
		if [ -d "$AGENT_DIR/npm/node_modules/node-pty" ]; then
			if command -v docker >/dev/null 2>&1 && docker image inspect node:22-bookworm-slim >/dev/null 2>&1; then
				say "尝试在容器内编译 node-pty（N-API，跨 Node 版本可用）..."
				mkdir -p "$WORK/node-pty"
				copy_tree "$AGENT_DIR/npm/node_modules/node-pty" "$WORK/node-pty"
				mkdir -p "$WORK/node-pty/node_modules"
				[ -d "$AGENT_DIR/npm/node_modules/node-addon-api" ] && copy_tree "$AGENT_DIR/npm/node_modules/node-addon-api" "$WORK/node-pty/node_modules/node-addon-api"
				if docker run --rm -v "$WORK/node-pty:/src" -w /src node:22-bookworm-slim \
					bash -lc 'npm config set nodedir /usr/local >/dev/null 2>&1; npx --yes node-gyp@10 rebuild >/tmp/build.log 2>&1 || { tail -20 /tmp/build.log; exit 1; }; ls build/Release/pty.node' \
					>/dev/null 2>&1; then
					mkdir -p "$PAYLOAD/tools/$ARCH/compiled/node-pty/prebuilds/linux-$ARCH"
					cp "$WORK/node-pty/build/Release/pty.node" "$PAYLOAD/tools/$ARCH/compiled/node-pty/prebuilds/linux-$ARCH/pty.node"
					printf '{"name":"node-pty","status":"compiled","arch":"%s"}\n' "$ARCH" >"$WORK/node-pty.json"
					say "node-pty 编译成功"
				else
					warn "node-pty 编译失败，标记为预期降级（依赖它的插件会被探针隔离）"
					printf '{"name":"node-pty","status":"expected-degraded"}\n' >"$WORK/node-pty.json"
				fi
			else
				warn "本机没有 node:22-bookworm-slim 镜像，跳过 node-pty 编译（标记为预期降级）"
				printf '{"name":"node-pty","status":"expected-degraded","reason":"no local node image"}\n' >"$WORK/node-pty.json"
			fi
		fi
	fi

	# ── 9. 可选：自带 node 运行时 ──
	if [ "$WITH_NODE" -eq 1 ]; then
		if [ -z "$NODE_VERSION" ]; then
			fetch_first "$WORK/node-index.json" \
				"https://npmmirror.com/mirrors/node/index.json" \
				"https://nodejs.org/dist/index.json" || die "下载 node 版本索引失败（镜像与直连都不可用）"
			NODE_VERSION="$(node -e '
let s="";
try{s=require("fs").readFileSync(process.argv[1],"utf8")}catch(e){process.exit(1)}
const rel=JSON.parse(s).filter(r=>r.lts && !r.security);
const major=Number(process.argv[2]);
const pick=rel.find(r=>Number(r.version.replace(/^v/,"").split(".")[0])===major)||rel[0];
process.stdout.write(pick.version);
' "$WORK/node-index.json" "$NODE_MAJOR")" || die "解析 node 版本索引失败"
		fi
		case "$NODE_VERSION" in v*) ;; *) NODE_VERSION="v$NODE_VERSION" ;; esac
		NODE_TARBALL="node-$NODE_VERSION-linux-$ARCH.tar.gz"
		say "下载 node ${NODE_VERSION}（${ARCH}，.tar.gz 以兼容无 xz 的老机器）..."
		mkdir -p "$PAYLOAD/tools/$ARCH"
		fetch_first "$PAYLOAD/tools/$ARCH/$NODE_TARBALL" \
			"https://npmmirror.com/mirrors/node/$NODE_VERSION/$NODE_TARBALL" \
			"https://nodejs.org/dist/$NODE_VERSION/$NODE_TARBALL" ||
			die "node 下载失败：$NODE_TARBALL"
		# 来源校验：node dist 的 SHASUMS256.txt（`<hex>  <filename>`），从同一镜像链取
		NODE_SHA="$(node_expected_sha \
			"https://npmmirror.com/mirrors/node/$NODE_VERSION/SHASUMS256.txt" \
			"https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" \
			"$NODE_TARBALL" || true)"
		verify_download "$PAYLOAD/tools/$ARCH/$NODE_TARBALL" "$NODE_SHA" "node $NODE_VERSION"
		# 记进 manifest，安装器的 --use-bundled-node 依据它定位
		node -e '
const fs=require("fs");
const p=process.argv[1];
let j={};
try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}
j.node={version:process.argv[2],tarball:process.argv[3]};
fs.writeFileSync(p,JSON.stringify(j)+"\n");
' "$TOOLS_JSON" "$NODE_VERSION" "$NODE_TARBALL"
		say "node $NODE_VERSION 已进包（安装时用 --use-bundled-node 启用）"
	fi
fi

# ── 10. 随包脚本 ────────────────────────────────────────────────────
cp "$SCRIPT_DIR/install.sh" "$PAYLOAD/install.sh"
cp "$SCRIPT_DIR/probe.mjs" "$PAYLOAD/probe.mjs"
chmod 755 "$PAYLOAD/install.sh"
mkdir -p "$PAYLOAD/tools"

# ── 11. 合并最终 manifest ───────────────────────────────────────────
say "生成 manifest.json ..."
node -e '
const fs=require("fs");
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return d}};
// collect.mjs 的产物是必需输入：坏 JSON 必须大声失败。若和可选输入共用兜底，
// 会产出一份 extensions: [] / nativePackages: [] 的空包并打印打包成功——离线机没有回滚通道。
const collect=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const tools=read(process.argv[2],{});
const native=read(process.argv[3],[]);
const nodePty=read(process.argv[4],null);
const manifest={
  ...collect,
  bundleVersion: process.argv[5],
  createdAt: new Date().toISOString().replace(/\.\d+Z$/,"Z"),
  sourceHost: `${process.platform}-${process.arch}`,
  node: { minVersion: "22.19.0" },
  tools,
  nativePackages: native,
  nodePty,
  // 注意：配置类/继承类路径的清单只存在于 install.sh（CONFIG_ITEMS 等），不要在 manifest 里
  // 复述一份无人读取的副本——两处一旦不同步，按字段接线的人会踩空。
};
fs.writeFileSync(process.argv[6],JSON.stringify(manifest,null,2)+"\n");
' "$MANIFEST_RAW" "$TOOLS_JSON" "$WORK/native.json" "$WORK/node-pty.json" \
	"$BUNDLE_VERSION" "$PAYLOAD/manifest.json" || die "manifest 合并失败"

node -e '
const fs=require("fs"),cp=require("child_process");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const p=process.argv[2];
const size=(f)=>{try{return cp.execFileSync("du",["-sk",f],{encoding:"utf8"}).split("\t")[0]+"K"}catch{return "?"}};
m.sizes={runtime:size(p+"/runtime"),source:size(p+"/source"),deps:size(p+"/deps"),config:size(p+"/config"),tools:size(p+"/tools")};
fs.writeFileSync(process.argv[1],JSON.stringify(m,null,2)+"\n");
' "$PAYLOAD/manifest.json" "$PAYLOAD" || true

cat >"$PAYLOAD/README-安装说明.txt" <<EOF
pi 离线包 $BUNDLE_VERSION （${ARCH}）
================================================
第一步：把这三个文件拷到目标机同一目录（U 盘 / scp 均可）

  pi-offline-$BUNDLE_VERSION-$ARCH.tar.gz
  pi-offline-$BUNDLE_VERSION-$ARCH.tar.gz.sha256
  install.sh

第二步：在该目录下执行（Linux；无网、无 sudo 均可）

  bash install.sh pi-offline-$BUNDLE_VERSION-$ARCH.tar.gz

第三步：新开终端（或 source ~/.bashrc），然后

  pi --version      # 应输出 $PI_VERSION
  pi                # 正常启动

安装日志： ~/.pi/agent/logs/offline-install-<时间戳>.log
加载报告： ~/.pi/agent/load-report.json
装的是哪个包： ~/.pi/agent/installed-bundle.json

升级 / 回填配置 / 排障：见 docs/offline-deployment.md
EOF

# ── 12. 打包 ────────────────────────────────────────────────────────
TARBALL="pi-offline-$BUNDLE_VERSION-$ARCH.tar.gz"
say "打包 $TARBALL ..."
(
	cd "$PAYLOAD"
	COPYFILE_DISABLE=1 tar -czf "$OUT_DIR/$TARBALL" .
)
SHA="$(shasum -a 256 "$OUT_DIR/$TARBALL" | awk '{print $1}')"
printf '%s  %s\n' "$SHA" "$TARBALL" >"$OUT_DIR/$TARBALL.sha256"

# 注意：tarball 的 sha256 不可能写进包内 manifest（tar 已封口）。
# 它只存在于 $TARBALL.sha256 这个 sidecar；安装器自己实测后落进 installed-bundle.json。

cp "$SCRIPT_DIR/install.sh" "$OUT_DIR/install.sh"
chmod 755 "$OUT_DIR/install.sh"
cp "$PAYLOAD/README-安装说明.txt" "$OUT_DIR/README-安装说明.txt"

# ── 13. 汇总 ────────────────────────────────────────────────────────
say "完成。"
printf '\n'
printf '  bundle 版本 : %s\n' "$BUNDLE_VERSION"
printf '  pi 运行时   : %s (%s)\n' "$PI_VERSION" "$(size_of "$PAYLOAD/runtime")"
printf '  仓库源码    : %s\n' "$(size_of "$PAYLOAD/source")"
printf '  依赖快照    : %s\n' "$(size_of "$PAYLOAD/deps")"
printf '  配置        : %s\n' "$(size_of "$PAYLOAD/config")"
printf '  工具/原生   : %s\n' "$(size_of "$PAYLOAD/tools")"
printf '  压缩包      : %s\n' "$(size_of "$OUT_DIR/$TARBALL")"
printf '  sha256      : %s\n' "$SHA"
printf '\n  产物目录：%s\n' "$OUT_DIR"
printf '  拷到目标机：%s、其 .sha256、install.sh 三个文件\n\n' "$TARBALL"
