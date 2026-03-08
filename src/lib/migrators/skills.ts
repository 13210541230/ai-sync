/**
 * Skills 迁移器
 */

import type { ToolConfig, ToolKey } from '../config'
import type { MigrateOptions, MigrationStats } from './types'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getCentralSkillsDir } from '../path'
import { copyDirectory, copyFileSafe, createDirectoryLink, directoryExists, ensureDirectoryExists, fileExists, getMarkdownFiles, isSymlinkOrJunction, readFile, writeFile } from '../utils/file'
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
   * 覆写主入口：全局 scope 下先逐个 skill 同步到集中目录并替换为链接
   */
  async migrate(): Promise<MigrationStats> {
    if (this.options.scope === 'project' || !await directoryExists(this.sourceDir)) {
      return super.migrate()
    }

    const centralDir = getCentralSkillsDir()
    await this.syncSkillsToCentral(centralDir)

    const originalSourceDir = this.sourceDir
    this.sourceDir = centralDir
    try {
      return await super.migrate()
    }
    finally {
      this.sourceDir = originalSourceDir
    }
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

    /** 显式 useLink：所有 skill 子目录都创建链接 */
    if (toolConfig?.skills?.useLink && this.options.scope !== 'project') {
      const centralDir = getCentralSkillsDir()
      await this.linkAllSkills(centralDir, targetDir, results, tool)
      return results
    }

    /** 有 transform 且非项目 scope：逐个 skill 检测，无变更的链接，有变更的复制 */
    if (toolConfig?.skills?.transform && this.options.scope !== 'project') {
      await this.migratePerSkill(targetDir, results, tool)
    }
    else if (toolConfig?.skills?.transform) {
      await this.migrateWithTransform(this.sourceDir, targetDir, results, tool)
    }
    else {
      const stats = await copyDirectory(this.sourceDir, targetDir, this.options.autoOverwrite)
      this.sumStats(results, stats)
    }

    return results
  }

  /**
   * 逐个 skill 子目录同步到集中目录，并将源目录中的真实目录替换为链接
   */
  private async syncSkillsToCentral(centralDir: string): Promise<void> {
    await ensureDirectoryExists(centralDir)

    let entries
    try {
      entries = await readdir(this.sourceDir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries) {
      const sourcePath = join(this.sourceDir, entry.name)
      const centralPath = join(centralDir, entry.name)

      if (entry.isDirectory()) {
        /** 已是链接 → 跳过 */
        if (await isSymlinkOrJunction(sourcePath))
          continue

        /** 真实目录 → 复制到集中目录，再替换为链接 */
        const stats = await copyDirectory(sourcePath, centralPath, true)
        if (stats.success > 0) {
          this.logger.success(`✓ 同步 Skill: ${entry.name} (${stats.success} files)`)
        }
        const linkResult = await createDirectoryLink(centralPath, sourcePath, true)
        if (linkResult.created) {
          this.logger.success(`✓ 替换为链接: ${entry.name} -> ${centralDir}`)
        }
      }
      else if (entry.isFile()) {
        /** 单文件 skill → 复制到集中目录（文件级无法创建 junction） */
        await copyFileSafe(sourcePath, centralPath, true)
      }
    }
  }

  /**
   * 逐个 skill 子目录处理：transform 无变更的创建链接，有变更的复制+transform
   */
  private async migratePerSkill(
    targetDir: string,
    results: MigrationStats,
    tool: ToolKey,
  ): Promise<void> {
    await ensureDirectoryExists(targetDir)
    const centralDir = getCentralSkillsDir()

    let entries
    try {
      entries = await readdir(this.sourceDir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillDir = join(this.sourceDir, entry.name)
        const centralSubdir = join(centralDir, entry.name)
        const targetSubdir = join(targetDir, entry.name)

        if (await this.isSkillTransformNoOp(tool, skillDir)) {
          /** 无变更 → 链接到集中目录 */
          const linkResult = await createDirectoryLink(centralSubdir, targetSubdir, this.options.autoOverwrite)
          if (linkResult.created) {
            this.reportSuccess(`链接 Skill: ${entry.name} (${tool})`)
            results.success++
          }
          else if (linkResult.skipped) {
            results.skipped++
          }
          else {
            const errorMsg = linkResult.error?.message || 'Unknown link error'
            this.reportError(`链接 Skill 失败: ${entry.name} (${tool})`, errorMsg)
            results.error++
            results.errors.push({ file: entry.name, error: errorMsg })
          }
        }
        else {
          /** 有变更 → 复制+transform */
          await this.migrateWithTransform(skillDir, targetSubdir, results, tool)
        }
      }
      else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdc'))) {
        /** 单文件 skill → 复制+transform */
        const sourcePath = join(this.sourceDir, entry.name)
        const targetPath = join(targetDir, entry.name)
        await this.transformSingleFile(sourcePath, targetPath, entry.name, results, tool)
      }
    }
  }

  /**
   * 所有 skill 子目录创建链接（useLink 模式）
   */
  private async linkAllSkills(
    centralDir: string,
    targetDir: string,
    results: MigrationStats,
    tool: ToolKey,
  ): Promise<void> {
    await ensureDirectoryExists(targetDir)

    let entries
    try {
      entries = await readdir(centralDir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory())
        continue

      const centralSubdir = join(centralDir, entry.name)
      const targetSubdir = join(targetDir, entry.name)

      const linkResult = await createDirectoryLink(centralSubdir, targetSubdir, this.options.autoOverwrite)
      if (linkResult.created) {
        this.reportSuccess(`链接 Skill: ${entry.name} (${tool})`)
        results.success++
      }
      else if (linkResult.skipped) {
        results.skipped++
      }
      else {
        const errorMsg = linkResult.error?.message || 'Unknown link error'
        this.reportError(`链接 Skill 失败: ${entry.name} (${tool})`, errorMsg)
        results.error++
        results.errors.push({ file: entry.name, error: errorMsg })
      }
    }
  }

  /**
   * 检测 transform 是否对某个 skill 子目录的所有文件都无变更
   */
  private async isSkillTransformNoOp(tool: ToolKey, skillDir: string): Promise<boolean> {
    const transform = this.tools[tool]?.skills?.transform
    if (!transform)
      return true

    const files = await getMarkdownFiles(skillDir, true)
    if (files.length === 0)
      return true

    for (const file of files) {
      try {
        const content = await readFile(join(skillDir, file), 'utf-8')
        const transformed = await transform(content, file)

        if (transformed === null || transformed === undefined)
          return false
        if (transformed !== content)
          return false
      }
      catch {
        return false
      }
    }

    return true
  }

  /**
   * 转换并写入单个文件
   */
  private async transformSingleFile(
    sourcePath: string,
    targetPath: string,
    fileName: string,
    results: MigrationStats,
    tool: ToolKey,
  ): Promise<void> {
    const transform = this.tools[tool]?.skills?.transform
    if (!transform)
      return

    if (await fileExists(targetPath) && !this.options.autoOverwrite) {
      results.skipped++
      return
    }

    try {
      const content = await readFile(sourcePath, 'utf-8')
      const transformed = await transform(content, fileName)

      if (transformed === null || transformed === undefined) {
        this.logger.warn(`⚠ 跳过 Skill: ${fileName} (${tool}) — Claude 专属内容`)
        results.skipped++
        return
      }

      await ensureDirectoryExists(dirname(targetPath))
      await writeFile(targetPath, transformed, 'utf-8')
      this.reportSuccess(`转换 Skills: ${fileName} (${tool})`)
      results.success++
    }
    catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : 'Unknown error'
      this.reportError(`转换 Skills 失败: ${fileName}`, errorMessage)
      results.error++
      results.errors.push({ file: fileName, error: errorMessage })
    }
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
