/**
 * Git 提交身份统一注入（测试基础设施约定）。
 *
 * 机制：环境变量无条件覆盖（优先级高于 git config，且不依赖 HOME）。
 * 根因：e2e 测试给 pi 进程隔离 HOME，git config --global 不可见；只有
 * 环境变量能穿透隔离，对 bash 脚本、node 进程、被隔离 HOME 的 pi 进程都生效。
 * 详见 test/README.md「Git Ident 注入约定」。
 */
process.env.GIT_AUTHOR_NAME = 'CI Bot';
process.env.GIT_AUTHOR_EMAIL = 'ci@nano-pi-agent-creator.invalid';
process.env.GIT_COMMITTER_NAME = 'CI Bot';
process.env.GIT_COMMITTER_EMAIL = 'ci@nano-pi-agent-creator.invalid';
