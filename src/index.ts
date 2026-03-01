#!/usr/bin/env node

/**
 * IDE Rules 迁移脚本主入口
 * 支持将 Claude/Cursor 的配置迁移到其他 AI 工具
 */

import type { ConfigDirType, ConfigType, SmartProvider, ToolConfig, ToolKey } from './lib/config'
import type { BaseMigrator } from './lib/migrators/base'
import type { MigrationResults } from './lib/utils/logger'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { getConfigDirChoiceList, getToolChoiceList, INTERNAL_CONFIG, isConfigTypeSupported } from './lib/config'
import { applySmartAdaptation, batchAdaptWithAI, isSmartProviderAvailable } from './lib/converters/smart-adapt'
import { loadUserConfig, mergeConfigs } from './lib/customConfig'
import { AgentsMigrator } from './lib/migrators/agents'
import { CommandsMigrator } from './lib/migrators/commands'
import { MCPMigrator } from './lib/migrators/mcp'
import { RulesMigrator } from './lib/migrators/rules'
import { SettingsMigrator } from './lib/migrators/settings'
import { SkillsMigrator } from './lib/migrators/skills'
import {
  expandHome,
  getAgentsSourcePath,
  getCommandsSourcePath,
  getMCPSourcePath,
  getProjectSkillsSourcePathByPreference,
  getRuleSourcePath,
  getSettingsSourcePath,
  getSkillsSourcePath,
  resolveSourceDir,
  resolveTargetPathByScope,
} from './lib/path'
import { Logger } from './lib/utils/logger'

/**
 * 打印帮助信息
 */
function printHelp(): void {
  console.log(chalk.cyan('AI Config 迁移脚本 (AI Config Migration)\n'))
  console.log('用法 (Usage): pnpm migrate [options]\n')
  console.log('选项 (Options):')
  console.log('  -s, --source <dir>     源目录 (Source directory)（默认：~）')
  console.log('  -t, --target <tools>   目标工具 (Target tools)，逗号分隔（如：cursor,claude,opencode）')
  console.log('  --type <types>         配置类型 (Config types)，逗号分隔（如：commands,skills,rules,mcp,settings）')
  console.log('  -c, --config <path>    指定配置文件 (Specify config file)')
  console.log('  --scope <scope>        迁移范围：global 或 project (Migration scope: global or project)')
  console.log('  --project              等价于 --scope project (Alias of --scope project)')
  console.log('  -y, --yes              自动覆盖 (Auto overwrite)')
  console.log('  --smart                启用智能适配 (Enable smart adaptation via AI)')
  console.log('  --smart-provider <p>   智能适配后端：claude 或 codex (AI provider: claude or codex)')
  console.log('  -h, --help             显示帮助信息 (Show help)')
  console.log('  --interactive          强制交互模式 (Force interactive mode)（默认）\n')
  console.log('支持的工具 (Supported tools):')
  console.log('  cursor      - Cursor')
  console.log('  claude      - Claude Code')
  console.log('  codebuddy   - CodeBuddy')
  console.log('  opencode    - OpenCode')
  console.log('  gemini      - Gemini CLI')
  console.log('  iflow       - IFlow CLI')
  console.log('  codex       - Codex\n')
  console.log('示例 (Examples):')
  console.log('  pnpm migrate                    # 交互式模式 (Interactive mode)')
  console.log('  pnpm migrate -t cursor          # 迁移到 Cursor (Migrate to Cursor)')
  console.log('  pnpm migrate -t cursor,claude   # 迁移到多个工具 (Migrate to multiple tools)\n')
}

/**
 * 交互式模式
 */
async function interactiveMode(tools: Record<ToolKey, ToolConfig> = INTERNAL_CONFIG.tools as Record<ToolKey, ToolConfig>): Promise<CommandLineOptions> {
  const logger = new Logger()

  logger.section('IDE Rules 迁移向导 (IDE Rules Migration Wizard)')

  const { scope } = await inquirer.prompt<InteractiveAnswers>([
    {
      type: 'list',
      name: 'scope',
      message: '选择迁移范围 [Select migration scope]:',
      choices: getConfigDirChoiceList(),
      default: 'global',
    },
  ])

  const { sourceDir } = await inquirer.prompt<InteractiveAnswers>([
    {
      type: 'input',
      name: 'sourceDir',
      message: '源配置目录 (Source Directory):',
      default: scope === 'project'
        ? '.'
        : '~',
    },
  ])

  const toolChoices = getToolChoiceList(tools)
  const { tools: selectedTools } = await inquirer.prompt<InteractiveAnswers>([
    {
      type: 'checkbox',
      name: 'tools',
      message: '请选择要迁移的目标工具 (默认全选，可取消勾选不需要的工具) [Select target tools (uncheck to skip)]:',
      choices: toolChoices,
      default: toolChoices.map(c => c.value),
    },
  ])

  if (selectedTools.length === 0) {
    console.log(chalk.yellow('未选择任何工具，退出。(No tools selected, exiting.)'))
    process.exit(0)
  }

  const { configTypes: selectedTypes } = await inquirer.prompt<InteractiveAnswers>([
    {
      type: 'checkbox',
      name: 'configTypes',
      message: '选择要迁移的配置类型 [Select configuration types to migrate]:',
      choices: [
        { name: 'Commands (命令/提示词)', value: 'commands' },
        { name: 'Skills (技能/工具)', value: 'skills' },
        { name: 'Agents (智能体/代理)', value: 'agents' },
        { name: 'Rules (规则/指令)', value: 'rules' },
        { name: 'MCP (模型上下文协议)', value: 'mcp' },
        { name: 'Settings (设置/Hooks/权限)', value: 'settings' },
      ],
      default: ['commands', 'skills', 'agents', 'rules', 'mcp', 'settings'],
    },
  ])

  if (selectedTypes.length === 0) {
    console.log(chalk.yellow('未选择任何配置类型，退出。(No config types selected, exiting.)'))
    process.exit(0)
  }

  const { overwrite } = await inquirer.prompt<InteractiveAnswers>([
    {
      type: 'confirm',
      name: 'overwrite',
      message: '覆盖已有文件？(Overwrite existing files?)',
      default: true,
    },
  ])

  const { smart } = await inquirer.prompt<InteractiveAnswers>([
    {
      type: 'confirm',
      name: 'smart',
      message: '启用 AI 智能适配？(Enable AI smart adaptation?)',
      default: false,
    },
  ])

  let smartProvider: SmartProvider = 'claude'
  if (smart) {
    const smartProviderAnswer = await inquirer.prompt<InteractiveAnswers>([
      {
        type: 'list',
        name: 'smartProvider',
        message: '选择智能适配后端 [Select AI adaptation provider]:',
        choices: [
          { name: 'Claude CLI（默认）', value: 'claude' },
          { name: 'Codex CLI', value: 'codex' },
        ],
        default: 'claude',
      },
    ])
    smartProvider = smartProviderAnswer.smartProvider || 'claude'
  }

  return {
    tools: selectedTools,
    configTypes: selectedTypes,
    autoOverwrite: overwrite,
    scope,
    sourceDir,
    smart,
    smartProvider,
  }
}

/**
 * 解析命令行参数
 */
async function parseCommandLineArgs(): Promise<CommandLineOptions | null> {
  const { values } = parseArgs({
    options: {
      'source': { type: 'string', short: 's' },
      'target': { type: 'string', short: 't' },
      'type': { type: 'string' },
      'config': { type: 'string', short: 'c' },
      'scope': { type: 'string' },
      'project': { type: 'boolean' },
      'yes': { type: 'boolean', short: 'y' },
      'smart': { type: 'boolean' },
      'smart-provider': { type: 'string' },
      'help': { type: 'boolean', short: 'h' },
      'interactive': { type: 'boolean' },
    },
    allowPositionals: true,
  })

  if (values.help) {
    printHelp()
    process.exit(0)
  }

  if (values.interactive || (!values.target && !values.source)) {
    return null
  }

  let tools: ToolKey[] = []
  if (values.target) {
    /** 处理空格或逗号分隔的工具列表 */
    tools = (values.target as string).split(/[\s,]+/).filter(t => t).map(t => t.trim().toLowerCase()) as ToolKey[]
  }

  let configTypes: ConfigType[] | undefined
  if (values.type) {
    configTypes = (values.type as string).split(/[\s,]+/).filter(t => t).map(t => t.trim().toLowerCase()) as ConfigType[]
  }

  const autoOverwrite = values.yes || false
  const sourceDir = values.source
    ? resolve(expandHome(values.source))
    : undefined
  const config = values.config
  const strScope = values.project
    ? 'project'
    : (values.scope || 'global')
  const scope: ConfigDirType = strScope === 'project'
    ? 'project'
    : 'global'
  const smartProviderValue = typeof values['smart-provider'] === 'string'
    ? values['smart-provider'].toLowerCase()
    : undefined
  const smartProvider: SmartProvider = smartProviderValue === 'codex'
    ? 'codex'
    : 'claude'

  return {
    tools,
    configTypes,
    autoOverwrite,
    scope,
    sourceDir,
    config,
    smart: values.smart || false,
    smartProvider,
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const logger = new Logger()

  let options = await parseCommandLineArgs()

  /** 加载用户配置 */
  const userConfig = await loadUserConfig(process.cwd(), options?.config)

  /** 合并配置 */
  const mergedConfigs = mergeConfigs(INTERNAL_CONFIG, userConfig)
  const toolsConfig = mergedConfigs.tools as Record<ToolKey, ToolConfig>

  if (options === null) {
    options = (await interactiveMode(toolsConfig)) as CommandLineOptions
  }

  options.scope = options.scope || 'global'
  options.smartProvider = options.smartProvider || 'claude'

  /** 检测 --smart 模式下 AI 后端可用性 */
  if (options.smart) {
    const bAvailable = await isSmartProviderAvailable(options.smartProvider)
    if (!bAvailable) {
      console.log(chalk.yellow(`⚠ ${options.smartProvider} CLI 不可用，AI 适配已禁用，仅使用规则引擎`))
      options.smart = false
    }
  }

  /** 注入 Layer 1 规则引擎 transform */
  applySmartAdaptation(toolsConfig)

  /** 探测源目录 */
  let sourceDir: string
  try {
    if (options.scope === 'project' && !options.sourceDir) {
      sourceDir = process.cwd()
    }
    else {
      const defaultConfigDir = userConfig.global?.defaultConfigDir || expandHome('~/.claude')
      sourceDir = await resolveSourceDir(options.sourceDir, defaultConfigDir)
    }
    options.sourceDir = sourceDir
  }
  catch (error) {
    console.error(chalk.red(error instanceof Error
      ? error.message
      : 'Unknown path error'))
    process.exit(1)
  }

  logger.section('开始迁移 (Start Migration)')
  console.log(chalk.cyan(`源目录 (Source directory): ${sourceDir}`))
  console.log(chalk.cyan(`迁移范围 (Scope): ${options.scope}`))
  console.log(chalk.cyan(`目标工具 (Target tools): ${options.tools.map(t => mergedConfigs.tools?.[t]?.name || t).join(', ')}`))
  console.log(chalk.cyan(`自动覆盖 (Auto overwrite): ${options.autoOverwrite
    ? '是 (Yes)'
    : '否 (No)'}`))
  if (options.smart) {
    console.log(chalk.cyan(`智能适配后端 (Smart provider): ${options.smartProvider}`))
  }
  console.log('')

  const results: MigrationResults = {
    success: 0,
    skipped: 0,
    error: 0,
    errors: [],
    tools: options.tools.map(t => mergedConfigs.tools?.[t]?.name || t),
  }

  const configTypes: ConfigType[] = options.configTypes || ['commands', 'skills', 'agents', 'rules', 'mcp', 'settings']

  for (const configType of configTypes) {
    if (options.scope === 'project' && !['rules', 'skills'].includes(configType)) {
      logger.warn(`⚠ scope=project 当前仅支持 rules/skills，跳过 ${configType}`)
      continue
    }

    const scopedTools = options.scope === 'project'
      ? options.tools.filter(tool => tool === 'claude' || tool === 'codex')
      : options.tools

    const supportedTools = scopedTools.filter(supportedTool => isConfigTypeSupported(supportedTool, configType, toolsConfig))

    if (supportedTools.length === 0) {
      continue
    }

    const spinner = logger.start(`迁移 ${configType}... (Migrating ${configType}...)`)

    try {
      let migrator: BaseMigrator

      switch (configType) {
        case 'rules': {
          const ruleSourcePath = options.scope === 'project'
            ? sourceDir
            : await getRuleSourcePath(sourceDir)
          migrator = new RulesMigrator(ruleSourcePath, supportedTools, options, toolsConfig)
          break
        }
        case 'commands': {
          const commandsPath = await getCommandsSourcePath(sourceDir)
          migrator = new CommandsMigrator(commandsPath, supportedTools, options, toolsConfig)
          break
        }
        case 'skills': {
          if (options.scope === 'project') {
            for (const scopedTool of supportedTools) {
              const preferSource = scopedTool === 'claude'
                ? 'codex'
                : 'claude'
              const skillsPath = await getProjectSkillsSourcePathByPreference(sourceDir, preferSource)
              const scopedMigrator = new SkillsMigrator(skillsPath, [scopedTool], options, toolsConfig)
              const scopedResults = await scopedMigrator.migrate()
              results.success += scopedResults.success
              results.skipped += scopedResults.skipped
              results.error += scopedResults.error
              results.errors.push(...scopedResults.errors)
            }
            spinner.succeed(chalk.green(`迁移 ${configType} 完成 (Migrated ${configType} successfully)`))
            continue
          }

          const skillsPath = await getSkillsSourcePath(sourceDir)
          migrator = new SkillsMigrator(skillsPath, supportedTools, options, toolsConfig)
          break
        }
        case 'agents': {
          const agentsPath = await getAgentsSourcePath(sourceDir)
          migrator = new AgentsMigrator(agentsPath, supportedTools, options, toolsConfig)
          break
        }
        case 'mcp': {
          const mcpPath = await getMCPSourcePath(sourceDir)
          migrator = new MCPMigrator(mcpPath, supportedTools, options, toolsConfig)
          break
        }
        case 'settings': {
          const settingsPath = await getSettingsSourcePath(sourceDir)
          migrator = new SettingsMigrator(settingsPath, supportedTools, options, toolsConfig)
          break
        }
        default:
          throw new Error(`不支持的配置类型 (Unsupported config type): ${configType}`)
      }

      const typeResults = await migrator.migrate()
      results.success += typeResults.success
      results.skipped += typeResults.skipped
      results.error += typeResults.error
      results.errors.push(...typeResults.errors)

      spinner.succeed(chalk.green(`迁移 ${configType} 完成 (Migrated ${configType} successfully)`))
    }
    catch (error) {
      spinner.fail(chalk.red(`迁移 ${configType} 失败 (Failed to migrate ${configType})`))
      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error'
      console.error(chalk.red(errorMessage))
      results.error++
      results.errors.push({ file: configType, error: errorMessage })
    }
  }

  /** Layer 2: AI 批量适配（--smart 模式，迁移完成后执行） */
  if (options.smart) {
    const aiConfigTypes: ConfigType[] = ['skills', 'agents', 'commands', 'rules']
    const aiTools = options.scope === 'project'
      ? options.tools.filter(tool => tool === 'claude' || tool === 'codex')
      : options.tools

    for (const tool of aiTools) {
      if (tool === 'claude')
        continue

      const vecDirs: string[] = []
      for (const ct of aiConfigTypes) {
        if (!configTypes.includes(ct))
          continue
        if (!isConfigTypeSupported(tool, ct, toolsConfig))
          continue
        try {
          vecDirs.push(await resolveTargetPathByScope(tool, ct, options.scope, sourceDir))
        }
        catch { /* 忽略不存在的路径 */ }
      }

      if (vecDirs.length > 0) {
        await batchAdaptWithAI(tool, vecDirs, options.smartProvider)
      }
    }
  }

  logger.summary(results)
}

main().catch((error) => {
  console.error(chalk.red('迁移失败 (Migration failed):'), error)
  process.exit(1)
})

/** 类型定义 */
/**
 * 命令行选项
 */
interface CommandLineOptions {
  tools: ToolKey[]
  configTypes?: ConfigType[]
  autoOverwrite: boolean
  scope: ConfigDirType
  sourceDir: string | undefined
  config?: string
  smart?: boolean
  smartProvider?: SmartProvider
}

/**
 * 交互式答案
 */
interface InteractiveAnswers {
  tools: ToolKey[]
  configTypes: ConfigType[]
  overwrite: boolean
  smart: boolean
  scope: ConfigDirType
  smartProvider?: SmartProvider
  sourceDir?: string
}
