# 多通道外部确认接口

**决策**：permission-gate 暴露**通道无关**的程序化确认接口，使任何插件（如 wechatbot）能订阅待确认请求并程序化确认，**等效于人工 TUI 选择**。

**接口形态**（`globalThis.__permissionGateApi`）：

```
onPendingRequest(cb: (req: ConfirmRequest) => void): () => void   // 订阅待确认请求（含 requestId / shortCode / tool / command / level / reasons）
confirm(requestId: string, decision: 'allow' | 'deny'): Promise<boolean>  // 程序化确认，等效 TUI 选择
listPending(): ConfirmRequest[]                                    // 通道重连同步
```

**关键约束**：

1. **阻塞行为不变**——permission-gate 的确认流程不因是否存在外部通道而改变（与现状一致地阻塞等待）；外部通道只是"多一个确认入口"。
2. **超时/作废归通道**——permission-gate 不管理外部通道的超时与作废；微信端 `#ab12cd:Y` 这类短码解析、消息格式化、过期作废，全部由 wechatbot 插件自己控制。
3. **decision 与 TUI 选项对齐**——`confirm` 的 decision 取值即 TUI 确认选项（现为 `allow`/`deny`），未来 TUI 扩展"放行并沉淀"等选项时同步扩展，保证外部确认与人工操作语义一致。

**系统通知**：复用现有 `extensions/auto/notify.ts`（升级加 osascript，不引入 alerter 这类重依赖），通过 `globalThis.__notifyApi` 弱桥接供 permission-gate 调用；仅在 `ask`（拦截需人工确认）时触发。

**为什么通道无关**：permission-gate 不应耦合任何特定外部通道（wechatbot 只是第一个消费者）。暴露标准接口 + 让通道自行适配（订阅 → 格式化 → 解析回复 → 调 confirm），使通道可插拔，且未来任何"程序化确认"需求（脚本、CI、其他 bot）都能复用同一接口。
