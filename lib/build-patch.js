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
 */
function buildArtifactNames (vcs, toLabel, zipPrefix) {
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
    zipPrefix
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

  if (addedOrModified.length === 0 && deleted.length === 0) {
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

  const { patchName, zipName } = buildArtifactNames(vcs, toLabel, zipPrefix)
  const patchDir = path.join(outDir, patchName)
  const zipPath = path.join(outDir, zipName)

  await fse.emptyDir(patchDir)

  for (const rel of addedOrModified) {
    const src = path.join(sourceDir, rel)
    const dst = path.join(patchDir, rel)
    await fse.ensureDir(path.dirname(dst))
    await fse.copy(src, dst)
  }

  await fse.copy(applyScriptPath, path.join(patchDir, 'apply-update.php'))

  const manifestLines = [
    '# PHP 后端增量部署清单',
    `backend=${backend}`,
    `vcs=${vcs}`,
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
    ...addedOrModified,
    '',
    '# deleted (需人工确认是否删除线上文件)',
    ...(deleted.length > 0 ? deleted : ['# (none)'])
  ]

  if (warnings.length > 0) {
    manifestLines.push('', '# warnings', ...warnings)
  }

  fs.writeFileSync(path.join(patchDir, 'MANIFEST.txt'), manifestLines.join('\n'), 'utf8')

  if (deleted.length > 0) {
    fs.writeFileSync(
      path.join(patchDir, 'MANIFEST-deleted.txt'),
      deleted.join('\n'),
      'utf8'
    )
  }

  let zipSize = 0
  if (!noZip) {
    const zipResult = await createZipFromDirectory(patchDir, zipPath)
    zipSize = zipResult.size
  }

  if (markDeployed) {
    writeDeployMarker(deployDir, vcs, toLabel)
  }

  return {
    success: true,
    skipped: false,
    message: `打包完成：${vcs === 'svn' ? `r${fromLabel} -> r${toLabel}` : `${fromLabel.slice(0, 8)}..${toLabel.slice(0, 8)}`}`,
    patchDir,
    zipPath: noZip ? undefined : zipPath,
    zipSize,
    fileCount: addedOrModified.length,
    deletedCount: deleted.length,
    warnings,
    vcs,
    fromLabel,
    toLabel,
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
