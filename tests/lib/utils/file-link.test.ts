import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDirectoryLink,
  isSymlinkOrJunction,
  removeLink,
} from '@utils/file'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('link functions (real fs)', () => {
  let tmpBase: string

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), 'ai-sync-link-test-'))
  })

  afterEach(async () => {
    await rm(tmpBase, { recursive: true, force: true })
  })

  describe('isSymlinkOrJunction', () => {
    it('对普通目录返回 false', async () => {
      const dir = join(tmpBase, 'real-dir')
      await mkdir(dir, { recursive: true })

      expect(await isSymlinkOrJunction(dir)).toBe(false)
    })

    it('对不存在的路径返回 false', async () => {
      expect(await isSymlinkOrJunction(join(tmpBase, 'nonexistent'))).toBe(false)
    })

    it('对符号链接返回 true', async () => {
      const source = join(tmpBase, 'source-dir')
      const link = join(tmpBase, 'link-dir')
      await mkdir(source, { recursive: true })
      await symlink(source, link, 'junction')

      expect(await isSymlinkOrJunction(link)).toBe(true)
    })
  })

  describe('createDirectoryLink', () => {
    it('应成功创建目录链接', async () => {
      const source = join(tmpBase, 'src')
      const target = join(tmpBase, 'lnk')
      await mkdir(source, { recursive: true })

      const result = await createDirectoryLink(source, target)

      expect(result.created).toBe(true)
      expect(result.skipped).toBe(false)
      expect(result.error).toBeNull()
      expect(await isSymlinkOrJunction(target)).toBe(true)
    })

    it('目标已是相同链接时应跳过', async () => {
      const source = join(tmpBase, 'src')
      const target = join(tmpBase, 'lnk')
      await mkdir(source, { recursive: true })
      await symlink(source, target, 'junction')

      const result = await createDirectoryLink(source, target)

      expect(result.created).toBe(false)
      expect(result.skipped).toBe(true)
      expect(result.error).toBeNull()
    })

    it('目标是真实目录且 autoOverwrite=false 时应跳过', async () => {
      const source = join(tmpBase, 'src')
      const target = join(tmpBase, 'existing')
      await mkdir(source, { recursive: true })
      await mkdir(target, { recursive: true })

      const result = await createDirectoryLink(source, target, false)

      expect(result.created).toBe(false)
      expect(result.skipped).toBe(true)
      expect(result.error).toBeNull()
    })

    it('目标是真实目录且 autoOverwrite=true 时应替换为链接', async () => {
      const source = join(tmpBase, 'src')
      const target = join(tmpBase, 'existing')
      await mkdir(source, { recursive: true })
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'old.txt'), 'old')

      const result = await createDirectoryLink(source, target, true)

      expect(result.created).toBe(true)
      expect(result.skipped).toBe(false)
      expect(result.error).toBeNull()
      expect(await isSymlinkOrJunction(target)).toBe(true)
    })

    it('源目录不存在时应返回结果（不抛异常）', async () => {
      const source = join(tmpBase, 'no-such-dir')
      const target = join(tmpBase, 'lnk')

      const result = await createDirectoryLink(source, target)

      // symlink 在部分平台即使源不存在也能创建，函数本身不校验源
      expect(result).toHaveProperty('created')
      expect(result).toHaveProperty('error')
    })
  })

  describe('removeLink', () => {
    it('应移除符号链接', async () => {
      const source = join(tmpBase, 'src')
      const link = join(tmpBase, 'lnk')
      await mkdir(source, { recursive: true })
      await symlink(source, link, 'junction')

      expect(await isSymlinkOrJunction(link)).toBe(true)
      await removeLink(link)
      expect(await isSymlinkOrJunction(link)).toBe(false)
    })

    it('对非链接路径不执行任何操作', async () => {
      const dir = join(tmpBase, 'real-dir')
      await mkdir(dir, { recursive: true })

      await removeLink(dir)
      const stats = await lstat(dir)
      expect(stats.isDirectory()).toBe(true)
    })
  })
})
