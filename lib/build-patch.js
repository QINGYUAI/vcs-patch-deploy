/**
 * 增量 patch 包构建核心（SVN / Git 统一入口）
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const fse = require('fs-extra')
const { shouldExcludePath } = require('./exclude')
const { getBackend } = require('./backends')
const { readDeployMarker, writeDeployMarker } = require('./marker')
const { registerVersion } = require('./version-registry')
const { sanitizeVersionLabel } = require('./file-filter')
const { resolveSelectedFiles, filterFilesBySelection } = require('./file-filter')
const { getSvnInfo, getSvnDiffSummary } = require('./svn')
const { getGitInfo, getGitDiffSummary, resolveGitRef } = require('./git')
const { createZipFromDirectory } = require('./zip')

/**
 * @typedef {object} BuildResult
 * @property {boolean} success
 * @property {boolean} skipped
 * @property {string} message
 * @property {string} [patchDir]
 * @property {string} [zipPath]
 * @property {number} [fileCount]
 * @property {number} [deletedCount]
 * @property {string[]} [warnings]
 * @property {'svn'|'git'} vcs
 * @property {string} fromLabel
 * @property {string} toLabel
 */

/**
 * 将 diff 条目分类为增改/删除，并应用排除规则
 * @param {Array<{ action: string, relativePath: string, parseError?: string }>} entries
 * @param {string} sourceDir
 */
function classifyDiffEntries (entries, sourceDir, backendId = 'php') {
  /** @type {string[]} */
  const addedOrModified = []
  /** @type {string[]} */
  const deleted = []
  /** @type {string[]} */
  const warnings = []

  for (const entry of entries) {
    if (entry.parseError) {
      warnings.push(entry.parseError)
      continue
    }

    const rel = entry.relativePath.replace(/\\/g, '/')
    const { excluded, isComposer } = shouldExcludePath(rel, [], backendId)

    if (excluded) {
      if (isComposer) {
        warnings.push(`composer 依赖变更：${rel} — 上线后可能需在服务器执行 composer install --no-dev`)
      }
      continue
    }

    if (entry.action === 'D') {
      deleted.push(rel)
      continue
    }

    const src = path.join(sourceDir, rel)
    if (!fs.existsSync(src)) {
      warnings.push(`跳过（工作副本不存在）：${rel}`)
      continue
    }

    addedOrModified.push(rel)
  }

  return {
    addedOrModified: [...new Set(addedOrModified)].sort(),
    deleted: [...new Set(deleted)].sort(),
    warnings
  }
}

/**
 * 生成 patch 目录名与 zip 名后缀
 * @param {'svn'|'git'} vcs
 * @param {string} toLabel
 * @param {string} [version]
 */
function buildArtifactNames (vcs, toLabel, zipPrefix, version = null) {
  const versionLabel = version ? sanitizeVersionLabel(version) : null

  if (versionLabel) {
    return {
      patchName: `patch-v${versionLabel}`,
      zipName: `${zipPrefix}-v${versionLabel}.zip`
    }
  }

  if (vcs === 'svn') {
    return {
      patchName: `patch-r${toLabel}`,
      zipName: `${zipPrefix}-r${toLabel}.zip`
    }
  }

  const short = toLabel.slice(0, 12)
  return {
    patchName: `patch-${short}`,
    zipName: `${zipPrefix}-${short}.zip`
  }
}

/**
 * @param {import('./config').BuildConfig} config
 * @returns {Promise<BuildResult>}
 */
async function buildPatch (config) {
  const {
    backend,
    vcs,
    sourceDir,
    deployDir,
    outDir,
    applyScriptPath,
    noZip,
    markDeployed,
    skipValidation,
    zipPrefix,
    version,
    onlyFiles,
    fileList
  } = config

  const backendModule = getBackend(backend)

  if (!skipValidation && backend === 'php') {
    const check = backendModule.validatePhpBackend(sourceDir)
    if (!check.valid) {
      throw new Error(check.hints.join('\n'))
    }
  }

  if (!fs.existsSync(applyScriptPath)) {
    throw new Error(`缺少 apply-update.php 模板：${applyScriptPath}`)
  }

  /** @type {string} */
  let fromLabel
  /** @type {string} */
  let toLabel
  /** @type {Array<{ action: string, relativePath: string, parseError?: string }>} */
  let diffEntries

  const marker = readDeployMarker(deployDir)

  if (vcs === 'svn') {
    const svnInfo = getSvnInfo(sourceDir)
    const toRev = config.toRef != null ? Number(config.toRef) : svnInfo.revision
    let fromRev = config.fromRef != null ? Number(config.fromRef) : null

    if (fromRev == null) {
      if (marker && marker.vcs === 'svn') {
        fromRev = parseInt(marker.value, 10)
      } else {
        throw new Error(
          `未找到 deploy/.last-deploy-marker 或 .last-deploy-rev，请指定 --from=<revision>`
        )
      }
    }

    if (!Number.isFinite(fromRev) || !Number.isFinite(toRev)) {
      throw new Error(`无效的 SVN revision：from=${fromRev} to=${toRev}，请检查 marker 或 --from/--to`)
    }

    if (fromRev >= toRev) {
      if (markDeployed && fromRev === toRev) {
        writeDeployMarker(deployDir, 'svn', String(toRev))
        return {
          success: true,
          skipped: true,
          message: `已更新 deploy 基准 = r${toRev}（无新文件需打包）`,
          vcs,
          fromLabel: String(fromRev),
          toLabel: String(toRev)
        }
      }
      return {
        success: true,
        skipped: true,
        message: `FromRev (${fromRev}) >= ToRev (${toRev})，无增量可打包`,
        vcs,
        fromLabel: String(fromRev),
        toLabel: String(toRev)
      }
    }

    fromLabel = String(fromRev)
    toLabel = String(toRev)
    diffEntries = getSvnDiffSummary({ sourceDir, fromRev, toRev })
  } else {
    const gitInfo = getGitInfo(sourceDir)
    const toCommit = config.toRef != null
      ? resolveGitRef(sourceDir, String(config.toRef))
      : gitInfo.commit

    let fromCommit = config.fromRef != null
      ? resolveGitRef(sourceDir, String(config.fromRef))
      : null

    if (!fromCommit) {
      if (marker && marker.vcs === 'git') {
        fromCommit = resolveGitRef(sourceDir, marker.value)
      } else {
        throw new Error(
          `未找到 deploy/.last-deploy-marker（git:...），请指定 --from=<commit|tag>`
        )
      }
    }

    if (fromCommit === toCommit) {
      if (markDeployed) {
        writeDeployMarker(deployDir, 'git', toCommit)
        return {
          success: true,
          skipped: true,
          message: `已更新 deploy 基准 = ${toCommit.slice(0, 12)}（无新文件需打包）`,
          vcs,
          fromLabel: fromCommit,
          toLabel: toCommit
        }
      }
      return {
        success: true,
        skipped: true,
        message: 'from 与 to 为同一 commit，无增量可打包',
        vcs,
        fromLabel: fromCommit,
        toLabel: toCommit
      }
    }

    fromLabel = fromCommit
    toLabel = toCommit
    diffEntries = getGitDiffSummary({ sourceDir, fromRef: fromCommit, toRef: toCommit })
  }

  const { addedOrModified, deleted, warnings } = classifyDiffEntries(diffEntries, sourceDir, backend)

  // 按 --only / --file-list 筛选本次打包文件（用于单独提取部署）
  const selectedFiles = resolveSelectedFiles(onlyFiles || [], fileList || null)
  let deployFiles = addedOrModified
  let deployDeleted = deleted
  if (selectedFiles.length > 0) {
    const filePick = filterFilesBySelection(addedOrModified, selectedFiles)
    if (filePick.missing.length > 0) {
      warnings.push(`--only 中以下文件不在本次增量内: ${filePick.missing.join(', ')}`)
    }
    deployFiles = filePick.matched

    const deletedPick = filterFilesBySelection(deleted, selectedFiles)
    deployDeleted = deletedPick.matched
    if (deletedPick.missing.length > 0) {
      warnings.push(`--only 中以下删除项不在本次增量内: ${deletedPick.missing.join(', ')}`)
    }
  }

  if (deployFiles.length === 0 && deployDeleted.length === 0) {
    return {
      success: true,
      skipped: true,
      message: '无需要部署的文件（可能全部被排除规则过滤）',
      warnings,
      vcs,
      fromLabel,
      toLabel
    }
  }

  const { patchName, zipName } = buildArtifactNames(vcs, toLabel, zipPrefix, version)
  const patchDir = path.join(outDir, patchName)
  const zipPath = path.join(outDir, zipName)
  const stagingDir = `${patchDir}.staging-${Date.now()}`
  const versionLabel = version ? sanitizeVersionLabel(version) : null

  await fse.emptyDir(stagingDir)

  let zipSize = 0
  try {
    for (const rel of deployFiles) {
      const src = path.join(sourceDir, rel)
      const dst = path.join(stagingDir, rel)
      await fse.ensureDir(path.dirname(dst))
      await fse.copy(src, dst)
    }

    await fse.copy(applyScriptPath, path.join(stagingDir, 'apply-update.php'))

    const manifestLines = [
      '# PHP 后端增量部署清单',
      `backend=${backend}`,
      `vcs=${vcs}`,
      ...(versionLabel ? [`version=${versionLabel}`] : []),
      vcs === 'svn'
        ? `from_revision=${fromLabel}`
        : `from_commit=${fromLabel}`,
      vcs === 'svn'
        ? `to_revision=${toLabel}`
        : `to_commit=${toLabel}`,
      `generated_at=${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
      `generated_by=${os.userInfo().username}`,
      '',
      '# files',
      ...deployFiles,
      '',
      '# deleted (需人工确认是否删除线上文件)',
      ...(deployDeleted.length > 0 ? deployDeleted : ['# (none)'])
    ]

    if (warnings.length > 0) {
      manifestLines.push('', '# warnings', ...warnings)
    }

    fs.writeFileSync(path.join(stagingDir, 'MANIFEST.txt'), manifestLines.join('\n'), 'utf8')

    if (versionLabel) {
      fs.writeFileSync(
        path.join(stagingDir, 'VERSION.txt'),
        [
          `version=${versionLabel}`,
          `vcs=${vcs}`,
          vcs === 'svn' ? `to_revision=${toLabel}` : `to_commit=${toLabel}`,
          `file_count=${deployFiles.length}`
        ].join('\n'),
        'utf8'
      )
    }

    if (deployDeleted.length > 0) {
      fs.writeFileSync(
        path.join(stagingDir, 'MANIFEST-deleted.txt'),
        deployDeleted.join('\n'),
        'utf8'
      )
    }

    // 构建成功后再替换目标 patch 目录，避免中途失败清空旧包
    if (fs.existsSync(patchDir)) {
      await fse.remove(patchDir)
    }
    await fse.move(stagingDir, patchDir)

    if (!noZip) {
      const zipResult = await createZipFromDirectory(patchDir, zipPath)
      zipSize = zipResult.size
    }
  } catch (error) {
    await fse.remove(stagingDir).catch(() => {})
    throw error
  }

  if (markDeployed) {
    writeDeployMarker(deployDir, vcs, toLabel)
  }

  // 注册版本号到 deploy/versions.json，便于后续 patch-extract 按版本提取
  if (versionLabel) {
    registerVersion(deployDir, {
      version: String(version),
      versionLabel,
      vcs,
      fromLabel,
      toLabel,
      files: deployFiles,
      deleted: deployDeleted,
      patchDir,
      zipPath: noZip ? undefined : zipPath,
      partial: selectedFiles.length > 0,
      createdAt: new Date().toISOString()
    })
  }

  return {
    success: true,
    skipped: false,
    message: `打包完成：${versionLabel ? `v${versionLabel}` : (vcs === 'svn' ? `r${fromLabel} -> r${toLabel}` : `${fromLabel.slice(0, 8)}..${toLabel.slice(0, 8)}`)}`,
    patchDir,
    zipPath: noZip ? undefined : zipPath,
    zipSize,
    fileCount: deployFiles.length,
    deletedCount: deployDeleted.length,
    warnings,
    vcs,
    fromLabel,
    toLabel,
    version: versionLabel || undefined,
    markDeployedHint: markDeployed
      ? undefined
      : `上线成功后执行：patch-build --vcs=${vcs} --mark-deployed --from=${toLabel} --to=${toLabel}`
  }
}

module.exports = {
  buildPatch,
  classifyDiffEntries,
  buildArtifactNames
}
