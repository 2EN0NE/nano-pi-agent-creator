---
name: native-web-search
description: '触发原生网络搜索。当需要进行快速互联网调研，需要简洁摘要和完整来源 URL 时使用。'
---

# 原生网络搜索技能

使用此技能运行**启用了原生网络搜索的快速模型**，获取简洁的研究摘要和明确的完整 URL。

## 脚本

- `search.mjs`

## 使用方法

从此技能目录运行：

```bash
node search.mjs "<what to search>" --purpose "<why you need this>"
```

Examples:

```bash
node search.mjs "latest python release" --purpose "update dependency notes"
node search.mjs "vite 7 breaking changes" --purpose "prepare migration checklist"
```

Optional flags:

- `--provider openai-codex|anthropic`
- `--model <model-id>`
- `--timeout <ms>`
- `--json`

## 输出预期

该脚本指示模型：

- 在互联网上搜索请求的主题
- 为给定目的提供简洁摘要
- 为每个关键发现包含完整规范 URL（`https://...`）
- 突出显示来源之间的分歧

## 注意事项

- 无需额外的 npm install。
- 如果模块解析失败，将 `PI_AI_MODULE_PATH` 设置为 `@earendil-works/pi-ai` 的 `dist/index.js` 路径。
- 如果 OAuth 辅助模块解析失败，将 `PI_AI_OAUTH_MODULE_PATH` 设置为 `@earendil-works/pi-ai` 的 `dist/oauth.js` 路径。
- 对于 OAuth 提供者，脚本可以回退到 `~/.pi/agent/auth.json` 中仍然有效的缓存 `access` 令牌。
