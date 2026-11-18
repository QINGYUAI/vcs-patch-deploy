/**
 * 上次成功上线基准标记（统一 SVN / Git）
 *
 * 主文件 `.last-deploy-marker` 格式（单行）：
 *   svn:467
 *   git:abc123def456789...
 *
 * 多环境 / 多 profile：`.last-deploy-marker.<profile>`
 *   .last-deploy-marker            生产（默认）
 *   .last-deploy-marker.php85      PHP 8.5 预发
 *
 * 兼容旧版工具：若无 marker 则读取 `.last-deploy-rev`（仅 SVN，仅默认 profile）
 */

const fs = require('fs')
const path = require('path')

const MARKER_FILE = '.last-deploy-marker'
const LEGACY_SVN_FILE = '.last-deploy-rev'

/**
 * profile 只允许安全字符，避免路径穿越（如 profile=../x）
 * @param {string} profile
 * @returns {boolean}
 */
function isValidProfile (profile) {
  return typeof profile === 'string' && /^[A-Za-z0-9._-]+$/.test(profile)
}

/**
 * 生成 marker 文件名（默认 profile 返回 `.last-deploy-marker`）
 * @param {string|null} [profile]
 * @returns {string}
 */
function markerFileName (profile = null) {
  if (!profile) {
    return MARKER_FILE
  }
  if (!isValidProfile(profile)) {
    throw new Error(`非法 profile: ${profile}（仅允许字母、数字、. _ -）`)
  }
  return `${MARKER_FILE}.${profile}`
}

/**
 * @param {string} filePath
 * @returns {{ vcs: 'svn'|'git', value: string } | null}
 */
function parseMarkerFile (filePath) {
  if (!fs.existsSync(filePath)) {
    return null
  }

  const line = fs.readFileSync(filePath, 'utf8').trim()
  const match = line.match(/^(svn|git):(.+)$/)
  if (!match) {
    return null
  }

  return { vcs: /** @type {'svn'|'git'} */ (match[1]), value: match[2].trim() }
}

/**
 * @param {string} deployDir
 * @param {string|null} [profile]
 * @returns {{ vcs: 'svn'|'git', value: string } | null}
 */
function readDeployMarker (deployDir, profile = null) {
  const marker = parseMarkerFile(path.join(deployDir, markerFileName(profile)))
  if (marker || profile) {
    // 指定 profile 时不回退到默认 marker / legacy rev，避免跨环境误用基准
    return marker
  }

  const legacyPath = path.join(deployDir, LEGACY_SVN_FILE)
  if (fs.existsSync(legacyPath)) {
    const rev = fs.readFileSync(legacyPath, 'utf8').trim()
    if (/^\d+$/.test(rev)) {
      return { vcs: 'svn', value: rev }
    }
  }

  return null
}

/**
 * 列出 deploy 目录下已有的 marker 文件（含 profile），默认 marker 排在前面
 * @param {string} deployDir
 * @returns {string[]} 文件名
 */
function listMarkerFiles (deployDir) {
  if (!fs.existsSync(deployDir)) {
    return []
  }

  return fs.readdirSync(deployDir)
    .filter(name => name === MARKER_FILE || name.startsWith(`${MARKER_FILE}.`))
    .filter(name => parseMarkerFile(path.join(deployDir, name)) !== null)
    .sort((a, b) => (a === MARKER_FILE ? -1 : b === MARKER_FILE ? 1 : a.localeCompare(b)))
}

/**
 * @param {string} deployDir
 * @param {'svn'|'git'} vcs
 * @param {string} value
 * @param {string|null} [profile]
 */
function writeDeployMarker (deployDir, vcs, value, profile = null) {
  fs.mkdirSync(deployDir, { recursive: true })
  fs.writeFileSync(path.join(deployDir, markerFileName(profile)), `${vcs}:${value}`, 'utf8')

  // SVN 兼容：同步写旧文件（仅默认 profile，profile 环境不写全局 rev）
  if (vcs === 'svn' && !profile) {
    fs.writeFileSync(path.join(deployDir, LEGACY_SVN_FILE), value, 'utf8')
  }
}

module.exports = {
  MARKER_FILE,
  LEGACY_SVN_FILE,
  isValidProfile,
  markerFileName,
  parseMarkerFile,
  readDeployMarker,
  writeDeployMarker,
  listMarkerFiles
}
