# pi-rate-limiter

pi.dev 大模型调用频率限制器插件，解决本地大模型服务商输出流式结果时突然报错 **"432-输入Token数已达每分钟上限"** 导致工作中断的问题。

## 功能

- **主动限流**：在请求发送前检查当前分钟窗口的使用量（RPM / TPM），必要时自动延迟到下一分钟，避免触发服务商限流。
- **实时状态叠加**：在 pi 默认 footer 下方叠加显示当前分钟的请求数和 Token 使用率，颜色随使用率变化：
  - 🟢 **绿色** (< 60%)：正常
  - 🟡 **黄色** (60% - 80%)：接近阈值
  - 🔴 **红色** (≥ 80%)：高危，即将限流
- **432 自动继续**：检测到 432 限流错误时，自动等待窗口刷新后发送继续消息（可选，通过 `/rate-limit` 面板开启）。

## 安装

```bash
# 1. 克隆仓库
git clone https://github.com/your-username/pi-rate-limiter.git

# 2. 复制到 pi 扩展目录
cp -r pi-rate-limiter/rate-limiter ~/.pi/agent/extensions/

# 3. 重启 pi 或在当前会话加载
pi -e ~/.pi/agent/extensions/rate-limiter
```

pi 启动时会自动发现 `~/.pi/agent/extensions/rate-limiter/` 目录下的 `index.ts`。

## 配置

配置采用 **四层覆盖**，优先级从低到高：

1. **代码硬编码默认值**
2. **扩展内置配置**：`~/.pi/agent/extensions/rate-limiter/pi-rate-limiter.yaml`
3. **全局配置**：`~/.pi/agent/extensions/pi-rate-limiter.yaml`
4. **项目级配置**（最高优先级）：`<project>/.pi/agent/extensions/pi-rate-limiter.yaml`

### 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxRequestsPerMinute` | number | 10 | 每分钟最大请求数（0 表示不限） |
| `maxTokensPerMinute` | number | 8000 | 每分钟最大输入 Token 数（0 表示不限） |
| `autoResumeOn432` | boolean | false | 遇到 432 是否自动继续 |
| `tokenEstimateRatio` | number | 4 | Token 估算分母（字符数 ÷ 该值） |
| `throttleThresholdPercent` | number | 80 | 达到上限百分之多少时开始主动限流 |

### 示例配置

在项目根目录创建 `.pi/agent/extensions/pi-rate-limiter.yaml`：

```yaml
maxRequestsPerMinute: 5
maxTokensPerMinute: 3000
autoResumeOn432: true
tokenEstimateRatio: 3
throttleThresholdPercent: 70
```

## 使用

启动 pi 后，footer 最下方会自动显示限流状态：

```
Rate: 3/10 req/min · 1.2k/8k tok/min
```

### 设置面板

在 pi 交互模式中输入：

```
/rate-limit
```

打开可视化设置面板，支持实时修改：
- 每分钟最大请求数
- 每分钟最大输入 Token
- Token 估算分母
- 限流触发阈值
- 432 自动继续开关

修改后的数值会随 Session 自动持久化（支持 fork / tree 恢复）。

## 技术细节

- **纯扩展实现**：零修改 pi.dev 核心代码。
- **Session 级状态**：运行时配置通过 `pi.appendEntry()` 持久化，分支导航后状态正确恢复。
- **通用 Token 估算**：遍历 provider payload 中所有 `messages` 的文本内容，按 `字符数 / tokenEstimateRatio` 估算，支持 Anthropic / OpenAI 等主流格式。

## License

MIT
