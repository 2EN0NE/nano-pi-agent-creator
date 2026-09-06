# bench 后台运行、进度查询与断点续跑

bench 真实评测单次可达几小时且烧真钱，因此运行模式锁定为「后台跑 + 结构化进度查询 + 显式断点续跑」：`run-matrix.sh` 强制显式 `--model`（preflight 校验）、tee `run.log`、写 `progress.json`，并新增 `bench-status.sh` 查询与 `--resume <run-id>` 续跑。

- **状态**：accepted
- **考虑过的选项**：
    - **模型默认值**：保留隐式默认 `cli-proxy-api/deepseek-v4-flash`（旧行为）——否决，该 provider 已不在 `models-store.json`（实际是 `deepseek/`），新机器上必炸，且烧钱不该有「碰运气」的默认；自动探测第一个可用模型——否决，可能选中昂贵默认、配对对比要求同轮固定模型，不可控。故选「强制显式 + preflight fail-fast」。
    - **续跑语义**：自动跳过已完成 cell（无开关）——否决，同 run-id 内半成品 `result.json` 会被误判跳过、掩盖失败；始终全量重跑——否决，中断后重烧已完成 cell 的钱。故选显式 `--resume`，跳过「`result.json` 存在且含 `reward_binary`」的 cell，其余（含中断/残缺）重跑，配置不一致拒绝——**与上游 DeepSWE/Harbor `job resume` 的 reconciliation 语义对齐**（已完成 trial 跳过、残缺 trial 删除重跑、换配置 `FileExistsError` 拒绝）。
    - **进度形态**：仅靠 stdout 解析——否决，后台跑无法可靠查询；故选结构化 `progress.json`（`progress.py` 单一读写 seam，可单元测试）+ `bench-status.sh` 人类可读渲染。
- **后果**：`bench-run` 技能依赖 `progress.json`/`run.log`/`--resume` 这套契约（agent 查进度、下结论）；`run-cell.sh` 的看门狗改为轮询式（`sleep 1`），消除原单次长 `sleep` 被 kill 后孤儿进程占用 stdout 管道导致的挂起；新增 `bench/test_progress.py` 覆盖 progress 生命周期。
