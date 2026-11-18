/**
 * MODES.txt — 包内可执行文件清单
 *
 * 格式（每行）：
 *   0755  app/console/run.sh
 *
 * Windows 打包时 zip 无法可靠携带 Unix 执行位，服务器端据此 chmod。
 */

const fs = require('fs')
const path = require('path')
const { isSafeRelativePath } = require('./file-filter')

const MODES_FILE = 'MODES.txt'

/**
 * @param {string} patchDir
 * @param {string[]} executableFiles
 * @returns {boolean} 是否写入
 */
function writeModesFile (patchDir, executableFiles) {
  if (!executableFiles || executableFiles.length === 0) {
    return false
  }

  fs.writeFileSync(
    path.join(patchDir, MODES_FILE),
    ['# mode 相对路径（0755 = 可执行）', ...executableFiles.map(rel => `0755  ${rel}`)].join('\n'),
    'utf8'
  )

  return true
}

/**
 * 读取 MODES.txt；不存在时返回空对象
 * @param {string} patchDir
 * @returns {Record<string, number>}
 */
function readModesFile (patchDir) {
  const filePath = path.join(patchDir, MODES_FILE)
  if (!fs.existsSync(filePath)) {
    return {}
  }

  /** @type {Record<string, number>} */
  const modes = {}

  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = trimmed.match(/^([0-7]{3,4})\s+(.+)$/)
    if (!match) continue

    const rel = match[2].trim().replace(/\\/g, '/')
    if (!isSafeRelativePath(rel)) continue

    const mode = parseInt(match[1], 8)
    if (Number.isFinite(mode)) {
      modes[rel] = mode
    }
  }

  return modes
}

module.exports = {
  MODES_FILE,
  writeModesFile,
  readModesFile
}
