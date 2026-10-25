### 3. `complete()` 调用全流程注意事项

`@earendil-works/pi-ai` 的 `complete()` 有两处文档未提及的细节：

**① Auth 解析不会走 Pi 的 ModelRegistry**

内部通过 `getEnvApiKey(model.provider)` 解析 API Key，**只检查环境变量**。但用户通常通过 `models.json` / auth storage 配置 Key。必须手动调用 `ctx.modelRegistry.getApiKeyAndHeaders()` 解析后传入 options：

```typescript
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(modelInfo);
const options: Record<string, unknown> = { maxTokens: 8192, signal };
if (auth.ok) {
	if (auth.apiKey) options.apiKey = auth.apiKey;
	if (auth.headers) options.headers = auth.headers;
}
const response = await complete(modelInfo, { messages }, options as any);
```

**② `Response.errorMessage` 在 `stopReason: "error"` 时有值**

```typescript
if (response.stopReason === 'error') {
	log.error('Model call failed', { errorMessage: response.errorMessage });
}
```
