/**
 * 文件工具函数
 */

import type { MigrationError } from './logger'
import { access, chmod, constants, copyFile, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import TOML from '@iarna/toml'
import stripJsonComments from 'strip-json-comments'

export { readFile, writeFile }

/**
 * 确保目录存在
 */
export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true })
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'EEXIST') {
      throw error
    }
  }
}

/**
 * 检查文件是否存在
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  }
  catch {
    return false
  }
}

/**
 * 检查目录是否存在
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await stat(dirPath)
    return stats.isDirectory()
  }
  catch {
    return false
  }
}

/**
 * 安全复制文件
 */
export async function copyFileSafe(
  sourcePath: string,
  targetPath: string,
  autoOverwrite: boolean = false,
): Promise<CopyResult> {
  if (await fileExists(targetPath) && !autoOverwrite) {
    return { success: false, skipped: true, error: null }
  }

  try {
    await ensureDirectoryExists(dirname(targetPath))
    await copyFile(sourcePath, targetPath)
    return { success: true, skipped: false, error: null }
  }
  catch (error) {
    return { success: false, skipped: false, error: error instanceof Error
      ? error
      : new Error(String(error)) }
  }
}

/**
 * 复制目录
 */
export async function copyDirectory(
  sourceDir: string,
  targetDir: string,
  autoOverwrite: boolean = false,
): Promise<CopyDirectoryResults> {
  const results: CopyDirectoryResults = { success: 0, skipped: 0, error: 0, errors: [] }

  try {
    const entries = await readdir(sourceDir, { withFileTypes: true })

    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name)
      const targetPath = join(targetDir, entry.name)

      if (entry.isDirectory()) {
        const subdirResults = await copyDirectory(sourcePath, targetPath, autoOverwrite)
        results.success += subdirResults.success
        results.skipped += subdirResults.skipped
        results.error += subdirResults.error
        results.errors.push(...subdirResults.errors)
      }
      else if (entry.isFile()) {
        const result = await copyFileSafe(sourcePath, targetPath, autoOverwrite)
        if (result.success) {
          results.success++
        }
        else if (result.skipped) {
          results.skipped++
        }
        else {
          results.error++
          results.errors.push({ file: entry.name, error: result.error?.message || 'Unknown error' })
        }
      }
    }
  }
  catch (error) {
    /** 如果目录不存在，视为跳过，不记为错误 (If directory not found, treat as skipped, not an error) */
    if (error instanceof Error && (error as any).code === 'ENOENT') {
      return results
    }
    results.error++
    results.errors.push({ file: sourceDir, error: error instanceof Error
      ? error.message
      : 'Unknown error' })
  }

  return results
}

/**
 * 获取 Markdown 文件列表（支持递归）
 * @param dirPath 目录路径
 * @param recursive 递归扫描子目录，返回相对路径（如 `react/SKILL.md`）
 */
export async function getMarkdownFiles(dirPath: string, recursive = false): Promise<string[]> {
  const files: string[] = []

  async function scan(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = prefix
        ? `${prefix}/${entry.name}`
        : entry.name
      if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdc'))) {
        files.push(relativePath)
      }
      else if (recursive && entry.isDirectory()) {
        await scan(join(dir, entry.name), relativePath)
      }
    }
  }

  try {
    await scan(dirPath, '')
  }
  catch (error) {
    /** 忽略目录不存在的错误 (Ignore directory not found error) */
    if (error instanceof Error && (error as any).code === 'ENOENT') {
      return []
    }
    console.error(`读取目录失败: ${dirPath}`, error instanceof Error
      ? error.message
      : 'Unknown error')
  }

  return files
}

/**
 * 读取 JSON 文件（支持 JSONC 格式）
 */
export async function readJSONFile<T = unknown>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8')
  const cleanedContent = stripJsonComments(content)
  return JSON.parse(cleanedContent) as T
}

/**
 * 写入 JSON 文件
 */
export async function writeJSONFile(filePath: string, data: unknown): Promise<void> {
  await ensureDirectoryExists(dirname(filePath))
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 读取 TOML 文件
 */
export async function readTOMLFile<T = unknown>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8')
  return TOML.parse(content) as unknown as T
}

/**
 * 写入 TOML 文件
 */
export async function writeTOMLFile(filePath: string, data: any): Promise<void> {
  await ensureDirectoryExists(dirname(filePath))
  await writeFile(filePath, TOML.stringify(data), 'utf-8')
}

/**
 * 设置可执行权限
 */
export async function setExecutablePermission(filePath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(filePath, 0o755)
  }
}

/**
 * 检查路径是否为符号链接或 junction
 */
export async function isSymlinkOrJunction(targetPath: string): Promise<boolean> {
  try {
    const stats = await lstat(targetPath)
    return stats.isSymbolicLink()
  }
  catch {
    return false
  }
}

/**
 * 创建目录链接（Windows 用 junction，其他平台用 symlink）
 *
 * 若目标已是指向相同源的链接，则跳过。
 * 若目标已存在（非链接的真实目录），根据 autoOverwrite 决定是否替换。
 */
export async function createDirectoryLink(
  source: string,
  target: string,
  autoOverwrite: boolean = false,
): Promise<LinkResult> {
  if (await isSymlinkOrJunction(target)) {
    try {
      const existingTarget = await readlink(target)
      if (resolve(existingTarget) === resolve(source)) {
        return { created: false, skipped: true, error: null }
      }
    }
    catch { /* readlink 失败则继续重建 */ }

    await rm(target, { force: true, recursive: false })
  }
  else if (await directoryExists(target)) {
    if (!autoOverwrite) {
      return { created: false, skipped: true, error: null }
    }
    await rm(target, { recursive: true, force: true })
  }

  await ensureDirectoryExists(dirname(target))

  try {
    const linkType = platform() === 'win32'
      ? 'junction'
      : 'dir'
    await symlink(source, target, linkType)
    return { created: true, skipped: false, error: null }
  }
  catch (error) {
    return {
      created: false,
      skipped: false,
      error: error instanceof Error
        ? error
        : new Error(String(error)),
    }
  }
}

/**
 * 移除符号链接/junction（不递归删除内容）
 */
export async function removeLink(linkPath: string): Promise<void> {
  if (await isSymlinkOrJunction(linkPath)) {
    await rm(linkPath, { force: true, recursive: false })
  }
}

export interface LinkResult {
  created: boolean
  skipped: boolean
  error: Error | null
}

export interface CopyResult {
  success: boolean
  skipped: boolean
  error: Error | null
}

export interface CopyDirectoryResults {
  success: number
  skipped: number
  error: number
  errors: MigrationError[]
}

/**
 * 移除目录及其内容
 */
export async function removeDirectory(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true })
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      throw error
    }
  }
}
