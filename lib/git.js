/**
 * Git 命令封装 — 增量 diff 与 commit 解析
 */

const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/**
 * @returns {string}
 */
function findGitExe () {
  if (process.env.GIT_EXE && fs.existsSync(process.env.GIT_EXE)) {
    return process.env.GIT_EXE
  }

  try {
    const which = process.platform === 'win32' ? 'where' : 'command -v'
    const result = execSync(`${which} git`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const first = result.split(/\r?\n/).find(Boolean)
    if (first) return first.trim()
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
function getGitInfo (sourceDir, gitExe = findGitExe()) {
  const root = runGit(gitExe, ['rev-parse', '--show-toplevel'], sourceDir).trim()
  const commit = runGit(gitExe, ['rev-parse', 'HEAD'], sourceDir).trim()
  const shortCommit = runGit(gitExe, ['rev-parse', '--short', 'HEAD'], sourceDir).trim()

  return { commit, shortCommit, root }
}

/**
 * @param {string} sourceDir
 * @param {string} ref
 * @param {string} [gitExe]
 * @returns {string} 完整 commit hash
 */
function resolveGitRef (sourceDir, ref, gitExe = findGitExe()) {
  return runGit(gitExe, ['rev-parse', ref], sourceDir).trim()
}

/**
 * @typedef {{ action: 'A'|'M'|'D', relativePath: string, parseError?: string }} DiffEntry
 */

/**
 * Git diff --name-status from..to
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {string} options.fromRef
 * @param {string} options.toRef
 * @param {string} [options.gitExe]
 * @returns {DiffEntry[]}
 */
function getGitDiffSummary ({ sourceDir, fromRef, toRef, gitExe = findGitExe() }) {
  const root = runGit(gitExe, ['rev-parse', '--show-toplevel'], sourceDir).trim()
  const fromCommit = resolveGitRef(sourceDir, fromRef, gitExe)
  const toCommit = resolveGitRef(sourceDir, toRef, gitExe)

  const output = runGit(
    gitExe,
    ['diff', '--name-status', `${fromCommit}..${toCommit}`],
    root
  )

  /** @type {DiffEntry[]} */
  const entries = []

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue

    // M\tpath | A\tpath | D\tpath | R100\told\tnew | C100\told\tnew
    const parts = line.split('\t')
    const status = parts[0]

    if (/^[AMD]$/.test(status)) {
      entries.push({
        action: /** @type {'A'|'M'|'D'} */ (status),
        relativePath: parts[1].replace(/\\/g, '/')
      })
      continue
    }

    if (/^[RC]\d+$/.test(status) && parts.length >= 3) {
      entries.push({
        action: 'M',
        relativePath: parts[2].replace(/\\/g, '/')
      })
      entries.push({
        action: 'D',
        relativePath: parts[1].replace(/\\/g, '/')
      })
      continue
    }

    entries.push({
      action: 'M',
      relativePath: parts[parts.length - 1].replace(/\\/g, '/'),
      parseError: `未识别的 git diff 行：${line}`
    })
  }

  return entries
}

/**
 * 判断目录是否在 Git 工作区内
 * @param {string} dir
 * @param {string} [gitExe]
 */
function isGitRepository (dir, gitExe = findGitExe()) {
  try {
    runGit(gitExe, ['rev-parse', '--is-inside-work-tree'], dir)
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
  isGitRepository
}
