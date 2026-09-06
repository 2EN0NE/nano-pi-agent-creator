# ADR-0025: pi-lab 实验形态分类学（select vs record + 臂来源二分类）

ADR-0023 确立了「能力变体」口径（臂 = 工具集切或参数切，扩展启停排除），但未区分**实验形态**——即「这个维度该由 pi-lab 随机分流，还是只统计用户的选择结果」。在接入 tools / preset / mode-switcher 等配置载体插件时，这一缺口暴露：edit 是「随机分流比客观指标」，custom-compaction 却是「用户主动选 profile、pi-lab 只统计满意度」，两种形态此前混称「能力变体」，导致接入新插件时无法判定该走哪条路。

本次确立**实验形态分类学**：两个正交维度——**实验形态**（select 型 / record 型）与**臂来源**（代码实现变体 / 配置状态变体）——加一条**形态选择判据**（用户对该维度有无明确偏好）。

## 决策

### 1. 实验形态二分类

| 形态          | 干预方式                                                  | 信号性质                           | 适用场景                                            |
| ------------- | --------------------------------------------------------- | ---------------------------------- | --------------------------------------------------- |
| **select 型** | `select()` 随机（stable-hash）分臂，`record()` 报客观指标 | 客观指标（成功率、节省量、错误率） | 用户对该维度无明确偏好，可安全随机分流              |
| **record 型** | 只 `record()` 不 `select()`，臂 = 用户可选配置项          | 满意度（回退/切换/重压等行为信号） | 用户有明确偏好，主动选配置即意图，pi-lab 不干预选择 |

参考实现：edit（select 型，`edit-strategy`）与 custom-compaction（record 型，`profile-satisfaction`）。

### 2. 臂来源二分类（补足 ADR-0023 的「能力变体」）

- **代码实现变体**：臂 = 同一能力的多种代码实现。例：edit 的 `classic`（精确匹配）vs `row-script`（模糊行匹配）。
- **配置状态变体**：臂 = 配置载体插件的配置状态本身，无需另写实现代码。例：preset id、mode id、工具范围档位。

两种臂来源均可同时存在于两种形态下：smart-context 的 `compression-aggression` 是 select 型 + 配置状态变体（参数切），custom-compaction 是 record 型 + 配置状态变体。

### 3. 形态选择判据

**用户对该维度有无明确偏好 → 有偏好走 record（不干预）、无偏好走 select（可随机分流）。**

理由：用户主动选 preset/mode 是明确意图，pi-lab 若随机切换会违背用户意志（数据也会被「用户不满被随机切走」污染）。反之，用户对「工具数量」这类维度通常无明确偏好，可安全随机分流以比较客观指标。

### 4. 已确认的插件到形态映射

| 插件              | 实验名                 | 形态   | 臂来源               |
| ----------------- | ---------------------- | ------ | -------------------- |
| edit              | edit-strategy          | select | 代码实现变体         |
| custom-compaction | profile-satisfaction   | record | 配置状态变体         |
| smart-context     | compression-aggression | select | 配置状态变体（参数） |
| tools             | tool-range             | select | 配置状态变体         |
| preset            | preset-usage           | record | 配置状态变体         |
| mode-switcher     | mode-usage             | record | 配置状态变体         |

## 考虑过的选项

- **统一用 select 型（否决）**：把所有维度都随机分流。违背「用户有明确偏好时不干预」——用户选 preset 是明确意图，随机切走会让实验干预用户行为、污染满意度信号（不满可能源于「被切走」而非「配置本身差」）。
- **统一用 record 型（否决）**：把所有维度都只统计不干预。对「用户无偏好」的维度（如工具数量），用户不会主动选择，record 型永远收不到数据，失去 A/B 意义。
- **臂来源不区分（否决）**：把「配置状态变体」强行包装成「代码实现变体」（为每个配置状态写一套实现）。配置载体插件本就只有配置状态，强造实现是伪抽象；承认「配置状态本身就是臂」才能让 preset/tools 这类插件零成本接入。

## 后果

- 新插件接入 pi-lab 前，先回答「用户对该维度有无明确偏好」，据此选定 select / record 形态，再判定臂来源（代码实现 vs 配置状态）。
- CONTEXT.md 新增「实验形态分类学」小节，与现有 pi-lab 术语表合并，`select 型`/`record 型`/`臂来源`成为共享词汇。
- custom-compaction 的「只 record 不 select」不再被视为特例，而是 record 型的规范形态；edit 的「select + 日志信号」是 select 型的规范形态。
- tools / preset / mode-switcher 的后续接入按此分类学落地（见各自 TODO）。

## 参考

- `docs/adr/0023-pi-lab-passive-signal-source-and-layering.md` — 能力变体口径（臂 = 工具集切或参数切）
- `docs/adr/0017-custom-compaction-layered-writes-and-lab.md` — record 型（profile-satisfaction）先例
- `extensions/accuracy/edit/index.ts` — select 型（edit-strategy）先例
