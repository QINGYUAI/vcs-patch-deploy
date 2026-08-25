/**
 * vcs-patch-deploy 主入口
 */

const { buildPatch } = require('./build-patch')
const { resolveConfig, detectVcs, initDeployDir } = require('./config')
const { readDeployMarker, writeDeployMarker } = require('./marker')
const { shouldExcludePath } = require('./exclude')
const { getBackend, BACKENDS } = require('./backends')
const svn = require('./svn')
const git = require('./git')
const { createZipFromDirectory } = require('./zip')

module.exports = {
  buildPatch,
  resolveConfig,
  initDeployDir,
  detectVcs,
  readDeployMarker,
  writeDeployMarker,
  shouldExcludePath,
  getBackend,
  BACKENDS,
  createZipFromDirectory,
  svn,
  git
}
