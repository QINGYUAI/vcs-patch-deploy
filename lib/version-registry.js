/**
 * 部署版本注册表 — 记录每次打包的版本号、VCS 基准与文件清单
 */

const fs = require('fs')
const path = require('path')
const { sanitizeVersionLabel } = require('./file-filter')

const REGISTRY_FILE = 'versions.json'

/**
 * @typedef {object} VersionRecord
 * @property {string} version 原始版本号（如 1.2.3）
 * @property {string} versionLabel 文件名安全版本（如 1.2.3）
 * @property {'svn'|'git'} vcs
 * @property {string} fromLabel
 * @property {string} toLabel
 * @property {string[]} files 本次包内文件（相对路径）
 * @property {string[]} deleted
 * @property {string} patchDir
 * @property {string} [zipPath]
 * @property {boolean} [partial] 是否为子集提取包
 * @property {boolean} [worktree] 是否为工作副本包
 * @property {string} [sourceVersion] 子集提取时的源版本
 * @property {string} createdAt ISO 时间
 */

/**
 * 原子写入 JSON，避免中途失败导致 versions.json 损坏
 * @param {string} filePath
 * @param {unknown} data
 */
function writeJsonAtomic (filePath, data) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * 将绝对路径登记为相对 deployDir 的路径，保证项目迁移后仍可用
 * @param {string} deployDir
 * @param {string} absPath
 * @returns {string}
 */
function toDeployRelative (deployDir, absPath) {
  if (!absPath) return absPath
  if (!path.isAbsolute(absPath)) return absPath.replace(/\\/g, '/')

  const rel = path.relative(deployDir, absPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return absPath
  }
  return rel.split(path.sep).join('/')
}

/**
 * 兼容旧记录：相对路径按 deployDir 解析
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
 * @returns {{ versions: VersionRecord[] }}
 */
function readVersionsRegistry (deployDir) {
  const registryPath = path.join(deployDir, REGISTRY_FILE)
  if (!fs.existsSync(registryPath)) {
    return { versions: [] }
  }

  try {
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    if (Array.isArray(data.versions)) {
      for (const record of data.versions) {
        if (!record || typeof record !== 'object') continue
        if (record.patchDir) record.patchDir = fromDeployRelative(deployDir, record.patchDir)
        if (record.zipPath) record.zipPath = fromDeployRelative(deployDir, record.zipPath)
      }
      return /** @type {{ versions: VersionRecord[] }} */ (data)
    }
    console.warn(`[vcs-patch-deploy] ${REGISTRY_FILE} 格式异常（缺少 versions 数组），已忽略`)
  } catch (error) {
    console.warn(`[vcs-patch-deploy] ${REGISTRY_FILE} 解析失败: ${error.message}`)
  }

  return { versions: [] }
}

/**
 * 写入前统一转成 deployDir 相对路径（读取时会解析回绝对路径）
 * @param {string} deployDir
 * @param {VersionRecord[]} versions
 * @returns {VersionRecord[]}
 */
function normalizeRegistryForWrite (deployDir, versions) {
  for (const record of versions) {
    if (!record || typeof record !== 'object') continue
    if (record.patchDir) record.patchDir = toDeployRelative(deployDir, record.patchDir)
    if (record.zipPath) record.zipPath = toDeployRelative(deployDir, record.zipPath)
  }
  return versions
}

/**
 * @param {string} deployDir
 * @param {VersionRecord} record
 */
function registerVersion (deployDir, record) {
  const registry = readVersionsRegistry(deployDir)
  const registryPath = path.join(deployDir, REGISTRY_FILE)
  const normalized = { ...record }
  if (normalized.patchDir) {
    normalized.patchDir = toDeployRelative(deployDir, normalized.patchDir)
  }
  if (normalized.zipPath) {
    normalized.zipPath = toDeployRelative(deployDir, normalized.zipPath)
  }

  if (normalized.partial) {
    // 子集包：同 version+sourceVersion 去重后追加
    const dupIdx = registry.versions.findIndex(v =>
      v.partial &&
      v.version === normalized.version &&
      v.sourceVersion === normalized.sourceVersion
    )
    if (dupIdx >= 0) {
      registry.versions[dupIdx] = normalized
    } else {
      registry.versions.push(normalized)
    }
  } else {
    const idx = registry.versions.findIndex(v => v.version === normalized.version && !v.partial)
    if (idx >= 0) {
      registry.versions[idx] = normalized
    } else {
      registry.versions.push(normalized)
    }
  }

  registry.versions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  normalizeRegistryForWrite(deployDir, registry.versions)
  writeJsonAtomic(registryPath, registry)
}

/**
 * 清理旧的工作副本包登记（可按需重建，避免 versions.json 无限增长）
 * @param {string} deployDir
 * @param {number} [keep=5]
 * @returns {number} 删除的记录数
 */
function pruneWorktreeRecords (deployDir, keep = 5) {
  const registry = readVersionsRegistry(deployDir)
  const worktrees = registry.versions.filter(v => v.worktree)
  if (worktrees.length <= keep) {
    return 0
  }

  const retained = new Set(worktrees.slice(0, keep))
  const removed = worktrees.slice(keep)
  registry.versions = registry.versions.filter(v => !v.worktree || retained.has(v))
  normalizeRegistryForWrite(deployDir, registry.versions)
  writeJsonAtomic(path.join(deployDir, REGISTRY_FILE), registry)
  return removed.length
}

/**
 * @param {string} deployDir
 * @param {string} version
 * @returns {VersionRecord|null}
 */
function findVersionRecord (deployDir, version) {
  const label = sanitizeVersionLabel(version)
  const registry = readVersionsRegistry(deployDir)

  // 优先返回非 partial 的完整版本包
  const full = registry.versions.find(v =>
    !v.partial && (
      v.version === version ||
      v.versionLabel === label ||
      sanitizeVersionLabel(v.version) === label
    )
  )
  if (full) return full

  return registry.versions.find(v =>
    v.version === version ||
    v.versionLabel === label ||
    sanitizeVersionLabel(v.version) === label
  ) || null
}

/**
 * @param {string} deployDir
 * @returns {VersionRecord[]}
 */
function listVersionRecords (deployDir) {
  return readVersionsRegistry(deployDir).versions
}

module.exports = {
  REGISTRY_FILE,
  readVersionsRegistry,
  registerVersion,
  pruneWorktreeRecords,
  findVersionRecord,
  listVersionRecords,
  writeJsonAtomic
}
