# @zenone/pi-ci-watch

监控 GitHub PR 的 CI 状态并自动修复失败。缩短 CI 与编码 Agent 之间的反馈循环。

## 安装

```bash
pi install npm:@zenone/pi-ci-watch
```

或者在 `.pi/settings.json` 中：

```json
{
  "packages": ["npm:@zenone/pi-ci-watch"]
}
```

## 命令

| 命令 | 描述 |
|---------|-------------|
| `/ci-watch <pr>` | 监控 CI 并自动修复失败（最多 3 次尝试） |
| `/ci-notify <pr>` | 监控 CI 并在完成时通知（不自动修复） |
| `/ci-auto on\|off` | 每次推送后自动监控（默认：关闭） |
| `/ci-config <min> <max> <step>` | 配置轮询间隔（秒） |
| `/ci-config` | 显示当前配置 |

## 工作原理

1. 使用智能间隔（30 秒 → 45 秒 → 60 秒 → 30 秒……）轮询 `gh pr checks`
2. 如果 CI 通过：通知 ✅
3. 如果 CI 失败：通过 `gh run view --log-failed` 获取日志，返回给 LLM 修复
4. LLM 读取错误、修复代码、提交、推送
5. 重复直到 CI 通过（最多 3 次尝试）

## 自动模式

使用 `/ci-auto on` 启用后，扩展会检测 `git push` 输出并自动开始监控关联的 PR。

## 轮询配置

默认：30 秒最小值、60 秒最大值、15 秒步长。间隔从最小值增长到最大值，然后重置——不会无限增长。

```
/ci-config 20 90 10
```

设置：20 秒 → 30 秒 → 40 秒 → …… → 90 秒 → 20 秒 → ……

## 要求

- 已安装并认证 `gh` CLI
- 启用了 GitHub Actions CI 的仓库
