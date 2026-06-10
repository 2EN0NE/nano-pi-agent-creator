# Agent Notes

## 本地同步

这个仓库当前只面向本人本地使用，不做正式发布。

如需把资源同步到本地 Pi 代理目录，请执行：

```bash
./scripts/sync-to-local-pi.sh
```

默认会把资源同步到当前项目的 .pi/agents；如果要改成同步到用户目录 ~/.pi/agents，可使用：

```bash
./scripts/sync-to-local-pi.sh --target user
```

如果要同时同步到两个位置，则用：

```bash
./scripts/sync-to-local-pi.sh --target both
```

如果只想预览要同步的内容，可先运行：

```bash
./scripts/sync-to-local-pi.sh --dry-run
```

## 扩展开发

Pi 扩展放在 [extensions](extensions) 目录中；修改时请在这里更新。若需要参考内部实现，可查看 `pi-mono`，但不要改动其源码。
