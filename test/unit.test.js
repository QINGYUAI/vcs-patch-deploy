'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  filterFilesBySelection,
  sanitizeVersionLabel,
  resolveSelectedFiles
} = require('../lib/file-filter')
const { classifyDiffEntries, buildArtifactNames } = require('../lib/build-patch')
const { readDeployMarker, writeDeployMarker } = require('../lib/marker')
const { readManifestFiles } = require('../lib/manifest')
const { readVersionsRegistry, registerVersion, writeJsonAtomic } = require('../lib/version-registry')

test('filterFilesBySelection 精确匹配与目录前缀', () => {
  const all = ['app/a.php', 'app/b.php', 'config/c.php']
  const exact = filterFilesBySelection(all, ['app/a.php'])
  assert.deepEqual(exact.matched, ['app/a.php'])
  assert.deepEqual(exact.missing, [])

  const prefix = filterFilesBySelection(all, ['app/'])
  assert.deepEqual(prefix.matched, ['app/a.php', 'app/b.php'])

  const missing = filterFilesBySelection(all, ['missing.php'])
  assert.deepEqual(missing.missing, ['missing.php'])
})

test('sanitizeVersionLabel 清理非法字符', () => {
  assert.equal(sanitizeVersionLabel('v1.2.3'), '1.2.3')
  assert.equal(sanitizeVersionLabel('1.2.3-rc+1'), '1.2.3-rc_1')
})

test('resolveSelectedFiles 支持 @列表文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  const listFile = path.join(tmp, 'files.txt')
  fs.writeFileSync(listFile, 'app/a.php\n# comment\napp/b.php\n', 'utf8')

  const files = resolveSelectedFiles(['@' + listFile], null)
  assert.deepEqual(files, ['app/a.php', 'app/b.php'])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('classifyDiffEntries 排除 vendor 与删除项', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  fs.mkdirSync(path.join(tmp, 'app'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'app', 'ok.php'), 'x', 'utf8')

  const result = classifyDiffEntries([
    { action: 'M', relativePath: 'app/ok.php' },
    { action: 'M', relativePath: 'vendor/x.php' },
    { action: 'D', relativePath: 'app/old.php' },
    { action: 'M', relativePath: 'bad', parseError: 'bad line' }
  ], tmp)

  assert.deepEqual(result.addedOrModified, ['app/ok.php'])
  assert.deepEqual(result.deleted, ['app/old.php'])
  assert.equal(result.warnings.length, 1)

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('buildArtifactNames 版本号优先', () => {
  const withVersion = buildArtifactNames('svn', '467', 'backend-update', '1.2.3')
  assert.equal(withVersion.patchName, 'patch-v1.2.3')
  assert.equal(withVersion.zipName, 'backend-update-v1.2.3.zip')

  const svn = buildArtifactNames('svn', '467', 'backend-update')
  assert.equal(svn.patchName, 'patch-r467')
})

test('readDeployMarker 兼容 legacy svn rev', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  writeDeployMarker(tmp, 'svn', '430')
  const marker = readDeployMarker(tmp)
  assert.equal(marker?.vcs, 'svn')
  assert.equal(marker?.value, '430')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('readManifestFiles 解析 # files 段', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  fs.writeFileSync(path.join(tmp, 'MANIFEST.txt'), [
    '# meta',
    '# files',
    'app/a.php',
    'app/b.php',
    '',
    '# deleted'
  ].join('\n'), 'utf8')

  assert.deepEqual(readManifestFiles(tmp), ['app/a.php', 'app/b.php'])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('registerVersion 原子写入并可读取', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  registerVersion(tmp, {
    version: '1.0.0',
    versionLabel: '1.0.0',
    vcs: 'svn',
    fromLabel: '1',
    toLabel: '2',
    files: ['app/a.php'],
    deleted: [],
    patchDir: '/tmp/patch',
    createdAt: '2026-01-01T00:00:00.000Z'
  })

  const registry = readVersionsRegistry(tmp)
  assert.equal(registry.versions.length, 1)
  assert.equal(registry.versions[0].version, '1.0.0')

  writeJsonAtomic(path.join(tmp, 'sample.json'), { ok: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'sample.json'), 'utf8')), { ok: true })

  fs.rmSync(tmp, { recursive: true, force: true })
})
