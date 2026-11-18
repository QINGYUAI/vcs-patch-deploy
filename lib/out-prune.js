/**
 * deploy/out 清理：按保留数量删除旧的 patch 目录与 zip
 *
 * 只处理本工具命名的产物（patch-* / <zipPrefix>-*.zip），不会碰用户文件；
 * 当前构建的产物与最近 keep 个产物始终保留。
 */

const fs = require('fs')
const path = require('path')
const fse = require('fs-extra')

const STAGING_MAX_AGE_MS = 60 * 60 * 1000

/**
 * @param {string} outDir
 * @param {object} [options]
 * @param {number} [options.keep=10] 保留的 patch 目录/zip 数量
 * @param {string} [options.zipPrefix='backend-update']
 * @param {string[]} [options.keepPaths] 必须保留的路径（当前产物）
 * @returns {Promise<string[]>} 被删除的产物名
 */
async function pruneOutDirectory (outDir, options = {}) {
  if (!fs.existsSync(outDir)) {
    return []
  }

  const keep = Math.max(1, Number(options.keep) || 10)
  const zipPrefix = options.zipPrefix || 'backend-update'
  /** @type {Set<string>} */
  const forced = new Set(
    (options.keepPaths || [])
      .filter(Boolean)
      .map(p => path.basename(p))
  )

  let entries
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true })
  } catch {
    return []
  }

  /** @type {string[]} */
  const removed = []

  /**
   * @param {import('fs').Dirent[]} items
   * @returns {import('fs').Dirent[]}
   */
  const sortByMtimeDesc = (items) => {
    return [...items].sort((a, b) => {
      const ma = safeMtime(path.join(outDir, a.name))
      const mb = safeMtime(path.join(outDir, b.name))
      if (ma !== mb) return mb - ma
      return b.name.localeCompare(a.name)
    })
  }

  /**
   * @param {import('fs').Dirent[]} items
   */
  const pruneItems = async (items) => {
    let kept = 0
    for (const item of sortByMtimeDesc(items)) {
      if (forced.has(item.name)) {
        kept++
      }
    }

    for (const item of sortByMtimeDesc(items)) {
      if (forced.has(item.name)) continue
      if (kept >= keep) {
        const abs = path.join(outDir, item.name)
        await fse.remove(abs).catch(() => {})
        removed.push(item.name)
        continue
      }
      kept++
    }
  }

  const patchDirs = entries.filter(
    e => e.isDirectory() && e.name.startsWith('patch-') && !e.name.includes('.staging-')
  )
  const zipFiles = entries.filter(
    e => e.isFile() && e.name.startsWith(`${zipPrefix}-`) && e.name.endsWith('.zip')
  )
  const stagingDirs = entries.filter(
    e => e.isDirectory() && /\.staging-\d+$/.test(e.name)
  )

  await pruneItems(patchDirs)
  await pruneItems(zipFiles)

  // 异常中断留下的 staging 目录：超过 1 小时才清理，避免误删并发构建
  const now = Date.now()
  for (const item of stagingDirs) {
    const abs = path.join(outDir, item.name)
    if (now - safeMtime(abs) < STAGING_MAX_AGE_MS) continue
    await fse.remove(abs).catch(() => {})
    removed.push(item.name)
  }

  return removed
}

/**
 * @param {string} filePath
 * @returns {number}
 */
function safeMtime (filePath) {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

module.exports = {
  pruneOutDirectory
}
