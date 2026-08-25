/**
 * PHP 后端（ThinkPHP / 通用 PHP API）增量部署配置
 *
 * 当前 v1 仅内置 php 后端；后续可扩展 node、java 等。
 */

const fs = require('fs')
const path = require('path')

/** PHP 项目默认排除路径（与 Build-BackendPatch.ps1 对齐） */
const PHP_EXCLUDE_PATTERNS = [
  /(^|\/)vendor\//,
  /(^|\/)runtime\//,
  /(^|\/)public\/uploads\//,
  /(^|\/)public\/runtime\//,
  /(^|\/)public\/cache\//,
  /(^|\/)deploy\/out\//,
  /(^|\/)tests\/coverage\//,
  /(^|\/)build\//,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)\\.git\//,
  /(^|\/)\\.svn\//,
  /(^|\/)\\.env$/,
  /(^|\/)\\.env\./,
  /Thumbs\.db$/,
  /\.DS_Store$/,
  /\.log$/
]

const COMPOSER_PATTERN = /(^|\/)composer\.(json|lock)$/

/** ThinkPHP 典型目录标记 */
const PHP_BACKEND_MARKERS = ['app', 'config', 'route']

/**
 * @param {string} pkgRoot npm 包根目录
 * @returns {string}
 */
function getApplyScriptPath (pkgRoot) {
  return path.join(pkgRoot, 'assets', 'php', 'apply-update.php')
}

/**
 * 校验源码目录是否像 PHP 后端项目
 * @param {string} sourceDir
 * @returns {{ valid: boolean, framework: 'thinkphp'|'php-generic'|null, hints: string[] }}
 */
function validatePhpBackend (sourceDir) {
  const hints = []
  const hasApp = fs.existsSync(path.join(sourceDir, 'app'))
  const hasConfig = fs.existsSync(path.join(sourceDir, 'config'))
  const hasThink = fs.existsSync(path.join(sourceDir, 'think'))
  const hasComposer = fs.existsSync(path.join(sourceDir, 'composer.json'))

  if (hasApp && (hasConfig || hasThink)) {
    return { valid: true, framework: 'thinkphp', hints }
  }

  if (hasApp) {
    hints.push('检测到 app/ 目录，按 ThinkPHP 结构处理')
    return { valid: true, framework: 'thinkphp', hints }
  }

  if (hasComposer) {
    hints.push('未检测到 app/，但存在 composer.json，按通用 PHP 项目处理')
    return { valid: true, framework: 'php-generic', hints }
  }

  const missing = PHP_BACKEND_MARKERS.filter(m => !fs.existsSync(path.join(sourceDir, m)))
  hints.push(`缺少典型 PHP 后端目录：${missing.join(', ')}`)
  hints.push('若确为 PHP 后端，请确认 --source 指向含 app/ 的项目根（如 trunk）')

  return { valid: false, framework: null, hints }
}

/**
 * @param {string} relativePath
 * @param {RegExp[]} [extraPatterns]
 */
function shouldExcludePath (relativePath, extraPatterns = []) {
  const p = relativePath.replace(/\\/g, '/')
  const patterns = [...PHP_EXCLUDE_PATTERNS, ...extraPatterns]

  for (const pat of patterns) {
    if (pat.test(p)) {
      return { excluded: true, isComposer: COMPOSER_PATTERN.test(p) }
    }
  }

  return { excluded: false, isComposer: false }
}

module.exports = {
  id: 'php',
  label: 'PHP 后端（ThinkPHP）',
  PHP_EXCLUDE_PATTERNS,
  COMPOSER_PATTERN,
  getApplyScriptPath,
  validatePhpBackend,
  shouldExcludePath,
  defaultZipPrefix: 'backend-update'
}
