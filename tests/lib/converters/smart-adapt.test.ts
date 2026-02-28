import type { ToolConfig } from '@lib/types/config'
import {
  CLAUDE_SPECIFIC_PATTERNS,
  createReplacements,
  TOOL_ADAPT_MAP,
} from '@lib/converters/adapt-rules'
import {
  adaptContent,
  applySmartAdaptation,
  shouldSkipSkill,
} from '@lib/converters/smart-adapt'
import { describe, expect, it } from 'vitest'

describe('adapt-rules', () => {
  describe('TOOL_ADAPT_MAP', () => {
    it('应包含所有 6 个工具的适配信息', () => {
      const keys = Object.keys(TOOL_ADAPT_MAP)
      expect(keys).toContain('cursor')
      expect(keys).toContain('codebuddy')
      expect(keys).toContain('opencode')
      expect(keys).toContain('gemini')
      expect(keys).toContain('iflow')
      expect(keys).toContain('codex')
      expect(keys).toHaveLength(6)
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

  describe('CLAUDE_SPECIFIC_PATTERNS', () => {
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
    it('应跳过 claude 工具', () => {
      const config: Record<string, ToolConfig> = {
        claude: {
          name: 'Claude Code',
          commands: {},
          skills: {},
          mcp: {},
          supported: ['commands', 'skills'],
        },
      }

      const original = { ...config.claude }
      applySmartAdaptation(config, { autoOverwrite: false })

      // claude 的 skills.transform 不应被修改
      expect(config.claude.skills.transform).toBe(original.skills.transform)
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

      applySmartAdaptation(config, { autoOverwrite: false })
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

      applySmartAdaptation(config, { autoOverwrite: false })
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

      applySmartAdaptation(config, { autoOverwrite: false })
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

      applySmartAdaptation(config, { autoOverwrite: false })
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

      applySmartAdaptation(config, { autoOverwrite: false })

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

      applySmartAdaptation(config, { autoOverwrite: false })

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

      applySmartAdaptation(config, { autoOverwrite: false })

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

      applySmartAdaptation(config, { autoOverwrite: false })

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
      applySmartAdaptation(config, { autoOverwrite: false })
      expect(config['unknown-tool'].skills.transform).toBe(originalTransform)
    })
  })
})
