/**
 * 路径排除 — 委托给当前后端配置（默认 PHP）
 */

const { getBackend } = require('./backends')

/**
 * @param {string} relativePath
 * @param {RegExp[]} [extraPatterns]
 * @param {string} [backendId]
 */
function shouldExcludePath (relativePath, extraPatterns = [], backendId = 'php') {
  return getBackend(backendId).shouldExcludePath(relativePath, extraPatterns)
}

module.exports = {
  shouldExcludePath
}
