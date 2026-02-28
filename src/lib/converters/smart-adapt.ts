/**
 * 智能适配层核心
 * Layer 1: 规则引擎（确定性替换）- 默认启用
 * Layer 2: AI 适配（claude CLI 批量语义改写）- --smart 触发，迁移完成后执行
 */

import type { ToolConfig, ToolKey } from '../types/config'
import type { MigrateOptions } from '../migrators/types'
import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import chalk from 'chalk'
import { mergeRules } from './rules-merger'
import { CLAUDE_SPECIFIC_PATTERNS, createReplacements, TOOL_ADAPT_MAP } from './adapt-rules'

/** 排除嵌套会话检测的环境变量 */
function getCleanEnv(): NodeJS.ProcessEnv {
  const { CLAUDECODE, ...env } = process.env
  return env
}

/** Claude 专属特征匹配阈值，达到此数量视为 Claude 专属内容 */
const CLAUDE_SPECIFIC_THRESHOLD = 2

/** CLI 版本检测超时（毫秒） */
const CLI_VERSION_TIMEOUT_MS = 5000

/** AI 批量适配超时（毫秒）— 30 分钟 */
const AI_BATCH_TIMEOUT_MS = 30 * 60 * 1000

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

    execFile(strCmd, vecArgs, { timeout: CLI_VERSION_TIMEOUT_MS, env: getCleanEnv() }, (err) => {
      resolve(!err)
    })
  })
}

/**
 * Layer 2: AI 批量适配 - 通过 claude CLI（yolo 模式）批量处理目标目录
 *
 * 迁移完成后调用，一次性让 claude 读取所有目标文件并执行语义级适配
 */
export async function batchAdaptWithAI(
  toolKey: ToolKey,
  targetDirs: string[],
): Promise<boolean> {
  const info = TOOL_ADAPT_MAP[toolKey]
  if (!info || targetDirs.length === 0) return false

  const strDirList = targetDirs.map(d => `  - ${d}`).join('\n')

  const strPrompt = `You are a configuration migration assistant. These directories contain files that have been migrated from Claude Code to ${info.displayName}, with basic path/name replacements already applied.

Your task: Read ALL markdown files (.md) in these directories (recursively), and perform semantic-level adaptation for ${info.displayName}.

Target directories:
${strDirList}

Adaptation rules:
1. Remove or adapt instructions referencing Claude Code-specific features not available in ${info.displayName} (e.g., MCP tool calls like mcp__xxx, Claude Code slash commands, Claude-specific workflows)
2. Adapt tool-specific paths, workflows, and commands to match ${info.displayName} conventions
3. Keep the content structure, formatting, and original language (Chinese/English) intact
4. If a file is already generic/universal, leave it unchanged
5. Do NOT add explanations or comments about your changes — just modify the files directly
6. Use the Edit tool to make targeted changes, preserving unchanged content exactly

Process each file: read it, identify Claude Code-specific content, apply adaptations, write back.`

  try {
    console.log(chalk.cyan(`\n🤖 AI 批量适配中 (${toolKey})，使用 claude yolo 模式...`))
    console.log(chalk.gray(`   目录: ${targetDirs.join(', ')}`))
    console.log(chalk.gray(`   超时: ${AI_BATCH_TIMEOUT_MS / 60000} 分钟`))

    await new Promise<void>((resolve, reject) => {
      const bIsWin = platform() === 'win32'
      const strCmd = bIsWin ? 'cmd' : 'claude'
      const vecArgs = bIsWin
        ? ['/c', 'claude', '--dangerously-skip-permissions', '-p', strPrompt]
        : ['--dangerously-skip-permissions', '-p', strPrompt]

      const child = spawn(strCmd, vecArgs, {
        env: getCleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      child.stdout.on('data', (data: Buffer) => {
        const str = data.toString().trim()
        if (str) console.log(chalk.gray(`   ${str}`))
      })

      let strStderr = ''
      child.stderr.on('data', (data: Buffer) => { strStderr += data.toString() })

      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`AI 批量适配超时 (${AI_BATCH_TIMEOUT_MS / 60000} 分钟)`))
      }, AI_BATCH_TIMEOUT_MS)

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) reject(new Error(strStderr || `Exit code ${code}`))
        else resolve()
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      child.stdin.end()
    })

    console.log(chalk.green(`✓ AI 批量适配完成 (${toolKey})`))
    return true
  }
  catch (e) {
    const strMsg = e instanceof Error ? e.message : String(e)
    console.log(chalk.yellow(`⚠ AI 批量适配失败 (${toolKey})，规则引擎结果保留: ${strMsg}`))
    return false
  }
}

/**
 * 创建 Skills 的 smart transform 函数（仅 Layer 1 规则引擎）
 */
function createSkillsTransform(
  toolKey: ToolKey,
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

    return adaptContent(result, toolKey)
  }
}

/**
 * 创建 Commands 的 smart transform 函数（仅 Layer 1 规则引擎）
 */
function createCommandsTransform(
  toolKey: ToolKey,
  existingTransform?: (content: string, fileName: string) => string | Promise<string>,
): (content: string, fileName: string) => Promise<string> {
  return async (content: string, fileName: string): Promise<string> => {
    const result = existingTransform
      ? await existingTransform(content, fileName)
      : content

    return adaptContent(result, toolKey)
  }
}

/**
 * 创建 Rules 的 customMerge（先 mergeRules 再 Layer 1 适配）
 */
function createRulesCustomMerge(
  toolKey: ToolKey,
): (sourceDir: string, targetFile: string) => Promise<void> {
  return async (sourceDir: string, targetFile: string): Promise<void> => {
    await mergeRules(sourceDir, targetFile)

    const strContent = await readFile(targetFile, 'utf-8')
    const strAdapted = adaptContent(strContent, toolKey)

    await writeFile(targetFile, strAdapted, 'utf-8')
  }
}

/**
 * 运行时装饰：为工具配置注入 Layer 1 规则引擎 transform
 *
 * Layer 2 AI 适配通过 batchAdaptWithAI 在迁移完成后独立执行
 */
export function applySmartAdaptation(
  toolsConfig: Record<string, ToolConfig>,
): void {
  for (const [toolKey, config] of Object.entries(toolsConfig)) {
    if (toolKey === 'claude') continue
    if (!TOOL_ADAPT_MAP[toolKey]) continue

    // Skills transform
    if (config.skills) {
      const existingTransform = config.skills.transform
      config.skills.transform = createSkillsTransform(toolKey, existingTransform)
    }

    // Commands transform（仅对非 TOML 格式）
    if (config.commands && config.commands.format !== 'toml') {
      const existingTransform = config.commands.transform
      config.commands.transform = createCommandsTransform(toolKey, existingTransform)
    }

    // Rules: 对有 merge: true 的配置注入 customMerge
    if (config.rules?.merge) {
      config.rules.customMerge = createRulesCustomMerge(toolKey)
      config.rules.merge = false
    }
  }
}
