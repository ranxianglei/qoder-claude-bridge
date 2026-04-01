# Qoder-Claude-Bridge

让 Claude Code 使用 Qoder 作为 AI 后端的桥接补丁。

## 功能

- 将 Claude Code 的 AI 调用路由到 Qoder CLI
- 支持跳过 Anthropic 登录流程
- 支持交互模式和非交互模式 (`-p`)

## 支持的版本

| Claude Code 版本 | 状态 |
|-----------------|------|
| 2.1.89          | ✅ 已测试 |

> ⚠️ **注意**: Claude Code 升级后需要重新运行安装脚本。新版本可能需要更新补丁模式。

## 快速开始

### 1. 前置条件

确保已安装：

- **Node.js** >= 18
- **Claude Code 2.1.89**（需指定版本）
- **Qoder CLI** >= 0.1.37

安装指定版本的 Claude Code：
```bash
# ⚠️ 必须指定版本，其他版本可能不兼容
npm install -g @anthropic-ai/claude-code@2.1.89
```

验证版本：
```bash
claude --version
# 应输出: 2.1.89 (Claude Code)
```

安装 Qoder CLI：
```bash
curl -fsSL https://qoder.com/install | bash
```

登录 Qoder 账号（必须完成，否则桥接无法工作）：
```bash
qoder login
```

> ⚠️ **重要**: 使用本桥接前，必须先完成 Qoder 账号登录。Qoder CLI 会将请求转发到 Qoder 后端，未登录时所有 AI 调用都会失败。

### 2. 构建桥接包

```bash
cd qoder-claude-bridge
npm install
npm run build
```

### 3. 安装补丁

```bash
./install.sh
```

安装脚本会：
- 检测 Claude Code 版本
- 备份原始文件
- 应用补丁

## 使用方法

### 方式 1: 跳过登录（推荐）

```bash
QODER_NO_AUTH=1 claude
```

### 方式 2: 添加别名

在 `~/.bashrc` 或 `~/.zshrc` 中添加：

```bash
alias claude='QODER_NO_AUTH=1 claude'
```

然后：
```bash
source ~/.bashrc
claude
```

### 方式 3: 非交互模式

```bash
claude -p "你的提示词"
```

## 安装脚本命令

```bash
# 安装补丁
./install.sh

# 强制安装（跳过版本和模式检测，不推荐）
./install.sh --force

# 查看状态
./install.sh --status

# 恢复原始 Claude Code
./install.sh --restore

# 卸载（恢复原文件）
./install.sh --uninstall

# 帮助
./install.sh --help
```

## 文件说明

```
qoder-claude-bridge/
├── install.sh          # 安装脚本
├── src/
│   ├── index.ts        # 桥接模块入口
│   ├── acpCallModel.ts # ACP 协议实现
│   └── patch/
│       └── apply.ts    # 补丁逻辑
├── dist/               # 编译输出
└── package.json
```

## 工作原理

### 补丁内容

1. **erY() 连接检查** - 跳过 api.anthropic.com 连接测试
2. **PJ() 登录判断** - 支持 `QODER_NO_AUTH` 环境变量跳过登录
3. **登录选项** - 添加 "Qoder (no login)" 等选项
4. **callModel 替换** - 将 AI 调用路由到 Qoder

### ACP 协议

桥接使用 Agent Communication Protocol (ACP) 与 Qoder CLI 通信：

- JSON-RPC 2.0 over stdin/stdout
- 支持流式响应
- 自动处理工具调用

## 备份文件

备份存储在：
```
~/.qoder-bridge-backups/claude-code-{version}-cli.js.backup
```

以及原地备份：
```
{claude-path}.qoder-bridge.bak
```

## 故障排除

### 补丁后 Claude Code 无法启动

```bash
# 恢复原文件
./install.sh --restore

# 检查版本是否支持
./install.sh --status
```

### 版本不兼容

如果 Claude Code 更新后补丁失效：

1. 查看支持的版本：`./install.sh --status`
2. 如果新版本不在列表中，可能需要更新补丁模式
3. 提交 issue 报告版本问题

### 手动恢复

```bash
# 查找备份
ls ~/.qoder-bridge-backups/

# 手动恢复
cp ~/.qoder-bridge-backups/claude-code-{version}-cli.js.backup \
   $(dirname $(which claude))/../cli.js
```

## 开发

### 添加新版本支持

1. 在 `install.sh` 的 `SUPPORTED_VERSIONS` 数组中添加版本号
2. 如果补丁模式变化，更新 `src/patch/apply.ts` 中的模式常量
3. 测试新版本

### 构建

```bash
npm run build
```

### 测试

```bash
# 测试 QODER_NO_AUTH
QODER_NO_AUTH=1 claude

# 测试 -p 模式
claude -p "hello"
```

## 许可证

MIT
