import type { ConfigDirType, SmartProvider } from '../types/config'
import type { MigrationError } from '../utils/logger'

/**
 * 迁移选项
 */
export interface MigrateOptions {
  autoOverwrite: boolean
  sourceDir?: string
  /** 配置作用域（全局/项目） */
  scope?: ConfigDirType
  /** 启用 AI 智能适配 */
  smart?: boolean
  /** AI 智能适配后端 */
  smartProvider?: SmartProvider
}

/**
 * 复制/迁移结果统计
 */
export interface MigrationStats {
  success: number
  skipped: number
  error: number
  errors: MigrationError[]
}
