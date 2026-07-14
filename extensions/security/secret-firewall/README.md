# @zenone/pi-secret-firewall

Pi/Kiro Agent 的秘钥防火墙。它将**秘钥值**彻底挡在模型上下文之外，仅将其作为 shell 环境变量暴露，模型可以*按名称引用*但**永远不能读取**。在秘钥值原本会出现的位置，模型看到的是一个自描述的占位符，指明了要使用的确切 shell 变量，例如：
`«SECRET DATABASE_URL redacted — the real value is live in your shell env; read it in bash as "$DATABASE_URL"»`。

## 工作原理

在会话启动时（及按需），它从两个来源发现秘钥：

1. **真实的环境变量**，其名称看起来是敏感的（`*_TOKEN`、`*_SECRET`、`*_API_KEY`、`*_PASSWORD`、`DATABASE_URL`……）——精确值匹配，零误报。
2. cwd 中的 **`.env` / `.env.local` / `.env.development*`** 文件。

每个秘钥值都会获得一个稳定的、自描述的占位符，准确告诉模型如何使用它。对于 env/dotenv 秘钥，shell 变量就是秘钥的**原始名称**：`MY_API_KEY=xptolksjf` → `«SECRET MY_API_KEY redacted — the real value is live in your shell env; read it in bash as "$MY_API_KEY"»`。

脱敏发生在三个通道上：

- **`input` 钩子**——用户的原始消息在提交的那一刻被脱敏，然后再存储到会话或显示在转录中。因此，粘贴的秘钥永远不会持久保存在用户会话中，用户也会看到占位符，从而清楚知道该值已被脱敏。
- **`context` 钩子**——发送给模型的每条消息（用户文本、助手文本、思考过程和工具调用参数）中的秘钥值都会被替换为占位符。
- **`tool_result` 钩子**——来自 `bash`、`read`、`grep` 等工具的输出会被脱敏，因此 `cat .env` 返回的是占位符，而不是值。

模式匹配回退还能捕获已知的令牌格式（AWS 密钥、JWT、`sk-...`、GitHub/Slack 令牌、PEM 私钥），这些令牌即使从未出现在环境变量中也可能泄露到输出中。当捕获到此类令牌时，其值会被**捕获并自动导出**到 shell 中，使用生成的名称（`SECRET_JWT`、`SECRET_JWT_2`……），写入 `process.env`，并在上下文中替换为占位符，指导模型用 `$SECRET_JWT` 来使用它。

被脱敏的字符串在上下文中**绝不会重新水合**。如果模型写出了字面*值*而不是 shell 引用，该值在返回时会被再次脱敏。

### 粘贴/泄露的令牌会被捕获并导出

当值被**模式规则**捕获时（JWT、AWS 密钥、`sk-...` 等），它不仅会被屏蔽——其真实值会被捕获并动态导出为 `$SECRET_*` shell 变量。这意味着粘贴到聊天中的令牌可以在 bash 中使用（`$SECRET_JWT`），而模型永远看不到该值，也不需要事先在 `.env` 中配置。被同一模式捕获的不同值会获得带后缀的名称（`$SECRET_JWT_2`）。

### 限制 / 非目标

- 一个有决心的模型仍然可以通过在输出前变换值的方式来泄露秘钥（例如 base64）。这提高了门槛，但不是一个沙箱。
- 少于 8 个字符的值或匹配简单值的值（`true`、`3000`……）不受保护——它们不是秘钥，脱敏它们会破坏 Agent。
- 基础设施/会话变量（`PATH`、`HOME`、`SSH_AUTH_SOCK`、`*_SESSION`……）明确不会被视为秘钥。

## 命令

- `/secret-firewall` — 显示状态（受保护的秘钥、脱敏次数、模型可以引用的 shell 环境变量名）。
- `/secret-firewall-toggle` — 启用/禁用脱敏。
- `/secret-firewall-rescan` — 重新扫描 env + `.env` 文件。

## 开发

```bash
pnpm build   # tsc -> dist/
pnpm test    # node --test 对 dist/ 运行测试
pnpm lint    # tsc --noEmit
```
