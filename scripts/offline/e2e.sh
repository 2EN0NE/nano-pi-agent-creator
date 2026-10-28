#!/usr/bin/env bash
#
# 离线包端到端仿真（源机执行）
#
#   bash scripts/offline/e2e.sh [--bundle PATH] [--keep] [--docker]
#
# 沙箱默认在 $TMPDIR（空间不足时用环境变量指到大盘；脚本会 rm -rf 该目录）：
#   PI_OFFLINE_E2E_WORK=/data/e2e bash scripts/offline/e2e.sh
#
# 默认用 --arch local 打一个"本机自测包"，在全新的 HOME 沙箱里跑完整安装流程，
# 覆盖：全新安装 → 断言 → 篡改配置 → 升级安装 → 断言继承/备份/剪枝 → 回填配置。
#
# 说明（为什么本机也能测）：
#   - 安装器 90% 的逻辑与平台无关（解包、落位、链接、备份、剪枝、PATH、探针调度）；
#   - local 模式跳过 rg/fd 与原生包换血（那两项只能在 Linux 上验证）；
#   - 因此本脚本证明"流程正确"，不证明"Linux 二进制可加载"——后者由目标机探针兜底。
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE=""
KEEP=0
TRY_DOCKER=0

while [ $# -gt 0 ]; do
	case "$1" in
	--bundle)
		BUNDLE="$2"
		shift 2
		;;
	--keep)
		KEEP=1
		shift
		;;
	--docker)
		TRY_DOCKER=1
		shift
		;;
	-h | --help)
		# 只印文件头注释：第 18 行是 `set -uo pipefail`，不能进帮助
		sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "未知参数：$1" >&2
		exit 1
		;;
	esac
done

# 沙箱必须放在仓库**之外**：Node 解析裸模块会逐级上溯，沙箱若在仓库内，
# 缺失的链接会被 $REPO_ROOT/node_modules 掩盖（曾让 '@zenone/pi-state 未打包' 一路 PASS）。
# 覆盖入口：TMPDIR 在 Linux 上常是容量有限的 tmpfs，空间不足时用 PI_OFFLINE_E2E_WORK 指到大盘。
if [ -n "${PI_OFFLINE_E2E_WORK:-}" ]; then
	WORK="$PI_OFFLINE_E2E_WORK"
	# 末尾斜杠会让下面的前缀判定失真（/Users 与 /Users/ 在 case 里并不等价）
	while [ "$WORK" != "/" ] && [ "${WORK%/}" != "$WORK" ]; do WORK="${WORK%/}"; done
	case "$WORK" in
	/*) ;;
	*)
		echo "PI_OFFLINE_E2E_WORK 必须是绝对路径（收到：${WORK}）" >&2
		exit 1
		;;
	esac
	case "$WORK" in
	/ | "$HOME" | "$HOME/")
		echo "PI_OFFLINE_E2E_WORK 不能是 ${WORK}（脚本会 rm -rf 它）" >&2
		exit 1
		;;
	"$REPO_ROOT" | "$REPO_ROOT"/*)
		echo "PI_OFFLINE_E2E_WORK 必须在仓库之外：${WORK}（Node 上溯会掩盖缺失的链接，且脚本会 rm -rf 它）" >&2
		exit 1
		;;
	esac
	# 祖先判定：$HOME 或仓库根位于 $WORK 之下时，rm -rf "$WORK" 会连带删掉它们
	# （上面只挡了「WORK 恰是它们本身 / 落在其子树内」这一半）。
	case "$HOME/" in
	"$WORK"/*)
		echo "PI_OFFLINE_E2E_WORK 不能是 \$HOME 的祖先目录：${WORK}（脚本会 rm -rf 它）" >&2
		exit 1
		;;
	esac
	case "$REPO_ROOT/" in
	"$WORK"/*)
		echo "PI_OFFLINE_E2E_WORK 不能是仓库根的祖先目录：${WORK}（脚本会 rm -rf 它）" >&2
		exit 1
		;;
	esac
	mkdir -p "$WORK" || {
		echo "无法创建 e2e 沙箱目录：$WORK" >&2
		exit 1
	}
else
	# mktemp 失败时 WORK 为空：脚本没有 set -e，空 WORK 会让 HOME_DIR 变成 /home，
	# 安装器随后以 HOME=/home 落位并覆盖真实配置 —— 必须在这里 fail-fast。
	WORK="$(mktemp -d "${TMPDIR:-/tmp}/pi-offline-e2e.XXXXXX")"
	if [ -z "$WORK" ] || [ ! -d "$WORK" ]; then
		echo "无法创建 e2e 沙箱目录（TMPDIR=${TMPDIR:-/tmp}）：需要 ~3GB 可用空间，可用 PI_OFFLINE_E2E_WORK 指定" >&2
		exit 1
	fi
fi
PASS=0
FAIL=0
FAILED_NAMES=""

ok() {
	PASS=$((PASS + 1))
	printf '  \033[32mPASS\033[0m %s\n' "$1"
}
bad() {
	FAIL=$((FAIL + 1))
	FAILED_NAMES="$FAILED_NAMES\n  - $1"
	printf '  \033[31mFAIL\033[0m %s\n' "$1"
	[ -n "${2:-}" ] && printf '       %s\n' "$2"
}
assert_eq() {
	if [ "$1" = "$2" ]; then ok "$3"; else bad "$3" "期望 [$2] 实际 [$1]"; fi
}
assert_file() {
	if [ -f "$1" ]; then ok "$2"; else bad "$2" "缺少文件 $1"; fi
}
assert_no_file() {
	if [ ! -e "$1" ]; then ok "$2"; else bad "$2" "不应存在 $1"; fi
}
sha_of() {
	if [ -f "$1" ]; then
		# 管道退出码取最后一个命令，`sha256sum ... | awk` 恒为 0 → 回退必须用 command -v 判定
		if command -v sha256sum >/dev/null 2>&1; then
			sha256sum "$1" | awk '{print $1}'
		else
			shasum -a 256 "$1" | awk '{print $1}'
		fi
	else
		echo "MISSING"
	fi
}

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# ── 0. 准备 bundle ──────────────────────────────────────────────────
if [ -z "$BUNDLE" ]; then
	step "打包（--arch local，本机自测）"
	PACK_LOG="$WORK/pack.log"
	bash "$REPO_ROOT/scripts/offline.sh" pack --arch local >"$PACK_LOG" 2>&1 ||
		{
			tail -20 "$PACK_LOG"
			echo "打包失败" >&2
			exit 1
		}
	BUNDLE="$(ls -t "$REPO_ROOT/tmp/offline"/pi-offline-*-local.tar.gz | head -1)"
fi
[ -f "$BUNDLE" ] || {
	echo "找不到 bundle：$BUNDLE" >&2
	exit 1
}
case "$BUNDLE" in
/*) ;;
*) BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")" ;;
esac
INSTALL_SH="$(dirname "$BUNDLE")/install.sh"
[ -f "$INSTALL_SH" ] || INSTALL_SH="$REPO_ROOT/scripts/offline/install.sh"

# 覆盖入口可能指向"上次没清干净"的目录：清空前明确告知，避免用户以为东西被凭空删掉
if [ -n "$(ls -A "$WORK" 2>/dev/null)" ]; then
	echo "PI_OFFLINE_E2E_WORK 目录非空，将先清空：$WORK"
fi

rm -rf "$WORK"
mkdir -p "$WORK"
HOME_DIR="$WORK/home"
mkdir -p "$HOME_DIR"

manifest_field() {
	node -p "const m=JSON.parse(require('child_process').execFileSync('tar',['-xzOf','$BUNDLE','./manifest.json'],{encoding:'utf8'}));String(m.$1)" 2>/dev/null
}
PI_VERSION="$(manifest_field piVersion)"
EXT_COUNT="$(manifest_field 'extensions.length')"
printf 'bundle   : %s\n' "$(basename "$BUNDLE")"
printf 'pi 版本  : %s\n' "$PI_VERSION"
printf '扩展数量 : %s\n' "$EXT_COUNT"
printf '沙箱 HOME: %s\n' "$HOME_DIR"

run_install() {
	local log="$1"
	shift
	(cd "$WORK" && HOME="$HOME_DIR" bash "$INSTALL_SH" "$BUNDLE" "$@") >"$log" 2>&1
}

run_install_home() {
	# run_install_home <home> <log> [args...]
	local home="$1" log="$2"
	shift 2
	(cd "$WORK" && HOME="$home" bash "$INSTALL_SH" "$BUNDLE" "$@") >"$log" 2>&1
}

IS_LOCAL="$(manifest_field localDev)"
if [ "$IS_LOCAL" != "true" ]; then
	step "本地流程"
	printf '  跳过：这是 arch=%s 的目标包，在 macOS 上只做结构验证（第 5 步）\n' "$(manifest_field arch)"
fi
if [ "$IS_LOCAL" = "true" ]; then
# ── 1. 全新安装 ─────────────────────────────────────────────────────
step "全新安装"
if run_install "$WORK/install-1.log"; then ok "安装退出码 0"; else
	bad "安装退出码 0" "见 $WORK/install-1.log"
	tail -30 "$WORK/install-1.log"
	exit 1
fi
AGENT="$HOME_DIR/.pi/agent"

assert_file "$AGENT/installed-bundle.json" "installed-bundle.json 已写入"
assert_file "$AGENT/load-report.json" "load-report.json 已写入"
assert_file "$AGENT/models.json" "models.json 占位已写入"
assert_file "$AGENT/auth.json" "auth.json 已写入"
assert_eq "$(HOME="$HOME_DIR" "$HOME_DIR/.local/bin/pi" --version 2>&1 | head -1)" "$PI_VERSION" "pi --version 输出期望版本"
assert_eq "$(ls -1 "$AGENT/extensions" | wc -l | tr -d ' ')" "$EXT_COUNT" "extensions 目录条目数 == manifest"
assert_eq "$(node -e "const r=require('$AGENT/load-report.json');process.stdout.write(String(r.extensionFailures.length))")" "0" "探针：扩展加载失败 0 个"
assert_eq "$(node -e "const r=require('$AGENT/load-report.json');process.stdout.write(String((r.disabled||[]).length))")" "0" "探针：隔离列表为空"
assert_eq "$(grep -c '# >>> pi-offline >>>' "$HOME_DIR/.bashrc")" "1" "~/.bashrc 标记块出现 1 次"
assert_eq "$(readlink "$AGENT/node_modules/@zenone/pi-logger" 2>/dev/null | grep -c 'extensions/pi-logger')" "1" "@zenone/pi-logger 链接指向安装目录（而非源机绝对路径）"
assert_file "$AGENT/extensions/pi-state/package.json" "纯库包 @zenone/pi-state 已随包安装（不被 profile 列出也不能漏）"
# 只断言"链接指向安装目录"不够：解析失败会被仓库 node_modules 兜住（沙箱现已移到仓库外，
# 加上这条把"链接可达、且落在安装目录内"钉死，缺包/悬空/链到源机都会 FAIL）
ZENONE_BAD="$(node -e '
const fs=require("fs"),path=require("path");
const agent=process.argv[1];
const scope=path.join(agent,"node_modules","@zenone");
if(!fs.existsSync(scope)){process.stdout.write("@zenone 目录不存在："+scope);process.exit(0);}
const root=fs.realpathSync(path.join(agent,"extensions"));
const bad=[];
for(const n of fs.readdirSync(scope)){
  let real;
  try{real=fs.realpathSync(path.join(scope,n))}
  catch(err){bad.push(n+" 链接悬空("+(err.code||err.message)+")");continue}
  if(real!==root&&!real.startsWith(root+path.sep)) bad.push(n+" → "+real);
  else if(!fs.existsSync(path.join(real,"package.json"))) bad.push(n+" 不是本地包（缺 package.json）");
}
process.stdout.write(bad.join(" | "));
' "$AGENT")"
ZENONE_RC=$?
# 检查脚本本身崩溃（fs.realpathSync/readdirSync 抛错）时 stdout 也是空串，
# 直接 assert_eq "" "" 会假 PASS —— 把退出码折进断言值。
[ "$ZENONE_RC" -eq 0 ] || ZENONE_BAD="检查脚本执行失败（exit=${ZENONE_RC}）：@zenone 链接无法校验"
assert_eq "$ZENONE_BAD" "" "@zenone/* 链接全部可达且指向安装目录内的本地包（无仓库上溯 / 无源机路径）"
assert_eq "$(node -p "require('$AGENT/installed-bundle.json').bundleVersion")" "$(manifest_field bundleVersion)" "包身份清单版本一致"

# ── 2. 模拟离线机被使用过：改配置 / 写历史 ─────────────────────────
step "模拟离线机使用痕迹"
printf '{"providers":{"my-local":{}}}\n' >"$AGENT/models.json"
printf '{"my-key":"secret"}\n' >"$AGENT/auth.json"
node -e "const p=require('$AGENT/settings.json');p.__e2e_marker='user-edit';require('fs').writeFileSync('$AGENT/settings.json',JSON.stringify(p,null,2))"
echo 'user-config' >"$AGENT/extensions-data/e2e-marker.txt"
mkdir -p "$AGENT/sessions" && echo "history" >"$AGENT/sessions/sentinel.jsonl"
mkdir -p "$AGENT/extensions/ghost-ext" && echo 'export default () => {}' >"$AGENT/extensions/ghost-ext/index.ts"
node -e "
const fs=require('fs');const p='$AGENT/installed-bundle.json';const r=JSON.parse(fs.readFileSync(p,'utf8'));
r.managedExtensions=[...new Set([...(r.managedExtensions||[]),'ghost-ext'])];
fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n');"
MODELS_SHA="$(sha_of "$AGENT/models.json")"
AUTH_SHA="$(sha_of "$AGENT/auth.json")"
SESSIONS_SHA="$(sha_of "$AGENT/sessions/sentinel.jsonl")"
ok "已写入离线期痕迹（models/auth/settings/extensions-data/sessions/ghost-ext）"

# ── 3. 升级安装 ─────────────────────────────────────────────────────
step "升级安装（同一 bundle，验证继承语义）"
sleep 1 # 备份目录名带秒级时间戳，避免同秒互相覆盖
if run_install "$WORK/install-2.log"; then ok "升级安装退出码 0"; else
	bad "升级安装退出码 0" "见 $WORK/install-2.log"
	tail -30 "$WORK/install-2.log"
	exit 1
fi

assert_eq "$(sha_of "$AGENT/models.json")" "$MODELS_SHA" "models.json 升级前后字节不变"
assert_eq "$(sha_of "$AGENT/auth.json")" "$AUTH_SHA" "auth.json 升级前后字节不变"
assert_eq "$(sha_of "$AGENT/sessions/sentinel.jsonl")" "$SESSIONS_SHA" "sessions 历史未被触碰"
BACKUP_DIR="$(ls -d "$AGENT"/.config-backup-* 2>/dev/null | sort | tail -1)"
if [ -n "$BACKUP_DIR" ]; then ok "配置备份目录已创建"; else bad "配置备份目录已创建"; fi
assert_file "$BACKUP_DIR/settings.json" "备份内含 settings.json"
assert_file "$BACKUP_DIR/manifest.json" "备份内含 manifest.json（可追溯）"
SETTINGS_MARKER="$(node -p "(require('$AGENT/settings.json').__e2e_marker)||''")"
SETTINGS_RC=$?
# node 崩了（settings.json 缺失/不可解析）时 stdout 也是空串，会假 PASS
[ "$SETTINGS_RC" -eq 0 ] || SETTINGS_MARKER="node 无法解析 settings.json（exit=${SETTINGS_RC}）"
assert_eq "$SETTINGS_MARKER" "" "settings.json 已被 bundle 版本替换（用户改动进入备份）"
assert_eq "$(node -p "require('$AGENT/installed-bundle.json').backupDir!==null")" "true" "installed-bundle.json 记录了备份目录"
if [ -d "$AGENT/extensions/ghost-ext" ]; then bad "ghost-ext 已从 extensions 移出"; else ok "ghost-ext 已从 extensions 移出"; fi
if ls "$AGENT/extensions-disabled" 2>/dev/null | grep -q '^ghost-ext.removed-'; then ok "ghost-ext 进入 extensions-disabled（未删除）"; else bad "ghost-ext 进入 extensions-disabled（未删除）"; fi

# 下架的技能/主题也要剪枝（与扩展剪枝对齐），且必须能从备份捞回
node -e "
const fs=require('fs');const p='$AGENT/installed-bundle.json';const r=JSON.parse(fs.readFileSync(p,'utf8'));
r.managedSkills=[...new Set([...(r.managedSkills||[]),'ghost-skill'])];
fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n');"
mkdir -p "$AGENT/skills/ghost-skill" && echo "# ghost" >"$AGENT/skills/ghost-skill/SKILL.md"
sleep 1
if run_install "$WORK/install-3.log"; then ok "第三次安装（技能剪枝）退出码 0"; else
	bad "第三次安装（技能剪枝）退出码 0" "见 $WORK/install-3.log"
fi
if [ -d "$AGENT/skills/ghost-skill" ]; then bad "下架技能已从 skills/ 剪枝"; else ok "下架技能已从 skills/ 剪枝"; fi
LATEST_BACKUP="$(ls -d "$AGENT"/.config-backup-* 2>/dev/null | sort | tail -1)"
assert_file "$LATEST_BACKUP/skills/ghost-skill/SKILL.md" "被剪枝的技能在备份目录里可捞回"

# ── 3b. 陈旧 load-report 不得驱动本次隔离 ──────────────────────────
step "陈旧 load-report 不被复用"
node -e "
const fs=require('fs');
fs.writeFileSync('$AGENT/load-report.json',JSON.stringify({generatedAt:'2000-01-01T00:00:00Z',
  extensionCount:1,extensionFailures:[{name:'pi-logger',error:'stale failure from previous run'}],
  nativeFailures:[],toolFailures:[]},null,2)+'\n');"
sleep 1
if run_install "$WORK/install-4.log"; then ok "第四次安装（陈旧报告）退出码 0"; else
	bad "第四次安装（陈旧报告）退出码 0" "见 $WORK/install-4.log"
fi
assert_eq "$(node -e "const r=require('$AGENT/load-report.json');process.stdout.write(String(r.extensionFailures.length))")" "0" "load-report 是本次结果（失败 0 个）"
if [ -d "$AGENT/extensions/pi-logger" ]; then ok "陈旧报告里的失败扩展未被隔离"; else bad "陈旧报告里的失败扩展未被隔离"; fi

# ── 3c. --dry-run 不做任何改动 ──────────────────────────────────────
step "dry-run"
DRY_HOME="$WORK/dry-home"
rm -rf "$DRY_HOME"
mkdir -p "$DRY_HOME"
if run_install_home "$DRY_HOME" "$WORK/dry.log" --dry-run; then ok "dry-run 退出码 0"; else
	bad "dry-run 退出码 0" "见 $WORK/dry.log"
fi
assert_no_file "$DRY_HOME/.pi/agent/settings.json" "dry-run 未写 settings.json"
assert_no_file "$DRY_HOME/.local/bin/pi" "dry-run 未写启动器"
if grep -q "dry-run 结束" "$WORK/dry.log"; then ok "dry-run 打印了计划"; else bad "dry-run 打印了计划"; fi

# ── 3d. sha256 不匹配必须拒绝安装 ───────────────────────────────────
step "sha256 不匹配拒绝安装"
TAMPER_DIR="$WORK/tamper"
rm -rf "$TAMPER_DIR"
mkdir -p "$TAMPER_DIR"
cp "$BUNDLE" "$TAMPER_DIR/"
printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  %s\n' "$(basename "$BUNDLE")" \
	>"$TAMPER_DIR/$(basename "$BUNDLE").sha256"
TAMPER_HOME="$WORK/tamper-home"
mkdir -p "$TAMPER_HOME"
if (cd "$TAMPER_DIR" && HOME="$TAMPER_HOME" bash "$INSTALL_SH" "$(basename "$BUNDLE")") >"$WORK/tamper.log" 2>&1; then
	bad "sha256 不匹配时安装失败" "安装竟然成功了"
else
	ok "sha256 不匹配时安装失败"
fi
if grep -q "sha256 不匹配" "$WORK/tamper.log"; then ok "失败原因是 sha256 不匹配"; else bad "失败原因是 sha256 不匹配"; fi
assert_no_file "$TAMPER_HOME/.local/bin/pi" "sha256 不匹配时没有写启动器"

# ── 3e. 迁移：旧 restore 布局（0.7x 老机器）────────────────────────
step "迁移安装（旧 restore 布局）"
LEGACY_HOME="$WORK/legacy-home"
rm -rf "$LEGACY_HOME"
mkdir -p "$LEGACY_HOME/.local/share/pi-runtime/node/bin" "$LEGACY_HOME/.local/bin" \
	"$LEGACY_HOME/.pi/agent/extensions/legacy-0.7-ext" "$LEGACY_HOME/.pi/agent/extensions-data"
echo '{"old":"runtime"}' >"$LEGACY_HOME/.local/share/pi-runtime/node/bin/node-marker"
printf '{"__legacy_marker":"keep-me"}\n' >"$LEGACY_HOME/.pi/agent/settings.json"
echo "legacy-config" >"$LEGACY_HOME/.pi/agent/extensions-data/legacy.txt"
echo 'export default () => {}' >"$LEGACY_HOME/.pi/agent/extensions/legacy-0.7-ext/index.ts"
# 旧布局的启动器是软链（旧 restore 的 node/npm 也是软链）：直接写会写穿
ln -s "$LEGACY_HOME/.local/share/pi-runtime/pi" "$LEGACY_HOME/.local/bin/pi"
ln -s "$LEGACY_HOME/.local/share/pi-runtime/node/bin/node" "$LEGACY_HOME/.local/bin/node"
if run_install_home "$LEGACY_HOME" "$WORK/legacy-install.log"; then ok "迁移安装退出码 0"; else
	bad "迁移安装退出码 0" "见 $WORK/legacy-install.log"
fi
LAGENT="$LEGACY_HOME/.pi/agent"
LEGACY_BACKUP="$(ls -d "$LAGENT"/.config-backup-* 2>/dev/null | sort | tail -1)"
if [ -n "$LEGACY_BACKUP" ]; then ok "迁移时配置已备份（无 installed-bundle.json 也备份）"; else bad "迁移时配置已备份（无 installed-bundle.json 也备份）"; fi
assert_eq "$(node -p "(require('$LEGACY_BACKUP/settings.json').__legacy_marker)||''")" "keep-me" "备份里有旧 settings.json"
assert_file "$LEGACY_BACKUP/extensions-data/legacy.txt" "备份里有旧 extensions-data"
LEGACY_MARKER="$(node -p "(require('$LAGENT/settings.json').__legacy_marker)||''")"
LEGACY_RC=$?
# node 崩了（settings.json 缺失/不可解析）时 stdout 也是空串，会假 PASS
[ "$LEGACY_RC" -eq 0 ] || LEGACY_MARKER="node 无法解析 settings.json（exit=${LEGACY_RC}）"
assert_eq "$LEGACY_MARKER" "" "settings.json 已替换为 bundle 版本"
assert_eq "$(node -p "require('$LAGENT/installed-bundle.json').migratedFrom||''")" "legacy/manual" "installed-bundle 记录 migratedFrom"
assert_eq "$(node -p "require('$LAGENT/installed-bundle.json').sha256||''")" "$(awk '{print $1}' "$BUNDLE.sha256")" "installed-bundle 记录的是实测 bundle sha256"
if [ -L "$LEGACY_HOME/.local/bin/pi" ]; then bad "启动器已从软链换成普通文件"; else ok "启动器已从软链换成普通文件"; fi
if grep -q "旧运行时目录" "$WORK/legacy-install.log"; then ok "迁移日志提示了旧运行时目录"; else bad "迁移日志提示了旧运行时目录"; fi
if grep -q "不属本包提供" "$WORK/legacy-install.log"; then ok "迁移日志列出了非本包扩展"; else bad "迁移日志列出了非本包扩展"; fi
if [ -d "$LAGENT/extensions/legacy-0.7-ext" ]; then ok "默认保留旧扩展（不删）"; else bad "默认保留旧扩展（不删）"; fi

# 再次迁移：--prune-unknown-extensions + --remove-legacy-runtime
if run_install_home "$LEGACY_HOME" "$WORK/legacy-install-2.log" \
	--prune-unknown-extensions --remove-legacy-runtime; then ok "迁移重跑（剪枝+清理旧运行时）退出码 0"; else
	bad "迁移重跑（剪枝+清理旧运行时）退出码 0" "见 $WORK/legacy-install-2.log"
fi
if [ -d "$LAGENT/extensions/legacy-0.7-ext" ]; then bad "非本包扩展已移出 extensions/"; else ok "非本包扩展已移出 extensions/"; fi
if ls "$LAGENT/extensions-disabled" 2>/dev/null | grep -q '^legacy-0.7-ext.unknown-'; then ok "非本包扩展移入 extensions-disabled（未删除）"; else bad "非本包扩展移入 extensions-disabled（未删除）"; fi
assert_no_file "$LEGACY_HOME/.local/share/pi-runtime" "旧运行时已删除"
if [ -L "$LEGACY_HOME/.local/bin/node" ]; then bad "指向旧运行时的 node 软链已摘掉"; else ok "指向旧运行时的 node 软链已摘掉"; fi
# ── 4. 回填配置 ─────────────────────────────────────────────────────
step "回填配置（--restore-config）"
BACKUP_TS="$(basename "$BACKUP_DIR" | sed 's/^\.config-backup-//')"
if (cd "$WORK" && HOME="$HOME_DIR" bash "$INSTALL_SH" --restore-config "$BACKUP_TS") >"$WORK/restore.log" 2>&1; then
	ok "回填命令退出码 0"
else
	bad "回填命令退出码 0" "见 $WORK/restore.log"
fi
assert_eq "$(node -p "(require('$AGENT/settings.json').__e2e_marker)||''")" "user-edit" "回填后 settings.json 恢复用户改动"
assert_file "$AGENT/extensions-data/e2e-marker.txt" "回填后 extensions-data 用户文件恢复"

fi # IS_LOCAL
# ── 5. 结构验证：真实 linux bundle 的落位（不执行 ELF） ─────────────
step "结构验证（linux bundle）"
BUNDLE_ARCH="$(manifest_field arch)"
if [ "$BUNDLE_ARCH" = "local" ]; then
	printf '  跳过：当前是 --arch local 自测包（原生换血/rg-fd 只在 linux 包里存在）\n'
else
	STRUCT_HOME="$WORK/structural-home"
	rm -rf "$STRUCT_HOME"
	mkdir -p "$STRUCT_HOME"
	# 在 macOS 上装 linux 包：跳过探针（ELF 无法在 macOS 执行），只看落位与清理
	if (cd "$WORK" && HOME="$STRUCT_HOME" bash "$INSTALL_SH" "$BUNDLE" \
		--allow-arch-mismatch --no-probe) >"$WORK/install-structural.log" 2>&1; then
		ok "linux bundle 结构安装退出码 0"
	else
		bad "linux bundle 结构安装退出码 0" "见 $WORK/install-structural.log"
	fi
	SAGENT="$STRUCT_HOME/.pi/agent"
	assert_eq "$(find "$SAGENT" -type d -name '*-darwin-*' 2>/dev/null | wc -l | tr -d ' ')" "0" "目标机不再残留任何 *-darwin-* 目录"
	assert_eq "$(ls "$SAGENT/node_modules/@typescript" 2>/dev/null | grep -c 'typescript-linux-x64')" "1" "typescript 已换成 linux 变体（静态链接）"
	assert_file "$SAGENT/npm/node_modules/@img/sharp-linux-x64/package.json" "sharp linux 变体已落位"
	assert_file "$SAGENT/bin/rg" "rg 已安装"
	assert_file "$SAGENT/bin/fd" "fd 已安装"
	assert_eq "$(head -c 4 "$SAGENT/bin/rg" | od -An -tx1 | tr -d ' \n')" "7f454c46" "rg 是 Linux ELF（不是 macOS 二进制）"
	if grep -q "glibc" "$WORK/install-structural.log"; then
		ok "安装日志包含 glibc 兼容性预检"
	else
		bad "安装日志包含 glibc 兼容性预检"
	fi
fi

# ── 6. 真实容器（可选，需要本地已有镜像） ──────────────────────────
step "真实 Linux 容器（可选）"
if [ "$TRY_DOCKER" -eq 0 ]; then
	printf '  跳过：未加 --docker\n'
elif ! command -v docker >/dev/null 2>&1; then
	printf '  跳过：没有 docker\n'
elif ! docker image inspect node:22-bullseye >/dev/null 2>&1; then
	printf '  跳过：本地没有 node:22-bullseye 镜像（拉取需要能连上 registry）\n'
else
	printf '  提示：真实容器验证请执行 docs/offline-deployment.md「目标机仿真」一节\n'
fi

# ── 汇总 ────────────────────────────────────────────────────────────
step "汇总"
printf '  PASS %s / FAIL %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || printf '  失败项：%b\n' "$FAILED_NAMES"
if [ "$KEEP" -eq 0 ] && [ "$FAIL" -eq 0 ]; then
	rm -rf "$WORK"
	printf '  沙箱已清理（--keep 可保留）\n'
else
	printf '  沙箱保留：%s\n' "$WORK"
	printf '  清理：rm -rf %s\n' "$WORK"
fi
[ "$FAIL" -eq 0 ] || exit 1
