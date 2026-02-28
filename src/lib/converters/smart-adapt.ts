/**
 * 智能适配层核心
 * Layer 1: 规则引擎（确定性替换）- 默认启用
 * Layer 2: AI 适配（claude CLI 语义改写）- --smart 触发
 */

import type { ToolConfig, ToolKey } from '../types/config'
import type { MigrateOptions } from '../migrators/types'
import { execFile } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRules } from './rules-merger'
import { CLAUDE_SPECIFIC_PATTERNS, createReplacements, TOOL_ADAPT_MAP } from './adapt-rules'

/** Claude 专属特征匹配阈值，达到此数量视为 Claude 专属内容 */
const CLAUDE_SPECIFIC_THRESHOLD = 2

/** CLI 版本检测超时（毫秒） */
const CLI_VERSION_TIMEOUT_MS = 5000

/** AI 适配单文件处理超时（毫秒） */
const AI_ADAPT_TIMEOUT_MS = 30000

/** AI 适配最大输出缓冲区（字节） */
const AI_ADAPT_MAX_BUFFER = 1024 * 1024

/**
 * Layer 1: 规则引擎 - 确定性内容适配
 */
export function adaptContent(content: string, toolKey: ToolKey): string {
  const replacements = createReplacements(toolKey)
  let result = content
  for (const { match, replace } of replacements) {
    result = result.replace(match, replace)
  }
  return result
}

/**
 * 检测 Skill 是否应该跳过（含 Claude 专属特征）
 */
export function shouldSkipSkill(content: string, _fileName: string, toolKey: ToolKey): boolean {
  if (toolKey === 'claude') return false

  let nMatchCount = 0
  for (const pattern of CLAUDE_SPECIFIC_PATTERNS) {
    if (pattern.test(content)) nMatchCount++
  }

  return nMatchCount >= CLAUDE_SPECIFIC_THRESHOLD
}

/**
 * 检测 claude CLI 是否可用
 */
export function isClaudeCLIAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const bIsWin = platform() === 'win32'
    const strCmd = bIsWin ? 'cmd' : 'claude'
    const vecArgs = bIsWin ? ['/c', 'claude', '--version'] : ['--version']

    execFile(strCmd, vecArgs, { timeout: CLI_VERSION_TIMEOUT_MS }, (err) => {
      resolve(!err)
    })
  })
}

/**
 * Layer 2: AI 适配 - 通过 claude CLI 进行语义级改写
 */
export async function adaptWithAI(
  content: string,
  toolKey: ToolKey,
  configType: string,
): Promise<string | null> {
  const info = TOOL_ADAPT_MAP[toolKey]
  if (!info) return null

  const strPrompt = `You are a configuration migration assistant. The following ${configType} content has already been pre-processed with basic path/name replacements for ${info.displayName}. Your job is to perform semantic-level adaptation:

Rules:
- Remove or adapt instructions that reference Claude Code-specific features not available in ${info.displayName}
- Ensure tool-specific workflows and commands are correctly adapted
- Keep the content structure and formatting intact
- If the content is already generic/universal, return it as-is with no changes
- Do NOT add explanations, just return the adapted content
- Preserve the original language (Chinese/English)

Content to adapt:`

  const strTmpFile = join(tmpdir(), `ai-sync-${Date.now()}.txt`)

  try {
    await writeFile(strTmpFile, content, 'utf-8')

    const strResult = await new Promise<string>((resolve, reject) => {
      const bIsWin = platform() === 'win32'
      const strCmd = bIsWin ? 'cmd' : 'claude'
      const vecArgs = bIsWin
        ? ['/c', 'claude', '--print', '-p', strPrompt, strTmpFile]
        : ['--print', '-p', strPrompt, strTmpFile]

      execFile(strCmd, vecArgs, {
        encoding: 'utf-8',
        timeout: AI_ADAPT_TIMEOUT_MS,
        maxBuffer: AI_ADAPT_MAX_BUFFER,
      }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout.trim())
      })
    })

    return strResult || null
  }
  catch {
    return null
  }
  finally {
    await unlink(strTmpFile).catch(() => {})
  }
}

/**
 * 通用适配管道：Layer 1 规则引擎 + 可选 Layer 2 AI 适配
 */
async function applyAdaptLayers(
  content: string,
  toolKey: ToolKey,
  bSmart: boolean,
  configType: string,
): Promise<string> {
  let result = adaptContent(content, toolKey)

  if (bSmart) {
    const strAiResult = await adaptWithAI(result, toolKey, configType)
    if (strAiResult) result = strAiResult
  }

  return result
}

/**
 * 创建 Skills 的 smart transform 函数
 */
function createSkillsTransform(
  toolKey: ToolKey,
  bSmart: boolean,
  existingTransform?: (content: string, fileName: string) => string | null | Promise<string | null>,
): (content: string, fileName: string) => Promise<string | null> {
  return async (content: string, fileName: string): Promise<string | null> => {
    if (shouldSkipSkill(content, fileName, toolKey)) {
      return null
    }

    let result = existingTransform
      ? await existingTransform(content, fileName)
      : content

    if (result === null) return null

    return applyAdaptLayers(result, toolKey, bSmart, 'skill')
  }
}

/**
 * 创建 Commands 的 smart transform 函数
 */
function createCommandsTransform(
  toolKey: ToolKey,
  bSmart: boolean,
  existingTransform?: (content: string, fileName: string) => string | Promise<string>,
): (content: string, fileName: string) => Promise<string> {
  return async (content: string, fileName: string): Promise<string> => {
    const result = existingTransform
      ? await existingTransform(content, fileName)
      : content

    return applyAdaptLayers(result, toolKey, bSmart, 'command')
  }
}

/**
 * 创建 Rules 的 customMerge（先 mergeRules 再适配）
 */
function createRulesCustomMerge(
  toolKey: ToolKey,
  bSmart: boolean,
): (sourceDir: string, targetFile: string) => Promise<void> {
  return async (sourceDir: string, targetFile: string): Promise<void> => {
    await mergeRules(sourceDir, targetFile)

    const strContent = await readFile(targetFile, 'utf-8')
    const strAdapted = await applyAdaptLayers(strContent, toolKey, bSmart, 'rules')

    await writeFile(targetFile, strAdapted, 'utf-8')
  }
}

/**
 * 运行时装饰：为工具配置注入智能适配 transform
 */
export function applySmartAdaptation(
  toolsConfig: Record<string, ToolConfig>,
  options: MigrateOptions,
): void {
  const bSmart = options.smart ?? false

  for (const [toolKey, config] of Object.entries(toolsConfig)) {
    if (toolKey === 'claude') continue
    if (!TOOL_ADAPT_MAP[toolKey]) continue

    // Skills transform
    if (config.skills) {
      const existingTransform = config.skills.transform
      config.skills.transform = createSkillsTransform(toolKey, bSmart, existingTransform)
    }

    // Commands transform（仅对非 TOML 格式）
    if (config.commands && config.commands.format !== 'toml') {
      const existingTransform = config.commands.transform
      config.commands.transform = createCommandsTransform(toolKey, bSmart, existingTransform)
    }

    // Rules: 对有 merge: true 的配置注入 customMerge
    if (config.rules?.merge) {
      config.rules.customMerge = createRulesCustomMerge(toolKey, bSmart)
      config.rules.merge = false
    }
  }
}
