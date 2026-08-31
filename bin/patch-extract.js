#!/usr/bin/env node

/**
 * 从已打包版本中提取指定文件，生成可单独部署的子集 patch
 */

const path = require('path')
const chalk = require('chalk')
const {
  extractPatchSubset,
  resolveConfig,
  listVersionRecords
} = require('../lib/index')

try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env') })
} catch {
  // optional
}

function showHelp () {
  console.log(`
${chalk.cyan.bold('patch-extract')} — 按版本号从完整 patch 中提取指定文件

${chalk.yellow('用法:')}
  patch-extract --version=<版本号> --only=<文件1,文件2>
  patch-extract --from-patch=<patch目录> --only=<文件> --file-list=<列表文件>

${chalk.yellow('选项:')}
  --version=<版本>      已注册版本（见 deploy/versions.json）
  --from-patch=<目录>   直接指定源 patch 目录
  --only=<路径>         要提取的文件（逗号分隔，可重复；支持 @files.txt）
  --file-list=<文件>    每行一个相对路径的列表文件
  --deploy=<目录>       deploy 目录
  --no-zip              仅生成 patch 目录
  --register            将子集包写入 versions.json
  --list-versions       列出已注册版本
  -h, --help            显示帮助

${chalk.yellow('示例:')}
  # 先打完整版本包
  patch-build --vcs=svn --version=1.2.3

  # 从 v1.2.3 中只提取部分文件单独部署
  patch-extract --version=1.2.3 --only=app/service/Foo.php,app/controller/Bar.php

  # 从列表文件提取
  patch-extract --version=1.2.3 --file-list=hotfix-files.txt
`)
}

function parseArgs () {
  const args = process.argv.slice(2)
  const opts = { showHelp: false, onlyFiles: [] }

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') opts.showHelp = true
    else if (arg === '--no-zip') opts.noZip = true
    else if (arg === '--register') opts.register = true
    else if (arg === '--list-versions') opts.listVersions = true
    else if (arg.startsWith('--version=')) opts.version = arg.split('=')[1]
    else if (arg.startsWith('--from-patch=')) opts.fromPatch = arg.split('=')[1]
    else if (arg.startsWith('--only=')) opts.onlyFiles.push(...arg.split('=')[1].split(','))
    else if (arg.startsWith('--file-list=')) opts.fileList = arg.split('=')[1]
    else if (arg.startsWith('--deploy=')) opts.deployDir = arg.split('=')[1]
    else console.warn(chalk.yellow(`未知参数: ${arg}`))
  }

  return opts
}

async function main () {
  const opts = parseArgs()
  if (opts.showHelp) {
    showHelp()
    process.exit(0)
  }

  const config = resolveConfig({
    deployDir: opts.deployDir,
    pkgRoot: path.join(__dirname, '..')
  })

  if (opts.listVersions) {
    const versions = listVersionRecords(config.deployDir)
    if (versions.length === 0) {
      console.log(chalk.yellow('暂无已注册版本（使用 patch-build --version= 打包）'))
    } else {
      console.log(chalk.cyan('已注册版本:'))
      for (const v of versions) {
        const tag = v.partial ? chalk.gray(' [子集]') : ''
        console.log(`  v${v.versionLabel}${tag}  文件:${v.files.length}  ${v.createdAt.slice(0, 19)}`)
        console.log(chalk.gray(`    patch: ${v.patchDir}`))
      }
    }
    process.exit(0)
  }

  const result = await extractPatchSubset({
    deployDir: config.deployDir,
    outDir: config.outDir,
    applyScriptPath: config.applyScriptPath,
    fromPatch: opts.fromPatch,
    version: opts.version,
    onlyFiles: opts.onlyFiles,
    fileList: opts.fileList || null,
    noZip: opts.noZip,
    zipPrefix: config.zipPrefix,
    registerSubset: Boolean(opts.register)
  })

  console.log(chalk.green(result.message))
  console.log(chalk.green(`  源 patch: ${result.sourcePatchDir}`))
  console.log(chalk.green(`  提取文件: ${result.fileCount}`))
  console.log(chalk.green(`  patch 目录: ${result.patchDir}`))
  if (result.zipPath) {
    console.log(chalk.green(`  zip: ${result.zipPath} (${result.zipSize} bytes)`))
  }

  console.log(chalk.cyan('\n下一步: 上传 zip → 解压 → php apply-update.php <Backend根目录>'))
  process.exit(0)
}

main().catch(error => {
  console.error(chalk.red(`错误: ${error.message}`))
  process.exit(1)
})
