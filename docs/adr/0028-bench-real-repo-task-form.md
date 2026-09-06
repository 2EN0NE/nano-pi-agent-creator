# bench 任务形态锁定为真实 repo 改动

bench 的 task 沿用 pi-fabric 的真实 repo 改动形态（`task.json` + `prompt.txt` + `verify.sh`，checkout base_ref → agent 改代码 → verify.sh 验收 patch），明确**不做** prompt 级 / 轻量沙箱的多形态扩展。

- **状态**：accepted
- **考虑过的选项**：给 task.json 加 `type` 字段支持 prompt 级 / 沙箱 repo 形态——否决。nano 首批打样与 pi-fabric 口径对齐优先，多形态会稀释评测范式的可比性；真实 repo 是唯一公认的 DeepSWE 风格基准负载。
- **后果**：真实 repo 任务资产须逐个准备（首批照搬 pi-fabric 的 scc + superjson）。纯上下文/meta 类插件也必须在真实编码任务上体现边际价值，否则不适用此 bench。
