/**
 * Commands Extension
 *
 * 通过 /commands 列出当前会话可用的斜杠命令。
 *
 * 用法：
 *   /commands                → 列出全部命令（带搜索过滤）
 *   /commands <source>       → 按来源过滤（extension/prompt/skill）
 *
 * 与 tools/skills 子模块一致：复用 SettingsList（输入即搜索），
 * Enter 查看命令来源路径，Esc/q 关闭。
 */
import type {
	ExtensionAPI,
	SlashCommandInfo,
	SlashCommandSource,
} from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme, DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Container, type SettingItem, SettingsList, Text } from '@earendil-works/pi-tui';
import { TitleBar } from '../../../src/tui/helpers.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('commands');

const SOURCE_LABEL: Record<SlashCommandSource, string> = {
	extension: '扩展',
	prompt: '提示词',
	skill: '技能',
};

export default function commandsExtension(pi: ExtensionAPI) {
	log.debug('Registering /commands command');
	pi.registerCommand('commands', {
		description: '列出可用的斜杠命令',
		getArgumentCompletions: (prefix) => {
			const sources: SlashCommandSource[] = ['extension', 'prompt', 'skill'];
			const filtered = sources.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const sourceFilter = args.trim() as SlashCommandSource | '';
			const commands = pi.getCommands();
			const filtered = sourceFilter
				? commands.filter((c) => c.source === sourceFilter)
				: commands;
			log.debug(
				'Executed /commands: filter=%s, total=%d, filtered=%d',
				sourceFilter || '(all)',
				commands.length,
				filtered.length,
			);

			if (filtered.length === 0) {
				ctx.ui.notify(
					sourceFilter ? `No ${sourceFilter} commands found` : 'No commands found',
					'info',
				);
				return;
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = filtered.map((cmd: SlashCommandInfo) => ({
					id: cmd.name,
					label: `/${cmd.name}`,
					description: cmd.description,
					currentValue: SOURCE_LABEL[cmd.source] ?? cmd.source,
					// values: [''] 让 Enter 触发 onChange（值不变，仅用于「选中执行」语义）
					values: [''],
				}));

				const container = new Container();
				container.addChild(
					new TitleBar('可用命令', (s) => theme.fg('accent', theme.bold(s))),
				);
				container.addChild(
					new Text(theme.fg('dim', '  (输入即搜索 · Enter 查看来源 · Esc 关闭)'), 1, 0),
				);
				container.addChild(new Text('', 1, 0));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id) => {
						const cmd = commands.find((c) => c.name === id);
						done(undefined);
						if (cmd?.sourceInfo.path) {
							void (async () => {
								const showPath = await ctx.ui.confirm(
									cmd.name,
									`View source path?\n${cmd.sourceInfo.path}`,
								);
								if (showPath) ctx.ui.notify(cmd.sourceInfo.path, 'info');
							})();
						}
					},
					() => done(undefined),
					{ enableSearch: true },
				);

				container.addChild(settingsList);
				container.addChild(new DynamicBorder((s) => theme.fg('accent', s)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
