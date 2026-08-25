# vcs-patch-deploy

PHP 后端（ThinkPHP）增量部署包生成工具。对比 **SVN revision** 或 **Git commit** 差异，生成本地 zip，附带 `apply-update.php`，供堡垒机 / Web 终端上线。

- npm：https://www.npmjs.com/package/vcs-patch-deploy
- GitHub：https://github.com/QINGYUAI/vcs-patch-deploy

> v1 仅内置 **PHP 后端**配置；Node/Java 等后端可在后续版本通过 `--backend` 扩展。

## 安装

```bash
npm install -g vcs-patch-deploy
# 或项目内
npm install --save-dev vcs-patch-deploy
npx patch-build --help
```

## 快速开始（ThinkPHP + SVN）

在 **PHP 项目根目录**（含 `app/`、`config/` 或 `think`）执行：

```bash
cd /path/to/your-php-api

# 首次：初始化 deploy 目录
patch-build --init --vcs=svn

# 创建基准（上次成功上线的 revision）
echo svn:430 > deploy/.last-deploy-marker

# 打包增量（430 -> 当前 HEAD）
patch-build --vcs=svn

# 产物
# deploy/out/backend-update-r{rev}.zip
# deploy/out/patch-r{rev}/
```

SVN 常见目录结构为 `repo-root/trunk`，进入 `trunk` 后执行上述命令即可。

## Git 仓库

```bash
cd /path/to/your-php-api

echo git:abc123def... > deploy/.last-deploy-marker
patch-build --vcs=git
patch-build --vcs=git --from=v1.0.0 --to=HEAD
```

## 服务器应用

```bash
unzip -o backend-update-r467.zip -d patch-r467
cd patch-r467

php apply-update.php --check /path/to/production-api
php apply-update.php /path/to/production-api

# 或环境变量
export PATCH_BACKEND_ROOT=/path/to/production-api
php apply-update.php
```

`apply-update.php` 行为：

- 按包内路径覆盖线上文件
- **不覆盖** `.env`
- **不自动删除** `MANIFEST-deleted.txt` 中的文件
- 成功后清理 `runtime/cache`，并尝试 `php think clear`

## CLI 参数

| 参数 | 说明 |
|------|------|
| `--backend=php` | 后端类型（默认 php） |
| `--vcs=svn\|git` | 强制 VCS 类型 |
| `--source=<dir>` | PHP 项目根 |
| `--deploy=<dir>` | deploy 目录 |
| `--from=<ref>` | 起始基准 |
| `--to=<ref>` | 结束目标 |
| `--no-zip` | 只生成 patch 目录 |
| `--mark-deployed` | 更新基准 marker |
| `--init` | 初始化 deploy 目录 |

## 不会打进包的内容

`.env`、`vendor/`、`runtime/`、`public/uploads/`、`deploy/out/` 等（见 `lib/backends/php.js`）。

若变更含 `composer.json` / `composer.lock`，上线后需在服务器执行 `composer install --no-dev`。

## 基准文件

| 文件 | 格式 |
|------|------|
| `deploy/.last-deploy-marker` | `svn:467` 或 `git:fullsha` |
| `deploy/.last-deploy-rev` | 兼容旧版 SVN 工具（仅数字） |

**上线成功后再更新基准**，否则下次增量会漏文件。

## 编程式调用

默认以 **当前工作目录** 为 PHP 项目根，无需写死路径：

```javascript
const path = require('path')
const { buildPatch, resolveConfig } = require('vcs-patch-deploy')

// 在 PHP 项目根目录运行，或显式指定 sourceDir
const config = resolveConfig({
  backend: 'php',
  vcs: 'svn',
  cwd: path.join(__dirname), // 调用方项目根
  fromRef: 430,
  toRef: 467
})

buildPatch(config).then(console.log)
```

也可通过环境变量配置（见 `env.example`）：

```bash
export PATCH_SOURCE_DIR=/path/to/your-php-api
export PATCH_VCS=svn
patch-build
```

## License

MIT
