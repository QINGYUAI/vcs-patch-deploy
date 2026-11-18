#!/usr/bin/env node

/**
 * PHP 后端增量部署包 CLI — SVN / Git 差异打包，附带 apply-update.php
 */

const path = require('path')
const chalk = require('chalk')
const { buildPatch, resolveConfig, initDeployDir, detectVcs } = require('../lib/index')

try {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env') })
} catch {
  // optional
}

function showHelp () {
  console.log(`
${chalk.cyan.bold('vcs-patch-deploy')} — PHP 后端增量部署 zip 打包工具

${chalk.yellow('用法:')}
  patch-build [选项]

${chalk.yellow('选项:')}
  --backend=php         后端类型（v1 仅支持 php，默认 php）
  --vcs=svn|git         版本控制系统（默认自动检测）
  --source=<目录>       PHP 项目根（SVN 常为 trunk，Git 为仓库根）
  --deploy=<目录>       deploy 配置目录（默认 <source>/deploy）
  --from=<ref>          起始基准（SVN revision / Git commit，不含）
  --to=<ref>            结束目标（默认 HEAD / 当前 revision）
  --no-zip              仅生成 patch 目录
  --mark-deployed       更新 deploy/.last-deploy-marker
  --init                初始化 deploy 目录结构
  --skip-validation     跳过 PHP 项目结构校验
  --zip-prefix=<前缀>   zip 前缀（默认 backend-update）
  --version=<版本号>    安装版本号（如 1.2.3，写入 VERSION.txt 与 versions.json）
  --only=<文件>         仅打包指定文件（逗号分隔，可重复；支持 @files.txt）
  --file-list=<文件>    文件列表（每行一个相对路径）
  --from-worktree       允许用工作区内容打包（跳过与目标版本的一致性检查）
  --worktree-diff       SVN：直接打包工作副本改动（对比基准 revision，含未提交文件）
  --apply-script=<文件> 使用自定义 apply-update.php 模板
  --profile=<名称>      多环境基准（deploy/.last-deploy-marker.<名称>）
  --protect=<路径>      受保护文件（逗号分隔，可重复；线上已存在则跳过覆盖）
  --protect-file=<文件> 受保护文件列表（每行一个相对路径）
  --no-archive          跳过本地版本归档（deploy/archive/）
  --keep-versions=<N>   本地 archive 保留版本数（默认 10）
  --prune-out           构建后清理 deploy/out 旧产物（patch-* / zip）
  --keep-out=<N>        deploy/out 保留数量（默认同 --keep-versions）
  --link-archive        archive 优先硬链接（同一磁盘可节省约一半空间）
  -h, --help            显示帮助

${chalk.yellow('环境变量:')}
  PATCH_BACKEND=php     后端类型
  PATCH_VCS             svn | git
  PATCH_SOURCE_DIR      源码根
  PATCH_DEPLOY_DIR      deploy 目录
  PATCH_ZIP_PREFIX      zip 前缀
  PATCH_VERSION         安装版本号
  PATCH_FILE_LIST       仅打包的文件列表路径
  PATCH_FROM_WORKTREE   true 时允许用工作区内容打包
  PATCH_DIFF_WORKTREE   true 时打包 SVN 工作副本改动
  PATCH_APPLY_SCRIPT    自定义 apply-update.php 路径
  PATCH_PROFILE         多环境基准名称
  PATCH_PROTECT         受保护文件（逗号分隔）
  PATCH_PROTECT_FILE    受保护文件列表路径
  PATCH_NO_ARCHIVE      true 时跳过本地 archive
  PATCH_KEEP_VERSIONS   本地 archive 保留版本数（默认 10）
  PATCH_PRUNE_OUT       true 时构建后清理 deploy/out 旧产物
  PATCH_KEEP_OUT        deploy/out 保留数量（默认同 PATCH_KEEP_VERSIONS）
  PATCH_ARCHIVE_LINK    true 时 archive 优先硬链接

${chalk.yellow('版本号 + 单独文件部署:')}
  patch-build --vcs=svn --version=1.2.3
  patch-build --vcs=svn --version=1.2.3 --only=app/service/Foo.php
  patch-extract --version=1.2.3 --only=app/service/Foo.php,app/controller/Bar.php
  patch-extract --list-versions

${chalk.yellow('ThinkPHP + SVN:')}
  cd /path/to/your-php-api
  patch-build --vcs=svn

${chalk.yellow('ThinkPHP + Git:')}
  cd /path/to/your-php-api
  patch-build --vcs=git --from=<commit> --to=HEAD

${chalk.yellow('服务器应用:')}
  php apply-update.php --check /path/to/backend
  php apply-update.php /path/to/backend
  # 或: PATCH_BACKEND_ROOT=/path/to/backend php apply-update.php
`)
}

function parseArgs () {
  const args = process.argv.slice(2)
  const opts = { showHelp: false, onlyFiles: [], protectFiles: [] }

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') opts.showHelp = true
    else if (arg === '--no-zip') opts.noZip = true
    else if (arg === '--mark-deployed') opts.markDeployed = true
    else if (arg === '--init') opts.init = true
    else if (arg === '--skip-validation') opts.skipValidation = true
    else if (arg.startsWith('--backend=')) opts.backend = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--vcs=')) opts.vcs = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--source=')) opts.sourceDir = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--deploy=')) opts.deployDir = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--from=')) opts.fromRef = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--to=')) opts.toRef = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--zip-prefix=')) opts.zipPrefix = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--version=')) opts.version = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--only=')) opts.onlyFiles.push(...arg.slice(arg.indexOf('=') + 1).split(','))
    else if (arg.startsWith('--file-list=')) opts.fileList = arg.slice(arg.indexOf('=') + 1)
    else if (arg === '--from-worktree') opts.fromWorktree = true
    else if (arg === '--worktree-diff') opts.diffWorktree = true
    else if (arg.startsWith('--apply-script=')) opts.applyScriptPath = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--profile=')) opts.profile = arg.slice(arg.indexOf('=') + 1)
    else if (arg.startsWith('--protect=')) opts.protectFiles.push(...arg.slice(arg.indexOf('=') + 1).split(','))
    else if (arg.startsWith('--protect-file=')) opts.protectFile = arg.slice(arg.indexOf('=') + 1)
    else if (arg === '--no-archive') opts.noArchive = true
    else if (arg.startsWith('--keep-versions=')) opts.keepVersions = arg.slice(arg.indexOf('=') + 1)
    else if (arg === '--prune-out') opts.pruneOut = true
    else if (arg.startsWith('--keep-out=')) opts.keepOut = arg.slice(arg.indexOf('=') + 1)
    else if (arg === '--link-archive') opts.archiveLink = true
    else {
      throw new Error(
        `未知参数: ${arg}\n参数需使用 --name=value 形式（如 --source=./trunk）；可用 --help 查看全部参数`
      )
    }
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
    backend: opts.backend,
    vcs: opts.vcs,
    sourceDir: opts.sourceDir,
    deployDir: opts.deployDir,
    fromRef: opts.fromRef ?? null,
    toRef: opts.toRef ?? null,
    noZip: opts.noZip,
    markDeployed: opts.markDeployed,
    skipValidation: opts.skipValidation,
    zipPrefix: opts.zipPrefix,
    version: opts.version,
    onlyFiles: opts.onlyFiles,
    fileList: opts.fileList,
    fromWorktree: opts.fromWorktree,
    diffWorktree: opts.diffWorktree,
    applyScriptPath: opts.applyScriptPath || undefined,
    profile: opts.profile,
    protectFiles: opts.protectFiles,
    protectFile: opts.protectFile,
    noArchive: opts.noArchive,
    keepVersions: opts.keepVersions,
    pruneOut: opts.pruneOut,
    keepOut: opts.keepOut,
    archiveLink: opts.archiveLink,
    pkgRoot: path.join(__dirname, '..')
  })

  if (opts.init) {
    initDeployDir(config.deployDir, config.vcs)
    console.log(chalk.green(`已初始化 deploy 目录: ${config.deployDir}`))
    if (!opts.fromRef && !opts.toRef && !opts.markDeployed) {
      process.exit(0)
    }
  }

  console.log(chalk.cyan(`后端: ${config.backend}  VCS: ${config.vcs}`))
  if (config.profile) {
    console.log(chalk.cyan(`环境 profile: ${config.profile}（基准 deploy/.last-deploy-marker.${config.profile}）`))
  }
  console.log(chalk.gray(`源码: ${config.sourceDir}`))
  console.log(chalk.gray(`apply 模板: ${config.applyScriptPath}`))
  console.log(chalk.gray(`deploy: ${config.deployDir}`))

  const result = await buildPatch(config)

  if (result.skipped) {
    console.log(chalk.yellow(result.message))
  } else {
    console.log(chalk.green(result.message))
    console.log(chalk.green(`  变更文件: ${result.fileCount}  删除: ${result.deletedCount}`))
    if (result.patchDir) console.log(chalk.green(`  patch 目录: ${result.patchDir}`))
    if (result.zipPath) console.log(chalk.green(`  zip: ${result.zipPath} (${result.zipSize} bytes)`))
    if (result.archiveDir) console.log(chalk.green(`  归档: ${result.archiveDir}`))
    if (result.prunedOut?.length) {
      console.log(chalk.gray(`  已清理 out: ${result.prunedOut.length} 个旧产物`))
    }
    if (result.protectCount) {
      console.log(chalk.gray(`  受保护文件: ${result.protectCount} 个（线上已存在则跳过覆盖）`))
    }
    if (result.deployVersionLabel) {
      console.log(chalk.gray(`  部署版本标识: ${result.deployVersionLabel}`))
    }
  }

  if (result.warnings?.length) {
    console.log(chalk.yellow('\n警告:'))
    result.warnings.forEach(w => console.log(chalk.yellow(`  - ${w}`)))
  }

  if (result.markDeployedHint) {
    console.log(chalk.cyan('\n上线成功后更新基准:'))
    console.log(chalk.cyan(`  ${result.markDeployedHint}`))
  }

  if (!result.skipped && !opts.markDeployed) {
    console.log(chalk.cyan('\n下一步: 上传 zip → 解压 → php apply-update.php <Backend根目录>'))
    if (result.version) {
      console.log(chalk.cyan(`  子集提取: patch-extract --version=${result.version} --only=<文件>`))
    }
  }

  process.exit(result.success ? 0 : 1)
}

main().catch(error => {
  console.error(chalk.red(`错误: ${error.message}`))
  process.exit(1)
})
