### 15. 判定模型（classifier）：存在性、验证步骤与插件研发用法

Pi 除 chat 之外还有两类**非对话模型**：`classifier`（判定模型，回答「是/否、多选一、打分」并给出概率）与 `image`（图像生成）。
两者**不出现在 `/model`**，只能经 `codemode` 脚本或扩展 API 调用。

判定模型的定位：**把「模糊判断」变成「带概率的结构化信号」**，用于路由、门禁、分级、批量分类。它不做生成，别指望它写代码或写文案。

本文档按 **存在性 → 如何验证 → 没有时怎么配 → 怎么用 → 边界** 组织。任何数字均为**某台机器上的实测记录**（见 15.3.3），
只作量级参考，**不是"你这里也能用"的断言**——每个环境都要自己走一遍 15.3。

---

#### 15.1 与 chat 模型的本质区别

| 维度     | chat 模型            | classifier                                                            |
| -------- | -------------------- | --------------------------------------------------------------------- |
| 输入     | 消息列表（messages） | `state`（JSON 对象，待判定数据）+ `questions`（按 ID 定义的问题）     |
| 输出     | 自由文本 / 工具调用  | `answers`，每题带**概率**（结构化字段，无需解析文本）                 |
| 能力     | 生成、推理、工具使用 | 只做判定：`bool`（真概率）/ `choice`（各选项概率）/ `score`（期望档） |
| 可见性   | `/model` 可选        | **不在 `/model`**，只能经 codemode 或扩展 API 调用                    |
| 确认方式 | 读文本               | 读 `stopReason` + `answers`；失败**不抛异常**                         |
| 成本     | 按 token 计价        | 取决于 catalog 的计价（自建/代理常为 0），token 仍计入会话            |

---

#### 15.2 存在性：Pi 侧有什么（与具体环境无关的事实）

> 下表路径基准：`dist/…` = `node_modules/@earendil-works/pi-coding-agent/dist/`，`pi-ai/…` = `node_modules/@earendil-works/pi-ai/`。

| 事实                                                                                                                                | 出处                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 模型按 `type` 分 `chat` / `image` / `classifier`，后两者需显式声明                                                                  | `docs/custom-provider.md`（「An omitted `type` means `"chat"`」）                               |
| `classifier` 的传输实现由 `classifiers: { <api>: { classify } }` 提供                                                               | 同上                                                                                            |
| 内置判定 API 家族：`typesafe-system-one`（含 `cloudflare-workers-ai-system-one`）                                                   | `pi-ai/dist/api/typesafe-system-one.js:8`、`pi-ai/dist/api/cloudflare-workers-ai-system-one.js` |
| 图像入参由**模型条目**的 `input`（`"text"` / `"image"`）决定；不支持时抛 `does not accept image input`                              | `pi-ai/dist/utils/model-operations.js:26`、`dist/core/model-config.d.ts:18`                     |
| 图片裁剪与上限由模型条目 `inputLimits.images` 声明（`resize` / `maxPerMessage` / `maxPerRequest`）                                  | `dist/core/model-config.d.ts:19-30`                                                             |
| 扩展 API 面已具备：`getModelsOfType` / `getAvailableOfType` / `findOfType` / `classify` / `generateImages` / `registerVirtualModel` | `dist/core/model-registry.d.ts`、`dist/core/extensions/types.d.ts`                              |
| `classify()` 源码注释明确 **never rejects**，失败只落在 `stopReason: "error"` + `errorMessage`                                      | `dist/core/model-runtime.js:558-571`、`pi-ai/dist/utils/model-operations.js:42`                 |

结论：**Pi 有判定模型这套机制**，且本仓库当前依赖的 `@earendil-works/pi-coding-agent` 1.3.0 类型面已齐备，**不需要升级依赖**。

但「机制存在」≠「你这个环境能用」：内置 catalog 里 `classifier` 条目不少（含 Cloudflare 的 `clef`、TypeSafe 的 `jev` 等），
**绝大多数没有凭证**（见 15.3 的实测：某环境 51 条 catalog 只有 1 条 available）。所以落地前必须验证。

---

#### 15.3 验证 → 尝试 → 确认（每个环境都要走一遍）

##### 15.3.1 验证：有没有、能不能用

```typescript
// ① catalog 里有哪些 classifier（有条目 ≠ 能用）
const all = ctx.modelRegistry.getModelsOfType('classifier'); // [{ provider, id, api, contextWindow, ... }]

// ② 真正可用 = 有凭证。注意 findOfType 只查 catalog、不校验凭证，不能当门控
const jev = ctx.modelRegistry.findOfType('classifier', 'typesafe', 'jev-latest');
const available = jev ? await ctx.modelRegistry.getAvailableOfType('classifier', jev.provider) : [];
const usable = available.some((m) => m.id === jev?.id);
```

实测反例（避免误判）：`findOfType('classifier', 'openai', 'gpt-6-luna')` **有值**，但
`getAvailableOfType('classifier', 'openai')` 返回 `[]`——说明当前环境没有该 provider 的凭证。

##### 15.3.2 尝试：一次最小冒烟（不启动 pi，只验传输层）

先把 `<BASE_URL>` / `<MODEL_ID>` / `<KEY_ENV>` 换成你环境的实际值；若拿不到，说明这门能力在你环境**尚未配置**（走 15.4）。

```bash
PI_AI="$HOME/.pi/agent/install/releases/$(cat "$HOME/.pi/agent/install/current-version")/node_modules/@earendil-works/pi-ai"
cat > /tmp/classifier-probe.mjs <<EOF
const R = '$PI_AI/dist';
const { classify } = await import(\`\${R}/api/typesafe-system-one.js\`);
const { TYPESAFE_CLASSIFIER_MODELS } = await import(\`\${R}/providers/typesafe.models.js\`);
// 用 catalog 条目（拿到正确的 api / input / cost / contextWindow），只覆盖 baseUrl
const model = { ...TYPESAFE_CLASSIFIER_MODELS['<MODEL_ID>'], baseUrl: '<BASE_URL>' };
const r = await classify(model, {
  state: { note: 'demo' },
  questions: { ok: { type: 'bool', instructions: 'Is the note positive?', criteria: { true: 'Positive', false: 'Otherwise' } } },
}, { apiKey: process.env.<KEY_ENV> });
console.log(r.stopReason, JSON.stringify(r.answers), r.errorMessage ?? '');
EOF
node /tmp/classifier-probe.mjs
```

> 这个脚本**手写了 baseUrl**，只适合验证传输层与网关；插件里不要这么写，走 `ctx.modelRegistry.classify()`（它读 `models.json`）。

##### 15.3.3 确认：什么算「可用」

| 观测                                                    | 结论                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `stopReason === "stop"`，`answers.<id>.type` 与题型一致 | 可用；再连跑 3–5 次看概率波动是否落在你能接受的范围         |
| `stopReason === "error"` + 401                          | 凭证缺失/无效：`apiKey` 的 `$ENV` 在 pi 进程环境里取不到    |
| `stopReason === "error"` + 422（`at least 1 item`）     | `choice.criteria` 传了空对象                                |
| `stopReason === "error"` + 400（invalid request）       | 题型写错（只允许 `bool`/`choice`/`score`）或 payload 不合法 |
| 客户端 0ms 报 `does not support image input`            | 该模型的 catalog 条目没有 `image` 输入，不是网关问题        |

**一份实测记录（示例环境，仅供量级参考）**：Pi 1.4.0 运行时，`typesafe` provider 以 `models.json` 覆盖方式指向一台
System One 兼容网关（`apiKey` 用 `$ENV` 插值）：

| 项                               | 观测                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| 直连传输层（bool/choice/score）  | 200，374ms，`usage` 462/72 tokens，`cost.total = 0`                        |
| 扩展内 `ctx.modelRegistry` 路径  | 352ms / 408ms，`stopReason: "stop"`                                        |
| 稳定性（同 state + 同 criteria） | 5 次概率 0.90 / 0.91 / 0.90 / 0.91 / 0.90，256–337ms，每次 351 tokens      |
| catalog 规模                     | `getModelsOfType('classifier')` 51 条，`getAvailableOfType` 仅 1 条        |
| 图像判定                         | catalog 声明 `input: ["text","image"]`，实际带图请求返回 400（服务端拒绝） |

---

#### 15.4 没配的情况下怎么配

**方式 1：`~/.pi/agent/models.json` 覆盖内置 provider（推荐，改动最小）**

```jsonc
{
	"providers": {
		"typesafe": {
			// 关键：baseUrl 必须与其协议前缀匹配——typesafe-system-one 向 `${baseUrl}/systemone` 发请求
			"baseUrl": "https://<your-gateway>/v1",
			// 覆盖方式下用这里的 apiKey，不要再指望 provider 自带的 TYPESAFE_API_KEY
			"apiKey": "$YOUR_KEY_ENV",
		},
	},
}
```

要点：

- **只写要改的字段**：不写 `models` 就保留内置 catalog 与传输实现（写了 `models` 等于整体替换 catalog，容易漂移）。
- 支持 `$NAME` / `${NAME}` 环境变量插值、`!command` 命令取值、`$$` / `$!` 转义。
- 环境变量必须在 **pi 进程**里可见：终端启动会继承 shell；GUI/Dock 启动不继承（→ 401 的常见原因），此时用 `/login` 或 Keychain 化。
- 判定质量取决于 `criteria` 的语义措辞，配置与 criteria 都应**版本化、冻结**，不要每次现场改。

**方式 2：接自建判定服务（`registerProvider` 完整形式）**

```typescript
pi.registerProvider('my-judge', {
	models: [
		{
			type: 'classifier',
			id: 'judge-v1',
			name: 'Judge V1',
			api: 'my-classifier',
			baseUrl: 'https://judge.example.com/v1',
			input: ['text'],
			contextWindow: 64000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	],
	classifiers: { 'my-classifier': { classify: async (model, context, options) => result } },
});
```

`type: 'classifier'` 与 `classifiers` 实现必须**成对**给；只给一边，catalog 里就多一条永远不可用的条目。

---

#### 15.5 三条访问路径

##### A. 扩展内调用（插件研发的推荐路径，也是唯一可产品化的路径）

```typescript
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('my-plugin');

pi.on('session_start', async (_event, ctx) => {
	// ① 验证：有 catalog 条目 + 有凭证
	const jev = ctx.modelRegistry.findOfType('classifier', 'typesafe', 'jev-latest');
	if (!jev) {
		log.warn('classifier not registered - fallback path', {});
		return;
	}
	const available = await ctx.modelRegistry.getAvailableOfType('classifier', jev.provider);
	if (!available.some((m) => m.id === jev.id)) {
		log.warn('classifier has no credentials - fallback path', {});
		return;
	}

	// ② 尝试：一次调用可问多题
	const t0 = Date.now();
	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { diff: patchText.slice(0, 16_000) }, // JSON 对象，自行截断
			questions: {
				needsE2E: {
					type: 'bool',
					instructions: 'Does this change require an end-to-end test run before merging?',
					criteria: {
						true: 'Runtime behavior of a Pi extension changed',
						false: 'Comment, doc, or formatting only',
					},
				},
				area: {
					type: 'choice',
					instructions: 'Which extension category does this change belong to?',
					criteria: {
						tui: 'Terminal UI',
						auto: 'Automation',
						security: 'Security',
						other: 'Anything else',
					},
				},
				risk: {
					type: 'score',
					instructions: 'How risky is merging as-is?',
					criteria: ['safe', 'needs review', 'needs e2e + manual check'],
				},
			},
		},
		{ signal: ctx.signal }, // 第三参数是 options；signal 在这里，不在 context 里
	);

	// ③ 确认：classify 永不 reject，失败只看这里
	if (result.stopReason !== 'stop') {
		log.warn('classifier call failed', {
			stopReason: result.stopReason,
			error: result.errorMessage,
		});
		return;
	}
	const e2e = result.answers.needsE2E;
	const area = result.answers.area;
	const risk = result.answers.risk;
	log.info('classifier verdict', {
		ms: Date.now() - t0,
		needsE2E: e2e?.type === 'bool' && e2e.probability >= 0.7,
		area: area?.type === 'choice' ? area.choice : undefined,
		risk: risk?.type === 'score' ? risk.score : undefined,
		tokens: result.usage?.totalTokens,
	});
});
```

要点：

- **题型只有三种**：`bool`（`criteria: { true, false }`）、`choice`（`criteria: Record<label, 说明>`，≥1 项）、`score`（`criteria: string[]`，低→高）。
- **`answers` 是按 `type` 判别的联合**：先判 `type` 再取值，别直接 `as` 强转。
- **`state` 声明为对象**（`JsonObject`）。实测传裸字符串也能通过（wire 原样透传），但不要依赖。
- 一次调用问多题比多次调用便宜：`questions` 是 map，一个请求回答全部。
- 第三个参数是 `ClassifierOptions`（`apiKey` / `headers` / `signal` / `requestOptions`），**不在 context 里**；在 `route()` 里调用会加首字延迟。

##### B. codemode 脚本（人工一次性使用，非插件路径）

`codemode` 工具默认**关闭**（除非 MCP 服务器打开过）。启用：`settings.json` 加 `"defaultTools": ["+codemode"]`，再让主模型执行脚本：

```js
const jev = await models.getModelOfType('classifier', 'typesafe', 'jev-latest');
const result = await models.classify(jev, {
	state: { message: 'The change works, thanks.' },
	questions: {
		approved: {
			type: 'bool',
			instructions: 'Does the user approve?',
			criteria: { true: 'Approve', false: 'No' },
		},
	},
});
return result.answers;
```

codemode 路径下 classifier 用量计入工具结果与会话用量（每脚本并发 4）。

##### C. 虚拟模型路由（`registerVirtualModel`）

官方范例 `examples/extensions/jev-router.ts`：注册一个虚拟模型，用判定模型判首条用户消息难度 → 选强/弱模型，
首个 `edit`/`write` 后切到便宜模型。关键契约（`docs/virtual-models.md`）：

- `route(request, ctx)` 每个请求前跑一次，返回 `{ model, thinkingLevel, state? }`；虚拟模型不能路由到另一个虚拟模型。
- `request.reason`：`user` / `continuation` / `retry` / `direct`。`continuation` 返回 `request.previous`、`retry` 返回 `request.failed` 才能保住 prompt cache。
- `request.state` 存在**会话分支**上（跟随 `/tree` 分叉、跨压缩存活），是路由决策（判定结论、phase）的唯一正规载体。
- 路由里调判定模型会增加首 token 延迟（量级见 15.3.3），别在每次 `continuation` 都判。
- 落地前先把 `models.json` / provider 里的模型 ID 与你实际后端对齐——ID 陈旧会 `find()` 到不存在的模型。
- **未用到的模型不要下线**：若虚拟模型的 `modelRegistry` 里弱/强模型之一不存在，`route()` 会直接抛错。

---

#### 15.6 对本项目插件研发的具体支持点

| 用途                            | 现状                                                                                                                                                                   | 建议做法                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 替代「用 chat 模型做弱判定」    | 已有同类实现：`extensions/auto/loop.ts`（Haiku 总结断出条件）、`extensions/auto/control`、`smart-context/src/router.ts`（`find` + `getApiKeyAndHeaders` + `complete`） | 纯二值/多选/打分改走判定模型：**不解析文本、不看上下文、通常更快**；但先按 15.3 验证可用性             |
| 门禁分级（是否要 e2e / 风险档） | 未实现                                                                                                                                                                 | 在 `tool_call` / `turn_end` 钩子里判 `bool` + `score`，过阈值才拦；**失败即放行**（fail-open）并记日志 |
| e2e `[REVIEW]` 用例衡量         | 目前靠主模型/人工逐条看（`test/README.md`：≤20 条全量衡量）                                                                                                            | 可把「这条日志是否显示目标 UI 状态」这类判定交给判定模型，批量并发（自行限流）                         |
| pi-lab 实验选臂                 | 现状是策略选臂（如 thompson-sampling）                                                                                                                                 | 若臂选择依赖「用户意图/请求类型」这类语义信号，可先用判定模型产出信号再喂给选臂策略                    |
| 路由/成本分层                   | 未实现，有官方范例                                                                                                                                                     | 见 15.5 C；先对齐模型 ID                                                                               |

**判定型能力的可观测要求**（与本仓库「可观测是首要前提」一致）：每次判定都要落
`{ 调用点, 耗时, 模型, 题目, 概率/choice, 阈值, 是否过阈值, stopReason, errorMessage, tokens }`，
否则「为什么这次没触发」无法复现。概率型信号**按阈值用，不要只取 `choice` 字段**。

---

#### 15.7 坑与边界

| 现象                                         | 原因 / 处理                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 401 / `stopReason: "error"`                  | `apiKey` 的 `$ENV` 在 pi 进程环境里取不到。终端启动继承 shell；GUI/Dock 启动不继承 → `/login` 或 Keychain 化 |
| 带图 400（服务端拒绝）                       | **catalog 声明 image ≠ 服务端支持 image**。要图像判定，先单独发一次带图请求验证                              |
| 客户端 0ms 报 `does not support image input` | 该模型 catalog 条目只有 `input: ["text"]`（不同 pi-ai 版本 catalog 数据不同，见 15.8），请求根本没发出去     |
| 422 `Dictionary should have at least 1 item` | `choice.criteria` 传了空对象。给 2–6 个语义清晰的选项                                                        |
| 400 `Invalid request`（未知题型）            | 题型只允许 `bool` / `choice` / `score`，写错类型直接在服务端 400                                             |
| `bool` 不传 `criteria` 也能通                | 服务端不强制，但**判定质量依赖 criteria 语义**，别省                                                         |
| 概率小幅漂移                                 | 同 state + 固定 criteria 浮动很小（量级见 15.3.3）；换措辞会改变分布 → criteria 冻结 + 阈值固定              |
| 会话成本显示很低/为 0                        | 取决于 catalog 计价（自建/代理常为 0）。token 仍计入会话用量                                                 |
| classifier 不在 `/model`                     | 正常现象，不是配置失败                                                                                       |
| `state` 过长                                 | catalog `contextWindow` 常见 64000；自行截断（范例用 16000 字符）                                            |

---

#### 15.8 版本差异（仓库 1.3.0 vs 全局 1.4.0）

- **API 面同构**：仓库内 `@earendil-works/pi-coding-agent`（1.3.0）的 `model-registry.d.ts` 已含
  `findOfType` / `getModelsOfType` / `getAvailableOfType` / `classify` / `generateImages` / `registerVirtualModel`，
  仓库内扩展可正常 typecheck，**无需升级依赖**。
- **catalog 数据不同**：同一 `jev-latest` 条目，1.3.0 是 `input: ["text"]` 且无 `compat`；1.4.0 是 `input: ["text","image"]` + `compat`。
  即图像判定的**客户端**可用性取决于运行时 pi-ai 版本；**服务端**是否接受仍需实测（示例环境不支持）。
- 运行时才是真的：e2e / 实际使用以 `$PI_BIN`（本仓库默认锚到 `node_modules/.bin/pi`）行为为准。

---

#### 15.9 未验证 / 待决

- 网关/服务端是否支持 `temperature`（logit 缩放）等调参——未测。
- 长 `state`（>10K tokens）下的延迟与稳定性——未测。
- 不同 `criteria` 措辞对概率分布的系统性影响——只做过单点对比，未做校准曲线。
- 是否把某条判定接进真实流程（门禁/路由/e2e 衡量）——**尚未落地任何代码**，本文档只固化「存在性 + 验证方法 + 配置方法 + 边界」。

---

#### 15.10 参考路径

- Pi 官方：`docs/models.md#use-classifier-models`、`docs/codemode.md#classify`、`docs/virtual-models.md`、`docs/custom-provider.md`（`type` / `classifiers` 声明）、`docs/llama-cpp.md`（`typesafe-system-one` 与 decision models）
- 官方范例：`examples/extensions/jev-router.ts`（虚拟模型路由）
- 传输层实现（读源码确认 URL 拼法）：`node_modules/@earendil-works/pi-ai/dist/api/typesafe-system-one.js`、`dist/api/system-one-shared.js`
- 类型与实现：`dist/core/model-registry.d.ts`、`dist/core/model-runtime.js:558`（`classify` 实现与 `classifierErrorResult`）
