#!/usr/bin/env bash
# ⚠️ DEPRECATED（2026-09）：本文件是 ADR-0004 迁移（`test/scripts/` → `test/e2e/scripts/`）
#    遗留的旧副本，**不是在用运行器**。它仍含旧的「每模块 `rm -f` 全部
#    `~/.pi/agent/extensions-data/*/config.json` + 整轮结束从 `test/results/<ts>/config-backup`
#    恢复」逻辑——该轮一旦中断（Ctrl-C / 超时 kill / CI 取消），用户插件配置就整批丢失
#    （见 ADR-0045 D6 修订）。请改用：`bash test/e2e/scripts/run-e2e.sh`
#
# ⛔ 硬停（2026-10-17）：保留本文件只为可追溯，不再提供运行 / --help 能力——它含会整批
#    删除用户插件配置的旧逻辑，任何「看起来还能跑」的入口都是风险。
echo "ERROR: test/scripts/run-e2e.sh 已废弃（旧副本含删除用户配置的逻辑），拒绝执行。" >&2
echo "       请改用: bash test/e2e/scripts/run-e2e.sh $*" >&2
exit 1

# 原 917 行旧逻辑（含每模块 rm 用户配置 + 结尾恢复）已删除；需要追溯请看：
#   git show 9eadc890:test/scripts/run-e2e.sh
