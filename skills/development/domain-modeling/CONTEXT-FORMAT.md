# CONTEXT.md 格式

## 结构

```md
# {上下文名称}

{一两句话描述这个上下文是什么以及它为什么存在。}

## 语言

**Order**：
{一两句话描述该术语}
_避免_：Purchase, transaction

**Invoice**：
发货后发送给客户的付款请求。
_避免_：Bill, payment request

**Customer**：
下单的个人或组织。
_避免_：Client, buyer, account
```

## 规则

- **要有主见。** 当同一个概念有多个词时，选择最好的一个，并将其他词列在 `_避免_` 下。
- **定义保持紧凑。** 最多一两句话。定义它是什么，而不是它做什么。
- **只包含本项目上下文特定的术语。** 通用编程概念（timeout、错误类型、工具模式）不属于，即使项目广泛使用它们。在添加术语之前问：这是当前上下文独有的概念，还是一个通用编程概念？只有前者属于。
- **当自然聚类出现时，将术语分组在子标题下。** 如果所有术语属于一个单一的凝聚区域，平铺列表也可以。

## 单上下文 vs 多上下文仓库

**单上下文（大多数仓库）：** 一个 `CONTEXT.md` 在仓库根目录。

**多上下文：** 一个 `CONTEXT-MAP.md` 在仓库根目录列出上下文、它们的位置，以及它们之间的关系：

```md
# 上下文地图

## 上下文

- [Ordering](./src/ordering/CONTEXT.md) —— 接收和跟踪客户订单
- [Billing](./src/billing/CONTEXT.md) —— 生成发票和处理付款
- [Fulfillment](./src/fulfillment/CONTEXT.md) —— 管理仓库拣货和发货

## 关系

- **Ordering → Fulfillment**: Ordering 发出 `OrderPlaced` 事件；Fulfillment 消费以开始拣货
- **Fulfillment → Billing**: Fulfillment 发出 `ShipmentDispatched` 事件；Billing 消费以生成发票
- **Ordering ↔ Billing**: `CustomerId` 和 `Money` 的共享类型
```

本技能推断适用哪种结构：

- 如果存在 `CONTEXT-MAP.md`，读取它以找到上下文
- 如果只有根目录的 `CONTEXT.md`，单上下文
- 如果两者都不存在，在第一个术语确定时懒创建一个根目录 `CONTEXT.md`

当存在多个上下文时，推断当前主题涉及哪个。如果不清晰，询问。
