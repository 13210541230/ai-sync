import type { ToolConfig } from '@lib/types/config'
import type { ChildProcess } from 'node:child_process'
import {
  CLAUDE_SPECIFIC_PATTERNS,
  createReplacements,
  stripUnsupportedSections,
  TOOL_ADAPT_MAP,
} from '@lib/converters/adapt-rules'
import {
  adaptContent,
  applySmartAdaptation,
  isSmartProviderAvailable,
  shouldSkipSkill,
} from '@lib/converters/smart-adapt'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn(() => ({}) as ChildProcess),
}))

describe('adapt-rules', () => {
  describe('tool_adapt_map', () => {
    it('应包含所有 7 个工具的适配信息', () => {
      const keys = Object.keys(TOOL_ADAPT_MAP)
      expect(keys).toContain('cursor')
      expect(keys).toContain('codebuddy')
      expect(keys).toContain('opencode')
      expect(keys).toContain('gemini')
      expect(keys).toContain('iflow')
      expect(keys).toContain('codex')
      expect(keys).toContain('claude')
      expect(keys).toHaveLength(7)
    })

    it('每个工具应有完整字段', () => {
      for (const info of Object.values(TOOL_ADAPT_MAP)) {
        expect(info.displayName).toBeTruthy()
        expect(info.globalPrefix).toBeTruthy()
        expect(info.projectPrefix).toBeTruthy()
        expect(info.rulesFileName).toBeTruthy()
        expect(info.mcpFileName).toBeTruthy()
      }
    })
  })

  describe('createReplacements', () => {
    it('应为已知工具生成替换规则', () => {
      const replacements = createReplacements('cursor')
      expect(replacements.length).toBeGreaterThan(0)
      expect(replacements[0]).toHaveProperty('match')
      expect(replacements[0]).toHaveProperty('replace')
    })

    it('应为未知工具返回空数组', () => {
      const replacements = createReplacements('unknown-tool')
      expect(replacements).toEqual([])
    })
  })

  describe('claude_specific_patterns', () => {
    it('应匹配 MCP 工具调用', () => {
      const pattern = CLAUDE_SPECIFIC_PATTERNS.find(p => p.test('mcp__word__create'))
      expect(pattern).toBeDefined()
    })

    it('应匹配 claude --print', () => {
      const pattern = CLAUDE_SPECIFIC_PATTERNS.find(p => p.test('claude --print'))
      expect(pattern).toBeDefined()
    })

    it('应匹配 collaborating-with-codex', () => {
      const pattern = CLAUDE_SPECIFIC_PATTERNS.find(p => p.test('/collaborating-with-codex'))
      expect(pattern).toBeDefined()
    })
  })
})

describe('smart-adapt', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  describe('isSmartProviderAvailable', () => {
    it('provider 可用时应返回 true', async () => {
      execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null)
      })

      const result = await isSmartProviderAvailable('claude')
      expect(result).toBe(true)
      expect(execFileMock).toHaveBeenCalledTimes(1)
    })

    it('provider 不可用时应返回 false', async () => {
      execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(new Error('not found'))
      })

      const result = await isSmartProviderAvailable('codex')
      expect(result).toBe(false)
      expect(execFileMock).toHaveBeenCalledTimes(1)
    })

    it('应使用对应 provider 的 version 参数', async () => {
      execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null)
      })

      await isSmartProviderAvailable('claude')
      await isSmartProviderAvailable('codex')

      const claudeCallArgs = execFileMock.mock.calls[0]?.[1] as string[]
      const codexCallArgs = execFileMock.mock.calls[1]?.[1] as string[]
      const lastClaudeArg = claudeCallArgs[claudeCallArgs.length - 2] || claudeCallArgs[0]
      const lastCodexArg = codexCallArgs[codexCallArgs.length - 2] || codexCallArgs[0]

      expect(claudeCallArgs).toContain('--version')
      expect(codexCallArgs).toContain('--version')
      expect(lastClaudeArg).toMatch(/claude|--version/)
      expect(lastCodexArg).toMatch(/codex|--version/)
    })
  })

  describe('adaptContent', () => {
    it('应替换 ~/.claude/ 为目标工具路径', () => {
      const content = '配置文件位于 ~/.claude/ 目录下'
      const result = adaptContent(content, 'cursor')
      expect(result).toBe('配置文件位于 ~/.cursor/ 目录下')
    })

    it('应替换 .claude/ 为目标工具项目路径', () => {
      const content = '项目配置在 .claude/ 中'
      const result = adaptContent(content, 'opencode')
      expect(result).toBe('项目配置在 .config/opencode/ 中')
    })

    it('应替换 CLAUDE.md 为目标规则文件名', () => {
      const content = '编辑 CLAUDE.md 文件'
      const result = adaptContent(content, 'gemini')
      expect(result).toBe('编辑 GEMINI.md 文件')
    })

    it('应替换 Claude Code 为目标工具显示名', () => {
      const content = '这是 Claude Code 的配置'
      const result = adaptContent(content, 'codebuddy')
      expect(result).toBe('这是 CodeBuddy 的配置')
    })

    it('应替换 .claude.json 为目标 MCP 文件名', () => {
      const content = '修改 .claude.json'
      const result = adaptContent(content, 'codex')
      expect(result).toBe('修改 config.toml')
    })

    it('对未知工具应原样返回', () => {
      const content = '不变的内容 ~/.claude/'
      const result = adaptContent(content, 'unknown-tool')
      expect(result).toBe(content)
    })

    it('应同时替换多个模式', () => {
      const content = 'Claude Code 配置在 ~/.claude/ 下，规则文件为 CLAUDE.md'
      const result = adaptContent(content, 'cursor')
      expect(result).toBe('Cursor 配置在 ~/.cursor/ 下，规则文件为 .cursorrules')
    })

    it('应替换 ~/.codex/ 为 ~/.claude/（反向）', () => {
      const content = '配置文件位于 ~/.codex/ 目录下'
      const result = adaptContent(content, 'claude')
      expect(result).toBe('配置文件位于 ~/.claude/ 目录下')
    })

    it('应替换 .codex/ 为 .claude/（反向）', () => {
      const content = '项目配置在 .codex/ 中'
      const result = adaptContent(content, 'claude')
      expect(result).toBe('项目配置在 .claude/ 中')
    })

    it('应替换 AGENTS.md 为 CLAUDE.md（反向）', () => {
      const content = '编辑 AGENTS.md 文件'
      const result = adaptContent(content, 'claude')
      expect(result).toBe('编辑 CLAUDE.md 文件')
    })

    it('应替换 Codex 为 Claude Code（反向）', () => {
      const content = '这是 Codex 的配置'
      const result = adaptContent(content, 'claude')
      expect(result).toBe('这是 Claude Code 的配置')
    })

    it('应替换 config.toml 为 .claude.json（反向）', () => {
      const content = '修改 config.toml'
      const result = adaptContent(content, 'claude')
      expect(result).toBe('修改 .claude.json')
    })

    it('应同时替换多个 codex 模式（反向）', () => {
      const content = 'Codex 配置在 ~/.codex/ 下，规则文件为 AGENTS.md'
      const result = adaptContent(content, 'claude')
      expect(result).toBe('Claude Code 配置在 ~/.claude/ 下，规则文件为 CLAUDE.md')
    })
  })

  describe('shouldSkipSkill', () => {
    it('claude 工具自身不跳过', () => {
      const content = 'mcp__word__create and claude --print and /collaborating-with-codex'
      expect(shouldSkipSkill(content, 'test.md', 'claude')).toBe(false)
    })

    it('匹配 2+ 个 Claude 专属特征时跳过', () => {
      const content = '使用 mcp__word__create 调用工具\n然后 claude --print 输出结果'
      expect(shouldSkipSkill(content, 'test.md', 'cursor')).toBe(true)
    })

    it('仅匹配 1 个特征时不跳过', () => {
      const content = '使用 mcp__word__create 调用工具'
      expect(shouldSkipSkill(content, 'test.md', 'cursor')).toBe(false)
    })

    it('无匹配时不跳过', () => {
      const content = '通用的技能描述，没有特定工具引用'
      expect(shouldSkipSkill(content, 'test.md', 'cursor')).toBe(false)
    })
  })

  describe('applySmartAdaptation', () => {
    it('应为 claude 注入反向 skills transform', () => {
      const config: Record<string, ToolConfig> = {
        claude: {
          name: 'Claude Code',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['commands', 'skills'],
        },
      }

      applySmartAdaptation(config)
      expect(config.claude.skills.transform).toBeDefined()
      expect(typeof config.claude.skills.transform).toBe('function')
    })

    it('注入的 claude skills transform 应执行反向替换', async () => {
      const config: Record<string, ToolConfig> = {
        claude: {
          name: 'Claude Code',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['skills'],
        },
      }

      applySmartAdaptation(config)

      const transform = config.claude.skills.transform!
      const result = await transform('配置在 ~/.codex/ 下', 'test.md')
      expect(result).toBe('配置在 ~/.claude/ 下')
    })

    it('应为已知工具注入 skills transform', () => {
      const config: Record<string, ToolConfig> = {
        cursor: {
          name: 'Cursor',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['commands', 'skills'],
        },
      }

      applySmartAdaptation(config)
      expect(config.cursor.skills.transform).toBeDefined()
      expect(typeof config.cursor.skills.transform).toBe('function')
    })

    it('应为非 TOML 格式工具注入 commands transform', () => {
      const config: Record<string, ToolConfig> = {
        cursor: {
          name: 'Cursor',
          commands: { format: 'markdown' },
          skills: {},
          mcp: {},
          supported: ['commands', 'skills'],
        },
      }

      applySmartAdaptation(config)
      expect(config.cursor.commands.transform).toBeDefined()
    })

    it('不应为 TOML 格式工具注入 commands transform', () => {
      const config: Record<string, ToolConfig> = {
        codex: {
          name: 'Codex',
          commands: { format: 'toml' },
          skills: {},
          mcp: {},
          supported: ['commands', 'skills'],
        },
      }

      applySmartAdaptation(config)
      expect(config.codex.commands.transform).toBeUndefined()
    })

    it('应为 merge:true 的 rules 注入 customMerge 并关闭 merge', () => {
      const config: Record<string, ToolConfig> = {
        cursor: {
          name: 'Cursor',
          commands: {},
          skills: {},
          rules: { merge: true },
          mcp: {},
          supported: ['commands', 'skills', 'rules'],
        },
      }

      applySmartAdaptation(config)
      expect(config.cursor.rules!.customMerge).toBeDefined()
      expect(config.cursor.rules!.merge).toBe(false)
    })

    it('注入的 skills transform 应执行规则引擎替换', async () => {
      const config: Record<string, ToolConfig> = {
        cursor: {
          name: 'Cursor',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['skills'],
        },
      }

      applySmartAdaptation(config)

      const transform = config.cursor.skills.transform!
      const result = await transform('配置在 ~/.claude/ 下', 'test.md')
      expect(result).toBe('配置在 ~/.cursor/ 下')
    })

    it('注入的 skills transform 对 Claude 专属内容返回 null', async () => {
      const config: Record<string, ToolConfig> = {
        cursor: {
          name: 'Cursor',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['skills'],
        },
      }

      applySmartAdaptation(config)

      const transform = config.cursor.skills.transform!
      const result = await transform(
        '使用 mcp__word__create 调用工具\n然后 claude --print 输出',
        'claude-only.md',
      )
      expect(result).toBeNull()
    })

    it('应保留用户已有的 skills transform', async () => {
      let bUserTransformCalled = false
      const config: Record<string, ToolConfig> = {
        cursor: {
          name: 'Cursor',
          commands: {},
          skills: {
            transform: (content: string) => {
              bUserTransformCalled = true
              return `[custom] ${content}`
            },
          },
          mcp: {},
          supported: ['skills'],
        },
      }

      applySmartAdaptation(config)

      const transform = config.cursor.skills.transform!
      const result = await transform('Claude Code 配置', 'test.md')

      expect(bUserTransformCalled).toBe(true)
      expect(result).toContain('[custom]')
      expect(result).toContain('Cursor')
    })

    it('注入的 commands transform 应执行规则引擎替换', async () => {
      const config: Record<string, ToolConfig> = {
        gemini: {
          name: 'Gemini CLI',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['commands'],
        },
      }

      applySmartAdaptation(config)

      const transform = config.gemini.commands.transform!
      const result = await transform('Claude Code 命令', 'test.md')
      expect(result).toBe('Gemini CLI 命令')
    })

    it('应跳过没有适配信息的未知工具', () => {
      const config: Record<string, ToolConfig> = {
        'unknown-tool': {
          name: 'Unknown',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['skills'],
        },
      }

      const originalTransform = config['unknown-tool'].skills.transform
      applySmartAdaptation(config)
      expect(config['unknown-tool'].skills.transform).toBe(originalTransform)
    })

    it('不应为 useLink:true 的工具注入 skills transform', () => {
      const config: Record<string, ToolConfig> = {
        codex: {
          name: 'Codex',
          commands: {},
          skills: { useLink: true },
          mcp: {},
          supported: ['skills'],
        },
      }

      applySmartAdaptation(config)
      expect(config.codex.skills.transform).toBeUndefined()
    })

    it('应为 useLink:false/undefined 的工具正常注入 skills transform', () => {
      const configNoLink: Record<string, ToolConfig> = {
        cursor: {
          name: 'Cursor',
          commands: {},
          skills: { useLink: false },
          mcp: {},
          supported: ['skills'],
        },
      }
      const configUndefined: Record<string, ToolConfig> = {
        cursor: {
          name: 'Cursor',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['skills'],
        },
      }

      applySmartAdaptation(configNoLink)
      applySmartAdaptation(configUndefined)

      expect(configNoLink.cursor.skills.transform).toBeDefined()
      expect(typeof configNoLink.cursor.skills.transform).toBe('function')
      expect(configUndefined.cursor.skills.transform).toBeDefined()
      expect(typeof configUndefined.cursor.skills.transform).toBe('function')
    })
  })
})

describe('stripUnsupportedSections', () => {
  const hooksContent = [
    '# Project Config',
    '',
    '## Rules',
    'Some rules here.',
    '',
    '## Hooks',
    'Pre-commit hook config:',
    '',
    '### Pre-commit Hooks',
    '```json',
    '{ "command": "lint" }',
    '```',
    '',
    '## MCP',
    'MCP config here.',
  ].join('\n')

  it('codex 目标应剥离 Hooks 段落（含子标题）', () => {
    const result = stripUnsupportedSections(hooksContent, 'codex')
    expect(result).not.toContain('## Hooks')
    expect(result).not.toContain('Pre-commit hook config')
    expect(result).not.toContain('### Pre-commit Hooks')
    expect(result).toContain('## Rules')
    expect(result).toContain('## MCP')
    expect(result).toContain('MCP config here.')
  })

  it('codex 目标应剥离 Settings 和 Permissions 段落', () => {
    const content = [
      '## Overview',
      'Intro text.',
      '',
      '## Settings',
      'Settings content.',
      '',
      '## Permissions',
      'Permissions content.',
      '',
      '## Other',
      'Other content.',
    ].join('\n')

    const result = stripUnsupportedSections(content, 'codex')
    expect(result).not.toContain('## Settings')
    expect(result).not.toContain('Settings content.')
    expect(result).not.toContain('## Permissions')
    expect(result).not.toContain('Permissions content.')
    expect(result).toContain('## Overview')
    expect(result).toContain('## Other')
    expect(result).toContain('Other content.')
  })

  it('codex 目标应保留不匹配的段落', () => {
    const content = [
      '## Rules',
      'Rules content.',
      '',
      '## MCP',
      'MCP content.',
    ].join('\n')

    const result = stripUnsupportedSections(content, 'codex')
    expect(result).toBe(content)
  })

  it('claude 目标不剥离任何段落', () => {
    const result = stripUnsupportedSections(hooksContent, 'claude')
    expect(result).toBe(hooksContent)
  })

  it('cursor 目标不剥离任何段落（未声明 features）', () => {
    const result = stripUnsupportedSections(hooksContent, 'cursor')
    expect(result).toBe(hooksContent)
  })

  it('未知工具不剥离任何段落', () => {
    const result = stripUnsupportedSections(hooksContent, 'unknown-tool')
    expect(result).toBe(hooksContent)
  })

  it('嵌套标题应随父段落一起剥离', () => {
    const content = [
      '## Hooks',
      'Hook intro.',
      '### Pre-commit Hooks',
      'Pre-commit config.',
      '### Post-commit Hooks',
      'Post-commit config.',
      '## Next Section',
      'Next content.',
    ].join('\n')

    const result = stripUnsupportedSections(content, 'codex')
    expect(result).not.toContain('Hooks')
    expect(result).not.toContain('Pre-commit')
    expect(result).not.toContain('Post-commit')
    expect(result).toContain('## Next Section')
    expect(result).toContain('Next content.')
  })

  it('adaptContent 应先剥离再替换', () => {
    const content = [
      '## Hooks',
      '配置 hooks。',
      '',
      '## Rules',
      'CLAUDE.md 位于 ~/.claude/ 下。',
    ].join('\n')

    const result = adaptContent(content, 'codex')
    expect(result).not.toContain('Hooks')
    expect(result).toContain('AGENTS.md')
    expect(result).toContain('~/.codex/')
  })
})
