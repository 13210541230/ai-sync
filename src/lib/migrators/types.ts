import type { MigrationError } from '../utils/logger'

/**
 * 迁移选项
 */
export interface MigrateOptions {
  autoOverwrite: boolean
  sourceDir?: string
  /** 启用 AI 智能适配 */
  smart?: boolean
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
