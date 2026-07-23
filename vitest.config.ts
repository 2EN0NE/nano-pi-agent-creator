import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/vitest/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/.pi/**', '**/results/**'],
		// e2e 测试可能耗时较长
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// TUI 测试（node-pty）会启动真实 pi -a 进程且操作沙箱文件系统，
		// 并行执行会导致沙箱/端口冲突、TTY 竞争和 stale 状态拾取。
		// 使用 forks pool + 串行文件执行确保测试可靠。
		pool: 'forks',
		fileParallelism: false,
		// CI 环境下额外输出 JUnit 格式
		...(process.env.CI
			? {
					reporter: ['default', 'junit'],
					outputFile: {
						junit: 'test/results/vitest-junit.xml',
					},
				}
			: {}),
	},
});
