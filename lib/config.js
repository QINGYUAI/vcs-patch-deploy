/**
 * 路径与 CLI 配置解析
 */

const fs = require('fs')
const path = require('path')
const { isGitRepository } = require('./git')
const { findSvnExe, runSvn } = require('./svn')
const { getBackend } = require('./backends')
const { readDeployMarker, listMarkerFiles, parseMarkerFile, isValidProfile } = require('./marker')
const { resolveProtectFiles } = require('./protect')

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isSvnWorkingCopy (dir) {
  try {
    const svnExe = findSvnExe()
    runSvn(svnExe, ['info', dir], dir)
    return true
  } catch {
    return false
  }
}

/**
 * 自动检测 VCS 类型（PHP 项目可能 Git + SVN 工作副本并存）
 * @param {string} sourceDir
 * @returns {'svn'|'git'|null}
 */
function detectVcs (sourceDir) {
  const deployDir = path.join(sourceDir, 'deploy')
  const profile = process.env.PATCH_PROFILE || null

  // 指定 profile 时优先用该环境基准；否则依次尝试默认 marker 与其他 profile，
  // 避免“只有 .last-deploy-marker.php85”的项目无法自动识别 VCS
  let marker = null
  try {
    marker = readDeployMarker(deployDir, profile)
  } catch {
    marker = null
  }
  if (!marker) {
    for (const name of listMarkerFiles(deployDir)) {
      marker = parseMarkerFile(path.join(deployDir, name))
      if (marker) break
    }
  }

  if (marker?.vcs === 'svn' && isSvnWorkingCopy(sourceDir)) return 'svn'
  if (marker?.vcs === 'git' && isGitRepository(sourceDir)) return 'git'

  const hasSvn = isSvnWorkingCopy(sourceDir)
  const hasGit = isGitRepository(sourceDir)

  // 双仓库并存时：有 SVN marker / 旧版 rev 文件则优先 SVN
  if (hasSvn && hasGit) {
    if (marker?.vcs === 'svn') return 'svn'
    const legacyRev = path.join(deployDir, '.last-deploy-rev')
    if (fs.existsSync(legacyRev)) return 'svn'
    return 'git'
  }

  if (hasGit) return 'git'
  if (hasSvn) return 'svn'
  return null
}

/**
 * @typedef {object} BuildConfig
 * @property {'php'} backend 后端类型（v1 仅 php）
 * @property {'svn'|'git'|null} vcs 仅在 needsVcs=false 且无法检测时为 null
 * @property {string} sourceDir
 * @property {string} deployDir
 * @property {string} outDir
 * @property {string} applyScriptPath apply-update.php 模板（可用 --apply-script 覆盖）
 * @property {string|number|null} fromRef
 * @property {string|number|null} toRef
 * @property {boolean} noZip
 * @property {boolean} markDeployed
 * @property {boolean} skipValidation
 * @property {string} zipPrefix
 * @property {string|null} version 安装版本号（如 1.2.3）
 * @property {string[]} onlyFiles 仅打包/部署指定文件
 * @property {string|null} fileList 文件列表路径（每行一个相对路径）
 * @property {boolean} noArchive 跳过本地版本归档
 * @property {number} keepVersions 本地 archive 保留版本数（默认 10）
 * @property {boolean} pruneOut 构建后清理 deploy/out 旧产物
 * @property {number} keepOut deploy/out 保留数量（默认与 keepVersions 相同）
 * @property {boolean} archiveLink 归档时优先使用硬链接（节省磁盘）
 * @property {boolean} fromWorktree 允许用工作区内容打包（跳过与目标版本的比对）
 * @property {string|null} profile 多环境基准（marker 后缀，如 php85）
 * @property {string[]} protectFiles 受保护文件（线上已存在则跳过覆盖）
 * @property {boolean} diffWorktree SVN：直接打包工作副本改动（对比基准 revision）
 */

/**
 * @param {Partial<BuildConfig> & { cwd?: string, pkgRoot?: string, needsVcs?: boolean }} input
 * @returns {BuildConfig}
 */
function resolveConfig (input = {}) {
  const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd()
  const sourceDir = path.resolve(input.sourceDir || process.env.PATCH_SOURCE_DIR || cwd)
  const deployDir = path.resolve(
    input.deployDir || process.env.PATCH_DEPLOY_DIR || path.join(sourceDir, 'deploy')
  )
  const outDir = path.join(deployDir, 'out')
  const pkgRoot = input.pkgRoot || path.join(__dirname, '..')

  const backendId = (input.backend || process.env.PATCH_BACKEND || 'php').toLowerCase()
  const backend = getBackend(backendId)

  const profileRaw = String(input.profile ?? process.env.PATCH_PROFILE ?? '').trim()
  const profile = profileRaw === '' ? null : profileRaw
  if (profile !== null && !isValidProfile(profile)) {
    throw new Error(`非法 profile: ${profile}（仅允许字母、数字、. _ -）`)
  }

  let vcs = input.vcs || process.env.PATCH_VCS
  if (vcs !== 'svn' && vcs !== 'git') {
    if (input.needsVcs === false) {
      // 只读 deploy 元数据的命令（如 patch-extract --list-versions）不依赖 VCS
      vcs = null
    } else {
      const detected = detectVcs(sourceDir)
      if (!detected) {
        throw new Error(
          `无法自动检测 VCS 类型：${sourceDir}\n请指定 --vcs=svn 或 --vcs=git`
        )
      }
      vcs = detected
    }
  }

  const applyScriptInput = input.applyScriptPath || process.env.PATCH_APPLY_SCRIPT || ''
  const applyScriptPath = applyScriptInput
    ? path.resolve(applyScriptInput)
    : backend.getApplyScriptPath(pkgRoot)

  // 受保护文件：deploy/protect.txt + --protect/--protect-file + 环境变量
  const protectFiles = resolveProtectFiles({
    deployDir,
    protectFiles: input.protectFiles || [],
    protectFile: input.protectFile || null
  })

  const keepVersions = parseKeepVersions(input.keepVersions ?? process.env.PATCH_KEEP_VERSIONS)
  const keepOut = parseKeepVersions(
    input.keepOut ?? process.env.PATCH_KEEP_OUT ?? keepVersions
  )

  return {
    backend: /** @type {'php'} */ (backendId),
    vcs,
    sourceDir,
    deployDir,
    outDir,
    applyScriptPath: applyScriptPath,
    fromRef: input.fromRef ?? null,
    toRef: input.toRef ?? null,
    noZip: Boolean(input.noZip),
    markDeployed: Boolean(input.markDeployed),
    skipValidation: Boolean(input.skipValidation || process.env.PATCH_SKIP_VALIDATION === 'true'),
    zipPrefix: input.zipPrefix || process.env.PATCH_ZIP_PREFIX || backend.defaultZipPrefix,
    version: input.version || process.env.PATCH_VERSION || null,
    onlyFiles: input.onlyFiles || [],
    fileList: input.fileList || process.env.PATCH_FILE_LIST || null,
    noArchive: Boolean(input.noArchive || process.env.PATCH_NO_ARCHIVE === 'true'),
    keepVersions,
    pruneOut: Boolean(input.pruneOut || process.env.PATCH_PRUNE_OUT === 'true'),
    keepOut,
    archiveLink: Boolean(input.archiveLink || process.env.PATCH_ARCHIVE_LINK === 'true'),
    fromWorktree: Boolean(input.fromWorktree || process.env.PATCH_FROM_WORKTREE === 'true'),
    profile,
    protectFiles,
    diffWorktree: Boolean(input.diffWorktree || process.env.PATCH_DIFF_WORKTREE === 'true')
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseKeepVersions (value) {
  const n = parseInt(String(value ?? '10'), 10)
  if (!Number.isFinite(n) || n < 1) {
    return 10
  }
  return n
}

/**
 * 初始化 PHP 后端 deploy 目录结构
 * @param {string} deployDir
 * @param {'svn'|'git'} [vcs]
 */
function initDeployDir (deployDir, vcs = 'svn') {
  fs.mkdirSync(path.join(deployDir, 'out'), { recursive: true })

  const exampleMarker = vcs === 'git' ? 'git:请替换为上次成功上线的commit' : 'svn:请替换为上次成功上线的revision'
  const markerPath = path.join(deployDir, '.last-deploy-marker.example')
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, exampleMarker, 'utf8')
  }

  const readmePath = path.join(deployDir, 'README.md')
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# PHP 后端增量部署

## 基准文件

- \`.last-deploy-marker\`：上次成功上线标记，格式 \`svn:467\` 或 \`git:abc123...\`
- \`.last-deploy-marker.<profile>\`：多环境基准（如 \`.last-deploy-marker.php85\`）
- \`versions.json\`：版本号与 patch 目录映射（\`patch-build --version=1.2.3\`）
- 兼容旧版 SVN：\`.last-deploy-rev\`（仅数字）

## 受保护文件（可选）

新建 \`deploy/protect.txt\`，每行一个相对路径（\`#\` 注释）：

\`\`\`text
# 运行时被程序改写、线上已存在时不覆盖
config/date_config.json
\`\`\`

## 本机打包

\`\`\`bash
npx patch-build --vcs=${vcs}
npx patch-build --vcs=${vcs} --profile=php85   # 预发环境
npx patch-build --vcs=${vcs} --worktree-diff   # SVN：直接打包工作副本改动
\`\`\`

## 服务器应用

\`\`\`bash
unzip -o backend-update-*.zip -d patch-dir
cd patch-dir
php apply-update.php --check /path/to/backend
php apply-update.php /path/to/backend
\`\`\`
`, 'utf8')
  }
}

module.exports = {
  detectVcs,
  resolveConfig,
  initDeployDir,
  isSvnWorkingCopy,
  parseKeepVersions
}
