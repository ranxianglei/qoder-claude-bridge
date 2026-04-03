# Qoder-Claude-Bridge

让 Claude Code 使用 Qoder 作为 AI 后端的桥接补丁。

## 功能

- 将 Claude Code 的 AI 调用路由到 Qoder CLI
- 支持通过 `QODER_NO_AUTH=1` 跳过 Anthropic 登录流程
- 安装时自动添加 `cq` alias（`cq` = `QODER_NO_AUTH=1 claude`）
- 支持交互模式和非交互模式 (`-p`)
- 会话语义跟随 Claude：新 chat = 新 Qoder session，`claude resume` = 恢复对应 Qoder session

## 兼容性

| Claude Code 版本 | 状态 |
|-----------------|------|
| 2.1.89          | ✅ known-tested |
| 2.1.86          | ✅ 本地实测可用 |

> ⚠️ **注意**:
> - `install.sh` 会先做 compatibility probe，再决定是否继续安装。
> - Claude Code 升级后需要重新运行安装脚本。
> - 新版本即使不在 known-tested 列表中，也可能通过 pattern probe 正常工作；以 `./install.sh --status` 为准。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/ranxianglei/qoder-claude-bridge/master/install.sh | bash
```

脚本会自动完成：clone/更新仓库 → 安装依赖 → 编译 → 打 patch → 建立运行时链接 → 校验 bridge import → 写入 `cq` alias。

## 快速开始

> 如果你想手动安装或参与开发，请按以下步骤操作。

### 1. 前置条件

确保已安装：

- **Node.js** >= 18
- **Claude Code**（推荐先用 `./install.sh --status` 看 probe 结果）
- **Qoder CLI** >= 0.1.37

安装 Claude Code：
```bash
npm install -g @anthropic-ai/claude-code
```

验证版本：
```bash
claude --version
# 例如: 2.1.86 (Claude Code)
```

安装 Qoder CLI：
```bash
curl -fsSL https://qoder.com/install | bash
```

登录 Qoder（必须完成，否则桥接无法工作）：
```bash
qodercli
/login
```

或使用 token：

```bash
export QODER_PERSONAL_ACCESS_TOKEN=你的token
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
- 检测 Claude Code 版本和兼容性
- 备份原始文件
- 应用补丁
- 创建运行时模块链接，确保 `import('qoder-claude-bridge')` 可解析
- 自动把 `alias cq='QODER_NO_AUTH=1 claude'` 写入 `~/.bashrc` / `~/.zshrc`（已存在则不会重复添加）

## 使用方法

### 方式 1: 跳过登录（推荐）

```bash
QODER_NO_AUTH=1 claude
```

### 方式 2: 添加别名

安装脚本现在会自动添加：

```bash
alias cq='QODER_NO_AUTH=1 claude'
```

然后：
```bash
source ~/.bashrc
cq
```

如果当前 shell 是 zsh，则执行：

```bash
source ~/.zshrc
```

### 方式 3: 非交互模式

```bash
claude -p "你的提示词"
```

### 方式 4: 续接旧会话

```bash
claude resume
```

桥接会跟随 Claude 的 session 语义：

- 新开 `claude` / `cq` → 新的 Qoder ACP session
- `claude resume` → 恢复对应的旧 Qoder ACP session
- 不再使用基于首条 prompt 的 hash 作为 durable restore key

## 安装脚本命令

```bash
# 一键安装（推荐，无需 clone 仓库）
curl -fsSL https://raw.githubusercontent.com/ranxianglei/qoder-claude-bridge/master/install.sh | bash

# 强制安装（跳过版本和模式检测，不推荐）
curl -fsSL https://raw.githubusercontent.com/ranxianglei/qoder-claude-bridge/master/install.sh | bash -s -- --force

# 以下命令需要先下载脚本：
curl -fsSL https://raw.githubusercontent.com/ranxianglei/qoder-claude-bridge/master/install.sh -o install.sh
chmod +x install.sh

# 查看状态
./install.sh --status

# 恢复原始 Claude Code
./install.sh --restore

# 卸载（恢复原文件）
./install.sh --uninstall
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

1. **callModel 替换** - 将 AI 调用路由到 Qoder
2. **运行时 bridge import** - 通过本地安装链接保证 bridge 可被 Claude 运行时解析
3. **session 注入** - 从 Claude bundle 中探测并注入 `sessionId` / `cwd`
4. **可选登录绕过** - 在兼容版本上支持 `QODER_NO_AUTH`

### ACP 协议

桥接使用 Agent Communication Protocol (ACP) 与 Qoder CLI 通信：

- JSON-RPC 2.0 over stdin/stdout
- 支持流式响应
- 自动处理工具调用
- 同一个 Claude chat 内复用同一个 ACP session
- `session/load` 可跨 ACP 进程恢复上下文

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

1. 先运行：`./install.sh --status`
2. 如果 compatibility probe 失败，说明当前 bundle 结构已经变化，需要更新 patch 模式
3. 提交 issue 报告版本问题

### 新 chat 带旧记忆 / resume 异常

当前桥接已经改成跟随 Claude 自己的 session 语义：

- 新 `claude` / `cq` 不应继承旧 chat 记忆
- `claude resume` 才应恢复旧 chat

会话映射文件在：

```bash
~/.qoder-bridge/sessions.json
```

如果要清空 bridge 的会话映射：

```bash
rm ~/.qoder-bridge/sessions.json
```

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

1. 更新 `install.sh` 的 `KNOWN_TESTED_VERSIONS`
2. 如果 bundle 结构变化，更新 `src/patch/apply.ts` 中的 probe / accessor 探测逻辑
3. 重新运行安装与真实 `cq` / `claude resume` 验证

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
