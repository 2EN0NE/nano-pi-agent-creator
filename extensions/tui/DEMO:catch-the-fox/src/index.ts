import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ANIMS, type FoxState } from './fox-art.js';
import { FoxWidget } from './fox-widget.js';

export { gridToAnsi } from './fox-widget.js';

function stateForTool(toolName: string): FoxState {
	const normalizedToolName = toolName.toLowerCase();
	if (/(read|grep|glob|find|search|ffgrep|list)/.test(normalizedToolName)) {
		return 'sniff';
	}
	if (/(edit|write|patch|replace)/.test(normalizedToolName)) {
		return 'dig';
	}
	if (/(bash|shell|exec|fetch|web|browser|curl)/.test(normalizedToolName)) {
		return 'run';
	}
	return 'sniff';
}

export default function catchTheFoxExtension(pi: ExtensionAPI): void {
	pi.registerFlag('fox-reduced-motion', {
		description: '保持狐狸静止，不播放连续动画',
		type: 'boolean',
		default: false,
	});
	pi.registerFlag('fox-scale', {
		description: '缩放狐狸的像素图 (0.5=半大小, 1=原尺寸)',
		type: 'string',
		default: '1',
	});

	const foxScale = Math.min(1, Math.max(0.1, parseFloat(pi.getFlag('fox-scale') as string) || 1));
	const fox = new FoxWidget(pi.getFlag('fox-reduced-motion') === true, foxScale);
	let errorStreak = 0;

	pi.on('session_start', async (_event, context) => {
		fox.setUI(context.ui);
		fox.setState('sleep');
	});

	pi.on('agent_start', async (_event, context) => {
		fox.setUI(context.ui);
		errorStreak = 0;
		fox.setState('sniff');
	});

	pi.on('tool_execution_start', async (event: any, context: any) => {
		fox.setUI(context.ui);
		fox.setState(stateForTool(event.toolName ?? ''));
	});

	pi.on('tool_result', async (event: any, context: any) => {
		fox.setUI(context.ui);
		if (event.isError) {
			errorStreak += 1;
			fox.setState(errorStreak >= 3 ? 'sad' : 'error');
		} else {
			errorStreak = 0;
		}
	});

	pi.on('agent_end', async (_event, context) => {
		fox.setUI(context.ui);
		if (errorStreak >= 3) {
			fox.setState('sad');
			return;
		}
		fox.completeTurn();
	});

	pi.on('session_shutdown', async () => {
		fox.shutdown();
	});

	pi.registerCommand('fox', {
		description:
			'控制狐狸: /fox <sleep|sniff|dig|run|jump|caught|error|sad|hide|show|scale <0.1-1>>',
		handler: async (args, context) => {
			if (!context.hasUI) {
				context.ui.notify('/fox 需要交互模式', 'error');
				return;
			}
			fox.setUI(context.ui);
			const parts = (args ?? '').trim().toLowerCase().split(/\s+/);
			const subCmd = parts[0];

			if (subCmd === 'scale' && parts[1]) {
				const parsed = parseFloat(parts[1]);
				if (isNaN(parsed) || parsed < 0.1 || parsed > 1) {
					context.ui.notify('缩放值需在 0.1 ~ 1 之间', 'warning');
					return;
				}
				fox.setScale(parsed);
				context.ui.notify(
					`狐狸缩放已调整为 ${parsed}，若要持久化请在启动时添加 --fox-scale ${parsed}`,
					'warning',
				);
				return;
			}

			if (subCmd === 'hide') {
				fox.hide();
				context.ui.notify('狐狸已隐藏 (/fox show 重新显示)', 'info');
				return;
			}
			if (subCmd === 'show') {
				fox.show();
				context.ui.notify('狐狸回来了！', 'info');
				return;
			}
			if (subCmd && subCmd in ANIMS) {
				fox.showState(subCmd as FoxState);
				return;
			}
			context.ui.notify(
				`状态列表: ${Object.keys(ANIMS).join(', ')} · hide · show · scale <0.1-1>`,
				'info',
			);
		},
	});
}
