/**
 * 上次成功上线基准标记（统一 SVN / Git）
 *
 * 主文件 `.last-deploy-marker` 格式（单行）：
 *   svn:467
 *   git:abc123def456789...
 *
 * 兼容旧版工具：若无 marker 则读取 `.last-deploy-rev`（仅 SVN）
 */

const fs = require('fs')
const path = require('path')

const MARKER_FILE = '.last-deploy-marker'
const LEGACY_SVN_FILE = '.last-deploy-rev'

/**
 * @param {string} deployDir
 * @returns {{ vcs: 'svn'|'git', value: string } | null}
 */
function readDeployMarker (deployDir) {
  const markerPath = path.join(deployDir, MARKER_FILE)
  if (fs.existsSync(markerPath)) {
    const line = fs.readFileSync(markerPath, 'utf8').trim()
    const match = line.match(/^(svn|git):(.+)$/)
    if (match) {
      return { vcs: /** @type {'svn'|'git'} */ (match[1]), value: match[2].trim() }
    }
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
 * @param {string} deployDir
 * @param {'svn'|'git'} vcs
 * @param {string} value
 */
function writeDeployMarker (deployDir, vcs, value) {
  fs.mkdirSync(deployDir, { recursive: true })
  fs.writeFileSync(path.join(deployDir, MARKER_FILE), `${vcs}:${value}`, 'utf8')

  // SVN 兼容：同步写旧文件
  if (vcs === 'svn') {
    fs.writeFileSync(path.join(deployDir, LEGACY_SVN_FILE), value, 'utf8')
  }
}

module.exports = {
  MARKER_FILE,
  LEGACY_SVN_FILE,
  readDeployMarker,
  writeDeployMarker
}
