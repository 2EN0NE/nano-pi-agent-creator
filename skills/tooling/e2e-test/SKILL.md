---
name: e2e-test
description: >
    完成扩展或技能的编码修改后，按标准流程搭建隔离环境进行端到端集成测试并生成可查阅的测试报告。
    包含依赖检测、场景设计、测试执行、AI 衡量非标结果、结果报告全流程。
---

# End-to-End Test

## 何时执行

在以下任务的**最后一步**执行，确认无误后再向用户报告"已完成"：

- 新建、修改、重构任何**扩展**（`extensions/*.ts` 或 `extensions/*/index.ts`）
- 新建、修改、重构任何**技能**（`skills/*/SKILL.md` 及其关联脚本）
- 修改与扩展/技能加载相关的**基础设施**（如 `package.json` 的 pi 配置、日志体系等）

## 流程总览

```
1. 识别改动范围
2. 确定对应测试模块
3. 设计/补充测试场景
4. 执行测试
5. 查看汇总报告
6. AI 衡量非标结果
7. 报告并确认完成
```

---

## 1. 识别改动范围

用 `git diff --name-status HEAD` 或 `git status` 列出变更文件，归入三类：

- **扩展** — `extensions/*.ts` 或 `extensions/*/` 目录
- **技能** — `skills/*/SKILL.md` 或关联脚本
- **基础设施** — `package.json` 的 pi 配置、AGENTS.md、`test/` 等

根据类型确定对应的测试模块路径：

| 源模块              | 测试模块路径                        |
| ------------------- | ----------------------------------- |
| `extensions/foo.ts` | `test/extensions/foo/smoke.test.sh` |
| `extensions/foo/`   | `test/extensions/foo/smoke.test.sh` |
| `skills/foo/`       | `test/skills/foo/smoke.test.sh`     |

---

## 2. 检测依赖（纯指令，无自动化脚本）

对于扩展文件，手动分析 import 语句找出依赖：

1. **读取修改的 `.ts` 文件**
2. **查找本地 import**（以 `./` 或 `../` 开头）：
    - `from "./pi-logger/api.js"` → 依赖 `pi-logger`
    - `from "../resources-tree/scanner.js"` → 依赖 `resources-tree`
3. **查找扩展间依赖**（通过 `pi.on` / `pi.registerTool` 等 API 间接引用）
4. **列出所有需要一同拷贝的依赖扩展**

对于技能：

1. **读取 `SKILL.md`** 中引用的脚本路径
2. **读取 `scripts/` 目录**下的所有文件
3. **检查引用的外部工具**（如 `gh`、`node` 等）

**原则**：不确定时宁多勿少，所有疑似依赖一律拷贝到测试环境。

---

## 3. 设计/补充测试场景

每个测试场景对应一条可观察的证据。从用户的原始需求反推验证点：

### 场景类型

| 类型         | 测试方法                              | 判定方式                           |
| ------------ | ------------------------------------- | ---------------------------------- |
| **加载**     | `pi -a --no-session -p "hi"`          | 检查 exit code=0、日志无 ERROR     |
| **工具调用** | prompt 中要求 LLM 调用该工具          | 检查 stdout 含预期输出             |
| **命令**     | prompt 中包含 `/command`              | 检查 stdout 含命令反馈             |
| **日志输出** | 检查 `test/results/.../cases/*-logs/` | grep 关键日志行                    |
| **技能加载** | prompt 中要求加载技能                 | 检查 `<available_skills>` 中技能名 |

### 设计原则

- 每个验证点独立为一条 `test_it` 用例
- 自动化可判断的（exit code、日志模式匹配）→ 直接在 `test_it body` 中用 shell 判断
- 需要 AI 判读的（语义验证、UI 表现）→ 用 `mark_for_review` 标记，保留完整输出快照
- 如果一个功能有 N 个关键验证点，设计 N 条测试用例，而非 1 条大用例

### 测试文件组织

```
test/
├── extensions/<name>/
│   └── smoke.test.sh      ← 该扩展的所有测试
└── skills/<name>/
    └── smoke.test.sh      ← 该技能的所有测试
```

每个 `smoke.test.sh` 文件的模板：

```bash
#!/usr/bin/env bash
test_describe "模块名称"

test_it "用例1描述" <<'TEST'
  run_pi_and_check --extensions "pi-logger,依赖1" --prompt "test prompt" --expect-no-error
TEST

test_it "需要AI衡量的用例 [REVIEW]" <<'TEST'
  run_pi_and_check --extensions "pi-logger" --prompt "test prompt" --save-output
  mark_for_review "请检查输出是否包含预期的 XXX 行为"
TEST
```

---

## 4. 执行测试

### 方式一：使用测试运行器（推荐）

```bash
# 运行指定模块
bash test/scripts/run-e2e.sh --ext <name>
bash test/scripts/run-e2e.sh --skill <name>

# 运行全部
bash test/scripts/run-e2e.sh
```

运行器自动完成：

- 创建隔离的 `.pi/tmp/e2e-test-$$/` 临时目录
- 拷贝被测试模块 + 依赖到 `.pi/extensions/`
- 调用 `pi -a --no-session -p "<prompt>"`
- 收集 stdout 和 pi-logger 日志到 `test/results/<timestamp>/cases/`
- 生成 summary.md 和 summary.json

### 方式二：快速手动测试（不修改 test 文件时）

```bash
# 仅用 CLI flag 快速验证
pi -a --no-session -e ./extensions/foo.ts -p "test prompt"

# 带依赖的完整环境
mkdir -p .pi/tmp/e2e-test/quick/.pi/{extensions,logs}
cp -r extensions/pi-logger .pi/tmp/e2e-test/quick/.pi/extensions/
cp extensions/foo.ts .pi/tmp/e2e-test/quick/.pi/extensions/
cd .pi/tmp/e2e-test/quick
pi -a --no-session -p "test prompt"
```

---

## 5. 查看汇总报告

测试完成后，读取最新结果：

```bash
# 定位最新结果
LATEST=$(ls -1t test/results/ | head -1)

# 查看人类可读汇总
cat test/results/$LATEST/summary.md

# 查看单条用例详细日志（含 pi stdout + pi-logger）
cat test/results/$LATEST/cases/*.log
```

汇总报告包含：

```
| # | Case Name          | Status     | Evidence                      |
|---|--------------------|------------|-------------------------------|
| 1 | loads without err  | PASS       | ...                           |
| 2 | custom behavior    | [REVIEW]   | cases/002-custom-behavior.log |

Summary: 2 PASS, 1 NEEDS_REVIEW, 0 FAIL
```

---

## 6. AI 衡量非标结果

对 `[REVIEW]` 状态的用例，需要逐条查看并判断：

### 流程

```bash
# 1. 定位最新结果
LATEST=$(ls -1t test/results/ | head -1)

# 2. 提取所有 REVIEW 用例
grep "\[REVIEW\]" test/results/$LATEST/summary.md

# 3. 逐条读取 case log
#    提取 review 问题的描述（summary.md 的 Review Required Cases 章节）
#    读取对应的 case log 文件
#    判断预期行为是否符合
```

### 判断标准

对每条 REVIEW 用例，回答：

1. **预期行为是什么？**（来自 `mark_for_review` 的问题描述）
2. **实际输出是什么？**（来自 case log 中的 pi stdout 和日志）
3. **是否符合预期？** → 若符合标记为 **PASS**，不符合 **FAIL**

### 数量控制

- **如果 `[REVIEW]` 总计 ≤ 20 条** → 由 AI 全部逐条衡量判断
- **如果 `[REVIEW]` 总计 > 20 条** → **停止逐条衡量**，输出 warning：
    > ⚠️ 当前 REVIEW 用例数 (N) 超过阈值 (20)，非标准化结果过多，
    > 不适宜由 AI 全量判断。请用户手动比对 case 日志与预期结果。
    >
    > 建议：将大规模场景拆分为多个小批量测试，或将 REVIEW 用例改为
    > 自动化判断形式。

---

## 7. 报告并确认完成

向用户汇报测试结果：

```
【端到端测试报告】
模块：extensions/foo.ts
测试目录：test/results/2026-06-28T14-30-00Z/
结果：3 PASS, 1 [REVIEW], 0 FAIL

PASS 的用例：
  ✅ 加载无报错
  ✅ 工具调用正常工作

REVIEW 的用例：
  🔍 自定义场景行为（见 case log）

结论：所有自动化用例通过。REVIEW 用例已衡量，符合预期。
可确认此次修改完成。
```

---

## 注意事项

1. **不要跳过测试** — 即使是简单修改也需要最少 1 条加载测试
2. **测试前先同步** — 如果修改了 skill，先运行 `./scripts/sync-to-local-pi.sh` 同步到用户目录再测试
3. **保留测试日志** — `test/results/` 下的结果由 agent 和用户共同查阅，不在结束时清理
4. **测试目录不与原始项目冲突** — 所有隔离环境在 `.pi/tmp/` 下，不影响原始 `.pi/`
5. **测试环境需要有 git 仓库** — 部分扩展（如 review）依赖 git diff，测试目录也需要是 git 工作目录或模拟
