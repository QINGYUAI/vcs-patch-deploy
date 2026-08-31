/**
 * CLI 公共参数解析（patch-build / patch-extract 复用）
 */

/**
 * @typedef {object} CommonCliOptions
 * @property {boolean} showHelp
 * @property {boolean} [noZip]
 * @property {string} [deployDir]
 * @property {string[]} onlyFiles
 * @property {string} [fileList]
 */

/**
 * @param {string[]} args process.argv.slice(2)
 * @param {Record<string, string>} flagMap 布尔开关，如 { noZip: '--no-zip' }
 * @param {Record<string, string>} valueMap 键值参数前缀，如 { deployDir: '--deploy=' }
 * @returns {CommonCliOptions & Record<string, unknown>}
 */
function parseCommonArgs (args, flagMap = {}, valueMap = {}) {
  /** @type {CommonCliOptions & Record<string, unknown>} */
  const opts = { showHelp: false, onlyFiles: [] }

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      opts.showHelp = true
      continue
    }

    let handled = false

    for (const [key, flag] of Object.entries(flagMap)) {
      if (arg === flag) {
        opts[key] = true
        handled = true
        break
      }
    }
    if (handled) continue

    for (const [key, prefix] of Object.entries(valueMap)) {
      if (arg.startsWith(prefix)) {
        opts[key] = arg.slice(prefix.length)
        handled = true
        break
      }
    }
    if (handled) continue

    if (arg.startsWith('--only=')) {
      opts.onlyFiles.push(...arg.slice(7).split(','))
      continue
    }

    opts.unknownArg = arg
  }

  return opts
}

module.exports = {
  parseCommonArgs
}
