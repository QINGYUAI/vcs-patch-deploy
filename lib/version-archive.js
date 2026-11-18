/**
 * 本地 patch 版本归档 — 保留最近 N 个版本包（方案 C）
 */

const fs = require('fs')
const path = require('path')
const fse = require('fs-extra')
const { sanitizeVersionLabel } = require('./file-filter')
const { writeJsonAtomic } = require('./version-registry')

const ARCHIVE_DIR = 'archive'
const ARCHIVE_INDEX = 'index.json'

/**
 * 生成部署/归档用版本标识（与 apply-update.php 对齐）
 * @param {'svn'|'git'} vcs
 * @param {string} toLabel
 * @param {string|null} [versionLabel] --version 清洗后的标签
 * @returns {string}
 */
function buildDeployVersionLabel (vcs, toLabel, versionLabel = null) {
  if (versionLabel) {
    return sanitizeVersionLabel(versionLabel)
  }
  if (vcs === 'svn') {
    return `r${toLabel}`
  }
  return String(toLabel).slice(0, 12)
}

/**
 * @param {string} deployDir
 * @returns {string}
 */
function getArchiveRoot (deployDir) {
  return path.join(deployDir, ARCHIVE_DIR)
}

/**
 * @param {string} deployDir
 * @param {string} absPath
 * @returns {string}
 */
function toDeployRelative (deployDir, absPath) {
  if (!absPath) return absPath
  if (!path.isAbsolute(absPath)) return absPath.replace(/\\/g, '/')
  const rel = path.relative(deployDir, absPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return absPath
  return rel.split(path.sep).join('/')
}

/**
 * @param {string} deployDir
 * @param {string} value
 * @returns {string}
 */
function fromDeployRelative (deployDir, value) {
  if (!value || path.isAbsolute(value)) return value
  return path.resolve(deployDir, value)
}

/**
 * @param {string} deployDir
 * @returns {{ versions: object[] }}
 */
function readArchiveIndex (deployDir) {
  const indexPath = path.join(getArchiveRoot(deployDir), ARCHIVE_INDEX)
  if (!fs.existsSync(indexPath)) {
    return { versions: [] }
  }

  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    if (Array.isArray(data.versions)) {
      for (const record of data.versions) {
        if (!record || typeof record !== 'object') continue
        if (record.archiveDir) record.archiveDir = fromDeployRelative(deployDir, record.archiveDir)
        if (record.zipPath) record.zipPath = fromDeployRelative(deployDir, record.zipPath)
      }
      return data
    }
  } catch (error) {
    console.warn(`[vcs-patch-deploy] ${ARCHIVE_INDEX} 解析失败: ${error.message}`)
  }

  return { versions: [] }
}

/**
 * 优先硬链接，失败时退回复制（跨盘/文件系统不支持硬链接）
 * @param {string} src
 * @param {string} dst
 */
function linkOrCopyFile (src, dst) {
  try {
    fs.linkSync(src, dst)
  } catch {
    fs.copyFileSync(src, dst)
  }
}

/**
 * 递归硬链接目录内容（归档可选，节省磁盘）；符号链接跳过
 * @param {string} srcDir
 * @param {string} dstDir
 */
function linkOrCopyTree (srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true })
  const stack = [[srcDir, dstDir]]

  while (stack.length > 0) {
    const [src, dst] = stack.pop()
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name)
      const dstPath = path.join(dst, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true })
        stack.push([srcPath, dstPath])
        continue
      }
      if (entry.isFile()) {
        linkOrCopyFile(srcPath, dstPath)
      }
    }
  }
}

/**
 * 归档 patch 目录与 zip，并清理超出保留数量的旧版本
 * @param {object} options
 * @param {string} options.deployDir
 * @param {string} options.archiveLabel 如 1.2.3 / r467 / abc123def456
 * @param {string} options.patchDir
 * @param {string} [options.zipPath]
 * @param {'svn'|'git'} options.vcs
 * @param {string} options.fromLabel
 * @param {string} options.toLabel
 * @param {boolean} [options.partial=false] 子集包（独立保留配额，避免挤掉正式版本）
 * @param {boolean} [options.link=false] 优先硬链接归档（同一磁盘时节省空间）
 * @param {number} [options.keepVersions=10]
 * @returns {Promise<{ archiveDir: string, zipArchivePath?: string }>}
 */
async function archivePatchPackage ({
  deployDir,
  archiveLabel,
  patchDir,
  zipPath,
  vcs,
  fromLabel,
  toLabel,
  partial = false,
  link = false,
  keepVersions = 10
}) {
  const archiveRoot = getArchiveRoot(deployDir)
  const safeLabel = sanitizeVersionLabel(archiveLabel)
  const archiveDir = path.join(archiveRoot, safeLabel)

  await fse.ensureDir(archiveRoot)
  await fse.emptyDir(archiveDir)
  if (link) {
    linkOrCopyTree(patchDir, archiveDir)
  } else {
    await fse.copy(patchDir, archiveDir)
  }

  /** @type {string|undefined} */
  let zipArchivePath
  if (zipPath && fs.existsSync(zipPath)) {
    zipArchivePath = path.join(archiveRoot, `${safeLabel}.zip`)
    if (link) {
      linkOrCopyFile(zipPath, zipArchivePath)
    } else {
      await fse.copy(zipPath, zipArchivePath)
    }
  }

  const index = readArchiveIndex(deployDir)
  const createdAt = new Date().toISOString()
  const record = {
    label: safeLabel,
    vcs,
    fromLabel,
    toLabel,
    partial,
    archiveDir: toDeployRelative(deployDir, archiveDir),
    zipPath: zipArchivePath ? toDeployRelative(deployDir, zipArchivePath) : undefined,
    createdAt
  }

  const dupIdx = index.versions.findIndex(v => v.label === safeLabel)
  if (dupIdx >= 0) {
    index.versions[dupIdx] = record
  } else {
    index.versions.push(record)
  }

  index.versions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  // 完整包与子集包分别保留最近 keepVersions 个，避免热修复子集挤掉正式版本归档
  const limit = Math.max(1, keepVersions)
  const fullVersions = index.versions.filter(v => !v.partial)
  const partialVersions = index.versions.filter(v => v.partial)
  const retained = new Set([
    ...fullVersions.slice(0, limit),
    ...partialVersions.slice(0, limit)
  ])
  const removed = index.versions.filter(v => !retained.has(v))
  index.versions = index.versions.filter(v => retained.has(v))

  for (const old of index.versions) {
    old.archiveDir = toDeployRelative(deployDir, old.archiveDir)
    if (old.zipPath) old.zipPath = toDeployRelative(deployDir, old.zipPath)
  }
  writeJsonAtomic(path.join(archiveRoot, ARCHIVE_INDEX), index)

  for (const old of removed) {
    const oldDir = old.archiveDir ? fromDeployRelative(deployDir, old.archiveDir) : null
    const oldZip = old.zipPath ? fromDeployRelative(deployDir, old.zipPath) : null
    if (oldDir && fs.existsSync(oldDir)) {
      await fse.remove(oldDir).catch(() => {})
    }
    if (oldZip && fs.existsSync(oldZip)) {
      await fse.remove(oldZip).catch(() => {})
    }
  }

  return { archiveDir, zipArchivePath }
}

module.exports = {
  ARCHIVE_DIR,
  buildDeployVersionLabel,
  getArchiveRoot,
  readArchiveIndex,
  archivePatchPackage
}
