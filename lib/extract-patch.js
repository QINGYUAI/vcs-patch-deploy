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

const { readManifestFiles } = require('./manifest')

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
    registerSubset = false
  } = config

  const sourcePatchDir = resolveSourcePatchDir({ deployDir, fromPatch, version })
  const allFiles = readManifestFiles(sourcePatchDir)
  const selected = resolveSelectedFiles(onlyFiles, fileList)

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
  const patchName = version
    ? `patch-v${sanitizeVersionLabel(version)}-${safeLabel}`
    : `patch-${safeLabel}`
  const patchDir = path.join(outDir, patchName)
  const zipPath = path.join(outDir, `${zipPrefix}-${safeLabel}.zip`)

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

  const versionTxt = version ? sanitizeVersionLabel(version) : 'unknown'
  const manifestLines = [
    '# PHP 后端增量部署清单（子集提取）',
    `extract_mode=partial`,
    version ? `source_version=${versionTxt}` : `source_patch=${sourcePatchDir}`,
    `extract_label=${label}`,
    `generated_at=${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    '',
    '# files',
    ...matched
  ]

  fs.writeFileSync(path.join(patchDir, 'MANIFEST.txt'), manifestLines.join('\n'), 'utf8')
  fs.writeFileSync(
    path.join(patchDir, 'VERSION.txt'),
    [
      version ? `version=${versionTxt}` : '',
      `subset=${label}`,
      `file_count=${matched.length}`
    ].filter(Boolean).join('\n'),
    'utf8'
  )

  let zipSize = 0
  if (!noZip) {
    const zipResult = await createZipFromDirectory(patchDir, zipPath)
    zipSize = zipResult.size
  }

  if (registerSubset && version) {
    registerVersion(deployDir, {
      version: `${version}-${label}`,
      versionLabel: `${sanitizeVersionLabel(version)}-${safeLabel}`,
      vcs: findVersionRecord(deployDir, version)?.vcs || 'svn',
      fromLabel: findVersionRecord(deployDir, version)?.fromLabel || '',
      toLabel: findVersionRecord(deployDir, version)?.toLabel || '',
      files: matched,
      deleted: [],
      patchDir,
      zipPath: noZip ? undefined : zipPath,
      partial: true,
      sourceVersion: version,
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
