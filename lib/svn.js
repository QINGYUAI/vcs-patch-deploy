/**
 * SVN 命令封装
 */

const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * 查找 svn 可执行文件
 * @returns {string}
 */
function findSvnExe () {
  if (process.env.SVN_EXE && fs.existsSync(process.env.SVN_EXE)) {
    return process.env.SVN_EXE
  }

  try {
    const which = process.platform === 'win32' ? 'where' : 'command -v'
    const result = execSync(`${which} svn`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const first = result.split(/\r?\n/).find(Boolean)
    if (first) return first.trim()
  } catch {
    // ignore
  }

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
      'C:\\Program Files\\SlikSvn\\bin\\svn.exe',
      'C:\\Program Files\\VisualSVN Server\\bin\\svn.exe'
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
  }

  throw new Error('未找到 svn 可执行文件，请安装 TortoiseSVN/SlikSVN 并加入 PATH，或设置环境变量 SVN_EXE')
}

/**
 * @param {string} svnExe
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function runSvn (svnExe, args, cwd) {
  try {
    return execFileSync(svnExe, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : ''
    const stdout = error.stdout ? error.stdout.toString() : ''
    throw new Error([stdout, stderr, error.message].filter(Boolean).join('\n'))
  }
}

/**
 * @param {string} sourceDir SVN 源码目录（如 trunk）
 * @returns {{ revision: number, wcRoot: string }}
 */
function getSvnInfo (sourceDir, svnExe = findSvnExe()) {
  const output = runSvn(svnExe, ['info', sourceDir], sourceDir)
  const revMatch = output.match(/^Revision:\s*(\d+)/m)
  const wcMatch = output.match(/^Working Copy Root Path:\s*(.+)$/m)

  if (!revMatch) {
    throw new Error(`无法读取 SVN revision：${sourceDir}`)
  }

  return {
    revision: parseInt(revMatch[1], 10),
    wcRoot: wcMatch ? wcMatch[1].trim() : sourceDir
  }
}

/**
 * 解析 svn diff --summarize 输出中的相对路径
 * @param {string} rawPath
 * @param {string} sourceDir
 * @param {string} svnRoot
 */
function normalizeRelativePath (rawPath, sourceDir, svnRoot) {
  const trunkNorm = path.resolve(sourceDir).replace(/\\/g, '/').replace(/\/$/, '')
  const svnNorm = path.resolve(svnRoot).replace(/\\/g, '/').replace(/\/$/, '')
  let normalized = rawPath.trim().replace(/\\/g, '/').replace(/\/$/, '')

  if (normalized.toLowerCase().startsWith(trunkNorm.toLowerCase())) {
    return normalized.slice(trunkNorm.length).replace(/^\//, '')
  }

  if (normalized.toLowerCase().startsWith(svnNorm.toLowerCase())) {
    const rest = normalized.slice(svnNorm.length).replace(/^\//, '')
    const trunkMatch = rest.match(/^trunk\/(.+)$/)
    return trunkMatch ? trunkMatch[1] : rest
  }

  const trunkMatch = normalized.match(/^trunk\/(.+)$/)
  if (trunkMatch) return trunkMatch[1]

  throw new Error(`无法解析 SVN 路径：${rawPath}`)
}

/**
 * @typedef {{ action: 'A'|'M'|'D', relativePath: string }} DiffEntry
 */

/**
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {number} options.fromRev
 * @param {number} options.toRev
 * @param {string} [options.svnExe]
 * @returns {DiffEntry[]}
 */
function getSvnDiffSummary ({ sourceDir, fromRev, toRev, svnExe = findSvnExe() }) {
  const svnRoot = path.dirname(sourceDir) // 常见 layout: repo-root/trunk
  const output = runSvn(
    svnExe,
    ['diff', '-r', `${fromRev}:${toRev}`, '--summarize', sourceDir],
    svnRoot
  )

  /** @type {DiffEntry[]} */
  const entries = []

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([AMD])\s+(.+)$/)
    if (!match) continue

    try {
      entries.push({
        action: /** @type {'A'|'M'|'D'} */ (match[1]),
        relativePath: normalizeRelativePath(match[2], sourceDir, svnRoot)
      })
    } catch (error) {
      entries.push({
        action: /** @type {'A'|'M'|'D'} */ (match[1]),
        relativePath: match[2],
        parseError: error.message
      })
    }
  }

  return entries
}

/**
 * 读取上次上线 revision
 * @param {string} lastRevFile
 * @returns {number|null}
 */
function readLastDeployRev (lastRevFile) {
  if (!fs.existsSync(lastRevFile)) return null
  const content = fs.readFileSync(lastRevFile, 'utf8')
  const line = content.split(/\r?\n/).find(l => /^\s*\d+\s*$/.test(l))
  return line ? parseInt(line.trim(), 10) : null
}

/**
 * @param {string} lastRevFile
 * @param {number} rev
 */
function writeLastDeployRev (lastRevFile, rev) {
  fs.mkdirSync(path.dirname(lastRevFile), { recursive: true })
  fs.writeFileSync(lastRevFile, String(rev), 'utf8')
}

module.exports = {
  findSvnExe,
  runSvn,
  getSvnInfo,
  normalizeRelativePath,
  getSvnDiffSummary,
  readLastDeployRev,
  writeLastDeployRev
}
