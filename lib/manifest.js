/**
 * MANIFEST.txt 解析（build / extract / 测试共用）
 */

const fs = require('fs')
const path = require('path')

/**
 * 从 patch 目录 MANIFEST.txt 读取 # files 段
 * @param {string} patchDir
 * @returns {string[]}
 */
function readManifestFiles (patchDir) {
  const manifestPath = path.join(patchDir, 'MANIFEST.txt')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`缺少 MANIFEST.txt: ${manifestPath}`)
  }

  const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)
  /** @type {string[]} */
  const files = []
  let inFiles = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '# files') {
      inFiles = true
      continue
    }
    if (inFiles && trimmed.startsWith('#')) {
      break
    }
    if (inFiles && trimmed) {
      files.push(trimmed.replace(/\\/g, '/'))
    }
  }

  if (files.length === 0) {
    throw new Error(`MANIFEST.txt 中未找到文件列表: ${manifestPath}`)
  }

  return files
}

module.exports = {
  readManifestFiles
}
