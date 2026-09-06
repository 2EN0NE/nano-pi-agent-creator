/**
 * ci-watch 核心逻辑 — Vitest 单元测试
 *
 * 测试 src/ci-logic.ts 中的纯函数（无 Pi / execSync 依赖）：
 *   - extractPushInfo：从 git push 输出提取分支/SHA
 *   - evaluateBranchRuns：分支 run 状态评估（含 expectedSha 等待新 run 逻辑）
 *   - evaluatePrChecks：PR checks 状态评估（空 checks 视为 pending）
 *   - nextPollDelay / isValidBranch / isPrRef
 */
import { describe, it, expect } from 'vitest';
import {
	extractPushInfo,
	evaluateBranchRuns,
	evaluatePrChecks,
	nextPollDelay,
	isValidBranch,
	isPrRef,
	decidePollStep,
	type RunInfo,
} from '../../../extensions/verification/ci-watch/src/ci-logic';

// ============================================================================
// extractPushInfo
// ============================================================================
describe('extractPushInfo', () => {
	it('提取 main 增量 push 的分支与短 SHA', () => {
		const out =
			'To github.com:2EN0NE/nano-pi-agent-creator.git\n   0ed3326b..040c8427  main -> main';
		expect(extractPushInfo(out)).toEqual({ branch: 'main', sha: '040c8427' });
	});

	it('提取新分支首次 push（new branch 行）', () => {
		const out =
			'To github.com:2EN0NE/nano-pi-agent-creator.git\n * [new branch]      dev -> dev';
		expect(extractPushInfo(out)).toEqual({ branch: 'dev', sha: null });
	});

	it('提取带 set upstream 的新分支（track 行优先于 new branch 行的场景）', () => {
		const out = [
			"branch 'feature/x' set up to track 'origin/feature/x'.",
			'To github.com:2EN0NE/nano-pi-agent-creator.git',
			' * [new branch]      feature/x -> feature/x',
		].join('\n');
		expect(extractPushInfo(out)).toEqual({ branch: 'feature/x', sha: null });
	});

	it('提取强制推送（三个点 + forced update）', () => {
		const out =
			'To github.com:2EN0NE/nano-pi-agent-creator.git\n + abc123...def456  main -> main (forced update)';
		expect(extractPushInfo(out)).toEqual({ branch: 'main', sha: 'def456' });
	});

	it('tag push 不匹配任何分支形态', () => {
		const out =
			'To github.com:2EN0NE/nano-pi-agent-creator.git\n * [new tag]         v0.1.0 -> v0.1.0';
		expect(extractPushInfo(out)).toEqual({ branch: null, sha: null });
	});

	it('无法识别时返回 null/null', () => {
		expect(extractPushInfo('Everything up-to-date')).toEqual({ branch: null, sha: null });
		expect(extractPushInfo('')).toEqual({ branch: null, sha: null });
	});
});

// ============================================================================
// evaluateBranchRuns
// ============================================================================
describe('evaluateBranchRuns', () => {
	const runs: RunInfo[] = [
		// 最新：old run（completed success）—— 不应被 expectedSha 误判
		{
			name: 'CI',
			status: 'completed',
			conclusion: 'success',
			databaseId: 200,
			headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		},
		// 目标：新 run（pending）—— push 后刚触发
		{
			name: 'CI',
			status: 'in_progress',
			conclusion: '',
			databaseId: 201,
			headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		},
	];

	it('expectedSha 匹配到 completed success → pass（忽略更旧的失败 run）', () => {
		const runs2: RunInfo[] = [
			{
				name: 'CI',
				status: 'completed',
				conclusion: 'success',
				databaseId: 300,
				headSha: 'cccccccccccccccccccccccccccccccccccccccc',
			},
			{
				name: 'CI',
				status: 'completed',
				conclusion: 'failure',
				databaseId: 299,
				headSha: 'dddddddddddddddddddddddddddddddddddddddd',
			},
		];
		const r = evaluateBranchRuns(runs2, 'cccccccccccccccccccccccccccccccccccccccc');
		expect(r.status).toBe('pass');
		expect(r.failedRuns).toEqual([]);
	});

	it('expectedSha 匹配到 pending run → pending', () => {
		const r = evaluateBranchRuns(runs, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
		expect(r.status).toBe('pending');
	});

	it('expectedSha 匹配到 completed failure → fail（含 run 名）', () => {
		const runs2: RunInfo[] = [
			{
				name: 'CI',
				status: 'completed',
				conclusion: 'failure',
				databaseId: 301,
				headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
			},
		];
		const r = evaluateBranchRuns(runs2, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
		expect(r.status).toBe('fail');
		expect(r.failedRuns).toEqual(['CI']);
	});

	it('expectedSha 未匹配（push 后新 run 尚未出现）→ pending + noRunsFound', () => {
		// 列表中只有旧 run（headSha 不匹配），这正是修复的核心场景：
		// 旧实现会误读旧 run 状态（completed success → 误报 pass）
		const oldOnly: RunInfo[] = [
			{
				name: 'CI',
				status: 'completed',
				conclusion: 'success',
				databaseId: 200,
				headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			},
		];
		const r = evaluateBranchRuns(oldOnly, 'ffffffffffffffffffffffffffffffffffffffff');
		expect(r.status).toBe('pending');
		expect(r.noRunsFound).toBe(true);
	});

	it('空 runs → pending + noRunsFound（新分支首次 push）', () => {
		const r = evaluateBranchRuns([], 'ffffffffffffffffffffffffffffffffffffffff');
		expect(r.status).toBe('pending');
		expect(r.noRunsFound).toBe(true);
	});

	it('无 expectedSha 时评估最新 run（runs[0]）', () => {
		const r = evaluateBranchRuns(runs, null);
		// runs[0] 是 completed success（旧 run），手动监控分支的既有语义
		expect(r.status).toBe('pass');
	});

	it('无 expectedSha 且无 run → pending + noRunsFound', () => {
		const r = evaluateBranchRuns([], null);
		expect(r.status).toBe('pending');
		expect(r.noRunsFound).toBe(true);
	});

	it('neutral conclusion 视为 pass', () => {
		const r = evaluateBranchRuns(
			[
				{
					name: 'CI',
					status: 'completed',
					conclusion: 'neutral',
					databaseId: 302,
					headSha: '1111111111111111111111111111111111111111',
				},
			],
			null,
		);
		expect(r.status).toBe('pass');
	});
});

// ============================================================================
// evaluatePrChecks
// ============================================================================
describe('evaluatePrChecks', () => {
	it('空 checks（push 后尚未注册）→ pending，而不是误报 pass', () => {
		const r = evaluatePrChecks([]);
		expect(r.status).toBe('pending');
	});

	it('有 pending check → pending', () => {
		const r = evaluatePrChecks([
			{ name: 'CI', state: 'IN_PROGRESS', bucket: 'pending' },
			{ name: 'lint', state: 'SUCCESS', bucket: 'pass' },
		]);
		expect(r.status).toBe('pending');
	});

	it('全部通过 → pass', () => {
		const r = evaluatePrChecks([
			{ name: 'CI', state: 'SUCCESS', bucket: 'pass' },
			{ name: 'lint', state: 'SUCCESS', bucket: 'pass' },
		]);
		expect(r.status).toBe('pass');
	});

	it('存在失败 check → fail（含失败名称列表）', () => {
		const r = evaluatePrChecks([
			{ name: 'CI', state: 'FAILURE', bucket: 'fail' },
			{ name: 'lint', state: 'SUCCESS', bucket: 'pass' },
		]);
		expect(r.status).toBe('fail');
		expect(r.failedRuns).toEqual(['CI']);
	});
});

// ============================================================================
// decidePollStep — 轮询循环单步决策
// ============================================================================
describe('decidePollStep', () => {
	const base = {
		noRunsFound: false,
		expectedSha: null,
		consecutiveEmptyPolls: 0,
		maxEmptyPolls: 3,
		elapsed: 0,
		maxWaitMs: 600_000,
	};

	it('error → 立即终止（error）', () => {
		const d = decidePollStep({ ...base, status: 'error' });
		expect(d).toEqual({ action: 'return', outcome: 'error' });
	});

	it('pass → 立即终止（pass）', () => {
		const d = decidePollStep({ ...base, status: 'pass' });
		expect(d).toEqual({ action: 'return', outcome: 'pass' });
	});

	it('fail → 立即终止（fail）', () => {
		const d = decidePollStep({ ...base, status: 'fail' });
		expect(d).toEqual({ action: 'return', outcome: 'fail' });
	});

	it('pending（非 noRunsFound）→ 继续并重置 empty 计数', () => {
		const d = decidePollStep({
			...base,
			status: 'pending',
			consecutiveEmptyPolls: 2,
		});
		expect(d).toEqual({ action: 'continue', consecutiveEmptyPolls: 0 });
	});

	it('noRunsFound + expectedSha（push 后等待新 run）→ 继续且计数不变（核心修复：不 fast-fail）', () => {
		const d = decidePollStep({
			...base,
			status: 'pending',
			noRunsFound: true,
			expectedSha: 'ab'.padEnd(40, '0'),
			consecutiveEmptyPolls: 2,
		});
		expect(d).toEqual({ action: 'continue', consecutiveEmptyPolls: 2 });
	});

	it('noRunsFound + 手动模式 + 未达上限 → 继续且计数递增', () => {
		const d = decidePollStep({
			...base,
			status: 'pending',
			noRunsFound: true,
			consecutiveEmptyPolls: 1,
		});
		expect(d).toEqual({ action: 'continue', consecutiveEmptyPolls: 2 });
	});

	it('noRunsFound + 手动模式 + 达上限 → 快速失败（no-runs，区别于 gh 出错）', () => {
		const d = decidePollStep({
			...base,
			status: 'pending',
			noRunsFound: true,
			consecutiveEmptyPolls: 2,
		});
		expect(d).toEqual({ action: 'return', outcome: 'no-runs' });
	});

	it('pending 超过 maxWaitMs → timeout', () => {
		const d = decidePollStep({
			...base,
			status: 'pending',
			elapsed: 600_000,
		});
		expect(d).toEqual({ action: 'return', outcome: 'timeout' });
	});

	it('noRunsFound + expectedSha + 超过 maxWaitMs → timeout（等待新 run 的兜底）', () => {
		const d = decidePollStep({
			...base,
			status: 'pending',
			noRunsFound: true,
			expectedSha: 'cd'.padEnd(40, '0'),
			elapsed: 700_000,
		});
		expect(d).toEqual({ action: 'return', outcome: 'timeout' });
	});
});

// ============================================================================
// nextPollDelay / isValidBranch / isPrRef
// ============================================================================
describe('基础工具函数', () => {
	it('nextPollDelay 按步长递增', () => {
		const config = { minMs: 30_000, maxMs: 60_000, stepMs: 15_000 };
		expect(nextPollDelay(30_000, config)).toBe(45_000);
		expect(nextPollDelay(45_000, config)).toBe(60_000);
	});

	it('nextPollDelay 超过最大值后回到最小值', () => {
		const config = { minMs: 30_000, maxMs: 60_000, stepMs: 15_000 };
		expect(nextPollDelay(60_000, config)).toBe(30_000);
	});

	it('isValidBranch 只允许安全字符', () => {
		expect(isValidBranch('main')).toBe(true);
		expect(isValidBranch('feature/foo-bar.1')).toBe(true);
		expect(isValidBranch('bad;rm -rf')).toBe(false);
		expect(isValidBranch('a b')).toBe(false);
	});

	it('isPrRef 只识别纯数字', () => {
		expect(isPrRef('12')).toBe(true);
		expect(isPrRef('main')).toBe(false);
		expect(isPrRef('1a')).toBe(false);
	});
});
