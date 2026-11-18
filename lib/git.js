/**
 * Git 命令封装 — 增量 diff 与 commit 解析
 */

const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/** @type {string|null} */
let cachedGitExe = null

/**
 * @returns {string}
 */
function findGitExe () {
  if (cachedGitExe) {
    return cachedGitExe
  }

  if (process.env.GIT_EXE && fs.existsSync(process.env.GIT_EXE)) {
    cachedGitExe = process.env.GIT_EXE
    return cachedGitExe
  }

  try {
    const which = process.platform === 'win32' ? 'where' : 'command -v'
    const result = execSync(`${which} git`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const first = result.split(/\r?\n/).find(Boolean)
    if (first) {
      cachedGitExe = first.trim()
      return cachedGitExe
    }
  } catch {
    // ignore
  }

  throw new Error('未找到 git 可执行文件，请安装 Git 并加入 PATH，或设置环境变量 GIT_EXE')
}

/**
 * @param {string} gitExe
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function runGit (gitExe, args, cwd) {
  try {
    return execFileSync(gitExe, args, {
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
 * @param {string} sourceDir Git 仓库根或子目录
 * @param {string} [gitExe]
 * @returns {{ commit: string, shortCommit: string, root: string }}
 */
function getGitInfo (sourceDir, gitExe) {
  const exe = gitExe || findGitExe()
  const root = runGit(exe, ['rev-parse', '--show-toplevel'], sourceDir).trim()
  const commit = runGit(exe, ['rev-parse', 'HEAD'], sourceDir).trim()
  const shortCommit = runGit(exe, ['rev-parse', '--short', 'HEAD'], sourceDir).trim()

  return { commit, shortCommit, root }
}

/**
 * @param {string} sourceDir
 * @param {string} ref
 * @param {string} [gitExe]
 * @returns {string} 完整 commit hash
 */
function resolveGitRef (sourceDir, ref, gitExe) {
  const exe = gitExe || findGitExe()
  return runGit(exe, ['rev-parse', ref], sourceDir).trim()
}

/**
 * @typedef {{ action: 'A'|'M'|'D', relativePath: string, parseError?: string }} DiffEntry
 */

/**
 * 将 git 输出的仓库根相对路径转换为 sourceDir 相对路径
 * @param {string} repoPath
 * @param {string} [prefix] sourceDir 相对仓库根的路径（可为空）
 * @returns {string|null} 不在 prefix 下时返回 null
 */
function repoPathToSourceRelative (repoPath, prefix = '') {
  const norm = repoPath.trim().replace(/\\/g, '/')
  if (!prefix) {
    return norm
  }

  const base = prefix.replace(/\\/g, '/').replace(/\/$/, '')
  if (norm === base) {
    return ''
  }
  if (norm.startsWith(base + '/')) {
    return norm.slice(base.length + 1)
  }

  return null
}

/**
 * Git diff --name-status from..to
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {string} options.fromRef
 * @param {string} options.toRef
 * @param {string} [options.prefix] sourceDir 相对仓库根的路径（非仓库根时必填）
 * @param {string} [options.gitExe]
 * @returns {DiffEntry[]}
 */
function getGitDiffSummary ({ sourceDir, fromRef, toRef, prefix = '', gitExe }) {
  const exe = gitExe || findGitExe()
  const root = runGit(exe, ['rev-parse', '--show-toplevel'], sourceDir).trim()
  const fromCommit = resolveGitRef(sourceDir, fromRef, exe)
  const toCommit = resolveGitRef(sourceDir, toRef, exe)

  // core.quotepath=false：避免中文等路径被转义成 "app/\344\270\255.php"
  const output = runGit(
    exe,
    ['-c', 'core.quotepath=false', 'diff', '--name-status', `${fromCommit}..${toCommit}`],
    root
  )

  /** @type {DiffEntry[]} */
  const entries = []

  /**
   * @param {'A'|'M'|'D'} action
   * @param {string} repoPath
   */
  const push = (action, repoPath) => {
    const rel = repoPathToSourceRelative(repoPath, prefix)
    if (!rel) {
      return
    }
    entries.push({ action, relativePath: rel })
  }

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue

    // M\tpath | A\tpath | D\tpath | R100\told\tnew | C100\told\tnew
    const parts = line.split('\t')
    const status = parts[0]

    if (/^[AMD]$/.test(status)) {
      push(/** @type {'A'|'M'|'D'} */ (status), parts[1])
      continue
    }

    if (/^[RC]\d+$/.test(status) && parts.length >= 3) {
      push('M', parts[2])
      push('D', parts[1])
      continue
    }

    // 类型变更（如文件 ↔ 符号链接）
    if (/^T\d*$/.test(status) && parts.length >= 2) {
      push('M', parts[1])
      continue
    }

    const rel = repoPathToSourceRelative(parts[parts.length - 1], prefix)
    if (rel) {
      entries.push({
        action: 'M',
        relativePath: rel,
        parseError: `未识别的 git diff 行：${line}`
      })
    }
  }

  return entries
}

/**
 * 检查待打包文件的工作区内容是否与目标 commit 一致
 *
 * 打包是从工作区复制文件的；若工作区未同步到目标 commit（或存在未提交改动），
 * 包内容就会与 MANIFEST 声明的版本范围不符。
 *
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {string} options.toRef 目标 commit/tag
 * @param {string[]} options.files sourceDir 相对路径
 * @param {string} [options.prefix]
 * @param {string} [options.gitExe]
 * @returns {string[]} 内容不一致的文件（sourceDir 相对路径）
 */
function getGitContentMismatch ({ sourceDir, toRef, files, prefix = '', gitExe }) {
  if (!files || files.length === 0) {
    return []
  }

  const exe = gitExe || findGitExe()
  const root = runGit(exe, ['rev-parse', '--show-toplevel'], sourceDir).trim()
  const toCommit = resolveGitRef(sourceDir, toRef, exe)
  const repoPaths = files.map(f => (prefix ? `${prefix}/${f}` : f))

  /** @type {Set<string>} */
  const mismatched = new Set()
  const chunkSize = 100

  for (let i = 0; i < repoPaths.length; i += chunkSize) {
    const chunk = repoPaths.slice(i, i + chunkSize)
    const output = runGit(
      exe,
      ['-c', 'core.quotepath=false', 'diff', '--name-only', toCommit, '--', ...chunk],
      root
    )

    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue
      const rel = repoPathToSourceRelative(line, prefix)
      if (rel) {
        mismatched.add(rel)
      }
    }
  }

  return [...mismatched].sort()
}

/**
 * 读取待打包文件中在 Git 索引里标记为可执行（100755）的路径
 *
 * Windows 上 fs.stat 不体现执行位，跨平台打包时需依赖 Git 索引模式。
 *
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {string[]} options.files sourceDir 相对路径
 * @param {string} [options.prefix]
 * @param {string} [options.gitExe]
 * @returns {string[]}
 */
function getGitExecutableFiles ({ sourceDir, files, prefix = '', gitExe }) {
  if (!files || files.length === 0) {
    return []
  }

  const exe = gitExe || findGitExe()
  const root = runGit(exe, ['rev-parse', '--show-toplevel'], sourceDir).trim()
  const repoPaths = files.map(f => (prefix ? `${prefix}/${f}` : f))

  /** @type {Set<string>} */
  const executable = new Set()
  const chunkSize = 100

  for (let i = 0; i < repoPaths.length; i += chunkSize) {
    const chunk = repoPaths.slice(i, i + chunkSize)
    const output = runGit(
      exe,
      ['-c', 'core.quotepath=false', 'ls-files', '-s', '--', ...chunk],
      root
    )

    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue
      // <mode> <sha> <stage>\t<path>
      const match = line.match(/^(\d{6})\s+\S+\s+\d+\t(.+)$/)
      if (!match || match[1] !== '100755') continue
      const rel = repoPathToSourceRelative(match[2], prefix)
      if (rel) {
        executable.add(rel)
      }
    }
  }

  return [...executable].sort()
}

/**
 * 计算 sourceDir 相对 git 仓库根的路径（用于把 git 输出映射回源码目录）
 * @param {string} root
 * @param {string} sourceDir
 * @returns {string}
 */
function getGitPrefix (root, sourceDir) {
  const rel = path.relative(path.resolve(root), path.resolve(sourceDir)).replace(/\\/g, '/')
  return rel === '.' || rel === '' ? '' : rel
}

/**
 * 判断目录是否在 Git 工作区内（Git 未安装时返回 false，不抛错）
 * @param {string} dir
 * @param {string} [gitExe]
 */
function isGitRepository (dir, gitExe) {
  try {
    const exe = gitExe || findGitExe()
    runGit(exe, ['rev-parse', '--is-inside-work-tree'], dir)
    return true
  } catch {
    return false
  }
}

module.exports = {
  findGitExe,
  runGit,
  getGitInfo,
  resolveGitRef,
  getGitDiffSummary,
  getGitContentMismatch,
  getGitExecutableFiles,
  getGitPrefix,
  repoPathToSourceRelative,
  isGitRepository
}
