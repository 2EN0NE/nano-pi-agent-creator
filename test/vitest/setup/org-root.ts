/**
 * org 配置根的 vitest 兜底 —— 防止用例写进用户真实的 `~/.pi/org`。
 *
 * 背景：org 命令路径的 `projectTask` 是 fire-and-forget，真正解析写盘路径发生在多个
 * `await` 之后；用例一旦在 `afterEach` 里 `delete process.env.ORG_ROOT`，`orgRoot()`
 * 就回落到真实 HOME（extensions/auto/org/util.ts），夹具任务会悄悄写进用户账本
 * （实测证据见 ADR-0045 / `.pi/todos/TODO.md`）。
 *
 * 两道防线：
 *   ① 本文件作为 `setupFiles` 在**每个测试文件的进程**里执行一次 → `ORG_ROOT` 无条件指向
 *      本文件专属临时目录。刻意**不用** `if (!process.env.ORG_ROOT)`：开发者 shell 里可能
 *      正导出真实 `ORG_ROOT`（开着 org 干活时），那样等于把泄漏原样放行。
 *   ② 清理时调用 `parkOrgRoot()`，把 `ORG_ROOT` 重新**指向**丢弃目录而不是 `delete`
 *      ——迟到写入落在系统临时目录，不落在真实 HOME。
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ORG_ROOT = mkdtempSync(join(tmpdir(), 'vitest-org-root-'));

/** 每个测试文件一个「丢弃目录」：所有 park 写入都落这里，不新建目录。 */
const parkedRoot = join(tmpdir(), `vitest-org-parked-${process.pid}`);

/**
 * `afterEach` 清理用：把 `ORG_ROOT` 指向丢弃目录。
 *
 * 不要写 `delete process.env.ORG_ROOT`——那会让迟到的 fire-and-forget 写入回落到真实
 * `~/.pi/org`（见文件头）。
 */
export function parkOrgRoot(): void {
	process.env.ORG_ROOT = parkedRoot;
}
