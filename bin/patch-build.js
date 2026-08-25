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
  -h, --help            显示帮助

${chalk.yellow('环境变量:')}
  PATCH_BACKEND=php     后端类型
  PATCH_VCS             svn | git
  PATCH_SOURCE_DIR      源码根
  PATCH_DEPLOY_DIR      deploy 目录
  PATCH_ZIP_PREFIX      zip 前缀

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
  const opts = { showHelp: false }

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') opts.showHelp = true
    else if (arg === '--no-zip') opts.noZip = true
    else if (arg === '--mark-deployed') opts.markDeployed = true
    else if (arg === '--init') opts.init = true
    else if (arg === '--skip-validation') opts.skipValidation = true
    else if (arg.startsWith('--backend=')) opts.backend = arg.split('=')[1]
    else if (arg.startsWith('--vcs=')) opts.vcs = arg.split('=')[1]
    else if (arg.startsWith('--source=')) opts.sourceDir = arg.split('=')[1]
    else if (arg.startsWith('--deploy=')) opts.deployDir = arg.split('=')[1]
    else if (arg.startsWith('--from=')) opts.fromRef = arg.split('=')[1]
    else if (arg.startsWith('--to=')) opts.toRef = arg.split('=')[1]
    else if (arg.startsWith('--zip-prefix=')) opts.zipPrefix = arg.split('=')[1]
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
  console.log(chalk.gray(`源码: ${config.sourceDir}`))
  console.log(chalk.gray(`deploy: ${config.deployDir}`))

  const result = await buildPatch(config)

  if (result.skipped) {
    console.log(chalk.yellow(result.message))
  } else {
    console.log(chalk.green(result.message))
    console.log(chalk.green(`  变更文件: ${result.fileCount}  删除: ${result.deletedCount}`))
    if (result.patchDir) console.log(chalk.green(`  patch 目录: ${result.patchDir}`))
    if (result.zipPath) console.log(chalk.green(`  zip: ${result.zipPath} (${result.zipSize} bytes)`))
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
  }

  process.exit(result.success ? 0 : 1)
}

main().catch(error => {
  console.error(chalk.red(`错误: ${error.message}`))
  process.exit(1)
})
