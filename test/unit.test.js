'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  filterFilesBySelection,
  sanitizeVersionLabel,
  resolveSelectedFiles,
  isSafeRelativePath
} = require('../lib/file-filter')
const {
  classifyDiffEntries,
  buildArtifactNames,
  buildVersionLabels,
  buildPatch
} = require('../lib/build-patch')
const {
  readDeployMarker,
  writeDeployMarker,
  markerFileName,
  listMarkerFiles
} = require('../lib/marker')
const { readManifestFiles, readManifestDeleted } = require('../lib/manifest')
const {
  readVersionsRegistry,
  registerVersion,
  pruneWorktreeRecords,
  writeJsonAtomic
} = require('../lib/version-registry')
const {
  buildDeployVersionLabel,
  archivePatchPackage,
  readArchiveIndex
} = require('../lib/version-archive')
const { parseKeepVersions, resolveConfig } = require('../lib/config')
const { createZipFromDirectory } = require('../lib/zip')
const { pruneOutDirectory } = require('../lib/out-prune')
const { writeModesFile, readModesFile } = require('../lib/modes')
const { extractPatchSubset } = require('../lib/extract-patch')
const {
  resolveProtectFiles,
  readProtectListFromFile,
  writeProtectFile,
  PROTECT_FILE
} = require('../lib/protect')
const { parseSvnStatusXml, parseSvnPropgetXml } = require('../lib/svn')

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

test('buildVersionLabels 统一子集与工作副本标识', () => {
  const full = buildVersionLabels({ vcs: 'git', toLabel: 'abcdef1234567890', version: '1.2.3' })
  assert.equal(full.deployVersionLabel, '1.2.3')
  assert.equal(full.baseVersionLabel, '1.2.3')
  assert.equal(full.partialSuffix, '')
  assert.equal(full.artifactVersionLabel, '1.2.3')

  const revision = buildVersionLabels({ vcs: 'svn', toLabel: '467' })
  assert.equal(revision.deployVersionLabel, 'r467')
  assert.equal(revision.artifactVersionLabel, null)

  const subset = buildVersionLabels({
    vcs: 'git',
    toLabel: 'abcdef1234567890',
    version: '1.2.3',
    partialSignature: 'a1b2c3d4'
  })
  assert.equal(subset.deployVersionLabel, '1.2.3-partial-a1b2c3d4')
  assert.equal(subset.baseVersionLabel, '1.2.3')
  assert.equal(subset.artifactVersionLabel, '1.2.3-partial-a1b2c3d4')

  const subsetNoVersion = buildVersionLabels({
    vcs: 'svn',
    toLabel: '467',
    partialSignature: 'a1b2c3d4'
  })
  assert.equal(subsetNoVersion.deployVersionLabel, 'r467-partial-a1b2c3d4')

  const worktree = buildVersionLabels({
    vcs: 'svn',
    toLabel: 'working-copy',
    worktreeLabel: 'wc-20261118093000'
  })
  assert.equal(worktree.deployVersionLabel, 'wc-20261118093000')
  assert.equal(worktree.baseVersionLabel, null)
  assert.equal(worktree.artifactVersionLabel, null)

  const worktreeVersion = buildVersionLabels({
    vcs: 'svn',
    toLabel: 'working-copy',
    version: '1.2.3',
    worktreeLabel: 'wc-20261118093000'
  })
  assert.equal(worktreeVersion.deployVersionLabel, '1.2.3-wc-20261118093000')
  assert.equal(worktreeVersion.baseVersionLabel, '1.2.3')

  const worktreePartial = buildVersionLabels({
    vcs: 'svn',
    toLabel: 'working-copy',
    version: '1.2.3',
    partialSignature: 'a1b2c3d4',
    worktreeLabel: 'wc-20261118093000'
  })
  assert.equal(
    worktreePartial.deployVersionLabel,
    '1.2.3-wc-20261118093000-partial-a1b2c3d4'
  )
})

test('buildArtifactNames 版本号优先', () => {
  const withVersion = buildArtifactNames('svn', '467', 'backend-update', '1.2.3')
  assert.equal(withVersion.patchName, 'patch-v1.2.3')
  assert.equal(withVersion.zipName, 'backend-update-v1.2.3.zip')

  // 子集包必须与完整包区分，避免同名覆盖
  const partial = buildArtifactNames('svn', '467', 'backend-update', '1.2.3', 'a1b2c3d4')
  assert.equal(partial.patchName, 'patch-v1.2.3-partial-a1b2c3d4')
  assert.equal(partial.zipName, 'backend-update-v1.2.3-partial-a1b2c3d4.zip')

  const svn = buildArtifactNames('svn', '467', 'backend-update')
  assert.equal(svn.patchName, 'patch-r467')

  const partialRev = buildArtifactNames('svn', '467', 'backend-update', null, 'a1b2c3d4')
  assert.equal(partialRev.patchName, 'patch-r467-partial-a1b2c3d4')

  // 工作副本包与 revision 包区分
  const worktree = buildArtifactNames('svn', 'working-copy', 'backend-update', null, null, 'wc-20261118093000')
  assert.equal(worktree.patchName, 'patch-wc-20261118093000')
  assert.equal(worktree.zipName, 'backend-update-wc-20261118093000.zip')

  const worktreeVersion = buildArtifactNames('svn', 'working-copy', 'backend-update', '1.2.3', null, 'wc-20261118093000')
  assert.equal(worktreeVersion.patchName, 'patch-v1.2.3-wc-20261118093000')
})

test('isSafeRelativePath 拒绝绝对路径与 ../ 逃逸', () => {
  assert.equal(isSafeRelativePath('app/service/Foo.php'), true)
  assert.equal(isSafeRelativePath('app/../config/a.php'), false)
  assert.equal(isSafeRelativePath('../outside.php'), false)
  assert.equal(isSafeRelativePath('/etc/passwd'), false)
  assert.equal(isSafeRelativePath('C:/Windows/win.ini'), false)
  assert.equal(isSafeRelativePath('app/\0.php'), false)
})

test('readManifestFiles 拒绝不安全路径', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  fs.writeFileSync(path.join(tmp, 'MANIFEST.txt'), '# files\n../evil.php\n', 'utf8')

  assert.throws(() => readManifestFiles(tmp), /不安全路径/)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('php 后端排除 deploy 元数据', () => {
  const { shouldExcludePath } = require('../lib/backends/php')
  assert.equal(shouldExcludePath('deploy/versions.json').excluded, true)
  assert.equal(shouldExcludePath('deploy/.last-deploy-marker').excluded, true)
  assert.equal(shouldExcludePath('deploy/archive/r467/MANIFEST.txt').excluded, true)
  assert.equal(shouldExcludePath('.deploy-backups/v1.0.0/app/a.php').excluded, true)
  assert.equal(shouldExcludePath('app/service/Foo.php').excluded, false)
})

test('classifyDiffEntries 跳过目录条目', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  fs.mkdirSync(path.join(tmp, 'app', 'newdir'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'app', 'newdir', 'a.php'), 'x', 'utf8')

  const result = classifyDiffEntries([
    { action: 'M', relativePath: 'app/newdir' },
    { action: 'A', relativePath: 'app/newdir/a.php' }
  ], tmp)

  assert.deepEqual(result.addedOrModified, ['app/newdir/a.php'])

  fs.rmSync(tmp, { recursive: true, force: true })
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

test('validatePhpBackend 兼容 ThinkPHP 5 application/', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  fs.mkdirSync(path.join(tmp, 'application', 'admin'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'public'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'application', 'admin', 'Index.php'), '<?php', 'utf8')

  const { validatePhpBackend } = require('../lib/backends/php')
  const result = validatePhpBackend(tmp)
  assert.equal(result.valid, true)
  assert.equal(result.framework, 'thinkphp')

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('buildDeployVersionLabel 支持 semver / r467 / git', () => {
  assert.equal(buildDeployVersionLabel('svn', '467', '1.2.3'), '1.2.3')
  assert.equal(buildDeployVersionLabel('svn', '467', null), 'r467')
  assert.equal(buildDeployVersionLabel('git', 'abc123def4567890abcdef', null), 'abc123def456')
})

test('parseKeepVersions 默认与非法值回退', () => {
  assert.equal(parseKeepVersions(undefined), 10)
  assert.equal(parseKeepVersions('5'), 5)
  assert.equal(parseKeepVersions('0'), 10)
})

test('archivePatchPackage 归档并保留最近 N 个版本', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-archive-'))
  const deployDir = path.join(tmp, 'deploy')

  async function archiveRevision (rev, content) {
    const patchDir = path.join(deployDir, 'out', `patch-r${rev}`)
    fs.mkdirSync(path.join(patchDir, 'app'), { recursive: true })
    fs.writeFileSync(path.join(patchDir, 'app', 'a.php'), content, 'utf8')
    fs.writeFileSync(path.join(patchDir, 'VERSION.txt'), `version=r${rev}\n`, 'utf8')
    await archivePatchPackage({
      deployDir,
      archiveLabel: `r${rev}`,
      patchDir,
      vcs: 'svn',
      fromLabel: String(Number(rev) - 1),
      toLabel: String(rev),
      keepVersions: 2
    })
  }

  await archiveRevision('1', 'v1')
  await archiveRevision('2', 'v2')
  await archiveRevision('3', 'v3')

  const index = readArchiveIndex(deployDir)
  assert.equal(index.versions.length, 2)
  assert.equal(index.versions[0].label, 'r3')
  assert.equal(index.versions[1].label, 'r2')
  assert.ok(!fs.existsSync(path.join(deployDir, 'archive', 'r1')))

  // index.json 中保存相对 deploy 的路径，项目迁移后仍可用
  const rawIndex = JSON.parse(fs.readFileSync(path.join(deployDir, 'archive', 'index.json'), 'utf8'))
  assert.equal(rawIndex.versions[0].archiveDir, 'archive/r3')
  assert.equal(index.versions[0].archiveDir, path.join(deployDir, 'archive', 'r3'))

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('archivePatchPackage 子集与完整版本使用独立保留配额', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-archive-partial-'))
  const deployDir = path.join(tmp, 'deploy')

  async function archiveVersion (label, partial) {
    const patchDir = path.join(deployDir, 'out', `patch-${label}`)
    fs.mkdirSync(patchDir, { recursive: true })
    fs.writeFileSync(path.join(patchDir, 'VERSION.txt'), `version=${label}\n`, 'utf8')
    await archivePatchPackage({
      deployDir,
      archiveLabel: label,
      patchDir,
      vcs: 'git',
      fromLabel: 'a',
      toLabel: 'b',
      partial,
      keepVersions: 1
    })
  }

  await archiveVersion('r1', false)
  await archiveVersion('r2', false)
  await archiveVersion('r2-partial-a1', true)
  await archiveVersion('r2-partial-b2', true)

  const index = readArchiveIndex(deployDir)
  assert.deepEqual(index.versions.map(v => v.label).sort(), ['r2', 'r2-partial-b2'])
  assert.ok(!fs.existsSync(path.join(deployDir, 'archive', 'r1')))
  assert.ok(!fs.existsSync(path.join(deployDir, 'archive', 'r2-partial-a1')))

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('archivePatchPackage link 模式归档目录与 zip', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-archive-link-'))
  const deployDir = path.join(tmp, 'deploy')
  const patchDir = path.join(tmp, 'out', 'patch-r9')
  fs.mkdirSync(path.join(patchDir, 'app'), { recursive: true })
  const srcFile = path.join(patchDir, 'app', 'a.php')
  fs.writeFileSync(srcFile, 'v9', 'utf8')
  const zipPath = path.join(tmp, 'out', 'backend-update-r9.zip')
  fs.writeFileSync(zipPath, 'zip-data', 'utf8')

  const first = await archivePatchPackage({
    deployDir,
    archiveLabel: 'r9',
    patchDir,
    zipPath,
    vcs: 'svn',
    fromLabel: '8',
    toLabel: '9',
    link: true,
    keepVersions: 5
  })

  const archivedFile = path.join(first.archiveDir, 'app', 'a.php')
  assert.equal(fs.readFileSync(archivedFile, 'utf8'), 'v9')
  assert.equal(fs.readFileSync(first.zipArchivePath, 'utf8'), 'zip-data')

  // 同盘时硬链接生效（跨盘或不支持时自动退回复制）
  const srcStat = fs.statSync(srcFile)
  const dstStat = fs.statSync(archivedFile)
  if (dstStat.nlink > 1) {
    assert.equal(dstStat.ino, srcStat.ino)
  }

  // 再次归档同一版本会先清空旧内容
  fs.writeFileSync(path.join(first.archiveDir, 'stale.txt'), 'old', 'utf8')
  fs.writeFileSync(srcFile, 'v10', 'utf8')
  const second = await archivePatchPackage({
    deployDir,
    archiveLabel: 'r9',
    patchDir,
    zipPath,
    vcs: 'svn',
    fromLabel: '8',
    toLabel: '9',
    link: true,
    keepVersions: 5
  })
  assert.equal(fs.readFileSync(path.join(second.archiveDir, 'app', 'a.php'), 'utf8'), 'v10')
  assert.ok(!fs.existsSync(path.join(second.archiveDir, 'stale.txt')))

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('pruneOutDirectory 只清理本工具产物并保留当前构建', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-out-prune-'))
  const outDir = path.join(tmp, 'out')
  const now = Date.now()

  function makeDir (name, offsetMs) {
    const dir = path.join(outDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'VERSION.txt'), `version=${name}\n`, 'utf8')
    const date = new Date(now + offsetMs)
    fs.utimesSync(dir, date, date)
    return dir
  }

  function makeZip (name, offsetMs) {
    const file = path.join(outDir, name)
    fs.writeFileSync(file, 'zip', 'utf8')
    const date = new Date(now + offsetMs)
    fs.utimesSync(file, date, date)
    return file
  }

  fs.mkdirSync(outDir, { recursive: true })
  for (let i = 1; i <= 5; i++) {
    const offset = -(6 - i) * 10000
    makeDir(`patch-${i}`, offset)
    makeZip(`backend-update-r${i}.zip`, offset)
  }
  makeDir('custom-dir', -1000)
  makeZip('other-artifact.zip', -1000)
  const oldStaging = makeDir('patch-x.staging-111', -2 * 60 * 60 * 1000)
  const newStaging = makeDir('patch-y.staging-222', -60 * 1000)

  const removed = await pruneOutDirectory(outDir, {
    keep: 3,
    zipPrefix: 'backend-update',
    keepPaths: [
      path.join(outDir, 'patch-5'),
      path.join(outDir, 'backend-update-r5.zip')
    ]
  })

  assert.deepEqual(removed.sort(), [
    'backend-update-r1.zip',
    'backend-update-r2.zip',
    'patch-1',
    'patch-2',
    'patch-x.staging-111'
  ])
  assert.ok(fs.existsSync(path.join(outDir, 'patch-3')))
  assert.ok(fs.existsSync(path.join(outDir, 'patch-4')))
  assert.ok(fs.existsSync(path.join(outDir, 'patch-5')))
  assert.ok(fs.existsSync(path.join(outDir, 'backend-update-r3.zip')))
  assert.ok(fs.existsSync(path.join(outDir, 'custom-dir')))
  assert.ok(fs.existsSync(path.join(outDir, 'other-artifact.zip')))
  assert.ok(!fs.existsSync(oldStaging))
  assert.ok(fs.existsSync(newStaging))

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('git 子目录前缀映射与工作区一致性检查', (t) => {
  let exe
  try {
    exe = require('../lib/git').findGitExe()
  } catch {
    t.skip('未安装 git，跳过')
    return
  }

  const git = require('../lib/git')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-git-'))
  const repo = path.join(tmp, 'repo')
  const sub = path.join(repo, 'trunk')
  fs.mkdirSync(path.join(sub, 'app'), { recursive: true })
  fs.writeFileSync(path.join(sub, 'app', 'a.php'), 'v1', 'utf8')

  try {
    git.runGit(exe, ['init'], repo)
    git.runGit(exe, ['config', 'user.email', 'test@example.com'], repo)
    git.runGit(exe, ['config', 'user.name', 'test'], repo)
    git.runGit(exe, ['add', '.'], repo)
    git.runGit(exe, ['commit', '-m', 'v1'], repo)
    const first = git.resolveGitRef(sub, 'HEAD')

    fs.writeFileSync(path.join(sub, 'app', 'a.php'), 'v2', 'utf8')
    git.runGit(exe, ['add', '.'], repo)
    git.runGit(exe, ['commit', '-m', 'v2'], repo)
    const second = git.resolveGitRef(sub, 'HEAD')

    // sourceDir 是仓库子目录时，diff 路径应映射回子目录相对路径
    const diff = git.getGitDiffSummary({
      sourceDir: sub,
      fromRef: first,
      toRef: second,
      prefix: 'trunk'
    })
    assert.deepEqual(diff.map(e => e.relativePath), ['app/a.php'])

    // 工作区与目标 commit 一致
    assert.deepEqual(
      git.getGitContentMismatch({
        sourceDir: sub,
        toRef: second,
        files: ['app/a.php'],
        prefix: 'trunk'
      }),
      []
    )

    // 工作区存在未提交改动时应被检出
    fs.writeFileSync(path.join(sub, 'app', 'a.php'), 'v3', 'utf8')
    assert.deepEqual(
      git.getGitContentMismatch({
        sourceDir: sub,
        toRef: second,
        files: ['app/a.php'],
        prefix: 'trunk'
      }),
      ['app/a.php']
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('registerVersion 原子写入、相对路径与工作副本清理', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
  const patchDir = path.join(tmp, 'out', 'patch-1.0.0')
  const zipPath = path.join(tmp, 'out', 'patch-1.0.0.zip')

  registerVersion(tmp, {
    version: '1.0.0',
    versionLabel: '1.0.0',
    vcs: 'svn',
    fromLabel: '1',
    toLabel: '2',
    files: ['app/a.php'],
    deleted: [],
    patchDir,
    zipPath,
    createdAt: '2026-01-01T00:00:00.000Z'
  })

  const registry = readVersionsRegistry(tmp)
  assert.equal(registry.versions.length, 1)
  assert.equal(registry.versions[0].version, '1.0.0')
  // 读取时解析回绝对路径，磁盘上保存的是 deploy 相对路径
  assert.equal(registry.versions[0].patchDir, patchDir)
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'versions.json'), 'utf8'))
  assert.equal(raw.versions[0].patchDir, 'out/patch-1.0.0')
  assert.equal(raw.versions[0].zipPath, 'out/patch-1.0.0.zip')

  // 工作副本登记只保留最近 N 条，完整版本不受影响
  for (let i = 1; i <= 4; i++) {
    registerVersion(tmp, {
      version: `1.0.0-wc-2026010100000${i}`,
      versionLabel: `1.0.0-wc-2026010100000${i}`,
      vcs: 'svn',
      fromLabel: '1',
      toLabel: 'working-copy',
      files: ['app/a.php'],
      deleted: [],
      patchDir: path.join(tmp, 'out', `patch-wc-${i}`),
      partial: false,
      worktree: true,
      createdAt: `2026-01-0${i}T00:00:00.000Z`
    })
  }
  assert.equal(readVersionsRegistry(tmp).versions.length, 5)
  assert.equal(pruneWorktreeRecords(tmp, 2), 2)
  const pruned = readVersionsRegistry(tmp)
  assert.equal(pruned.versions.filter(v => v.worktree).length, 2)
  assert.equal(pruned.versions.filter(v => !v.worktree).length, 1)

  writeJsonAtomic(path.join(tmp, 'sample.json'), { ok: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'sample.json'), 'utf8')), { ok: true })

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('marker 支持 profile，且默认 profile 不误读其他环境', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-marker-'))
  try {
    writeDeployMarker(tmp, 'git', 'abc123', 'php85')
    assert.equal(readDeployMarker(tmp, 'php85')?.value, 'abc123')

    // 指定 profile 时不回退默认 marker / legacy
    assert.equal(readDeployMarker(tmp), null)
    assert.equal(readDeployMarker(tmp, 'production'), null)

    writeDeployMarker(tmp, 'git', 'def456')
    assert.equal(readDeployMarker(tmp)?.value, 'def456')
    assert.deepEqual(listMarkerFiles(tmp), ['.last-deploy-marker', '.last-deploy-marker.php85'])

    assert.equal(markerFileName('php85'), '.last-deploy-marker.php85')
    assert.throws(() => markerFileName('../evil'), /非法 profile/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveProtectFiles 合并 deploy/protect.txt 与 CLI 参数', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-protect-'))
  const deployDir = path.join(tmp, 'deploy')
  fs.mkdirSync(deployDir, { recursive: true })
  fs.writeFileSync(path.join(deployDir, 'protect.txt'), [
    '# 运行时配置不覆盖',
    'config/date_config.json',
    ''
  ].join('\n'), 'utf8')

  const files = resolveProtectFiles({
    deployDir,
    protectFiles: ['app/legacy.php,config/date_config.json'],
    envList: '',
    envFile: ''
  })

  assert.deepEqual(files, ['app/legacy.php', 'config/date_config.json'])
  assert.throws(
    () => resolveProtectFiles({ deployDir, protectFiles: ['../evil.php'], envList: '', envFile: '' }),
    /不安全路径/
  )

  const patchDir = path.join(tmp, 'patch')
  fs.mkdirSync(patchDir)
  assert.equal(writeProtectFile(patchDir, files), true)
  const content = fs.readFileSync(path.join(patchDir, PROTECT_FILE), 'utf8')
  assert.match(content, /config\/date_config\.json/)
  assert.equal(writeProtectFile(patchDir, []), false)

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('parseSvnStatusXml 映射工作副本状态并识别冲突', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path="D:/repo/trunk">
<entry path="D:/repo/trunk/app/mod.php"><wc-status props="none" item="modified" revision="10"></wc-status></entry>
<entry path="D:/repo/trunk/app/new.php"><wc-status props="none" item="unversioned"></wc-status></entry>
<entry path="D:/repo/trunk/app/gone.php"><wc-status props="none" item="missing" revision="10"></wc-status></entry>
<entry path="D:/repo/trunk/app/replaced.php"><wc-status props="none" item="replaced" revision="10"></wc-status></entry>
<entry path="D:/repo/trunk/app/ok.php"><wc-status props="none" item="normal" revision="10"></wc-status></entry>
<entry path="D:/repo/trunk/app/conflict.php"><wc-status props="none" item="conflicted" revision="10"></wc-status></entry>
</target>
</status>`

  const { entries, conflicted } = parseSvnStatusXml(xml, {
    sourceDir: 'D:/repo/trunk',
    svnRoot: 'D:/repo'
  })

  const byPath = Object.fromEntries(entries.map(e => [e.relativePath, e.action]))
  assert.deepEqual(byPath, {
    'app/mod.php': 'M',
    'app/new.php': 'A',
    'app/gone.php': 'D',
    'app/replaced.php': 'M'
  })
  assert.deepEqual(conflicted, ['app/conflict.php'])
})

test('resolveConfig 支持自定义 apply 脚本与 profile', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-config-'))
  try {
    const config = resolveConfig({
      cwd: tmp,
      sourceDir: tmp,
      vcs: 'git',
      applyScriptPath: 'custom/apply.php',
      profile: 'php85',
      protectFiles: ['config/date_config.json']
    })

    assert.equal(config.applyScriptPath, path.resolve('custom/apply.php'))
    assert.equal(config.profile, 'php85')
    assert.deepEqual(config.protectFiles, ['config/date_config.json'])
    assert.equal(config.diffWorktree, false)
    assert.throws(() => resolveConfig({ cwd: tmp, vcs: 'git', profile: '../x' }), /非法 profile/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('buildPatch 写入 PROTECT.txt、自定义 apply 脚本与 profile 基准', async (t) => {
  let exe
  try {
    exe = require('../lib/git').findGitExe()
  } catch {
    t.skip('未安装 git，跳过')
    return
  }

  const git = require('../lib/git')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-build-'))
  const repo = path.join(tmp, 'repo')
  const sub = path.join(repo, 'trunk')
  const deployDir = path.join(sub, 'deploy')
  const customApply = path.join(tmp, 'custom-apply.php')

  try {
    fs.mkdirSync(path.join(sub, 'app'), { recursive: true })
    fs.mkdirSync(path.join(sub, 'config'), { recursive: true })
    fs.mkdirSync(deployDir, { recursive: true })
    fs.writeFileSync(path.join(sub, 'app', 'a.php'), 'v1', 'utf8')
    fs.writeFileSync(path.join(sub, 'config', 'app.php'), '<?php', 'utf8')
    fs.writeFileSync(path.join(deployDir, 'protect.txt'), 'config/date_config.json\n', 'utf8')
    fs.writeFileSync(customApply, '<?php // custom apply template\n', 'utf8')

    git.runGit(exe, ['init'], repo)
    git.runGit(exe, ['config', 'user.email', 'test@example.com'], repo)
    git.runGit(exe, ['config', 'user.name', 'test'], repo)
    git.runGit(exe, ['add', '.'], repo)
    git.runGit(exe, ['commit', '-m', 'v1'], repo)
    const first = git.resolveGitRef(sub, 'HEAD')

    fs.writeFileSync(path.join(sub, 'app', 'a.php'), 'v2', 'utf8')
    fs.writeFileSync(path.join(deployDir, 'protect.txt'), 'config/date_config.json\nruntime/extra.php\n', 'utf8')
    git.runGit(exe, ['add', '.'], repo)
    git.runGit(exe, ['commit', '-m', 'v2'], repo)
    const second = git.resolveGitRef(sub, 'HEAD')

    const config = resolveConfig({
      cwd: sub,
      sourceDir: sub,
      deployDir,
      vcs: 'git',
      fromRef: first,
      toRef: second,
      profile: 'php85',
      protectFiles: ['app/legacy.php'],
      applyScriptPath: customApply,
      version: '1.0.0',
      noArchive: true,
      markDeployed: true
    })

    const result = await buildPatch(config)
    assert.equal(result.skipped, false)
    assert.equal(result.profile, 'php85')
    assert.equal(result.protectCount, 3)

    // 自定义 apply 脚本必须进入包内
    assert.equal(
      fs.readFileSync(path.join(result.patchDir, 'apply-update.php'), 'utf8'),
      '<?php // custom apply template\n'
    )

    const protectContent = fs.readFileSync(path.join(result.patchDir, 'PROTECT.txt'), 'utf8')
    assert.match(protectContent, /config\/date_config\.json/)
    assert.match(protectContent, /runtime\/extra\.php/)
    assert.match(protectContent, /app\/legacy\.php/)

    const manifest = fs.readFileSync(path.join(result.patchDir, 'MANIFEST.txt'), 'utf8')
    assert.match(manifest, /^profile=php85$/m)
    assert.match(manifest, /^protect_count=3$/m)
    assert.match(manifest, /^content_source=target-revision$/m)
    // deploy 元数据不进入补丁包
    assert.doesNotMatch(manifest, /deploy\/protect\.txt/)

    // profile 基准写入独立文件，不污染默认 marker
    assert.equal(
      fs.readFileSync(path.join(deployDir, '.last-deploy-marker.php85'), 'utf8').trim(),
      `git:${second}`
    )
    assert.equal(fs.existsSync(path.join(deployDir, '.last-deploy-marker')), false)

    // 同版本号重建（目标 commit 不同）必须给出覆盖告警
    fs.writeFileSync(path.join(sub, 'app', 'a.php'), 'v3', 'utf8')
    git.runGit(exe, ['add', '.'], repo)
    git.runGit(exe, ['commit', '-m', 'v3'], repo)
    const third = git.resolveGitRef(sub, 'HEAD')

    const rebuild = await buildPatch(resolveConfig({
      cwd: sub,
      sourceDir: sub,
      deployDir,
      vcs: 'git',
      fromRef: second,
      toRef: third,
      profile: 'php85',
      applyScriptPath: customApply,
      version: '1.0.0',
      noArchive: true
    }))
    assert.ok(
      rebuild.warnings.some(w => w.includes('将覆盖已存在的同版本产物')),
      `应提示同版本覆盖，实际: ${rebuild.warnings.join(' | ')}`
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('buildPatch 子集包写入独立版本标识与 partial 标记', async (t) => {
  let exe
  try {
    exe = require('../lib/git').findGitExe()
  } catch {
    t.skip('未安装 git，跳过')
    return
  }

  const git = require('../lib/git')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-build-partial-'))
  const repo = path.join(tmp, 'repo')
  const deployDir = path.join(tmp, 'deploy')
  const applyTemplate = path.join(tmp, 'apply.php')

  try {
    fs.mkdirSync(path.join(repo, 'app'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'app', 'a.php'), 'v1', 'utf8')
    fs.writeFileSync(path.join(repo, 'app', 'b.php'), 'v1', 'utf8')
    fs.writeFileSync(applyTemplate, '<?php // tmpl\n', 'utf8')

    git.runGit(exe, ['init'], repo)
    git.runGit(exe, ['config', 'user.email', 'test@example.com'], repo)
    git.runGit(exe, ['config', 'user.name', 'test'], repo)
    git.runGit(exe, ['add', '.'], repo)
    git.runGit(exe, ['commit', '-m', 'v1'], repo)
    const first = git.resolveGitRef(repo, 'HEAD')

    fs.writeFileSync(path.join(repo, 'app', 'a.php'), 'v2', 'utf8')
    fs.writeFileSync(path.join(repo, 'app', 'b.php'), 'v2', 'utf8')
    git.runGit(exe, ['commit', '-am', 'v2'], repo)
    const second = git.resolveGitRef(repo, 'HEAD')

    const result = await buildPatch(resolveConfig({
      cwd: repo,
      sourceDir: repo,
      deployDir,
      vcs: 'git',
      fromRef: first,
      toRef: second,
      version: '1.2.3',
      onlyFiles: ['app/a.php'],
      applyScriptPath: applyTemplate,
      noArchive: true
    }))

    assert.match(result.deployVersionLabel, /^1\.2\.3-partial-[0-9a-f]{8}$/)
    assert.equal(path.basename(result.patchDir), `patch-v${result.deployVersionLabel}`)

    const versionTxt = fs.readFileSync(path.join(result.patchDir, 'VERSION.txt'), 'utf8')
    assert.match(versionTxt, new RegExp(`^version=${result.deployVersionLabel}$`, 'm'))
    assert.match(versionTxt, /^partial=1$/m)
    assert.match(versionTxt, /^source_version=1\.2\.3$/m)

    const manifest = fs.readFileSync(path.join(result.patchDir, 'MANIFEST.txt'), 'utf8')
    assert.match(manifest, new RegExp(`^version=${result.deployVersionLabel}$`, 'm'))

    // registry 与产物使用同一版本标识，且保存相对路径
    const raw = JSON.parse(fs.readFileSync(path.join(deployDir, 'versions.json'), 'utf8'))
    assert.equal(raw.versions[0].version, result.deployVersionLabel)
    assert.equal(raw.versions[0].partial, true)
    assert.equal(raw.versions[0].patchDir, `out/patch-v${result.deployVersionLabel}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('createZipFromDirectory 失败时清理临时文件', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-zip-fail-'))
  try {
    const zipPath = path.join(tmp, 'out.zip')
    await assert.rejects(
      createZipFromDirectory(path.join(tmp, 'missing'), zipPath),
      /ENOENT|no such file/i
    )
    assert.equal(fs.existsSync(zipPath), false)
    assert.deepEqual(
      fs.readdirSync(tmp).filter(name => name.includes('.tmp')),
      []
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('CLI 未知参数直接失败', () => {
  const { spawnSync } = require('node:child_process')
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'patch-build.js'), '--unknown-flag=1'],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未知参数/)
})

test('parseSvnPropgetXml 解析 --xml 属性输出（含 " - " 路径）', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<properties>
<target path="D:/repo/trunk/app/run - tool.sh">
<property name="svn:executable">*</property>
</target>
<target path="D:/repo/trunk/app/a.php">
<property name="svn:executable">*</property>
</target>
<target path="D:/repo/trunk/app/plain.php">
</target>
</properties>`

  assert.deepEqual(
    parseSvnPropgetXml(xml, { sourceDir: 'D:/repo/trunk', svnRoot: 'D:/repo' }),
    ['app/a.php', 'app/run - tool.sh']
  )
})

test('createZipFromDirectory 保留可执行位', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-zip-'))
  try {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(path.join(src, 'app'), { recursive: true })
    fs.writeFileSync(path.join(src, 'app', 'run.sh'), '#!/bin/sh\n', 'utf8')
    fs.writeFileSync(path.join(src, 'app', 'a.php'), '<?php\n', 'utf8')

    const zipPath = path.join(tmp, 'out.zip')
    await createZipFromDirectory(src, zipPath, { modes: { 'app/run.sh': 0o755 } })

    const modes = readZipEntryModes(zipPath)
    assert.equal(modes['app/run.sh'], 0o755)
    assert.equal(modes['app/a.php'], 0o644)
    assert.equal(modes['app/'], 0o755)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('git 可执行位来自索引模式', (t) => {
  let exe
  try {
    exe = require('../lib/git').findGitExe()
  } catch {
    t.skip('未安装 git，跳过')
    return
  }

  const git = require('../lib/git')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-exec-'))
  const repo = path.join(tmp, 'repo')

  try {
    fs.mkdirSync(path.join(repo, 'app'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'app', 'run.sh'), '#!/bin/sh\n', 'utf8')
    fs.writeFileSync(path.join(repo, 'app', 'a.php'), '<?php\n', 'utf8')
    git.runGit(exe, ['init'], repo)
    git.runGit(exe, ['config', 'user.email', 'test@example.com'], repo)
    git.runGit(exe, ['config', 'user.name', 'test'], repo)
    git.runGit(exe, ['add', '.'], repo)
    git.runGit(exe, ['update-index', '--chmod=+x', 'app/run.sh'], repo)
    git.runGit(exe, ['commit', '-m', 'v1'], repo)

    assert.deepEqual(
      git.getGitExecutableFiles({ sourceDir: repo, files: ['app/run.sh', 'app/a.php'] }),
      ['app/run.sh']
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('MODES.txt 读写、子集删除清单过滤与保护清单合并', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-extract-'))
  try {
    const sourcePatch = path.join(tmp, 'source')
    fs.mkdirSync(path.join(sourcePatch, 'app'), { recursive: true })
    fs.writeFileSync(path.join(sourcePatch, 'app', 'a.php'), '<?php\n', 'utf8')
    fs.writeFileSync(path.join(sourcePatch, 'MANIFEST.txt'), [
      'backend=php',
      'vcs=git',
      'from_commit=a',
      'to_commit=b',
      '',
      '# files',
      'app/a.php',
      '',
      '# deleted (需人工确认是否删除线上文件)',
      'app/old.php',
      'other/unrelated.php'
    ].join('\n'), 'utf8')
    fs.writeFileSync(path.join(sourcePatch, 'VERSION.txt'), 'version=9.9.9\n', 'utf8')
    fs.writeFileSync(path.join(sourcePatch, 'PROTECT.txt'), 'config/keep.json\n', 'utf8')
    assert.equal(writeModesFile(sourcePatch, ['app/a.php']), true)
    assert.deepEqual(readModesFile(sourcePatch), { 'app/a.php': 0o755 })
    assert.deepEqual(readManifestDeleted(sourcePatch), ['app/old.php', 'other/unrelated.php'])

    const applyTemplate = path.join(tmp, 'apply.php')
    fs.writeFileSync(applyTemplate, '<?php // tmpl\n', 'utf8')

    const outDir = path.join(tmp, 'out')
    const result = await extractPatchSubset({
      deployDir: path.join(tmp, 'deploy'),
      outDir,
      applyScriptPath: applyTemplate,
      fromPatch: sourcePatch,
      version: '1.2.3',
      onlyFiles: ['app/'],
      protectFiles: ['config/extra.json'],
      noZip: true
    })

    const versionTxt = fs.readFileSync(path.join(result.patchDir, 'VERSION.txt'), 'utf8')
    assert.match(versionTxt, /^version=1\.2\.3-partial-\d{14}$/m)
    assert.match(versionTxt, /^source_version=1\.2\.3$/m)
    assert.match(versionTxt, /^partial=1$/m)
    assert.deepEqual(readModesFile(result.patchDir), { 'app/a.php': 0o755 })

    // 只保留与提取范围匹配的删除项
    assert.deepEqual(readManifestDeleted(result.patchDir), ['app/old.php'])
    // 源包保护清单 + 当前配置合并
    assert.deepEqual(
      readProtectListFromFile(path.join(result.patchDir, PROTECT_FILE)),
      ['config/extra.json', 'config/keep.json']
    )

    // --from-patch 未传 --version 时，沿用源包 VERSION 中的版本号
    const second = await extractPatchSubset({
      deployDir: path.join(tmp, 'deploy'),
      outDir,
      applyScriptPath: applyTemplate,
      fromPatch: sourcePatch,
      onlyFiles: ['app/a.php'],
      subsetLabel: 'srcver',
      noZip: true
    })
    assert.equal(path.basename(second.patchDir), 'patch-v9.9.9-srcver')
    const secondVersion = fs.readFileSync(path.join(second.patchDir, 'VERSION.txt'), 'utf8')
    assert.match(secondVersion, /^version=9\.9\.9-srcver$/m)
    assert.match(secondVersion, /^source_version=9\.9\.9$/m)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

/**
 * 解析 zip 中央目录，返回 name -> Unix 权限
 * @param {string} zipPath
 * @returns {Record<string, number>}
 */
function readZipEntryModes (zipPath) {
  const buf = fs.readFileSync(zipPath)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, '未找到 zip 中央目录结尾')

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  /** @type {Record<string, number>} */
  const modes = {}

  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const externalAttrs = buf.readUInt32LE(offset + 38)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    modes[name] = (externalAttrs >>> 16) & 0o777
    offset += 46 + nameLen + extraLen + commentLen
  }

  return modes
}
