/**
 * 智能适配层核心
 * Layer 1: 规则引擎（确定性替换）- 默认启用
 * Layer 2: AI 适配（claude/codex CLI 批量语义改写）- --smart 触发，迁移完成后执行
 */

import type { SmartProvider, ToolConfig, ToolKey } from '../types/config'
import type { ToolAdaptInfo } from './adapt-rules'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import chalk from 'chalk'
import { CLAUDE_SPECIFIC_PATTERNS, createReplacements, TOOL_ADAPT_MAP } from './adapt-rules'
import { mergeRules } from './rules-merger'

/** 排除嵌套会话检测的环境变量 */
function getCleanEnv(): NodeJS.ProcessEnv {
  const { CLAUDECODE, ...env } = process.env
  return env
}

/** Claude 专属特征匹配阈值，达到此数量视为 Claude 专属内容 */
const CLAUDE_SPECIFIC_THRESHOLD = 2

/** CLI 版本检测超时（毫秒） */
const CLI_VERSION_TIMEOUT_MS = 5000

/** AI 单文件适配并发数 */
const AI_CONCURRENCY = 5

/** AI 单文件适配超时（毫秒）— 10 分钟 */
const AI_FILE_TIMEOUT_MS = 10 * 60 * 1000

const PROVIDER_COMMANDS: Record<SmartProvider, string> = {
  claude: 'claude',
  codex: 'codex',
}

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
  if (toolKey === 'claude')
    return false

  let nMatchCount = 0
  for (const pattern of CLAUDE_SPECIFIC_PATTERNS) {
    if (pattern.test(content))
      nMatchCount++
  }

  return nMatchCount >= CLAUDE_SPECIFIC_THRESHOLD
}

/**
 * 检测智能适配后端 CLI 是否可用
 */
export function isSmartProviderAvailable(provider: SmartProvider): Promise<boolean> {
  return new Promise((resolve) => {
    const command = PROVIDER_COMMANDS[provider]
    const bIsWin = platform() === 'win32'
    const strCmd = bIsWin
      ? 'cmd'
      : command
    const vecArgs = bIsWin
      ? ['/c', command, '--version']
      : ['--version']

    execFile(strCmd, vecArgs, { timeout: CLI_VERSION_TIMEOUT_MS, env: getCleanEnv() }, (err) => {
      resolve(!err)
    })
  })
}

/**
 * 兼容旧 API：检测 claude CLI
 */
export function isClaudeCLIAvailable(): Promise<boolean> {
  return isSmartProviderAvailable('claude')
}

/**
 * 递归收集目录下所有 .md 文件
 */
async function collectMarkdownFiles(dirs: string[]): Promise<string[]> {
  const vecFiles: string[] = []
  for (const dir of dirs) {
    try {
      const fileStats = await stat(dir)
      if (fileStats.isFile()) {
        if (dir.endsWith('.md'))
          vecFiles.push(dir)
        continue
      }

      const entries = await readdir(dir, { recursive: true })
      for (const entry of entries) {
        if (typeof entry === 'string' && entry.endsWith('.md')) {
          vecFiles.push(join(dir, entry))
        }
      }
    }
    catch { /* 目录不存在则跳过 */ }
  }
  return vecFiles
}

/**
 * 构建单文件 AI 适配 prompt（指令 + 文件内容一体）
 */
function buildAdaptPrompt(content: string, info: ToolAdaptInfo): string {
  return [
    `AUTOMATED TEXT TRANSFORMER — output ONLY the adapted text, nothing else.`,
    `Convert this markdown from Claude Code to ${info.displayName}.`,
    `Rules:`,
    `- Remove mcp__xxx tool references (e.g. mcp__word__create)`,
    `- Remove or generalize Claude Code slash commands (/commit, /review-pr, etc.)`,
    `- Remove Claude Code-specific workflow instructions and agent patterns`,
    `- Replace remaining "Claude Code" mentions with "${info.displayName}"`,
    `- Keep ALL other content, structure, formatting, and original language intact`,
    `- If content is already tool-agnostic, output it unchanged`,
    `CRITICAL: Your entire response must be the adapted file content only. No preamble, no explanation, no code fences, no trailing summary.`,
    ``,
    content,
  ].join('\n')
}

/** Windows cmd /c 参数长度安全阈值（字节，仅 claude 参数模式使用） */
const WIN_CMD_SAFE_LIMIT = 7500

/**
 * 单文件 AI 适配：直接通过 prompt 参数传递内容，CLI 输出转换后文本
 */
function adaptSingleFile(
  content: string,
  info: ToolAdaptInfo,
  provider: SmartProvider,
): Promise<string | null> {
  const strPrompt = buildAdaptPrompt(content, info)
  const outputFile = provider === 'codex'
    ? join(tmpdir(), `ai-sync-codex-${randomUUID()}.txt`)
    : undefined

  if (provider === 'claude' && platform() === 'win32' && strPrompt.length > WIN_CMD_SAFE_LIMIT) {
    console.log(chalk.yellow(`   ⚠ 文件过大 (${strPrompt.length} chars)，跳过 AI 适配`))
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const bIsWin = platform() === 'win32'
    const providerCommand = PROVIDER_COMMANDS[provider]
    const providerArgs = provider === 'claude'
      ? ['-p', strPrompt]
      : ['exec', '-', '--skip-git-repo-check', '--color', 'never', '--output-last-message', outputFile!]
    const command = bIsWin
      ? 'cmd'
      : providerCommand
    const args = bIsWin
      ? ['/c', providerCommand, ...providerArgs]
      : providerArgs

    const child = spawn(command, args, {
      shell: false,
      env: getCleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let strOut = ''
    let bSettled = false
    child.stdout.on('data', (d: Buffer) => { strOut += d.toString() })

    async function cleanupOutputFile(): Promise<void> {
      if (!outputFile)
        return
      await rm(outputFile, { force: true }).catch(() => undefined)
    }

    async function finalize(result: string | null): Promise<void> {
      if (bSettled)
        return
      bSettled = true
      clearTimeout(timer)
      await cleanupOutputFile()
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill()
      void finalize(null)
    }, AI_FILE_TIMEOUT_MS)

    child.on('close', (code) => {
      void (async () => {
        let strResult = strOut.trim()
        if (provider === 'codex' && outputFile) {
          const fileOutput = await readFile(outputFile, 'utf-8').catch(() => '')
          if (fileOutput.trim()) {
            strResult = fileOutput.trim()
          }
        }
        await finalize(code === 0 && strResult ? strResult : null)
      })()
    })

    child.on('error', () => {
      void finalize(null)
    })

    if (provider === 'codex' && child.stdin) {
      child.stdin.write(strPrompt)
      child.stdin.end()
    }
  })
}

/**
 * Layer 2: AI 批量适配 — 逐文件并行处理，Node.js 管理文件 I/O，CLI 仅做 text-in/text-out
 *
 * 迁移完成后调用，并行启动多个 AI 进程处理各文件
 */
export async function batchAdaptWithAI(
  toolKey: ToolKey,
  targetDirs: string[],
  provider: SmartProvider = 'claude',
): Promise<boolean> {
  const info = TOOL_ADAPT_MAP[toolKey]
  if (!info || targetDirs.length === 0)
    return false

  const vecFiles = await collectMarkdownFiles(targetDirs)
  if (vecFiles.length === 0)
    return true

  console.log(chalk.cyan(`\n🤖 AI 适配中 (${toolKey}/${provider})，${vecFiles.length} 个文件，并发 ${AI_CONCURRENCY}...`))

  let nSuccess = 0
  let nSkipped = 0
  let nFailed = 0

  const queue = [...vecFiles]

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const filePath = queue.shift()
      if (!filePath)
        break

      try {
        const strContent = await readFile(filePath, 'utf-8')

        const shouldUseAI = provider === 'codex'
          || CLAUDE_SPECIFIC_PATTERNS.some(p => p.test(strContent))
        if (!shouldUseAI) {
          nSkipped++
          continue
        }

        const strAdapted = await adaptSingleFile(strContent, info, provider)
        if (!strAdapted) {
          nFailed++
          console.log(chalk.yellow(`   ✗ ${filePath}`))
          continue
        }

        if (strAdapted !== strContent) {
          await writeFile(filePath, strAdapted, 'utf-8')
          nSuccess++
          console.log(chalk.gray(`   ✓ ${filePath}`))
        }
        else {
          nSkipped++
        }
      }
      catch {
        nFailed++
        console.log(chalk.yellow(`   ✗ ${filePath}`))
      }
    }
  }

  const nWorkers = Math.min(AI_CONCURRENCY, vecFiles.length)
  await Promise.all(Array.from({ length: nWorkers }, () => worker()))

  console.log(chalk.green(`✓ AI 适配完成 (${toolKey}/${provider})：成功 ${nSuccess}，跳过 ${nSkipped}，失败 ${nFailed}`))
  return nFailed === 0
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

    const result = existingTransform
      ? await existingTransform(content, fileName)
      : content

    if (result === null)
      return null

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
    if (toolKey === 'claude')
      continue
    if (!TOOL_ADAPT_MAP[toolKey])
      continue

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
