/**
 * MANIFEST.txt 解析（build / extract / 测试共用）
 */

const fs = require('fs')
const path = require('path')
const { isSafeRelativePath } = require('./file-filter')

/**
 * 从 patch 目录 MANIFEST.txt 读取 # files 段
 * @param {string} patchDir
 * @returns {string[]}
 */
function readManifestFiles (patchDir) {
  const manifestPath = path.join(patchDir, 'MANIFEST.txt')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`缺少 MANIFEST.txt: ${manifestPath}`)
  }

  const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)
  /** @type {string[]} */
  const files = []
  let inFiles = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '# files') {
      inFiles = true
      continue
    }
    if (inFiles && trimmed.startsWith('#')) {
      break
    }
    if (inFiles && trimmed) {
      const rel = trimmed.replace(/\\/g, '/')
      if (!isSafeRelativePath(rel)) {
        throw new Error(`MANIFEST.txt 含不安全路径（拒绝处理）: ${rel}`)
      }
      files.push(rel)
    }
  }

  if (files.length === 0) {
    throw new Error(`MANIFEST.txt 中未找到文件列表: ${manifestPath}`)
  }

  return files
}

/**
 * 读取 MANIFEST.txt 的删除段；不存在时返回空数组
 * @param {string} patchDir
 * @returns {string[]}
 */
function readManifestDeleted (patchDir) {
  const manifestPath = path.join(patchDir, 'MANIFEST.txt')
  if (!fs.existsSync(manifestPath)) {
    return []
  }

  const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)
  /** @type {string[]} */
  const files = []
  let inDeleted = false
  let hasSection = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# deleted')) {
      inDeleted = true
      hasSection = true
      continue
    }
    if (inDeleted && trimmed.startsWith('#')) {
      break
    }
    if (inDeleted && trimmed) {
      const rel = trimmed.replace(/\\/g, '/')
      if (isSafeRelativePath(rel)) {
        files.push(rel)
      }
    }
  }

  if (hasSection) {
    return files
  }

  // 兼容只有 MANIFEST-deleted.txt、没有 # deleted 段的旧包
  const deletedPath = path.join(patchDir, 'MANIFEST-deleted.txt')
  if (!fs.existsSync(deletedPath)) {
    return []
  }

  for (const line of fs.readFileSync(deletedPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const rel = trimmed.replace(/\\/g, '/')
    if (isSafeRelativePath(rel)) {
      files.push(rel)
    }
  }

  return files
}

module.exports = {
  readManifestFiles,
  readManifestDeleted
}
