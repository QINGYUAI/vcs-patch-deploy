/**
 * 路径与 CLI 配置解析
 */

const fs = require('fs')
const path = require('path')
const { isGitRepository } = require('./git')
const { findSvnExe, runSvn } = require('./svn')
const { getBackend } = require('./backends')

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
  const { readDeployMarker } = require('./marker')
  const deployDir = path.join(sourceDir, 'deploy')
  const marker = readDeployMarker(deployDir)

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
 * @property {'svn'|'git'} vcs
 * @property {string} sourceDir
 * @property {string} deployDir
 * @property {string} outDir
 * @property {string} applyScriptPath
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
 */

/**
 * @param {Partial<BuildConfig> & { cwd?: string, pkgRoot?: string }} input
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

  let vcs = input.vcs || process.env.PATCH_VCS
  if (vcs !== 'svn' && vcs !== 'git') {
    const detected = detectVcs(sourceDir)
    if (!detected) {
      throw new Error(
        `无法自动检测 VCS 类型：${sourceDir}\n请指定 --vcs=svn 或 --vcs=git`
      )
    }
    vcs = detected
  }

  return {
    backend: /** @type {'php'} */ (backendId),
    vcs,
    sourceDir,
    deployDir,
    outDir,
    applyScriptPath: backend.getApplyScriptPath(pkgRoot),
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
    keepVersions: parseKeepVersions(input.keepVersions ?? process.env.PATCH_KEEP_VERSIONS)
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
- \`versions.json\`：版本号与 patch 目录映射（\`patch-build --version=1.2.3\`）
- 兼容旧版 SVN：\`.last-deploy-rev\`（仅数字）

## 本机打包

\`\`\`bash
npx patch-build --vcs=${vcs}
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
