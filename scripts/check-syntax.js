#!/usr/bin/env node

/**
 * 轻量语法门禁：对 bin/lib/test/scripts 下所有 JS 执行 node --check
 * 不引入 ESLint/TypeScript 依赖，主要用于尽早拦截语法错误与无效脚本。
 */

'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const TARGETS = ['bin', 'lib', 'test', 'scripts']
const files = []

/**
 * @param {string} dir
 */
function collect (dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(abs)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(abs)
    }
  }
}

for (const target of TARGETS) {
  collect(path.join(ROOT, target))
}
files.sort()

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    failed++
    process.stderr.write(`语法错误: ${path.relative(ROOT, file)}\n`)
    if (result.stderr) process.stderr.write(result.stderr)
  }
}

if (failed > 0) {
  console.error(`语法检查失败: ${failed}/${files.length} 个文件`)
  process.exit(1)
}

console.log(`语法检查通过: ${files.length} 个文件`)
