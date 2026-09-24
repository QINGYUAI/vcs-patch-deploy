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
      return data
    }
  } catch (error) {
    console.warn(`[vcs-patch-deploy] ${ARCHIVE_INDEX} 解析失败: ${error.message}`)
  }

  return { versions: [] }
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
  keepVersions = 10
}) {
  const archiveRoot = getArchiveRoot(deployDir)
  const safeLabel = sanitizeVersionLabel(archiveLabel)
  const archiveDir = path.join(archiveRoot, safeLabel)

  await fse.ensureDir(archiveRoot)
  await fse.emptyDir(archiveDir)
  await fse.copy(patchDir, archiveDir)

  /** @type {string|undefined} */
  let zipArchivePath
  if (zipPath && fs.existsSync(zipPath)) {
    zipArchivePath = path.join(archiveRoot, `${safeLabel}.zip`)
    await fse.copy(zipPath, zipArchivePath)
  }

  const index = readArchiveIndex(deployDir)
  const createdAt = new Date().toISOString()
  const record = {
    label: safeLabel,
    vcs,
    fromLabel,
    toLabel,
    archiveDir,
    zipPath: zipArchivePath,
    createdAt
  }

  const dupIdx = index.versions.findIndex(v => v.label === safeLabel)
  if (dupIdx >= 0) {
    index.versions[dupIdx] = record
  } else {
    index.versions.push(record)
  }

  index.versions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  // 保留最近 keepVersions 个版本，删除更早的归档
  const removed = index.versions.splice(keepVersions)
  writeJsonAtomic(path.join(archiveRoot, ARCHIVE_INDEX), index)

  for (const old of removed) {
    if (old.archiveDir && fs.existsSync(old.archiveDir)) {
      await fse.remove(old.archiveDir).catch(() => {})
    }
    if (old.zipPath && fs.existsSync(old.zipPath)) {
      await fse.remove(old.zipPath).catch(() => {})
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
