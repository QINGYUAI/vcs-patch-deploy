/**
 * vcs-patch-deploy 主入口
 */

const { buildPatch } = require('./build-patch')
const { extractPatchSubset } = require('./extract-patch')
const { readManifestFiles } = require('./manifest')
const { resolveConfig, detectVcs, initDeployDir } = require('./config')
const { readDeployMarker, writeDeployMarker } = require('./marker')
const { shouldExcludePath } = require('./exclude')
const { getBackend, BACKENDS } = require('./backends')
const { registerVersion, findVersionRecord, listVersionRecords } = require('./version-registry')
const { resolveSelectedFiles, filterFilesBySelection } = require('./file-filter')
const svn = require('./svn')
const git = require('./git')
const { createZipFromDirectory } = require('./zip')
const {
  buildDeployVersionLabel,
  archivePatchPackage,
  readArchiveIndex,
  getArchiveRoot
} = require('./version-archive')

module.exports = {
  buildPatch,
  extractPatchSubset,
  readManifestFiles,
  resolveConfig,
  initDeployDir,
  detectVcs,
  readDeployMarker,
  writeDeployMarker,
  registerVersion,
  findVersionRecord,
  listVersionRecords,
  resolveSelectedFiles,
  filterFilesBySelection,
  shouldExcludePath,
  getBackend,
  BACKENDS,
  createZipFromDirectory,
  buildDeployVersionLabel,
  archivePatchPackage,
  readArchiveIndex,
  getArchiveRoot,
  svn,
  git
}
