# AI 工具配置迁移

<div align="center">
  <img alt="npm-version" src="https://img.shields.io/npm/v/@jl-org/ai-sync?color=red&logo=npm" />
  <img alt="npm-download" src="https://img.shields.io/npm/dm/@jl-org/ai-sync?logo=npm" />
  <img alt="License" src="https://img.shields.io/npm/l/@jl-org/ai-sync?color=blue" />
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" />
  <img alt="node.js" src="https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white" />
  <img alt="vitest" src="https://img.shields.io/badge/Vitest-646CFF?logo=vitest&logoColor=white" />
  <img alt="tsup" src="https://img.shields.io/badge/tsup-161B22?logo=tsup&logoColor=white" />
</div>

<div align="center">
  <a href="./README.md">中文</a>
  <span>|</span>
  <a href="./README.en.md">English</a>
</div>

自动化将 Claude 配置迁移到不同 AI IDE 工具的脚本，支持**智能适配**（规则引擎 + AI 语义改写）

## 支持的工具

- Cursor
- Claude Code
- CodeBuddy
- OpenCode
- CodeX
- Gemini CLI
- IFlow CLI

## 快速开始

### 1. 准备配置

**遵循 Claude Code 配置规范** https://code.claude.com/docs/zh-CN/settings

创建 `~/.claude` 目录，包含以下子目录：
- `~/.claude/commands/` - 存放自定义命令（Markdown 格式）
- `~/.claude/skills/` - 存放技能模块（Markdown 格式）
- `~/.claude/{CLAUDE.md,AGENTS.md}` - 存放 IDE 规则
- `~/.claude.json` - MCP 配置文件

### 2. 执行迁移命令

```bash
npm i -g @jl-org/ai-sync

# 交互式执行
ai-sync
# 启用智能适配（AI 语义改写，需本地安装 claude/codex CLI）
ai-sync --smart
# 使用 Codex 作为智能适配后端
ai-sync --smart --smart-provider codex
# 项目级迁移（codex/claude 互转，rules + skills）
ai-sync -t codex --type rules,skills --scope project
# 查看帮助
ai-sync --help
```

```bash
? 选择要迁移到的工具（使用方向键导航，空格选择，回车确认）：
 ◯  Cursor
 ⬤  Claude Code
 ⬤  OpenCode
 ◯  Gemini CLI
 ◯  IFlow CLI

? 选择迁移范围 [Select migration scope]: global
? 启用智能适配？（通过 AI 对内容进行语义级改写） (y/N) n
? 是否自动覆盖已存在的文件？ (y/N) y

开始迁移...
✓ 迁移 Commands... (2/2)
✓ 迁移 Skills... (1/1)
✓ 迁移 Rules... (1/1)
✓ 迁移 MCP... (1/1)

--- 迁移完成 ---
工具: Claude Code, OpenCode
成功: 15
跳过: 3
错误: 0
```

## 自定义配置

你可以通过在项目根目录创建 `ai-sync.config.js` 文件来深度自定义同步行为

### 1. 使用 `defineConfig`

通过 `defineConfig` 你可以定义新的工具配置，或修改现有工具的同步逻辑：

```typescript
import { defineConfig } from '@jl-org/ai-sync'

export default defineConfig({
  tools: {
    /** 定义一个新的工具：test-cli */
    'test-cli': {
      name: 'Test CLI',
      /** 支持的配置类型 */
      supported: ['commands', 'skills', 'rules', 'mcp'],
      /** 具体的转换逻辑 */
      commands: {
        source: '.test-cli/commands',
        format: 'markdown',
        target: '~/.test-cli/commands',
      },
      rules: {
        source: '.test-cli/rules',
        target: '~/.test-cli/RULES.md',
        /** 开启合并模式：将多个规则合并为一个文件 */
        merge: true,
        /** 高度自定义转换逻辑 */
        transform: (content, fileName) => {
          return `${content}\n\n> Generated from ${fileName}`
        }
      }
    }
  }
})
```

## 执行规则

### 配置转换规则

| 配置类型 | 转换说明 |
|---------|--------|
| **Commands** | Claude → Cursor/OpenCode：直接复制（`--smart` 时进行路径/名称适配 + AI 语义改写）<br>Claude → Gemini/IFlow：Markdown → TOML 自动转换 |
| **Skills** | 所有工具：直接复制（`--smart` 时自动跳过 Claude 专属 Skill，路径/名称适配 + AI 语义改写） |
| **Rules** | Cursor → 其他工具：.mdc 文件合并为单个 Markdown（`--smart` 时合并后追加适配）<br>其他工具 → Cursor：不迁移（Cursor 已支持自动检测 ~/.claude/CLAUDE.md） |
| **MCP** | Claude → Cursor/OpenCode/Gemini/IFlow：自动格式转换 |

### 智能适配（`--smart`）

默认迁移仅做文件复制和格式转换。启用 `--smart` 后，迁移管道增加两层适配：

| 层级 | 说明 | 触发条件 |
|------|------|----------|
| **Layer 1: 规则引擎** | 路径前缀替换（`~/.claude/` → `~/.cursor/` 等）、工具名替换（`Claude Code` → `Cursor` 等）、Claude 专属 Skill 自动跳过 | 始终启用 |
| **Layer 2: AI 适配** | 通过本地 `claude` 或 `codex` CLI 对内容进行语义级改写，移除/适配目标工具不支持的特性 | `--smart` + 可选 `--smart-provider` |

**前置条件**：Layer 2 需要本地安装所选后端 CLI（`claude` 或 `codex`）。若未检测到 CLI，将回退到仅 Layer 1 并提示警告。

### 路径规则

- **工具配置**：统一使用全局 Home 目录下的配置路径，如 `~/.claude/`
- **项目级迁移**：`--scope project` 重点支持 codex/claude 互转，迁移项目规则文件（`CLAUDE.md`/`AGENTS.md`，含子目录）及项目级 `rules`/`skills`
- **路径解析**：支持使用 `~` 表示用户主目录，自动处理跨平台路径
- **默认目录**：默认使用家目录 `~` 作为配置探测起点，以 `~/.claude` 作为唯一配置标准
- **指定路径**：支持通过命令行参数或配置文件指定自定义的源目录和目标项目目录
