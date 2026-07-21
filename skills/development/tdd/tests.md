# 好测试与坏测试

## 好测试

**集成风格**：通过真实接口测试，而非 mock 内部部件。

```typescript
// 好：测试可观察行为
test('用户能用有效购物车结账', async () => {
	const cart = createCart();
	cart.add(product);
	const result = await checkout(cart, paymentMethod);
	expect(result.status).toBe('confirmed');
});
```

特征：

- 测试用户/调用者在意的行为
- 仅使用公开 API
- 能经受内部重构
- 描述 WHAT（什么），而非 HOW（如何）
- 每个测试一个逻辑断言

## 坏测试

**实现细节测试**：耦合到内部结构。

```typescript
// 坏：测试实现细节
test('结账调用 paymentService.process', async () => {
	const mockPayment = jest.mock(paymentService);
	await checkout(cart, payment);
	expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

危险信号：

- Mock 内部协作者
- 测试私有方法
- 断言调用次数/顺序
- 重构（无行为变化）时测试中断
- 测试名称描述 HOW 而非 WHAT
- 通过外部手段而非接口验证

```typescript
// 坏：绕过接口验证
test('createUser 保存到数据库', async () => {
	await createUser({ name: 'Alice' });
	const row = await db.query('SELECT * FROM users WHERE name = ?', ['Alice']);
	expect(row).toBeDefined();
});

// 好：通过接口验证
test('createUser 使可检索到用户', async () => {
	const user = await createUser({ name: 'Alice' });
	const retrieved = await getUser(user.id);
	expect(retrieved.name).toBe('Alice');
});
```

**同义反复测试**：期望值重述了实现，因此测试在构造上必然通过。

```typescript
// 坏：期望值用与代码相同的方式重新计算
test('calculateTotal 求和行项目', () => {
	const items = [{ price: 10 }, { price: 5 }];
	const expected = items.reduce((sum, i) => sum + i.price, 0);
	expect(calculateTotal(items)).toBe(expected);
});

// 好：期望值是独立的已知字面量
test('calculateTotal 求和行项目', () => {
	expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```
