---
name: web-browser
description: '通过执行点击按钮、填写表单、导航链接等操作与网页交互。通过 Chrome DevTools Protocol (CDP) 远程控制 Google Chrome 或 Chromium 浏览器来实现。当 Claude 需要浏览网页时，可以使用此技能。'
license: Stolen from Mario
---

# 网页浏览器技能

用于协作站点探索的最小化 CDP 工具集。

## 启动 Chrome（推荐 Headless 模式）

```bash
./scripts/start.js --headless             # 推荐：隔离的可复用配置文件，headless
./scripts/start.js --headless --profile   # Headless 模式，复制你的配置文件到隔离缓存
./scripts/start.js                        # 可见浏览器窗口（需要人为交互时使用）
./scripts/start.js --headless --reset-profile  # 启动前清除选中的缓存配置文件
```

以远程调试模式启动 Chrome（默认端口 `:9222`）。**Agent 应默认使用 `--headless`**，因为它干扰小，支持导航、执行 JS、截图、模拟和日志功能。只有在需要人为查看或操作浏览器时才使用有头模式（如 `pick.js`、手动认证或调试 headless 特有的问题）。

启动脚本仅在配置文件和启动模式匹配时复用已有浏览器进程。在切换 headless 和有头模式前，请先关闭正在运行的技能浏览器。

配置文件行为：

- 默认模式使用：`~/.cache/agent-web/browser/fresh-profile`
- `--profile` 模式使用：`~/.cache/agent-web/browser/profile-copy`
- 该技能**不会直接附加到你正在使用的 Chrome 配置文件**
- 如果 `:9222` 已被未知实例占用，启动将失败，不会复用它

如果 Chrome 安装在非标准位置，请设置：

```bash
BROWSER_BIN=/path/to/chrome ./scripts/start.js --headless
```

可选的调试端点覆盖：

```bash
BROWSER_DEBUG_PORT=9333 ./scripts/start.js --headless
```

## 导航

```bash
./scripts/nav.js https://example.com
./scripts/nav.js https://example.com --new
```

导航当前标签页或打开新标签页。

## 设备模拟（移动端）

```bash
./scripts/emulate.js --list
./scripts/emulate.js iphone-14
./scripts/emulate.js pixel-7 --landscape
./scripts/emulate.js --reset
```

为浏览器技能命令设置活动的设备模拟偏好（视口、DPR、触摸、UA）。使用 `--reset` 清除。

`nav.js`、`eval.js`、`pick.js`、`dismiss-cookies.js` 和 `screenshot.js` 等命令会自动应用活动的模拟偏好。

## 执行 JavaScript

```bash
./scripts/eval.js 'document.title'
./scripts/eval.js 'document.querySelectorAll("a").length'
./scripts/eval.js 'document.querySelector("button")?.click(); "clicked"'
./scripts/eval.js 'await Promise.resolve(document.title)'
./scripts/eval.js 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(link => !link.href.startsWith("https://")))'
```

在当前活动标签页中执行 JavaScript。输入可以是表达式或语句列表；会打印控制台风格的完成值，并等待 promise/顶层 `await`。注意字符串转义，最好使用单引号。

## 截图

```bash
./scripts/screenshot.js
./scripts/screenshot.js --full-page
./scripts/screenshot.js --device iphone-14
./scripts/screenshot.js --device pixel-7 --full-page
```

截取屏幕并返回临时文件路径。

- 默认：当前视口
- `--full-page`：捕获完整文档高度
- `--device <preset>`：仅对该截图临时进行移动端模拟

## 选取元素

```bash
./scripts/pick.js "Click the submit button"
```

交互式元素选择器。点击选择，Cmd/Ctrl+点击多选，Enter 完成。

## 关闭 Cookie 对话框

```bash
./scripts/dismiss-cookies.js          # 接受 cookie
./scripts/dismiss-cookies.js --reject # 拒绝 cookie（尽可能）
```

自动关闭欧盟 Cookie 同意对话框。

在导航到页面后运行：

```bash
./scripts/nav.js https://example.com && ./scripts/dismiss-cookies.js
```

## 快速移动端调试流程

```bash
./scripts/start.js
./scripts/nav.js https://example.com
./scripts/emulate.js iphone-14
./scripts/nav.js https://example.com      # 用移动端 UA 重新加载
./scripts/dismiss-cookies.js
./scripts/screenshot.js --full-page
```

## 后台日志（控制台 + 错误 + 网络）

由 `start.js` 自动启动，将 JSONL 日志写入：

```
~/.cache/agent-web/logs/YYYY-MM-DD/<targetId>.jsonl
```

手动启动：

```bash
./scripts/watch.js
```

查看最新日志：

```bash
./scripts/logs-tail.js           # 导出当前日志并退出
./scripts/logs-tail.js --follow  # 持续跟踪
```

汇总网络响应：

```bash
./scripts/net-summary.js
```
