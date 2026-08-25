/**
 * 后端类型注册表 — v1 仅支持 PHP
 */

const php = require('./php')

/** @type {Record<string, typeof php>} */
const BACKENDS = {
  php
}

/**
 * @param {string} [backendId]
 * @returns {typeof php}
 */
function getBackend (backendId = 'php') {
  const id = (backendId || 'php').toLowerCase()
  const backend = BACKENDS[id]
  if (!backend) {
    const supported = Object.keys(BACKENDS).join(', ')
    throw new Error(`不支持的后端类型「${backendId}」，当前支持: ${supported}`)
  }
  return backend
}

module.exports = {
  BACKENDS,
  getBackend
}
