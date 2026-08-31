/**
 * 将 patch 目录压缩为 zip
 */

const fs = require('fs')
const path = require('path')
const archiver = require('archiver')

/**
 * @param {string} sourceDir patch 目录
 * @param {string} zipPath 输出 zip 路径
 * @returns {Promise<{ zipPath: string, size: number }>}
 */
function createZipFromDirectory (sourceDir, zipPath) {
  const level = Number(process.env.PATCH_ZIP_LEVEL ?? 6)
  const zipLevel = Number.isFinite(level) ? Math.min(9, Math.max(0, level)) : 6

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true })

    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: zipLevel } })

    output.on('close', () => {
      resolve({ zipPath, size: archive.pointer() })
    })

    archive.on('error', reject)
    output.on('error', reject)

    archive.pipe(output)
    archive.directory(sourceDir, false)
    archive.finalize()
  })
}

module.exports = {
  createZipFromDirectory
}
