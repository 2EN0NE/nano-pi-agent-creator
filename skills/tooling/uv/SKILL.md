---
name: uv
description: '使用 `uv` 替代 pip/python/venv。用 `uv run script.py` 运行脚本，用 `uv add` 添加依赖，在独立脚本中使用内联脚本元数据。'
---

## 快速参考

```bash
uv run script.py                   # 运行脚本
uv run --with requests script.py   # 临时依赖运行
uv run python -m ast foo.py >/dev/null  # 验证语法，不写入 __pycache__
uv add requests                    # 向项目添加依赖
uv init --script foo.py            # 创建带内联元数据的脚本
```

## 内联脚本依赖

```python
# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
```

关于运行脚本、锁定和可重现性的完整详情，请参见 [scripts.md](scripts.md)。

## 构建后端

对于纯 Python 包，使用 `uv_build`：

```toml
[build-system]
requires = ["uv_build>=0.9.28,<0.10.0"]
build-backend = "uv_build"
```

关于项目结构、命名空间和文件包含，请参见 [build.md](build.md)。
