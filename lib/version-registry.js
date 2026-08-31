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
      return /** @type {{ versions: VersionRecord[] }} */ (data)
    }
    console.warn(`[vcs-patch-deploy] ${REGISTRY_FILE} 格式异常（缺少 versions 数组），已忽略`)
  } catch (error) {
    console.warn(`[vcs-patch-deploy] ${REGISTRY_FILE} 解析失败: ${error.message}`)
  }

  return { versions: [] }
}

/**
 * @param {string} deployDir
 * @param {VersionRecord} record
 */
function registerVersion (deployDir, record) {
  const registry = readVersionsRegistry(deployDir)
  const registryPath = path.join(deployDir, REGISTRY_FILE)

  if (record.partial) {
    // 子集包：同 version+sourceVersion 去重后追加
    const dupIdx = registry.versions.findIndex(v =>
      v.partial &&
      v.version === record.version &&
      v.sourceVersion === record.sourceVersion
    )
    if (dupIdx >= 0) {
      registry.versions[dupIdx] = record
    } else {
      registry.versions.push(record)
    }
  } else {
    const idx = registry.versions.findIndex(v => v.version === record.version && !v.partial)
    if (idx >= 0) {
      registry.versions[idx] = record
    } else {
      registry.versions.push(record)
    }
  }

  registry.versions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  writeJsonAtomic(registryPath, registry)
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
  findVersionRecord,
  listVersionRecords,
  writeJsonAtomic
}
