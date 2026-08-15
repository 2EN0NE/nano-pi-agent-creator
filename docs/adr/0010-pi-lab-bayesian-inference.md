# pi-lab 统计推断：贝叶斯后验为主，频率学派不预建

**状态**: accepted

`query()` 的统计推断采用贝叶斯后验。共轭先验覆盖全部 Metric Type：binary→Beta、continuous→Normal-Gamma、count→Poisson-Gamma。结论形态为概率（P(arm i 更好)、credible interval、胜出概率），而非 p-value。

理由：现有 `record()` 已是 Beta-Bernoulli 贝叶斯更新；Pi 会话样本量小、无固定实验时长，频率学派的固定样本量/peeking 前提不成立；程序自动决策需要直接可用的概率。频率学派检验（t-test/z-test/p-value）留作可选扩展，不预建。

## 考虑过的选项

- **频率学派（p-value + 置信区间）**：被否决为主路径——需固定样本量、peeking 失效、p-value 需转译。
- **贝叶斯为主**：采纳。
