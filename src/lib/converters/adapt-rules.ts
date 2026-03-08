/**
 * 工具适配规则数据模块
 */

import type { ToolKey } from '../types/config'

/** 工具特性声明（未声明的特性视为支持） */
export interface ToolFeatures {
  hooks?: boolean
  settings?: boolean
  permissions?: boolean
}

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
  /** 工具支持的特性（未声明视为全部支持） */
  features?: ToolFeatures
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
    features: { hooks: false, settings: false, permissions: false },
  },
  claude: {
    displayName: 'Claude Code',
    globalPrefix: '~/.claude/',
    projectPrefix: '.claude/',
    rulesFileName: 'CLAUDE.md',
    mcpFileName: '.claude.json',
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

/** 特性到 markdown 标题关键词的映射 */
export const FEATURE_SECTION_PATTERNS: Record<keyof ToolFeatures, RegExp> = {
  hooks: /hooks/i,
  settings: /settings/i,
  permissions: /permissions/i,
}

/** 标题行正则：捕获 # 级别和标题文本 */
const HEADING_RE = /^(#{1,6})\s+(.+)$/

/**
 * 段落级特性剥离：移除目标工具不支持的 markdown 段落
 *
 * 逐行状态机，遇到匹配不支持特性的标题时跳过整个段落（含子标题），
 * 直到遇到同级或更高级标题时恢复输出。
 */
export function stripUnsupportedSections(content: string, toolKey: ToolKey): string {
  const info = TOOL_ADAPT_MAP[toolKey]
  if (!info?.features)
    return content

  const unsupported = (Object.keys(FEATURE_SECTION_PATTERNS) as Array<keyof ToolFeatures>)
    .filter(k => info.features![k] === false)

  if (unsupported.length === 0)
    return content

  const lines = content.split('\n')
  const result: string[] = []
  let nSkipLevel = 0

  for (const line of lines) {
    const match = HEADING_RE.exec(line)
    if (match) {
      const nLevel = match[1].length
      const strTitle = match[2]

      if (nSkipLevel > 0 && nLevel <= nSkipLevel) {
        nSkipLevel = 0
      }

      if (nSkipLevel === 0) {
        const bShouldStrip = unsupported.some(k => FEATURE_SECTION_PATTERNS[k].test(strTitle))
        if (bShouldStrip) {
          nSkipLevel = nLevel
          continue
        }
      }
    }

    if (nSkipLevel === 0) {
      result.push(line)
    }
  }

  return result.join('\n')
}

/** 生成路径和名称替换规则 */
export function createReplacements(toolKey: ToolKey): Array<{ match: RegExp, replace: string }> {
  const info = TOOL_ADAPT_MAP[toolKey]
  if (!info)
    return []

  if (toolKey === 'claude') {
    return [
      { match: /~\/\.codex\//g, replace: info.globalPrefix },
      { match: /\.codex\//g, replace: info.projectPrefix },
      { match: /AGENTS\.md/g, replace: info.rulesFileName },
      { match: /config\.toml/g, replace: info.mcpFileName },
      { match: /\bCodex\b/g, replace: info.displayName },
    ]
  }

  return [
    { match: /~\/\.claude\//g, replace: info.globalPrefix },
    { match: /\.claude\//g, replace: info.projectPrefix },
    { match: /CLAUDE\.md/g, replace: info.rulesFileName },
    { match: /\.claude\.json/g, replace: info.mcpFileName },
    { match: /Claude Code/g, replace: info.displayName },
  ]
}
