/**
 * 将 patch 目录压缩为 zip
 *
 * 逐条写入（而不是 archive.directory），以便：
 *   - 保留 Unix 执行位（Windows 上 fs.stat 不体现 exec 位，需由 VCS 元数据提供）
 *   - 固定文件/目录权限，避免不同平台产物差异
 *   - 跳过符号链接，目录条目显式写入
 */

const fs = require('fs')
const path = require('path')
const archiver = require('archiver')

const DEFAULT_FILE_MODE = 0o644
const DEFAULT_DIR_MODE = 0o755

/**
 * @param {object} [options]
 * @param {Record<string, number>} [options.modes] 相对路径 -> 权限（如 { 'app/run.sh': 0o755 }）
 * @param {number} [options.fileMode] 未在 modes 中指定时的默认文件权限
 * @param {number} [options.dirMode] 目录权限
 * @returns {Promise<{ zipPath: string, size: number }>}
 */
function createZipFromDirectory (sourceDir, zipPath, options = {}) {
  const level = Number(process.env.PATCH_ZIP_LEVEL ?? 6)
  const zipLevel = Number.isFinite(level) ? Math.min(9, Math.max(0, level)) : 6
  const modes = options.modes || {}
  const fileMode = options.fileMode ?? DEFAULT_FILE_MODE
  const dirMode = options.dirMode ?? DEFAULT_DIR_MODE

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true })

    const archive = archiver('zip', { zlib: { level: zipLevel } })

    // 先收集条目：源目录不可读等错误会在创建临时文件前抛出
    try {
      addDirectory(archive, sourceDir, '', { modes, fileMode, dirMode })
    } catch (error) {
      reject(/** @type {Error} */ (error))
      return
    }

    // 先写临时文件，成功后再替换：失败时不会留下截断的 zip，也不会提前销毁旧产物
    const tmpPath = `${zipPath}.${process.pid}.${Date.now()}.tmp`
    const output = fs.createWriteStream(tmpPath)
    let settled = false

    /** @param {Error} error */
    const fail = (error) => {
      if (settled) return
      settled = true
      try {
        archive.abort()
      } catch {
        // ignore
      }
      try {
        output.destroy()
      } catch {
        // ignore
      }
      const cleanup = () => {
        try {
          fs.rmSync(tmpPath, { force: true })
        } catch {
          // ignore
        }
      }
      if (output.closed) {
        cleanup()
      } else {
        output.once('close', cleanup)
      }
      reject(error)
    }

    output.on('close', () => {
      if (settled) return
      try {
        try {
          fs.renameSync(tmpPath, zipPath)
        } catch {
          // Windows 上目标已存在时 rename 可能失败：先移除旧文件再重试
          fs.rmSync(zipPath, { force: true })
          fs.renameSync(tmpPath, zipPath)
        }
      } catch (error) {
        fail(error)
        return
      }
      settled = true
      resolve({ zipPath, size: archive.pointer() })
    })

    archive.on('error', fail)
    output.on('error', fail)

    archive.pipe(output)
    archive.finalize().catch(fail)
  })
}

/**
 * 递归写入目录（排序保证产物稳定；跳过符号链接）
 * @param {import('archiver')} archive
 * @param {string} absDir
 * @param {string} relDir
 * @param {{ modes: Record<string, number>, fileMode: number, dirMode: number }} options
 */
function addDirectory (archive, absDir, relDir, options) {
  const names = fs.readdirSync(absDir).sort()
  if (relDir !== '') {
    archive.append(null, {
      name: `${relDir}/`,
      type: 'directory',
      mode: options.dirMode
    })
  }

  for (const name of names) {
    const abs = path.join(absDir, name)
    const rel = relDir ? `${relDir}/${name}` : name

    let stat
    try {
      stat = fs.lstatSync(abs)
    } catch {
      continue
    }

    // 符号链接一律跳过（服务器端同样拒绝）
    if (stat.isSymbolicLink()) {
      continue
    }

    if (stat.isDirectory()) {
      addDirectory(archive, abs, rel, options)
      continue
    }

    if (!stat.isFile()) {
      continue
    }

    archive.file(abs, {
      name: rel,
      mode: options.modes[rel] ?? options.fileMode
    })
  }
}

module.exports = {
  DEFAULT_FILE_MODE,
  DEFAULT_DIR_MODE,
  createZipFromDirectory
}
