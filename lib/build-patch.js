/**
 * 增量 patch 包构建核心（SVN / Git 统一入口）
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const fse = require('fs-extra')
const { shouldExcludePath } = require('./exclude')
const { getBackend } = require('./backends')
const { readDeployMarker, writeDeployMarker, markerFileName } = require('./marker')
const { registerVersion, pruneWorktreeRecords } = require('./version-registry')
const { sanitizeVersionLabel } = require('./file-filter')
const { resolveSelectedFiles, filterFilesBySelection } = require('./file-filter')
const { getSvnInfo, getSvnDiffSummary, getSvnContentMismatch, getSvnWorktreeDiffEntries, getSvnExecutableFiles } = require('./svn')
const { getGitInfo, getGitDiffSummary, resolveGitRef, getGitContentMismatch, getGitPrefix, getGitExecutableFiles } = require('./git')
const { createZipFromDirectory } = require('./zip')
const { buildDeployVersionLabel, archivePatchPackage } = require('./version-archive')
const { pruneOutDirectory } = require('./out-prune')
const { writeProtectFile } = require('./protect')
const { writeModesFile } = require('./modes')

/**
 * @typedef {object} BuildResult
 * @property {boolean} success
 * @property {boolean} skipped
 * @property {string} message
 * @property {string} [patchDir]
 * @property {string} [zipPath]
 * @property {string} [archiveDir]
 * @property {string} [deployVersionLabel]
 * @property {number} [fileCount]
 * @property {number} [deletedCount]
 * @property {string[]} [warnings]
 * @property {string[]} [prunedOut] 被清理的 deploy/out 旧产物
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

    let stat
    try {
      stat = fs.lstatSync(src)
    } catch {
      warnings.push(`跳过（无法读取）：${rel}`)
      continue
    }

    // 服务器端拒绝符号链接；打包阶段提前跳过并提示
    if (stat.isSymbolicLink()) {
      warnings.push(`跳过符号链接：${rel}`)
      continue
    }

    // SVN --summarize 会列出目录本身（属性变更、新增目录）；目录内容由子文件条目体现，
    // 直接复制目录会递归带入未版本控制的文件，因此跳过目录条目。
    if (!stat.isFile()) {
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
 * 计算包内/服务器使用的版本标签
 *
 * 规则：
 *   - 完整包：--version，或 r467 / commit 短哈希
 *   - 子集包：追加 -partial-<hash>，并写 partial=1（服务器据此识别部分部署）
 *   - 工作副本包：wc-<时间戳>，带 --version 时保留版本前缀
 *
 * @param {object} options
 * @param {'svn'|'git'} options.vcs
 * @param {string} options.toLabel
 * @param {string|null} [options.version]
 * @param {string|null} [options.partialSignature]
 * @param {string|null} [options.worktreeLabel]
 */
function buildVersionLabels ({
  vcs,
  toLabel,
  version = null,
  partialSignature = null,
  worktreeLabel = null
}) {
  const versionLabel = version ? sanitizeVersionLabel(version) : null
  const partialSuffix = partialSignature ? `-partial-${partialSignature}` : ''
  // 工作副本包的目标不是某个 revision，base 仅来自 --version（可为空）
  const baseVersionLabel = worktreeLabel
    ? versionLabel
    : buildDeployVersionLabel(vcs, toLabel, versionLabel)
  const deployVersionLabel = worktreeLabel
    ? `${versionLabel ? `${versionLabel}-` : ''}${worktreeLabel}${partialSuffix}`
    : `${baseVersionLabel}${partialSuffix}`
  const artifactVersionLabel = (versionLabel || partialSuffix) ? deployVersionLabel : null

  return {
    versionLabel,
    partialSuffix,
    baseVersionLabel,
    deployVersionLabel,
    artifactVersionLabel
  }
}

/**
 * 生成 patch 目录名与 zip 名后缀
 * @param {'svn'|'git'} vcs
 * @param {string} toLabel
 * @param {string} zipPrefix
 * @param {string|null} [version]
 * @param {string|null} [partialSuffix] 子集包唯一后缀（--only / --file-list）
 * @param {string|null} [worktreeLabel] 工作副本包标识（如 wc-20261118093000）
 */
function buildArtifactNames (vcs, toLabel, zipPrefix, version = null, partialSuffix = null, worktreeLabel = null) {
  const versionLabel = version ? sanitizeVersionLabel(version) : null

  /** @type {string} */
  let base
  if (versionLabel) {
    base = worktreeLabel ? `v${versionLabel}-${worktreeLabel}` : `v${versionLabel}`
  } else if (worktreeLabel) {
    base = worktreeLabel
  } else if (vcs === 'svn') {
    base = `r${toLabel}`
  } else {
    base = toLabel.slice(0, 12)
  }

  const suffix = partialSuffix ? `-partial-${partialSuffix}` : ''

  return {
    patchName: `patch-${base}${suffix}`,
    zipName: `${zipPrefix}-${base}${suffix}.zip`
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
    fileList,
    noArchive,
    keepVersions,
    pruneOut,
    keepOut,
    archiveLink,
    fromWorktree,
    profile,
    protectFiles,
    diffWorktree
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
  /** git：sourceDir 相对仓库根的路径（sourceDir 不是仓库根时用于路径映射） */
  let gitPrefix = ''
  /** 工作副本包标识（仅 diffWorktree） */
  const worktreeLabel = diffWorktree
    ? `wc-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
    : null

  const marker = readDeployMarker(deployDir, profile || null)
  const markerHint = markerFileName(profile || null)

  if (vcs === 'svn' && diffWorktree) {
    if (markDeployed) {
      throw new Error(
        '工作副本模式（--worktree-diff）不能自动更新基准：线上内容并非某个 revision。\n' +
        '请先提交代码，再用 --mark-deployed 指向对应 revision。'
      )
    }
    if (config.toRef != null) {
      throw new Error(
        '--worktree-diff 与 --to 不能同时使用：工作副本模式的目标固定为 working-copy。\n' +
        '若只想打包某个 revision 区间，请去掉 --worktree-diff。'
      )
    }

    let fromRev = config.fromRef != null ? Number(config.fromRef) : null
    if (fromRev == null) {
      if (marker && marker.vcs === 'svn') {
        fromRev = parseInt(marker.value, 10)
      } else {
        throw new Error(`未找到 deploy/${markerHint}，请指定 --from=<revision>`)
      }
    }

    if (!Number.isFinite(fromRev)) {
      throw new Error(`无效的 SVN revision：from=${fromRev}，请检查 marker 或 --from`)
    }

    fromLabel = String(fromRev)
    toLabel = 'working-copy'
    diffEntries = getSvnWorktreeDiffEntries({
      sourceDir,
      fromRev,
      shouldSkip: rel => shouldExcludePath(rel, [], backend).excluded
    })
  } else if (vcs === 'svn') {
    const svnInfo = getSvnInfo(sourceDir)
    const toRev = config.toRef != null ? Number(config.toRef) : svnInfo.revision
    let fromRev = config.fromRef != null ? Number(config.fromRef) : null

    if (fromRev == null) {
      if (marker && marker.vcs === 'svn') {
        fromRev = parseInt(marker.value, 10)
      } else {
        throw new Error(
          `未找到 deploy/${markerHint} 或 .last-deploy-rev，请指定 --from=<revision>`
        )
      }
    }

    if (!Number.isFinite(fromRev) || !Number.isFinite(toRev)) {
      throw new Error(`无效的 SVN revision：from=${fromRev} to=${toRev}，请检查 marker 或 --from/--to`)
    }

    if (fromRev >= toRev) {
      if (markDeployed && fromRev === toRev) {
        writeDeployMarker(deployDir, 'svn', String(toRev), profile || null)
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
    if (diffWorktree) {
      throw new Error(
        '--worktree-diff 目前仅支持 SVN 工作副本；Git 请先提交改动，再按 commit 打包（或用 --from-worktree 放宽一致性校验）'
      )
    }

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
          `未找到 deploy/${markerHint}（git:...），请指定 --from=<commit|tag>`
        )
      }
    }

    if (fromCommit === toCommit) {
      if (markDeployed) {
        writeDeployMarker(deployDir, 'git', toCommit, profile || null)
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
    gitPrefix = getGitPrefix(gitInfo.root, sourceDir)
    diffEntries = getGitDiffSummary({
      sourceDir,
      fromRef: fromCommit,
      toRef: toCommit,
      prefix: gitPrefix
    })
  }

  const { addedOrModified, deleted, warnings } = classifyDiffEntries(diffEntries, sourceDir, backend)

  if (worktreeLabel) {
    warnings.push(
      '工作副本模式：包内容来自当前工作副本（含未提交改动），不会更新基准；' +
      '上线成功后请先提交代码，再用 --mark-deployed 指向对应 revision'
    )
    if (!noArchive) {
      warnings.push('工作副本包不写入 deploy/archive（避免挤掉版本归档）；产物保留在 deploy/out')
    }
  }

  // 按 --only / --file-list 筛选本次打包文件（用于单独提取部署）
  const selectedFiles = resolveSelectedFiles(onlyFiles || [], fileList || null)
  let deployFiles = addedOrModified
  let deployDeleted = deleted
  if (selectedFiles.length > 0) {
    const filePick = filterFilesBySelection(addedOrModified, selectedFiles)
    const deletedPick = filterFilesBySelection(deleted, selectedFiles)
    deployFiles = filePick.matched
    deployDeleted = deletedPick.matched

    // 只有同时不在“增改”与“删除”列表中的选择才算未命中（删除项不应被误报）
    const combinedPick = filterFilesBySelection(
      [...addedOrModified, ...deleted],
      selectedFiles
    )
    if (combinedPick.missing.length > 0) {
      warnings.push(`--only 中以下文件不在本次增量内: ${combinedPick.missing.join(', ')}`)
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

  // 打包是从工作区复制文件的：先确认工作区内容与目标版本一致，
  // 否则 zip 内容会与 MANIFEST 声明的 from..to 范围不符。
  // 工作副本模式（--worktree-diff）本身就以工作区为准，无需校验。
  if (!fromWorktree && !diffWorktree && deployFiles.length > 0) {
    const mismatched = vcs === 'git'
      ? getGitContentMismatch({
        sourceDir,
        toRef: toLabel,
        files: deployFiles,
        prefix: gitPrefix
      })
      : getSvnContentMismatch({
        sourceDir,
        toRev: Number(toLabel),
        files: deployFiles
      })

    if (mismatched.length > 0) {
      const sample = mismatched.slice(0, 10).map(f => `  - ${f}`).join('\n')
      const more = mismatched.length > 10 ? `\n  … 另有 ${mismatched.length - 10} 个` : ''
      const syncHint = vcs === 'git'
        ? `git checkout ${toLabel}（或先把工作区同步到该 commit）`
        : `svn update -r ${toLabel}`
      throw new Error(
        `工作区内容与目标版本不一致，打包会与 MANIFEST 声明不符：\n${sample}${more}\n\n` +
        `请先执行 ${syncHint}；若确实要用当前工作区内容打包，请加 --from-worktree 明确允许。`
      )
    }
  }

  const partialSignature = selectedFiles.length > 0
    ? crypto
      .createHash('sha256')
      .update([...selectedFiles].sort().join('\n'))
      .digest('hex')
      .slice(0, 8)
    : null

  // 可执行位依赖 VCS 元数据（Windows 上 fs.stat 不体现 exec 位）
  /** @type {string[]} */
  let executableFiles = []
  if (deployFiles.length > 0) {
    try {
      executableFiles = vcs === 'git'
        ? getGitExecutableFiles({ sourceDir, files: deployFiles, prefix: gitPrefix })
        : getSvnExecutableFiles({ sourceDir, files: deployFiles })
    } catch (error) {
      warnings.push(`无法读取可执行权限（这些文件将按 0644 打包）: ${error.message}`)
    }
  }
  // 非 Windows 上补一层文件系统权限判断：--worktree-diff 的未纳入版本控制的
  // 脚本没有 svn:executable 属性，只能依靠实际执行位
  if (process.platform !== 'win32') {
    const execSet = new Set(executableFiles)
    for (const rel of deployFiles) {
      try {
        if ((fs.statSync(path.join(sourceDir, rel)).mode & 0o111) !== 0) {
          execSet.add(rel)
        }
      } catch {
        // 无法读取的文件保持默认权限
      }
    }
    executableFiles = [...execSet].sort()
  }

  /** @type {Record<string, number>} */
  const fileModes = {}
  for (const rel of executableFiles) {
    fileModes[rel] = 0o755
  }

  const { patchName, zipName } = buildArtifactNames(
    vcs,
    toLabel,
    zipPrefix,
    version,
    partialSignature,
    worktreeLabel
  )
  const patchDir = path.join(outDir, patchName)
  const zipPath = path.join(outDir, zipName)
  const stagingDir = `${patchDir}.staging-${Date.now()}`

  // 同版本重复构建：目标版本不同则提示（产物、archive、versions.json 会被覆盖）
  if (fs.existsSync(patchDir)) {
    /** @type {string|null} */
    let previousTo = null
    try {
      const prev = fs.readFileSync(path.join(patchDir, 'VERSION.txt'), 'utf8')
      const match = prev.match(/^to_(?:revision|commit)=(.+)$/m)
      previousTo = match ? match[1].trim() : null
    } catch {
      // 无 VERSION.txt 的旧产物
    }
    if (previousTo === null || previousTo !== toLabel) {
      warnings.push(
        `将覆盖已存在的同版本产物 ${patchName}` +
        `（原目标 ${previousTo ?? '未知'}，本次 ${toLabel}）；如需保留请先改 --version 或备份 deploy/out`
      )
    }
  }
  const {
    versionLabel,
    partialSuffix,
    baseVersionLabel,
    deployVersionLabel,
    artifactVersionLabel
  } = buildVersionLabels({
    vcs,
    toLabel,
    version,
    partialSignature,
    worktreeLabel
  })

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
      `version=${deployVersionLabel}`,
      vcs === 'svn'
        ? `from_revision=${fromLabel}`
        : `from_commit=${fromLabel}`,
      vcs === 'svn'
        ? `to_revision=${toLabel}`
        : `to_commit=${toLabel}`,
      `generated_at=${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
      `generated_by=${os.userInfo().username}`,
      `content_source=${fromWorktree || diffWorktree ? 'working-copy' : 'target-revision'}`,
      ...(worktreeLabel ? ['worktree=1'] : []),
      ...(profile ? [`profile=${profile}`] : []),
      ...(protectFiles && protectFiles.length > 0 ? [`protect_count=${protectFiles.length}`] : []),
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

    // 始终写入 VERSION.txt，供服务器按版本号备份（含 r467 等 revision 包）
    fs.writeFileSync(
      path.join(stagingDir, 'VERSION.txt'),
      [
        `version=${deployVersionLabel}`,
        `vcs=${vcs}`,
        vcs === 'svn' ? `to_revision=${toLabel}` : `to_commit=${toLabel}`,
        ...(worktreeLabel ? ['content_source=working-copy'] : []),
        ...(partialSignature
          ? ['partial=1', ...(baseVersionLabel ? [`source_version=${baseVersionLabel}`] : [])]
          : []),
        `file_count=${deployFiles.length}`
      ].join('\n'),
      'utf8'
    )

    // 受保护文件清单：服务器端对“线上已存在”的文件跳过覆盖
    writeProtectFile(stagingDir, protectFiles || [])

    if (deployDeleted.length > 0) {
      fs.writeFileSync(
        path.join(stagingDir, 'MANIFEST-deleted.txt'),
        deployDeleted.join('\n'),
        'utf8'
      )
    }

    // 可执行文件清单：服务器端据此 chmod（zip 在 Windows 上无法携带 exec 位）
    writeModesFile(stagingDir, executableFiles)

    // 构建成功后再替换目标 patch 目录，避免中途失败清空旧包
    if (fs.existsSync(patchDir)) {
      await fse.remove(patchDir)
    }
    await fse.move(stagingDir, patchDir)

    if (!noZip) {
      const zipResult = await createZipFromDirectory(patchDir, zipPath, { modes: fileModes })
      zipSize = zipResult.size
    }
  } catch (error) {
    await fse.remove(stagingDir).catch(() => { })
    throw error
  }

  if (markDeployed) {
    writeDeployMarker(deployDir, vcs, toLabel, profile || null)
  }

  // 子集包使用独立标识，避免覆盖同版本的完整包；工作副本包带 wc 标识，
  // 且不写入同版本号记录，避免覆盖真正的发布包
  // （deployVersionLabel / artifactVersionLabel 已在上方统一计算）

  // 注册版本号到 deploy/versions.json，便于后续 patch-extract 按版本提取
  if (versionLabel) {
    registerVersion(deployDir, {
      version: worktreeLabel
        ? `${String(version)}-${worktreeLabel}${partialSuffix}`
        : partialSignature
          ? `${String(version)}-partial-${partialSignature}`
          : String(version),
      versionLabel: artifactVersionLabel,
      vcs,
      fromLabel,
      toLabel,
      files: deployFiles,
      deleted: deployDeleted,
      patchDir,
      zipPath: noZip ? undefined : zipPath,
      partial: Boolean(partialSignature),
      worktree: Boolean(worktreeLabel),
      sourceVersion: partialSignature ? String(version) : undefined,
      createdAt: new Date().toISOString()
    })
    if (worktreeLabel) {
      // 工作副本包可随时重建，注册表只保留最近若干个，避免无限增长
      pruneWorktreeRecords(deployDir, 5)
    }
  }

  /** @type {string|undefined} */
  let archiveDir
  if (worktreeLabel) {
    // 工作副本包可从工作区随时重建；不写入 archive（提示已在 warnings 中）
  } else if (!noArchive) {
    const archived = await archivePatchPackage({
      deployDir,
      archiveLabel: artifactVersionLabel || deployVersionLabel,
      patchDir,
      zipPath: noZip ? undefined : zipPath,
      vcs,
      fromLabel,
      toLabel,
      partial: Boolean(partialSignature),
      keepVersions: keepVersions || 10,
      link: Boolean(archiveLink)
    })
    archiveDir = archived.archiveDir
  }

  /** @type {string[]} */
  let prunedOut = []
  if (pruneOut) {
    prunedOut = await pruneOutDirectory(outDir, {
      keep: keepOut || keepVersions || 10,
      zipPrefix,
      keepPaths: [patchDir, noZip ? null : zipPath]
    })
  }

  return {
    success: true,
    skipped: false,
    message: worktreeLabel
      ? `打包完成：工作副本（基准 r${fromLabel}）`
      : `打包完成：${versionLabel ? `v${versionLabel}` : (vcs === 'svn' ? `r${fromLabel} -> r${toLabel}` : `${fromLabel.slice(0, 8)}..${toLabel.slice(0, 8)}`)}`,
    patchDir,
    zipPath: noZip ? undefined : zipPath,
    zipSize,
    fileCount: deployFiles.length,
    deletedCount: deployDeleted.length,
    warnings,
    vcs,
    fromLabel,
    toLabel,
    profile: profile || undefined,
    protectCount: (protectFiles || []).length,
    executableCount: executableFiles.length,
    version: versionLabel || undefined,
    deployVersionLabel,
    artifactVersionLabel: artifactVersionLabel || undefined,
    archiveDir,
    prunedOut: prunedOut.length > 0 ? prunedOut : undefined,
    markDeployedHint: markDeployed || worktreeLabel
      ? undefined
      : `上线成功后执行：patch-build --vcs=${vcs}${profile ? ` --profile=${profile}` : ''} --mark-deployed --from=${toLabel} --to=${toLabel}` +
        (fromWorktree ? '\n注意: 本次用工作区内容打包，请确认该 commit/revision 与线上内容一致' : '')
  }
}

module.exports = {
  buildPatch,
  buildVersionLabels,
  classifyDiffEntries,
  buildArtifactNames
}
