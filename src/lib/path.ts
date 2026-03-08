/**
 * 路径工具函数
 */

import type { ConfigDirType, ConfigType, ToolKey } from './config'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DEFAULT_TOOL_CONFIGS } from './configs'
import { directoryExists, fileExists } from './utils/file'

const PROJECT_SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage'])

/**
 * 展开家目录路径
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith('~')) {
    return join(homedir(), filepath.slice(1))
  }
  return filepath
}

/**
 * Skills 集中存储目录
 */
export const CENTRAL_SKILLS_DIR = '~/.agents/skills'

/**
 * 获取展开后的集中 skills 目录绝对路径
 */
export function getCentralSkillsDir(): string {
  return expandHome(CENTRAL_SKILLS_DIR)
}

/**
 * 获取工具配置路径 (统一且唯一从配置中心读取)
 * 不再包含任何 Fallback 猜测，完全由 ToolConfig 驱动
 * 注意：由于涉及数组探测，此同步版本仅返回第一个配置值
 */
export function getToolPath(
  tool: ToolKey,
  configType: ConfigType,
): string {
  const toolConfig = DEFAULT_TOOL_CONFIGS[tool]
  const typeConfig = toolConfig?.[configType] as any

  if (!typeConfig?.target) {
    /** 只有在完全没有配置时才使用极简默认值 (仅作为系统鲁棒性保底) */
    return expandHome(`~/.${tool}/${configType === 'mcp'
      ? 'mcp.json'
      : configType}`)
  }

  const target = typeConfig.target
  const firstPath = Array.isArray(target)
    ? target[0]
    : target
  return expandHome(firstPath)
}

/**
 * 异步解析最终目标路径 (支持数组动态探测)
 */
export async function resolveTargetPath(
  tool: ToolKey,
  configType: ConfigType,
): Promise<string> {
  const toolConfig = DEFAULT_TOOL_CONFIGS[tool]
  const typeConfig = toolConfig?.[configType] as any

  if (!typeConfig?.target) {
    return getToolPath(tool, configType)
  }

  const target = typeConfig.target
  if (!Array.isArray(target)) {
    return expandHome(target)
  }

  /** 如果是数组，按顺序探测磁盘 */
  for (const p of target) {
    const expanded = expandHome(p)
    if (existsSync(expanded)) {
      return expanded
    }
  }

  /** 如果都不存在，返回第一个作为默认 */
  return expandHome(target[0])
}

/**
 * 规范化路径
 */
export function normalizePath(filepath: string): string {
  return filepath.replace(/\\/g, '/')
}

/**
 * 探测并获取最终的源目录
 */
export async function resolveSourceDir(
  providedSourceDir: string | undefined,
  _defaultConfigDir: string,
): Promise<string> {
  if (providedSourceDir) {
    const resolvedPath = resolve(expandHome(providedSourceDir))
    if (basename(resolvedPath) === '.claude') {
      return dirname(resolvedPath)
    }
    return resolvedPath
  }
  return homedir()
}

/**
 * 获取 MCP 源路径
 */
export async function getMCPSourcePath(sourceDir: string): Promise<string> {
  return resolve(sourceDir, '.claude.json')
}

/**
 * 获取 OpenCode 配置文件路径 (动态探测逻辑)
 * 用于当配置虽然定义了 target，但需要检查磁盘上是否存在已有的 alternative 格式
 */
export async function getOpenCodeMCPPath(basePath: string): Promise<string> {
  const jsonCPath = join(basePath, 'opencode.jsonc')
  const jsonPath = join(basePath, 'opencode.json')

  if (await fileExists(jsonCPath))
    return jsonCPath
  if (await fileExists(jsonPath))
    return jsonPath

  return jsonCPath // 默认返回 jsonc
}

export async function getCommandsSourcePath(sourceDir: string): Promise<string> {
  return resolve(sourceDir, '.claude/commands')
}

export async function getSkillsSourcePath(sourceDir: string): Promise<string> {
  return resolve(sourceDir, '.claude/skills')
}

/**
 * 获取项目级 Skills 源路径（优先 Claude，其次 Codex）
 */
export async function getProjectSkillsSourcePath(sourceDir: string): Promise<string> {
  const priorityDirs = [
    resolve(sourceDir, '.claude/skills'),
    resolve(sourceDir, '.codex/skills'),
  ]

  for (const dir of priorityDirs) {
    if (await directoryExists(dir)) {
      return dir
    }
  }

  return priorityDirs[0]
}

/**
 * 获取项目级 Skills 源路径（按偏好工具优先）
 */
export async function getProjectSkillsSourcePathByPreference(
  sourceDir: string,
  prefer: 'claude' | 'codex',
): Promise<string> {
  const priorityDirs = prefer === 'codex'
    ? [
        resolve(sourceDir, '.codex/skills'),
        resolve(sourceDir, '.claude/skills'),
      ]
    : [
        resolve(sourceDir, '.claude/skills'),
        resolve(sourceDir, '.codex/skills'),
      ]

  for (const dir of priorityDirs) {
    if (await directoryExists(dir)) {
      return dir
    }
  }

  return priorityDirs[0]
}

export async function getAgentsSourcePath(sourceDir: string): Promise<string> {
  return resolve(sourceDir, '.claude/agents')
}

export async function getSettingsSourcePath(sourceDir: string): Promise<string> {
  return resolve(sourceDir, '.claude/settings.json')
}

export async function getRuleSourcePath(sourceDir: string): Promise<string> {
  const priorityFiles = ['CLAUDE.md', 'AGENTS.md']
  for (const fileName of priorityFiles) {
    const filePath = resolve(sourceDir, '.claude', fileName)
    if (await fileExists(filePath))
      return filePath
  }
  for (const fileName of priorityFiles) {
    const filePath = resolve(sourceDir, fileName)
    if (await fileExists(filePath))
      return filePath
  }
  return resolve(sourceDir, '.claude', 'CLAUDE.md')
}

/**
 * 按作用域解析目标路径
 */
export async function resolveTargetPathByScope(
  tool: ToolKey,
  configType: ConfigType,
  scope: ConfigDirType = 'global',
  sourceDir?: string,
): Promise<string> {
  if (scope !== 'project' || !sourceDir) {
    return resolveTargetPath(tool, configType)
  }

  const projectTargets: Record<string, Partial<Record<ConfigType, string>>> = {
    claude: {
      rules: 'CLAUDE.md',
      skills: '.claude/skills',
    },
    codex: {
      rules: 'AGENTS.md',
      skills: '.codex/skills',
    },
  }

  const target = projectTargets[tool]?.[configType]
  if (target) {
    return resolve(sourceDir, target)
  }

  return resolveTargetPath(tool, configType)
}

/**
 * 收集项目级目标规则文件（递归）
 */
export async function collectProjectRuleTargetFiles(
  sourceDir: string,
  targetTool: 'claude' | 'codex',
): Promise<string[]> {
  const targetFileName = targetTool === 'codex'
    ? 'AGENTS.md'
    : 'CLAUDE.md'

  const files: string[] = []

  async function scan(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PROJECT_SCAN_SKIP_DIRS.has(entry.name)) {
          continue
        }
        await scan(fullPath)
      }
      else if (entry.isFile() && entry.name === targetFileName) {
        files.push(fullPath)
      }
    }
  }

  await scan(sourceDir)
  return files
}

/**
 * 收集项目级目标 skills 目录（递归）
 */
export async function collectProjectSkillTargetDirs(
  sourceDir: string,
  targetTool: 'claude' | 'codex',
): Promise<string[]> {
  const targetConfigDir = targetTool === 'codex'
    ? '.codex'
    : '.claude'
  const dirs: string[] = []

  async function scan(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const fullPath = join(dir, entry.name)
      if (PROJECT_SCAN_SKIP_DIRS.has(entry.name)) {
        continue
      }

      if (entry.name === targetConfigDir) {
        const skillDir = join(fullPath, 'skills')
        if (await directoryExists(skillDir)) {
          dirs.push(skillDir)
        }
        continue
      }

      await scan(fullPath)
    }
  }

  await scan(sourceDir)
  return dirs
}
