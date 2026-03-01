/**
 * Skills 迁移器
 */

import type { ToolConfig, ToolKey } from '../config'
import type { MigrateOptions, MigrationStats } from './types'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { copyDirectory, directoryExists, ensureDirectoryExists, fileExists, getMarkdownFiles, readFile, writeFile } from '../utils/file'
import { BaseMigrator } from './base'

const PROJECT_SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage'])

interface ProjectSkillPair {
  sourceDir: string
  targetDir: string
}

/**
 * Skills 迁移器类
 */
export class SkillsMigrator extends BaseMigrator {
  constructor(sourceDir: string, targetTools: ToolKey[], options: MigrateOptions, tools: Record<ToolKey, ToolConfig>) {
    super(sourceDir, targetTools, options, 'skills', tools)
  }

  /**
   * 为单个工具执行迁移
   */
  protected async migrateForTool(tool: ToolKey, targetDir: string): Promise<MigrationStats> {
    const results: MigrationStats = { success: 0, skipped: 0, error: 0, errors: [] }
    const toolConfig = this.tools[tool]

    if (this.options.scope === 'project' && (tool === 'claude' || tool === 'codex')) {
      await this.migrateProjectSkills(tool, results)
      return results
    }

    /** 如果有自定义 transform 函数，使用自定义逻辑 */
    if (toolConfig?.skills?.transform) {
      await this.migrateWithTransform(this.sourceDir, targetDir, results, tool)
    }
    else {
      const stats = await copyDirectory(this.sourceDir, targetDir, this.options.autoOverwrite)
      this.sumStats(results, stats)
    }

    return results
  }

  /**
   * 带自定义转换的迁移
   */
  private async migrateWithTransform(
    sourceDir: string,
    targetDir: string,
    results: MigrationStats,
    tool: ToolKey,
  ): Promise<void> {
    const transform = this.tools[tool]?.skills?.transform
    if (!transform)
      return

    const files = await getMarkdownFiles(sourceDir, true)

    for (const file of files) {
      const sourcePath = join(sourceDir, file)
      const targetPath = join(targetDir, file)

      if (await fileExists(targetPath) && !this.options.autoOverwrite) {
        results.skipped++
        continue
      }

      try {
        const content = await readFile(sourcePath, 'utf-8')
        const transformed = await transform(content, file)

        // transform 返回 null 表示跳过该文件（Claude 专属内容）
        if (transformed === null || transformed === undefined) {
          this.logger.warn(`⚠ 跳过 Skill: ${file} (${tool}) — Claude 专属内容`)
          results.skipped++
          continue
        }

        await ensureDirectoryExists(dirname(targetPath))
        await writeFile(targetPath, transformed, 'utf-8')
        this.reportSuccess(`转换 Skills: ${file} (${tool})`)
        results.success++
      }
      catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : 'Unknown error'
        this.reportError(`转换 Skills 失败: ${file}`, errorMessage)
        results.error++
        results.errors.push({ file, error: errorMessage })
      }
    }
  }

  /**
   * 项目级 Skills 迁移（按组织目录逐个映射 .claude/.codex）
   */
  private async migrateProjectSkills(tool: ToolKey, results: MigrationStats): Promise<void> {
    const projectRoot = this.options.sourceDir || this.sourceDir
    const sourceConfigDir = tool === 'codex'
      ? '.claude'
      : '.codex'
    const targetConfigDir = tool === 'codex'
      ? '.codex'
      : '.claude'

    const pairs = await this.collectProjectSkillPairs(projectRoot, projectRoot, sourceConfigDir, targetConfigDir)
    for (const pair of pairs) {
      const transform = this.tools[tool]?.skills?.transform
      if (transform) {
        await this.migrateWithTransform(pair.sourceDir, pair.targetDir, results, tool)
      }
      else {
        const stats = await copyDirectory(pair.sourceDir, pair.targetDir, this.options.autoOverwrite)
        this.sumStats(results, stats)
      }
    }
  }

  /**
   * 收集项目内 skills 源/目标目录对
   */
  private async collectProjectSkillPairs(
    projectRoot: string,
    scanDir: string,
    sourceConfigDir: '.claude' | '.codex',
    targetConfigDir: '.claude' | '.codex',
  ): Promise<ProjectSkillPair[]> {
    const pairs: ProjectSkillPair[] = []

    let entries
    try {
      entries = await readdir(scanDir, { withFileTypes: true })
    }
    catch {
      return pairs
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      if (PROJECT_SCAN_SKIP_DIRS.has(entry.name)) {
        continue
      }

      const dirPath = join(scanDir, entry.name)
      if (entry.name === sourceConfigDir) {
        const sourceSkills = join(dirPath, 'skills')
        if (await directoryExists(sourceSkills)) {
          const targetSkills = join(scanDir, targetConfigDir, 'skills')
          pairs.push({ sourceDir: sourceSkills, targetDir: targetSkills })
        }
        continue
      }

      pairs.push(...await this.collectProjectSkillPairs(projectRoot, dirPath, sourceConfigDir, targetConfigDir))
    }

    if (scanDir === projectRoot) {
      const rootSourceSkills = join(projectRoot, sourceConfigDir, 'skills')
      if (await directoryExists(rootSourceSkills)) {
        const targetSkills = join(projectRoot, targetConfigDir, 'skills')
        const exists = pairs.some(pair => pair.sourceDir.toLowerCase() === rootSourceSkills.toLowerCase())
        if (!exists) {
          pairs.unshift({ sourceDir: rootSourceSkills, targetDir: targetSkills })
        }
      }
    }

    return pairs
  }
}
