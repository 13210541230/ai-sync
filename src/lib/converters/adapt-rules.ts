/**
 * 工具适配规则数据模块
 */

import type { ToolKey } from '../types/config'

/** 工具适配信息 */
export interface ToolAdaptInfo {
  /** 工具显示名 */
  displayName: string
  /** 全局配置目录前缀 */
  globalPrefix: string
  /** 项目配置目录前缀 */
  projectPrefix: string
  /** 规则文件名 */
  rulesFileName: string
  /** MCP 配置文件名 */
  mcpFileName: string
}

/** 各工具的适配信息 */
export const TOOL_ADAPT_MAP: Record<string, ToolAdaptInfo> = {
  cursor: {
    displayName: 'Cursor',
    globalPrefix: '~/.cursor/',
    projectPrefix: '.cursor/',
    rulesFileName: '.cursorrules',
    mcpFileName: 'mcp.json',
  },
  codebuddy: {
    displayName: 'CodeBuddy',
    globalPrefix: '~/.codebuddy/',
    projectPrefix: '.codebuddy/',
    rulesFileName: 'CODEBUDDY.md',
    mcpFileName: '.mcp.json',
  },
  opencode: {
    displayName: 'OpenCode',
    globalPrefix: '~/.config/opencode/',
    projectPrefix: '.config/opencode/',
    rulesFileName: 'AGENTS.md',
    mcpFileName: 'opencode.jsonc',
  },
  gemini: {
    displayName: 'Gemini CLI',
    globalPrefix: '~/.gemini/',
    projectPrefix: '.gemini/',
    rulesFileName: 'GEMINI.md',
    mcpFileName: 'settings.json',
  },
  iflow: {
    displayName: 'IFlow CLI',
    globalPrefix: '~/.iflow/',
    projectPrefix: '.iflow/',
    rulesFileName: 'IFLOW.md',
    mcpFileName: 'settings.json',
  },
  codex: {
    displayName: 'Codex',
    globalPrefix: '~/.codex/',
    projectPrefix: '.codex/',
    rulesFileName: 'AGENTS.md',
    mcpFileName: 'config.toml',
  },
}

/** 检测 Claude 专属内容的正则模式 */
export const CLAUDE_SPECIFIC_PATTERNS: RegExp[] = [
  /mcp__\w+__\w+/,
  /claude\s+--print/,
  /\/collaborating-with-codex/,
  /agent-browser\s/,
  /\.claude\/(plan|settings)\.json/,
]

/** 生成路径和名称替换规则 */
export function createReplacements(toolKey: ToolKey): Array<{ match: RegExp, replace: string }> {
  const info = TOOL_ADAPT_MAP[toolKey]
  if (!info) return []

  return [
    { match: /~\/\.claude\//g, replace: info.globalPrefix },
    { match: /\.claude\//g, replace: info.projectPrefix },
    { match: /CLAUDE\.md/g, replace: info.rulesFileName },
    { match: /\.claude\.json/g, replace: info.mcpFileName },
    { match: /Claude Code/g, replace: info.displayName },
  ]
}
