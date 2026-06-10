# Lint 检查和 Pre-commit 配置

本项目已配置 ESLint 和 Husky Pre-commit 检查，确保代码质量。

## 📋 已配置的工具

- **ESLint**: JavaScript/Node.js 代码风格检查
- **Husky**: Git hooks 管理器
- **lint-staged**: 仅在暂存文件上运行检查

## 🚀 使用方法

### 1. 安装依赖
```bash
npm install
```
Husky 会在 `npm install` 后自动初始化。

### 2. 运行 Lint 检查

#### 检查所有文件
```bash
npm run lint
```

#### 自动修复可修复的问题
```bash
npm run lint:fix
```

#### 仅检查暂存文件（Pre-commit）
```bash
npm run lint:staged
```

## 🔧 Pre-commit Hook

提交代码时，Husky 会自动运行 `.husky/pre-commit` 脚本，执行 `npm run lint:staged`，对暂存的文件进行 ESLint 检查。

- 如果检查失败，提交会被阻止 ❌
- 可用 `npm run lint:fix` 自动修复，然后重新提交 ✅

## 📝 ESLint 配置

配置文件：`eslint.config.js`

### 检查规则
- 使用 @eslint/js 推荐配置
- 支持 ES2024+ 语法
- 允许空 catch 块（用于静默错误）
- 检查未使用的变量和其他常见问题

### 忽略文件
- `node_modules/`
- `dist/`, `build/`
- `.husky/`
- `package-lock.json`

## 🎯 常见任务

### 跳过 Pre-commit 检查（不推荐）
```bash
git commit --no-verify
```

### 修复所有 Lint 错误
```bash
npm run lint:fix
```

### 检查特定文件
```bash
npx eslint path/to/file.js
```

## 📊 当前状态

当前有 3 个 Lint 错误需要修复（真实的代码问题）：
- 2 个未使用变量的问题
- 1 个错误处理的问题

可使用 `npm run lint` 查看具体错误位置。

---

更多信息：[ESLint 官方文档](https://eslint.org/)
