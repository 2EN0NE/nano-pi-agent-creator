# pi-lab 面板定位：展示分析结论，不做切换推荐

**状态**: accepted

`/lab` 面板从"原始计数查看器"升级为"分析结论展示"：每个 metric 展示胜出概率、credible interval、guardrail 告警，胜出概率 ≥ 阈值（如 95%）的 arm 用 accent 色高亮。

面板不生成"建议切换到 arm X"的推荐——那是决策，归消费方（smart-context）或用户。这是对问题 1（pi-lab 不做决策）的一致贯彻：面板是"结论的镜子"，不是"决策的大脑"。顺带修复四个半成品：session/global tab 真正按 ctxKey 区分、winProbability 接入面板、Settings/Reset 接上已有的 forceArm/reset API、/lab 与 /experiment 文案统一。
