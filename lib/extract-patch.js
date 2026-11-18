/**
 * 从完整版本包中提取指定文件，生成可单独部署的子集 patch
 */

const fs = require('fs')
const path = require('path')
const fse = require('fs-extra')
const { getBackend } = require('./backends')
const { createZipFromDirectory } = require('./zip')
const { resolveSelectedFiles, filterFilesBySelection, sanitizeVersionLabel } = require('./file-filter')
const { findVersionRecord, registerVersion } = require('./version-registry')
const { readModesFile, writeModesFile } = require('./modes')
const { readProtectListFromFile, writeProtectFile, PROTECT_FILE } = require('./protect')

const { readManifestFiles, readManifestDeleted } = require('./manifest')

/**
 * 读取源包 VERSION.txt 中的 version（用于 --from-patch 时保留版本上下文）
 * @param {string} patchDir
 * @returns {string|null}
 */
function readSourceVersion (patchDir) {
  const versionPath = path.join(patchDir, 'VERSION.txt')
  if (!fs.existsSync(versionPath)) {
    return null
  }

  for (const line of fs.readFileSync(versionPath, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^version=(.+)$/)
    if (match && match[1].trim()) {
      return match[1].trim()
    }
  }
  return null
}

/**
 * 解析源 patch 目录（--from-patch 或 --version 查注册表）
 * @param {object} options
 * @param {string} options.deployDir
 * @param {string} [options.fromPatch]
 * @param {string} [options.version]
 */
function resolveSourcePatchDir ({ deployDir, fromPatch, version }) {
  if (fromPatch) {
    const abs = path.resolve(fromPatch)
    if (!fs.existsSync(abs)) {
      throw new Error(`源 patch 目录不存在: ${abs}`)
    }
    return abs
  }

  if (!version) {
    throw new Error('请指定 --version=<版本号> 或 --from-patch=<patch目录>')
  }

  const record = findVersionRecord(deployDir, version)
  if (!record) {
    throw new Error(`未找到版本 ${version}，请先 patch-build --version=${version} 或检查 deploy/versions.json`)
  }

  if (!fs.existsSync(record.patchDir)) {
    throw new Error(`版本 ${version} 的 patch 目录已不存在: ${record.patchDir}`)
  }

  return record.patchDir
}

/**
 * @typedef {object} ExtractResult
 * @property {boolean} success
 * @property {string} message
 * @property {string} sourcePatchDir
 * @property {string} patchDir
 * @property {string} [zipPath]
 * @property {number} [zipSize]
 * @property {number} fileCount
 * @property {string[]} files
 * @property {string[]} missing
 */

/**
 * @param {object} config
 * @param {string} config.deployDir
 * @param {string} config.outDir
 * @param {string} config.applyScriptPath
 * @param {string} [config.fromPatch]
 * @param {string} [config.version]
 * @param {string[]} [config.onlyFiles]
 * @param {string|null} [config.fileList]
 * @param {string} [config.subsetLabel] 子集包标识（默认 partial-<时间戳>）
 * @param {boolean} [config.noZip]
 * @param {string} [config.zipPrefix]
 * @param {boolean} [config.registerSubset] 是否写入 versions.json
 * @returns {Promise<ExtractResult>}
 */
async function extractPatchSubset (config) {
  const {
    deployDir,
    outDir,
    applyScriptPath,
    fromPatch,
    version,
    onlyFiles = [],
    fileList = null,
    subsetLabel,
    noZip = false,
    zipPrefix = 'backend-update',
    registerSubset = false,
    protectFiles = []
  } = config

  const sourcePatchDir = resolveSourcePatchDir({ deployDir, fromPatch, version })
  const allFiles = readManifestFiles(sourcePatchDir)
  const selected = resolveSelectedFiles(onlyFiles, fileList)
  // 源包版本：优先 CLI --version，其次源包 VERSION.txt（--from-patch 场景）
  const sourceVersion = version || readSourceVersion(sourcePatchDir)
  const versionTxt = sourceVersion ? sanitizeVersionLabel(sourceVersion) : 'unknown'

  if (selected.length === 0) {
    throw new Error('请指定 --only=<文件> 或 --file-list=<列表文件> 以提取子集')
  }

  const { matched, missing } = filterFilesBySelection(allFiles, selected)
  if (missing.length > 0) {
    throw new Error(`以下文件不在源 patch 中:\n  - ${missing.join('\n  - ')}`)
  }

  if (matched.length === 0) {
    throw new Error('筛选后无文件可提取')
  }

  const label = subsetLabel || `partial-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`
  const safeLabel = sanitizeVersionLabel(label)
  const sourceVersionLabel = sourceVersion ? versionTxt : null
  const patchName = sourceVersionLabel
    ? `patch-v${sourceVersionLabel}-${safeLabel}`
    : `patch-${safeLabel}`
  const patchDir = path.join(outDir, patchName)
  const zipPath = path.join(
    outDir,
    `${zipPrefix}-${sourceVersionLabel ? `${sourceVersionLabel}-` : ''}${safeLabel}.zip`
  )

  await fse.emptyDir(patchDir)

  for (const rel of matched) {
    const src = path.join(sourcePatchDir, rel)
    const dst = path.join(patchDir, rel)
    if (!fs.existsSync(src)) {
      throw new Error(`源 patch 缺少文件: ${rel}`)
    }
    await fse.ensureDir(path.dirname(dst))
    await fse.copy(src, dst)
  }

  await fse.copy(applyScriptPath, path.join(patchDir, 'apply-update.php'))

  // 保护清单：源包 PROTECT.txt ∪ 当前项目配置（deploy/protect.txt + --protect）
  /** @type {Set<string>} */
  const protectSet = new Set()
  const sourceProtect = path.join(sourcePatchDir, PROTECT_FILE)
  if (fs.existsSync(sourceProtect)) {
    for (const rel of readProtectListFromFile(sourceProtect)) {
      protectSet.add(rel)
    }
  }
  for (const rel of protectFiles) {
    if (rel) protectSet.add(rel)
  }
  writeProtectFile(patchDir, [...protectSet].sort())

  // 删除清单按本次提取范围过滤：子集包不应提示删除与本次热修复无关的文件
  const sourceDeleted = readManifestDeleted(sourcePatchDir)
  const deletedMatched = sourceDeleted.length > 0
    ? filterFilesBySelection(sourceDeleted, selected).matched
    : []
  if (deletedMatched.length > 0) {
    fs.writeFileSync(
      path.join(patchDir, 'MANIFEST-deleted.txt'),
      deletedMatched.join('\n'),
      'utf8'
    )
  }

  // 可执行位：优先读源包 MODES.txt；Linux 上再结合实际文件权限
  const modes = readModesFile(sourcePatchDir)
  if (process.platform !== 'win32') {
    for (const rel of matched) {
      const abs = path.join(sourcePatchDir, rel)
      try {
        const stat = fs.statSync(abs)
        if ((stat.mode & 0o111) !== 0) {
          modes[rel] = 0o755
        }
      } catch {
        // 忽略无法读取的文件
      }
    }
  }
  const executableFiles = matched.filter(rel => modes[rel] === 0o755)
  writeModesFile(patchDir, executableFiles)

  const manifestLines = [
    '# PHP 后端增量部署清单（子集提取）',
    `extract_mode=partial`,
    sourceVersionLabel ? `source_version=${sourceVersionLabel}` : `source_patch=${sourcePatchDir}`,
    `extract_label=${label}`,
    `generated_at=${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    '',
    '# files',
    ...matched
  ]

  fs.writeFileSync(path.join(patchDir, 'MANIFEST.txt'), manifestLines.join('\n'), 'utf8')

  // 子集包使用独立的版本标识（<源版本>-<标签>），避免服务器把它当成完整版本，
  // 回滚时也不会误用部分部署的备份
  const subsetVersion = sourceVersionLabel
    ? `${sourceVersionLabel}-${safeLabel}`
    : safeLabel
  fs.writeFileSync(
    path.join(patchDir, 'VERSION.txt'),
    [
      `version=${subsetVersion}`,
      sourceVersionLabel ? `source_version=${sourceVersionLabel}` : '',
      `subset=${label}`,
      'partial=1',
      `file_count=${matched.length}`
    ].filter(Boolean).join('\n'),
    'utf8'
  )

  let zipSize = 0
  if (!noZip) {
    const zipResult = await createZipFromDirectory(patchDir, zipPath, { modes })
    zipSize = zipResult.size
  }

  if (registerSubset && sourceVersionLabel) {
    const baseRecord = findVersionRecord(deployDir, version || sourceVersionLabel)
    registerVersion(deployDir, {
      version: `${sourceVersionLabel}-${label}`,
      versionLabel: `${sourceVersionLabel}-${safeLabel}`,
      vcs: baseRecord?.vcs || 'svn',
      fromLabel: baseRecord?.fromLabel || '',
      toLabel: baseRecord?.toLabel || '',
      files: matched,
      deleted: deletedMatched,
      patchDir,
      zipPath: noZip ? undefined : zipPath,
      partial: true,
      sourceVersion: sourceVersionLabel,
      createdAt: new Date().toISOString()
    })
  }

  return {
    success: true,
    message: `已从 ${path.basename(sourcePatchDir)} 提取 ${matched.length} 个文件`,
    sourcePatchDir,
    patchDir,
    zipPath: noZip ? undefined : zipPath,
    zipSize,
    fileCount: matched.length,
    files: matched,
    missing
  }
}

module.exports = {
  resolveSourcePatchDir,
  extractPatchSubset
}
