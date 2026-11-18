/**
 * 受保护文件清单（上线时线上已存在则跳过覆盖）
 *
 * 来源（合并去重）：
 *   1. deploy/protect.txt（每行一个相对路径，# 注释）
 *   2. --protect=<路径>（逗号分隔，可重复）
 *   3. --protect-file=<文件>
 *   4. PATCH_PROTECT / PATCH_PROTECT_FILE
 *
 * 打包时写入包内 PROTECT.txt，apply-update.php 读取后对“线上已存在”的
 * 受保护文件跳过覆盖（不存在时仍写入，便于首次部署）。适用于运行时
 * 被程序改写、又被版本控制的配置文件（如 config/date_config.json）。
 */

const fs = require('fs')
const path = require('path')
const { normalizeRelativePath, isSafeRelativePath } = require('./file-filter')

const PROTECT_FILE = 'PROTECT.txt'
const DEPLOY_PROTECT_FILE = 'protect.txt'

/**
 * 从列表文件读取（每行一个相对路径，忽略空行与 # 注释）
 * @param {string} filePath
 * @returns {string[]}
 */
function readProtectListFromFile (filePath) {
  const abs = path.resolve(filePath)
  if (!fs.existsSync(abs)) {
    throw new Error(`保护清单不存在: ${abs}`)
  }

  return fs.readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => normalizeRelativePath(line))
}

/**
 * 解析 --protect 等输入并合并 deploy/protect.txt
 * @param {object} options
 * @param {string} options.deployDir
 * @param {string[]} [options.protectFiles]
 * @param {string|null} [options.protectFile]
 * @param {string} [options.envList]
 * @param {string} [options.envFile]
 * @returns {string[]}
 */
function resolveProtectFiles ({
  deployDir,
  protectFiles = [],
  protectFile = null,
  envList = process.env.PATCH_PROTECT,
  envFile = process.env.PATCH_PROTECT_FILE
}) {
  /** @type {string[]} */
  const collected = []

  const deployList = path.join(deployDir, DEPLOY_PROTECT_FILE)
  if (fs.existsSync(deployList)) {
    collected.push(...readProtectListFromFile(deployList))
  }

  for (const item of protectFiles) {
    if (!item) continue
    collected.push(...String(item).split(',').map(normalizeRelativePath).filter(Boolean))
  }

  if (envList) {
    collected.push(...String(envList).split(',').map(normalizeRelativePath).filter(Boolean))
  }

  const listFile = protectFile || envFile
  if (listFile) {
    collected.push(...readProtectListFromFile(listFile))
  }

  /** @type {string[]} */
  const invalid = []
  /** @type {Set<string>} */
  const unique = new Set()

  for (const rel of collected) {
    if (!isSafeRelativePath(rel)) {
      invalid.push(rel)
      continue
    }
    unique.add(rel.replace(/\\/g, '/'))
  }

  if (invalid.length > 0) {
    throw new Error(`保护清单含不安全路径（拒绝）: ${invalid.join(', ')}`)
  }

  return [...unique].sort()
}

/**
 * 将保护清单写入 patch 包根目录
 * @param {string} patchDir
 * @param {string[]} files
 * @returns {boolean} 是否写入
 */
function writeProtectFile (patchDir, files) {
  if (!files || files.length === 0) {
    return false
  }

  fs.writeFileSync(
    path.join(patchDir, PROTECT_FILE),
    ['# 受保护文件：线上已存在时不覆盖（每行一个相对路径）', ...files].join('\n'),
    'utf8'
  )
  return true
}

module.exports = {
  PROTECT_FILE,
  DEPLOY_PROTECT_FILE,
  readProtectListFromFile,
  resolveProtectFiles,
  writeProtectFile
}
