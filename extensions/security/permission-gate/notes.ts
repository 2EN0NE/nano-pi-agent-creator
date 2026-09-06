/**
 * permission-gate — 内置命中解释文案（ADR-0025/0030 补充）
 *
 * 命中弹窗详情页（ConfirmTree）逐条展示「为什么危险」的解释。
 * 文案来源优先级：条目 note（用户/内置预填）→ 分类兜底文案。
 *
 * 内置命令清单（dangerCommands / permissionCommands）与默认拦截模式（patterns）
 * 的官方解释集中于此，加载配置时通过 injectBuiltinNotes 注入到「note 为空」的条目，
 * 不覆盖用户自己写的 note。用户自增条目未写 note 时，展示层落入分类兜底文案。
 */

export type ReasonKey =
	| 'destructive'
	| 'permission-related'
	| 'credential'
	| 'system-dir-write'
	| 'system-dir-read'
	| 'pattern';

/** 危险命令清单（默认 15 条）→ 官方解释 */
export const DANGER_COMMAND_NOTES: Record<string, string> = {
	dd: '直接读写块设备/文件，参数错误会无提示覆写磁盘',
	mkfs: '格式化文件系统，会清空整个分区数据',
	fdisk: '修改分区表，误操作会导致分区不可访问',
	parted: '分区管理工具，写操作会改动分区边界',
	wipefs: '擦除文件系统签名，分区可能无法再识别',
	shred: '安全覆写文件内容，覆写后无法恢复',
	blkdiscard: '批量丢弃块设备存储，直接释放存储块',
	iptables: '修改包过滤规则，可能切断网络或锁死远程连接',
	nftables: '修改包过滤规则，可能切断网络或锁死远程连接',
	ip6tables: '修改 IPv6 包过滤规则，可能切断网络',
	arptables: '修改 ARP 过滤规则，可能影响二层连通',
	shutdown: '关机系统，中断所有运行中的任务',
	reboot: '重启系统，中断所有运行中的任务',
	halt: '停机，中断所有运行中的任务',
	poweroff: '断电关机，中断所有运行中的任务',
};

/** 权限命令清单（默认 22 条）→ 官方解释 */
export const PERMISSION_COMMAND_NOTES: Record<string, string> = {
	chmod: '修改文件权限位，递归误用会过度放开或改乱系统文件',
	chown: '修改文件属主，可能改乱系统文件归属',
	chgrp: '修改文件属组，可能改乱系统文件归属',
	sudo: '以提权身份执行，绕过当前用户权限边界',
	su: '切换用户身份（常至 root）',
	setfacl: '修改文件访问控制列表（ACL）',
	getfacl: '读取 ACL 配置，属权限信息侦察',
	chattr: '修改文件扩展属性（如 +i 锁定），可令文件不可删改',
	lsattr: '读取文件扩展属性，属权限信息侦察',
	usermod: '修改账户属性，可能影响登录与权限归属',
	useradd: '新增账户，可能引入未授权登录入口',
	userdel: '删除账户，可能影响归属文件与服务',
	groupmod: '修改用户组属性',
	groupadd: '新增用户组',
	groupdel: '删除用户组',
	mount: '挂载文件系统，可覆盖系统路径内容视图',
	umount: '卸载文件系统，可能中断依赖该挂载的服务',
	passwd: '修改账户密码',
	visudo: '编辑 sudoers 提权配置',
	setcap: '授予文件细粒度提权能力（capabilities）',
	getcap: '读取文件 capabilities，属权限信息侦察',
	chroot: '切换根目录视图，常配合提权或隔离',
};

/** 默认拦截模式（8 条）→ 官方解释（key = 正则字符串） */
export const DEFAULT_PATTERN_NOTES: Record<string, string> = Object.fromEntries([
	['\\brm\\s+(-rf?|--recursive)', 'rm -rf 递归强制删除，误删不可恢复'],
	['>\\s*/dev/', '直接写 /dev 设备文件，可能覆写磁盘或系统设备'],
	['\\bgit\\s+push\\s+.*(--force|--force-with-lease)', '强制推送改写远端历史，会覆盖他人提交'],
	['\\bgit\\s+reset\\s+--hard', '硬重置丢弃工作区与暂存改动，提交可能丢失'],
	['\\bdocker\\s+(rm|rmi|system\\s+prune)\\b', '删除容器/镜像或批量清理，镜像与数据不可恢复'],
	['\\bcurl.*\\|\\s*(ba)?sh', '管道直接执行远程脚本，内容不可审计（供应链风险）'],
	['\\bwget.*\\|\\s*(ba)?sh', '管道直接执行远程脚本，内容不可审计（供应链风险）'],
	['\\beval\\s+', '把字符串当代码执行，输入未清洗会注入执行'],
]);

/** 分类兜底文案：条目无 note 时的最后一道（含用户自增命令未写备注） */
export const FALLBACK_EXPLAIN: Record<ReasonKey, string> = {
	destructive: '破坏性命令，可能抹除或覆写数据',
	'permission-related': '权限相关操作，可能改变访问控制或提权',
	credential: '触及敏感凭证/密钥文件',
	'system-dir-write': '写入系统关键目录',
	'system-dir-read': '读取系统关键目录',
	pattern: '匹配拦截模式（未写备注）',
};
