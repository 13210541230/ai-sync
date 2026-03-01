/**
 * Rules 迁移器
 */

import type { ToolConfig, ToolKey } from '../config'
import type { MigrateOptions, MigrationStats } from './types'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { mergeRules } from '../converters/rules-merger'
import { adaptContent } from '../converters/smart-adapt'
import { copyDirectory, copyFileSafe, directoryExists, ensureDirectoryExists, fileExists, readFile, writeFile } from '../utils/file'
import { BaseMigrator } from './base'

const PROJECT_RULE_NAME = /^(claude|agents)\.md$/i
const PROJECT_SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage'])

interface ProjectRuleFile {
  sourcePath: string
  relativeDir: string
}

/**
 * Rules 迁移器类
 */
export class RulesMigrator extends BaseMigrator {
  constructor(sourceDir: string, targetTools: ToolKey[], options: MigrateOptions, tools: Record<ToolKey, ToolConfig>) {
    super(sourceDir, targetTools, options, 'rules', tools)
  }

  /**
   * 为单个工具执行迁移
   */
  protected async migrateForTool(tool: ToolKey, targetDir: string): Promise<MigrationStats> {
    const results: MigrationStats = { success: 0, skipped: 0, error: 0, errors: [] }
    const toolConfig = this.tools[tool]

    if (!toolConfig.rules) {
      return results
    }

    if (this.options.scope === 'project' && (tool === 'claude' || tool === 'codex')) {
      await this.migrateProjectRules(tool, results)
      return results
    }

    /** 检查源路径是文件还是目录 */
    let isSourceFile = false
    try {
      const sourceStats = await stat(this.sourceDir)
      isSourceFile = sourceStats.isFile()
    }
    catch (error) {
      if (error instanceof Error && (error as any).code === 'ENOENT') {
        /** 源不存在，视为正常跳过 (Source not found, treat as normal skip) */
        return results
      }
      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error'
      results.error++
      results.errors.push({ file: this.sourceDir, error: errorMessage })
      return results
    }

    if (isSourceFile) {
      await this.migrateSingleFile(tool, results)
    }
    else {
      if (toolConfig.rules.customMerge) {
        await this.migrateWithCustomMerge(tool, results)
      }
      else if (toolConfig.rules.merge) {
        await this.migrateWithMerge(tool, results)
      }
      else {
        await this.migrateDirect(tool, targetDir, results)
      }
    }

    return results
  }

  /**
   * 直接迁移 (带格式转换或直接复制)
   */
  private async migrateDirect(tool: ToolKey, targetDir: string, results: MigrationStats): Promise<void> {
    const toolConfig = this.tools[tool]

    /** 如果有自定义 transform 函数，使用自定义逻辑处理目录 */
    if (toolConfig?.rules?.transform) {
      await this.copyWithTransform(this.sourceDir, targetDir, results, toolConfig.rules.transform)
      return
    }

    const stats = await copyDirectory(this.sourceDir, targetDir, this.options.autoOverwrite)
    this.sumStats(results, stats)
  }

  /**
   * 自定义合并迁移
   */
  private async migrateWithCustomMerge(tool: ToolKey, results: MigrationStats): Promise<void> {
    const customMerge = this.tools[tool]?.rules?.customMerge
    if (!customMerge)
      return

    const targetFile = await this.getTargetDir(tool)

    try {
      await customMerge(this.sourceDir, targetFile)
      this.reportSuccess(`自定义合并 Rules → ${tool} (Custom merge Rules → ${tool})`)
      results.success++
    }
    catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error'
      this.reportError(`自定义合并 Rules 失败 (${tool}) (Custom merge Rules failed (${tool}))`, errorMessage)
      results.error++
      results.errors.push({ file: targetFile, error: errorMessage })
    }
  }

  /**
   * 合并迁移
   */
  private async migrateWithMerge(tool: ToolKey, results: MigrationStats): Promise<void> {
    const targetFile = await this.getTargetDir(tool)

    try {
      await mergeRules(this.sourceDir, targetFile)
      this.reportSuccess(`合并 Rules → ${tool} (Merge Rules → ${tool})`)
      results.success++
    }
    catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error'
      this.reportError(`合并 Rules 失败 (${tool}) (Merge Rules failed (${tool}))`, errorMessage)
      results.error++
      results.errors.push({ file: targetFile, error: errorMessage })
    }
  }

  /**
   * 单个文件迁移
   */
  private async migrateSingleFile(tool: ToolKey, results: MigrationStats): Promise<void> {
    const targetFile = await this.getTargetDir(tool)

    try {
      const copyResult = await copyFileSafe(this.sourceDir, targetFile, this.options.autoOverwrite)
      if (copyResult.success) {
        this.reportSuccess(`复制 Rules 文件 → ${tool} (Copy Rules file → ${tool})`)
        results.success++
      }
      else if (copyResult.skipped) {
        this.logger.warn(`⚠ 跳过 Rules 文件 (${tool}): 文件已存在 (Skip Rules file (${tool}): File already exists)`)
        results.skipped++
      }
      else {
        const errorMessage = copyResult.error?.message || 'Unknown error'
        this.reportError(`复制 Rules 文件失败 (${tool}) (Copy Rules file failed (${tool}))`, errorMessage)
        results.error++
        results.errors.push({ file: targetFile, error: errorMessage })
      }
    }
    catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error'
      this.reportError(`复制 Rules 文件失败 (${tool}) (Copy Rules file failed (${tool}))`, errorMessage)
      results.error++
      results.errors.push({ file: targetFile, error: errorMessage })
    }
  }

  /**
   * 项目级 Rules 迁移（递归规则文件 + 项目级 rules 目录）
   */
  private async migrateProjectRules(tool: ToolKey, results: MigrationStats): Promise<void> {
    const projectRoot = this.sourceDir
    const targetRuleName = tool === 'codex'
      ? 'AGENTS.md'
      : 'CLAUDE.md'
    const transform = this.tools[tool]?.rules?.transform

    const files = await this.collectProjectRuleFiles(projectRoot, projectRoot)
    const selectedFiles = this.selectProjectRuleFiles(files, targetRuleName, projectRoot)

    for (const file of selectedFiles) {
      const targetFile = file.relativeDir
        ? join(projectRoot, file.relativeDir, targetRuleName)
        : join(projectRoot, targetRuleName)

      if (file.sourcePath.toLowerCase() === targetFile.toLowerCase()) {
        results.skipped++
        continue
      }

      if (await fileExists(targetFile) && !this.options.autoOverwrite) {
        results.skipped++
        continue
      }

      try {
        const content = await readFile(file.sourcePath, 'utf-8')
        const transformed = transform
          ? await transform(content, basename(file.sourcePath))
          : content
        const adapted = this.adaptProjectRuleContent(transformed, tool)
        await ensureDirectoryExists(dirname(targetFile))
        await writeFile(targetFile, adapted, 'utf-8')
        this.reportSuccess(`迁移项目规则文件: ${file.sourcePath} → ${targetFile}`)
        results.success++
      }
      catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : 'Unknown error'
        this.reportError(`迁移项目规则文件失败: ${file.sourcePath}`, errorMessage)
        results.error++
        results.errors.push({ file: file.sourcePath, error: errorMessage })
      }
    }

    await this.migrateProjectRuleDirectory(tool, projectRoot, results)
  }

  /**
   * 递归收集项目内 CLAUDE.md / AGENTS.md
   */
  private async collectProjectRuleFiles(rootDir: string, scanDir: string): Promise<ProjectRuleFile[]> {
    const files: ProjectRuleFile[] = []
    let entries
    try {
      entries = await readdir(scanDir, { withFileTypes: true })
    }
    catch {
      return files
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (PROJECT_SCAN_SKIP_DIRS.has(entry.name)) {
          continue
        }
        files.push(...await this.collectProjectRuleFiles(rootDir, join(scanDir, entry.name)))
      }
      else if (entry.isFile() && PROJECT_RULE_NAME.test(entry.name)) {
        const sourcePath = join(scanDir, entry.name)
        const relativeDirRaw = relative(rootDir, scanDir)
        const relativeDir = relativeDirRaw === '.'
          ? ''
          : relativeDirRaw
        files.push({ sourcePath, relativeDir })
      }
    }

    return files
  }

  /**
   * 同目录优先选择 CLAUDE.md，其次 AGENTS.md
   */
  private selectProjectRuleFiles(
    files: ProjectRuleFile[],
    targetRuleName: string,
    projectRoot: string,
  ): ProjectRuleFile[] {
    const priorityNames = targetRuleName.toLowerCase() === 'agents.md'
      ? ['claude.md', 'agents.md']
      : ['agents.md', 'claude.md']

    const grouped = new Map<string, ProjectRuleFile[]>()
    for (const file of files) {
      const vecGroup = grouped.get(file.relativeDir) || []
      vecGroup.push(file)
      grouped.set(file.relativeDir, vecGroup)
    }

    const selected: ProjectRuleFile[] = []
    for (const [relativeDir, group] of grouped.entries()) {
      const targetFilePath = (relativeDir
        ? join(projectRoot, relativeDir, targetRuleName)
        : join(projectRoot, targetRuleName)).toLowerCase()

      const sorted = [...group].sort((a, b) => {
        const aName = basename(a.sourcePath).toLowerCase()
        const bName = basename(b.sourcePath).toLowerCase()
        const aPriority = priorityNames.indexOf(aName)
        const bPriority = priorityNames.indexOf(bName)
        return aPriority - bPriority
      })

      const candidate = sorted.find(file => file.sourcePath.toLowerCase() !== targetFilePath) || sorted[0]
      selected.push(candidate)
    }

    return selected
  }

  /**
   * 迁移项目级 rules 目录（.claude/rules 或 .codex/rules）
   */
  private async migrateProjectRuleDirectory(tool: ToolKey, projectRoot: string, results: MigrationStats): Promise<void> {
    const sourceCandidates = [
      join(projectRoot, '.claude/rules'),
      join(projectRoot, '.codex/rules'),
    ]

    let sourceDir: string | undefined
    for (const candidate of sourceCandidates) {
      if (await directoryExists(candidate)) {
        sourceDir = candidate
        break
      }
    }

    if (!sourceDir) {
      return
    }

    const targetDir = tool === 'codex'
      ? join(projectRoot, '.codex/rules')
      : join(projectRoot, '.claude/rules')

    if (sourceDir.toLowerCase() === targetDir.toLowerCase()) {
      return
    }

    const transform = this.tools[tool]?.rules?.transform
    if (transform) {
      await this.copyWithTransform(sourceDir, targetDir, results, transform)
      return
    }

    const stats = await copyDirectory(sourceDir, targetDir, this.options.autoOverwrite)
    this.sumStats(results, stats)
  }

  /**
   * 项目级 rules 内容按目标工具做最小适配
   */
  private adaptProjectRuleContent(content: string, tool: ToolKey): string {
    if (tool === 'codex') {
      return adaptContent(content, 'codex')
    }

    if (tool === 'claude') {
      return content
        .replace(/~\/\.codex\//g, '~/.claude/')
        .replace(/\.codex\//g, '.claude/')
        .replace(/AGENTS\.md/g, 'CLAUDE.md')
        .replace(/config\.toml/g, '.claude.json')
        .replace(/\bCodex\b/g, 'Claude Code')
    }

    return content
  }

  /**
   * 递归转换 (Transform)
   */
  private async copyWithTransform(
    sourceDir: string,
    targetDir: string,
    results: MigrationStats,
    transform: (content: string, fileName: string) => string | Promise<string>,
  ): Promise<void> {
    try {
      const entries = await readdir(sourceDir, { withFileTypes: true })

      for (const entry of entries) {
        const sourcePath = join(sourceDir, entry.name)
        const targetPath = join(targetDir, entry.name)

        if (entry.isDirectory()) {
          await this.copyWithTransform(sourcePath, targetPath, results, transform)
        }
        else if (entry.isFile()) {
          if (await fileExists(targetPath) && !this.options.autoOverwrite) {
            results.skipped++
            continue
          }

          try {
            const content = await readFile(sourcePath, 'utf-8')
            const transformed = await transform(content, entry.name)
            await ensureDirectoryExists(dirname(targetPath))
            await writeFile(targetPath, transformed, 'utf-8')
            results.success++
          }
          catch (error) {
            results.error++
            results.errors.push({ file: entry.name, error: error instanceof Error
              ? error.message
              : '转换失败 (Conversion failed)' })
          }
        }
      }
    }
    catch (error) {
      results.error++
      results.errors.push({ file: sourceDir, error: error instanceof Error
        ? error.message
        : 'Unknown error' })
    }
  }
}
