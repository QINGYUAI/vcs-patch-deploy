/**
 * vcs-patch-deploy 主入口
 */

const { buildPatch, buildVersionLabels } = require('./build-patch')
const { extractPatchSubset } = require('./extract-patch')
const { readManifestFiles, readManifestDeleted } = require('./manifest')
const { resolveConfig, detectVcs, initDeployDir } = require('./config')
const { readDeployMarker, writeDeployMarker } = require('./marker')
const { shouldExcludePath } = require('./exclude')
const { resolveProtectFiles, readProtectListFromFile, PROTECT_FILE } = require('./protect')
const { MODES_FILE, readModesFile, writeModesFile } = require('./modes')
const { getBackend, BACKENDS } = require('./backends')
const {
  registerVersion,
  pruneWorktreeRecords,
  findVersionRecord,
  listVersionRecords
} = require('./version-registry')
const { resolveSelectedFiles, filterFilesBySelection, isSafeRelativePath } = require('./file-filter')
const svn = require('./svn')
const git = require('./git')
const { createZipFromDirectory } = require('./zip')
const { pruneOutDirectory } = require('./out-prune')
const {
  buildDeployVersionLabel,
  archivePatchPackage,
  readArchiveIndex,
  getArchiveRoot
} = require('./version-archive')

module.exports = {
  buildPatch,
  buildVersionLabels,
  extractPatchSubset,
  readManifestFiles,
  readManifestDeleted,
  resolveConfig,
  initDeployDir,
  detectVcs,
  readDeployMarker,
  writeDeployMarker,
  registerVersion,
  pruneWorktreeRecords,
  findVersionRecord,
  listVersionRecords,
  resolveSelectedFiles,
  filterFilesBySelection,
  isSafeRelativePath,
  shouldExcludePath,
  resolveProtectFiles,
  readProtectListFromFile,
  PROTECT_FILE,
  MODES_FILE,
  readModesFile,
  writeModesFile,
  getBackend,
  BACKENDS,
  createZipFromDirectory,
  pruneOutDirectory,
  buildDeployVersionLabel,
  archivePatchPackage,
  readArchiveIndex,
  getArchiveRoot,
  svn,
  git
}
