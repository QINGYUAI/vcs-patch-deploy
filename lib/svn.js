/**
 * SVN 命令封装
 */

const { execFileSync, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * 查找 svn 可执行文件
 * @returns {string}
 */
function findSvnExe () {
  if (process.env.SVN_EXE && fs.existsSync(process.env.SVN_EXE)) {
    return process.env.SVN_EXE
  }

  try {
    const which = process.platform === 'win32' ? 'where' : 'command -v'
    const result = execSync(`${which} svn`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const first = result.split(/\r?\n/).find(Boolean)
    if (first) return first.trim()
  } catch {
    // ignore
  }

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
      'C:\\Program Files\\SlikSvn\\bin\\svn.exe',
      'C:\\Program Files\\VisualSVN Server\\bin\\svn.exe'
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
  }

  throw new Error('未找到 svn 可执行文件，请安装 TortoiseSVN/SlikSVN 并加入 PATH，或设置环境变量 SVN_EXE')
}

/**
 * @param {string} svnExe
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function runSvn (svnExe, args, cwd) {
  try {
    return execFileSync(svnExe, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : ''
    const stdout = error.stdout ? error.stdout.toString() : ''
    throw new Error([stdout, stderr, error.message].filter(Boolean).join('\n'))
  }
}

/**
 * @param {string} sourceDir SVN 源码目录（如 trunk）
 * @returns {{ revision: number, wcRoot: string }}
 */
function getSvnInfo (sourceDir, svnExe = findSvnExe()) {
  const output = runSvn(svnExe, ['info', sourceDir], sourceDir)
  const revMatch = output.match(/^Revision:\s*(\d+)/m)
  const wcMatch = output.match(/^Working Copy Root Path:\s*(.+)$/m)

  if (!revMatch) {
    throw new Error(`无法读取 SVN revision：${sourceDir}`)
  }

  return {
    revision: parseInt(revMatch[1], 10),
    wcRoot: wcMatch ? wcMatch[1].trim() : sourceDir
  }
}

/**
 * 解析 svn diff --summarize 输出中的相对路径
 * @param {string} rawPath
 * @param {string} sourceDir
 * @param {string} svnRoot
 */
function normalizeRelativePath (rawPath, sourceDir, svnRoot) {
  const trunkNorm = path.resolve(sourceDir).replace(/\\/g, '/').replace(/\/$/, '')
  const svnNorm = path.resolve(svnRoot).replace(/\\/g, '/').replace(/\/$/, '')
  let normalized = rawPath.trim().replace(/\\/g, '/').replace(/\/$/, '')

  if (normalized.toLowerCase().startsWith(trunkNorm.toLowerCase())) {
    return normalized.slice(trunkNorm.length).replace(/^\//, '')
  }

  if (normalized.toLowerCase().startsWith(svnNorm.toLowerCase())) {
    const rest = normalized.slice(svnNorm.length).replace(/^\//, '')
    const trunkMatch = rest.match(/^trunk\/(.+)$/)
    return trunkMatch ? trunkMatch[1] : rest
  }

  const trunkMatch = normalized.match(/^trunk\/(.+)$/)
  if (trunkMatch) return trunkMatch[1]

  // svn 对相对目标会输出相对路径（如 "app/x.php"），直接使用
  if (!path.isAbsolute(rawPath)) {
    return normalized
  }

  throw new Error(`无法解析 SVN 路径：${rawPath}`)
}

/**
 * @typedef {{ action: 'A'|'M'|'D', relativePath: string }} DiffEntry
 */

/**
 * 解析 `svn diff --summarize` 输出
 * @param {string} output
 * @param {string} sourceDir
 * @param {string} svnRoot
 * @returns {Array<DiffEntry & { parseError?: string }>}
 */
function parseSummarizeOutput (output, sourceDir, svnRoot) {
  /** @type {Array<DiffEntry & { parseError?: string }>} */
  const entries = []

  for (const line of output.split(/\r?\n/)) {
    // svn diff --summarize 的状态包含 A/M/D/R（R = 替换）
    const match = line.match(/^\s*([AMDR])\s+(.+)$/)
    if (!match) continue

    const action = match[1] === 'R' ? 'M' : match[1]

    try {
      entries.push({
        action: /** @type {'A'|'M'|'D'} */ (action),
        relativePath: normalizeRelativePath(match[2], sourceDir, svnRoot)
      })
    } catch (error) {
      entries.push({
        action: /** @type {'A'|'M'|'D'} */ (action),
        relativePath: match[2],
        parseError: error.message
      })
    }
  }

  return entries
}

/**
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {number} options.fromRev
 * @param {number} options.toRev
 * @param {string} [options.svnExe]
 * @returns {DiffEntry[]}
 */
function getSvnDiffSummary ({ sourceDir, fromRev, toRev, svnExe = findSvnExe() }) {
  const svnRoot = path.dirname(sourceDir) // 常见 layout: repo-root/trunk
  const output = runSvn(
    svnExe,
    ['diff', '-r', `${fromRev}:${toRev}`, '--summarize', sourceDir],
    svnRoot
  )

  return parseSummarizeOutput(output, sourceDir, svnRoot)
}

/**
 * 工作副本 vs 指定 revision 的差异（单 revision 形式，包含未提交改动）
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {number} options.rev
 * @param {string} [options.svnExe]
 * @returns {Array<DiffEntry & { parseError?: string }>}
 */
function getSvnDiffVsRevision ({ sourceDir, rev, svnExe = findSvnExe() }) {
  const svnRoot = path.dirname(sourceDir)
  const output = runSvn(
    svnExe,
    ['diff', '-r', String(rev), '--summarize', sourceDir],
    svnRoot
  )

  return parseSummarizeOutput(output, sourceDir, svnRoot)
}

/**
 * XML 属性值反转义（svn status --xml）
 * @param {string} value
 */
function decodeXmlAttr (value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * @param {string} attrs
 * @param {string} name
 */
function readXmlAttr (attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
  return match ? decodeXmlAttr(match[1]) : null
}

/**
 * 解析 `svn status --xml`（纯函数，便于测试）
 *
 * item: modified / added / deleted / replaced / missing / unversioned / conflicted / ...
 * @param {string} xml
 * @param {{ sourceDir: string, svnRoot: string }} paths
 * @returns {{ entries: Array<DiffEntry & { parseError?: string }>, conflicted: string[] }}
 */
function parseSvnStatusXml (xml, { sourceDir, svnRoot }) {
  /** @type {Array<DiffEntry & { parseError?: string }>} */
  const entries = []
  /** @type {string[]} */
  const conflicted = []

  const entryRe = /<entry\s+path="([^"]*)"[^>]*>([\s\S]*?)<\/entry>/g
  let match

  while ((match = entryRe.exec(xml)) !== null) {
    const rawPath = decodeXmlAttr(match[1])
    const body = match[2]
    const statusMatch = body.match(/<wc-status\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wc-status>)/)
    if (!statusMatch) continue

    const attrs = statusMatch[1]
    const item = readXmlAttr(attrs, 'item') || 'none'
    const treeConflicted = readXmlAttr(attrs, 'tree-conflicted') === 'true'

    let rel
    try {
      rel = normalizeRelativePath(rawPath, sourceDir, svnRoot)
    } catch (error) {
      entries.push({ action: 'M', relativePath: rawPath, parseError: error.message })
      continue
    }

    if (item === 'conflicted' || treeConflicted) {
      conflicted.push(rel)
      continue
    }

    /** @type {'A'|'M'|'D'|null} */
    let action = null
    if (item === 'modified' || item === 'replaced') action = 'M'
    else if (item === 'added') action = 'A'
    else if (item === 'deleted' || item === 'missing') action = 'D'
    else if (item === 'unversioned') action = 'A'
    else if (item === 'obstructed' || item === 'incomplete') {
      entries.push({
        action: 'M',
        relativePath: rel,
        parseError: `SVN 状态异常（${item}）: ${rel}`
      })
      continue
    }

    if (action) {
      entries.push({ action, relativePath: rel })
    }
  }

  return { entries, conflicted }
}

/**
 * 解析 `svn propget -R --xml` 的输出，返回设置了属性的路径（sourceDir 相对）
 * @param {string} xml
 * @param {{ sourceDir: string, svnRoot: string }} paths
 * @returns {string[]}
 */
function parseSvnPropgetXml (xml, { sourceDir, svnRoot }) {
  /** @type {Set<string>} */
  const executable = new Set()
  const targetRe = /<target\s+path="([^"]*)"[^>]*>([\s\S]*?)<\/target>/g
  let match

  while ((match = targetRe.exec(xml)) !== null) {
    const rawPath = decodeXmlAttr(match[1])
    const body = match[2]
    if (!/<property\b/.test(body)) continue

    try {
      const rel = normalizeRelativePath(rawPath, sourceDir, svnRoot).replace(/\\/g, '/')
      executable.add(rel)
    } catch {
      // 无法解析的路径忽略
    }
  }

  return [...executable].sort()
}

/**
 * 读取待打包文件中设置了 svn:executable 属性的路径
 *
 * Windows 上 fs.stat 不体现执行位；SVN 属性是跨平台的可靠来源。
 *
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {string[]} options.files sourceDir 相对路径
 * @param {string} [options.svnExe]
 * @returns {string[]}
 */
function getSvnExecutableFiles ({ sourceDir, files, svnExe = findSvnExe() }) {
  if (!files || files.length === 0) {
    return []
  }

  const svnRoot = path.dirname(sourceDir)
  let output
  try {
    // 在 sourceDir 内执行并传 "."：输出路径相对 sourceDir，可直接用于匹配。
    // 使用 --xml 避免路径中含 " - " 时被普通文本输出误拆。
    output = runSvn(svnExe, ['propget', '-R', '--xml', 'svn:executable', '.'], sourceDir)
  } catch (error) {
    // 旧版 svn 在属性不存在时的报错不阻断打包；其余错误交给上层告警
    if (/W200017|property.*not found|属性.*不存在/i.test(error.message)) {
      return []
    }
    throw error
  }

  const wanted = new Set(files.map(f => f.replace(/\\/g, '/')))
  return parseSvnPropgetXml(output, { sourceDir, svnRoot }).filter(rel => wanted.has(rel))
}

/**
 * 递归列出未纳入版本控制的目录内容（svn status 只列出目录本身）
 *
 * @param {string} dirAbs
 * @param {string} relBase
 * @param {object} [options]
 * @param {(rel: string) => boolean} [options.shouldSkip] 排除规则（目录会带尾部 /）
 * @param {number} [options.maxFiles] 文件数上限，防止误扫 node_modules 等大目录
 * @returns {string[]}
 */
function expandUnversionedDir (dirAbs, relBase, options = {}) {
  const shouldSkip = options.shouldSkip || (() => false)
  const maxFiles = options.maxFiles ?? 20000
  /** @type {string[]} */
  const files = []
  const stack = [[dirAbs, relBase]]

  while (stack.length > 0) {
    const [abs, rel] = stack.pop()
    let names
    try {
      names = fs.readdirSync(abs)
    } catch {
      continue
    }

    for (const name of names) {
      if (name === '.svn') continue
      const childAbs = path.join(abs, name)
      const childRel = rel ? `${rel}/${name}` : name

      let stat
      try {
        stat = fs.lstatSync(childAbs)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue

      if (stat.isDirectory()) {
        if (!shouldSkip(`${childRel}/`)) {
          stack.push([childAbs, childRel])
        }
        continue
      }

      if (stat.isFile()) {
        if (shouldSkip(childRel)) continue
        if (files.length >= maxFiles) {
          throw new Error(
            `未纳入版本控制的目录文件过多（>${maxFiles}）: ${relBase}\n` +
            '请将大目录（node_modules、runtime、deploy/out 等）加入忽略规则，或先提交/排除后再打包'
          )
        }
        files.push(childRel)
      }
    }
  }

  return files
}

/**
 * 工作副本本地改动（svn status）：新增/修改/删除/未纳入版本控制的文件
 *
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {string} [options.svnExe]
 * @param {(rel: string) => boolean} [options.shouldSkip]
 * @param {number} [options.maxFiles]
 * @returns {Array<DiffEntry & { parseError?: string }>}
 */
function getSvnStatusEntries ({ sourceDir, svnExe = findSvnExe(), shouldSkip, maxFiles }) {
  const svnRoot = path.dirname(sourceDir)
  const output = runSvn(
    svnExe,
    ['status', '--xml', '--ignore-externals', sourceDir],
    svnRoot
  )

  const { entries, conflicted } = parseSvnStatusXml(output, { sourceDir, svnRoot })

  if (conflicted.length > 0) {
    throw new Error(
      `工作副本存在未解决冲突，请先 svn resolve 后再打包：\n  - ${conflicted.join('\n  - ')}`
    )
  }

  // 未纳入版本控制的目录：展开为具体文件（否则会漏掉整个新增目录）
  /** @type {Array<DiffEntry & { parseError?: string }>} */
  const expanded = []
  for (const entry of entries) {
    if (entry.parseError || entry.action !== 'A') {
      expanded.push(entry)
      continue
    }

    const abs = path.join(sourceDir, entry.relativePath.split('/').join(path.sep))
    let stat = null
    try {
      stat = fs.lstatSync(abs)
    } catch {
      // 已删除的 A 条目等，交给后续打包阶段提示
    }

    if (stat && stat.isDirectory()) {
      const expandedFiles = expandUnversionedDir(abs, entry.relativePath, { shouldSkip, maxFiles })
      for (const rel of expandedFiles) {
        expanded.push({ action: 'A', relativePath: rel })
      }
    } else {
      expanded.push(entry)
    }
  }

  return expanded
}

/**
 * 工作副本增量：`svn diff -r <fromRev>`（含已提交与本地改动）∪ `svn status`（含未纳入版本控制的文件）
 *
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {number} options.fromRev 上次上线基准 revision
 * @param {string} [options.svnExe]
 * @param {(rel: string) => boolean} [options.shouldSkip] 扫描未纳入版本控制目录时的排除规则
 * @param {number} [options.maxFiles]
 * @returns {DiffEntry[]}
 */
function getSvnWorktreeDiffEntries ({ sourceDir, fromRev, svnExe = findSvnExe(), shouldSkip, maxFiles }) {
  /** @type {Map<string, 'A'|'M'|'D'>} */
  const merged = new Map()

  /** @param {Array<DiffEntry & { parseError?: string }>} entries */
  const absorb = (entries) => {
    for (const entry of entries) {
      if (entry.parseError) continue
      const rel = entry.relativePath.replace(/\\/g, '/')
      const prev = merged.get(rel)
      if (entry.action === 'D' || prev === 'D') {
        merged.set(rel, 'D')
      } else if (prev === 'A' || entry.action === 'A') {
        merged.set(rel, 'A')
      } else {
        merged.set(rel, 'M')
      }
    }
  }

  absorb(getSvnDiffVsRevision({ sourceDir, rev: fromRev, svnExe }))
  absorb(getSvnStatusEntries({ sourceDir, svnExe, shouldSkip, maxFiles }))

  return [...merged.entries()]
    .map(([relativePath, action]) => ({ action, relativePath }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}


/**
 * 检查工作副本内容是否与目标 revision 一致
 *
 * 用 `svn diff -r <toRev>` 将工作副本与目标版本对比（单 revision 形式），
 * 能覆盖“未 update 到 toRev”“混合版本”“本地未提交改动”三种情况。
 *
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {number} options.toRev
 * @param {string[]} options.files 待打包的 sourceDir 相对路径
 * @param {string} [options.svnExe]
 * @returns {string[]} 内容不一致的文件（sourceDir 相对路径）
 */
function getSvnContentMismatch ({ sourceDir, toRev, files, svnExe = findSvnExe() }) {
  if (!files || files.length === 0) {
    return []
  }

  const svnRoot = path.dirname(sourceDir)
  const output = runSvn(
    svnExe,
    ['diff', '-r', String(toRev), '--summarize', sourceDir],
    svnRoot
  )

  const wanted = new Set(files)
  /** @type {Set<string>} */
  const mismatched = new Set()

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([AMDR])\s+(.+)$/)
    if (!match) continue

    try {
      const rel = normalizeRelativePath(match[2], sourceDir, svnRoot).replace(/\\/g, '/')
      if (wanted.has(rel)) {
        mismatched.add(rel)
      }
    } catch {
      // 无法解析的路径不参与比对；真正打包时会再校验
    }
  }

  return [...mismatched].sort()
}

/**
 * 读取上次上线 revision
 * @param {string} lastRevFile
 * @returns {number|null}
 */
function readLastDeployRev (lastRevFile) {
  if (!fs.existsSync(lastRevFile)) return null
  const content = fs.readFileSync(lastRevFile, 'utf8')
  const line = content.split(/\r?\n/).find(l => /^\s*\d+\s*$/.test(l))
  return line ? parseInt(line.trim(), 10) : null
}

/**
 * @param {string} lastRevFile
 * @param {number} rev
 */
function writeLastDeployRev (lastRevFile, rev) {
  fs.mkdirSync(path.dirname(lastRevFile), { recursive: true })
  fs.writeFileSync(lastRevFile, String(rev), 'utf8')
}

module.exports = {
  findSvnExe,
  runSvn,
  getSvnInfo,
  normalizeRelativePath,
  parseSummarizeOutput,
  getSvnDiffSummary,
  getSvnDiffVsRevision,
  parseSvnStatusXml,
  getSvnStatusEntries,
  parseSvnPropgetXml,
  getSvnWorktreeDiffEntries,
  getSvnExecutableFiles,
  getSvnContentMismatch,
  readLastDeployRev,
  writeLastDeployRev
}
