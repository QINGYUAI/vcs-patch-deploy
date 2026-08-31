/**
 * 部署文件列表解析与过滤（版本子集提取、按文件单独部署）
 */

const fs = require('fs')
const path = require('path')

/**
 * 规范化相对路径（统一 /，去掉 ./ 前缀）
 * @param {string} relativePath
 * @returns {string}
 */
function normalizeRelativePath (relativePath) {
  return String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/**
 * 解析逗号分隔或数组形式的文件列表
 * @param {string|string[]|null|undefined} input
 * @returns {string[]}
 */
function parseFileListInput (input) {
  if (input == null || input === '') {
    return []
  }

  if (Array.isArray(input)) {
    return [...new Set(input.map(normalizeRelativePath).filter(Boolean))]
  }

  return [...new Set(
    String(input)
      .split(',')
      .map(normalizeRelativePath)
      .filter(Boolean)
  )]
}

/**
 * 从 @file 或 file 路径读取每行一个相对路径
 * @param {string} listPath
 * @returns {string[]}
 */
function readFileListFromPath (listPath) {
  const abs = path.resolve(listPath)
  if (!fs.existsSync(abs)) {
    throw new Error(`文件列表不存在: ${abs}`)
  }

  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/)
  const files = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    files.push(normalizeRelativePath(trimmed))
  }

  return [...new Set(files)]
}

/**
 * 合并 CLI 传入的文件与列表文件（支持 @files.txt 前缀）
 * @param {string[]} onlyFiles
 * @param {string|null} fileListPath
 * @returns {string[]}
 */
function resolveSelectedFiles (onlyFiles = [], fileListPath = null) {
  /** @type {string[]} */
  const selected = []

  for (const item of onlyFiles) {
    if (item.startsWith('@')) {
      selected.push(...readFileListFromPath(item.slice(1)))
    } else {
      selected.push(normalizeRelativePath(item))
    }
  }

  if (fileListPath) {
    selected.push(...readFileListFromPath(fileListPath))
  }

  return [...new Set(selected.filter(Boolean))]
}

/**
 * 从全量文件列表中筛选指定文件；支持目录前缀（以 / 结尾）
 * @param {string[]} allFiles
 * @param {string[]} selected
 * @returns {{ matched: string[], missing: string[] }}
 */
function filterFilesBySelection (allFiles, selected) {
  if (selected.length === 0) {
    return { matched: [...allFiles], missing: [] }
  }

  /** @type {Set<string>} */
  const matchedSet = new Set()
  /** @type {string[]} */
  const missing = []

  for (const sel of selected) {
    const prefix = sel.endsWith('/') ? sel : null

    if (prefix) {
      const hits = allFiles.filter(f => f.startsWith(prefix))
      if (hits.length === 0) {
        missing.push(sel)
      } else {
        hits.forEach(f => matchedSet.add(f))
      }
      continue
    }

    if (allFiles.includes(sel)) {
      matchedSet.add(sel)
    } else {
      missing.push(sel)
    }
  }

  return {
    matched: [...matchedSet].sort(),
    missing
  }
}

/**
 * 清理版本号用于目录/zip 命名
 * @param {string} version
 * @returns {string}
 */
function sanitizeVersionLabel (version) {
  return String(version).trim().replace(/^v/i, '').replace(/[^a-zA-Z0-9._-]/g, '_')
}

module.exports = {
  normalizeRelativePath,
  parseFileListInput,
  readFileListFromPath,
  resolveSelectedFiles,
  filterFilesBySelection,
  sanitizeVersionLabel
}
