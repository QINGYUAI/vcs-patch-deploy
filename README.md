# vcs-patch-deploy

PHP 后端（ThinkPHP）增量部署包生成工具。对比 **SVN revision** 或 **Git commit** 差异，生成本地 zip，附带 `apply-update.php`，供堡垒机 / Web 终端上线。

- npm：<https://www.npmjs.com/package/vcs-patch-deploy>
- GitHub：<https://github.com/QINGYUAI/vcs-patch-deploy>

> v1 仅内置 **PHP 后端**配置；Node/Java 等后端可在后续版本通过 `--backend` 扩展。

## 安装

```bash
npm install -g vcs-patch-deploy
# 或项目内
npm install --save-dev vcs-patch-deploy
npx patch-build --help
```

环境要求：打包端 Node.js >= 18；服务器端 PHP >= 7.4（兼容 ThinkPHP 5/6）。

## 快速开始（ThinkPHP + SVN）

在 **PHP 项目根目录**（含 `app/`、`application/`、`config/` 或 `think`）执行：

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

打包内容从**工作区**复制。为避免包内容与 `from..to` 声明不一致，打包前会校验工作区是否与目标版本一致：

- SVN：`svn diff -r <to> --summarize` 有差异（未 update / 混合版本 / 本地改动）时中止
- Git：`git diff <to> -- <文件>` 有差异（工作区未切到目标 commit / 未提交改动）时中止

确有需要时用 `--from-worktree` 明确允许按当前工作区内容打包（MANIFEST 会记录 `content_source=working-copy`）。

## Git 仓库

```bash
cd /path/to/your-php-api

echo git:abc123def... > deploy/.last-deploy-marker
patch-build --vcs=git
patch-build --vcs=git --from=v1.0.0 --to=HEAD
```

## 版本号与单独文件部署

为每次上线打上**安装版本号**，并支持从完整包中**提取部分文件**单独部署：

```bash
# 1. 打完整版本包（写入 VERSION.txt、deploy/versions.json）
patch-build --vcs=svn --version=1.2.3

# 2. 打包时只包含指定文件（从本次增量中筛选）
patch-build --vcs=svn --version=1.2.3 --only=app/service/Foo.php,app/controller/Bar.php
patch-build --vcs=svn --version=1.2.3 --file-list=hotfix-files.txt

# 3. 从已打好的 v1.2.3 完整包中提取子集（无需重新 diff）
patch-extract --version=1.2.3 --only=app/service/Foo.php
patch-extract --list-versions

# 产物示例
# deploy/out/patch-v1.2.3/
# deploy/out/backend-update-v1.2.3.zip
# deploy/versions.json
```

同一版本号的子集包会使用独立后缀（`--only` / `--file-list` 组合的短哈希），不会覆盖完整包：

```text
deploy/out/patch-v1.2.3/                     完整包
deploy/out/patch-v1.2.3-partial-a1b2c3d4/    子集包
deploy/out/patch-r467-partial-a1b2c3d4/      无版本号时的子集包
```

子集包（`patch-build --only` 与 `patch-extract` 提取包）的 `VERSION.txt` 会写入
`version=<源版本>-partial-<hash>` 与 `partial=1`，服务器据此按**部分部署**处理；
`deploy/archive/` 中完整包与子集包分别保留 `--keep-versions` 个，避免热修复包挤掉正式版本归档。

重复打包会在 `deploy/out/` 累积产物，可用 `--prune-out` 自动清理旧的 `patch-*` 目录与 `<zip-prefix>-*.zip`：
保留数量由 `--keep-out` 控制（默认同 `--keep-versions`），当前构建始终保留，且不会触碰其他文件。
归档与 out 在同一磁盘时，可加 `--link-archive` 用硬链接代替整份复制，节省约一半空间（跨盘自动退回复制）；
注意硬链接共享文件内容，之后修改 `deploy/out` 中的产物会同时改变归档。

服务器上也可在完整 patch 包内**只部署部分文件**：

```bash
php apply-update.php --files=app/service/Foo.php /path/to/production-api
php apply-update.php --file-list=deploy-files.txt /path/to/production-api
export PATCH_DEPLOY_FILES=app/service/Foo.php,app/controller/Bar.php
php apply-update.php /path/to/production-api
```

## 自定义 apply-update.php

项目内如需修改服务器脚本（自定义环境变量、跳过特定文件、权限修复等），不必改 npm 包，也不必再写包装脚本：

```bash
patch-build --vcs=git --apply-script=deploy/apply-update.php
```

- 也可用 `PATCH_APPLY_SCRIPT=deploy/apply-update.php`
- 包内文件始终命名为 `apply-update.php`（与源文件名无关）
- `patch-extract` 同样支持 `--apply-script=`
- 未指定时使用插件自带模板 `assets/php/apply-update.php`

## 可执行文件权限（MODES.txt）

在 Windows 上打包时，文件系统不体现 Unix 执行位，普通 zip 会让 `.sh`、`think` 等文件丢掉 `0755`。插件会从 VCS 元数据识别可执行文件：

- Git：读取索引模式 `100755`（`git ls-files -s`）
- SVN：读取 `svn:executable` 属性（`svn propget -R`）

命中的文件会：

1. 以 `0755` 写入 zip（其余文件固定 `0644`，目录 `0755`）
2. 写入包内 `MODES.txt`，服务器端部署后据此 `chmod`
3. 子集提取时随包复制，保持同样权限

```text
# MODES.txt
# mode 相对路径（0755 = 可执行）
0755  app/console/run.sh
```

## 受保护文件（不覆盖线上运行时配置）

有些配置文件被版本控制跟踪，但线上会被程序改写（如 `config/date_config.json`）。
把它们加入保护清单后，**线上已存在时不覆盖**；线上不存在时仍会写入（便于首次部署）。

```bash
# 方式一：项目内持久配置 deploy/protect.txt（每行一个相对路径）
cat > deploy/protect.txt <<'EOF'
config/date_config.json
# 注释行会被忽略
EOF

# 方式二：打包时指定
patch-build --vcs=git --protect=config/date_config.json
patch-build --vcs=git --protect-file=protect-files.txt
export PATCH_PROTECT=config/date_config.json,config/site.json
```

打包后在包内生成 `PROTECT.txt`，`apply-update.php` 会打印 `PROTECT: N 个文件`，并对已存在的受保护文件输出：

```text
SKIP config/date_config.json — 受保护文件（线上已存在，未覆盖）
```

`--check` 同样跳过（不计为失败）；回滚也不会删除受保护文件。`deploy/protect.txt` 本身不会进入补丁包。

## 多环境基准（profile）

同一仓库需要分别向生产、预发（如不同 PHP 版本）部署时，用 profile 隔离基准：

```bash
# 预发环境使用 deploy/.last-deploy-marker.php85
patch-build --vcs=git --profile=php85
patch-build --vcs=svn --profile=php85 --mark-deployed
# 或 export PATCH_PROFILE=php85
```

- 默认（不带 profile）仍使用 `deploy/.last-deploy-marker`
- 指定 profile 时**不会**回退读取默认 marker / `.last-deploy-rev`，避免跨环境误用基准
- profile 仅允许字母、数字、`.` `_` `-`

## SVN 工作副本打包（含未提交改动）

默认 SVN 模式只按 revision 对比，要求工作副本干净。需要把本地未提交的改动直接打包时：

```bash
patch-build --vcs=svn --worktree-diff
# 或 PATCH_DIFF_WORKTREE=true
```

行为：

- 以 `deploy/.last-deploy-marker`（或 `--from=`）为基准，合并 `svn diff -r <from>`（已提交 + 本地修改）与 `svn status`（新增、未纳入版本控制的文件、删除）
- 未纳入版本控制的目录会展开为具体文件；存在未解决冲突时拒绝打包
- 产物标识为 `patch-wc-<时间戳>` / `backend-update-wc-<时间戳>.zip`，MANIFEST 记录 `to_revision=working-copy`、`content_source=working-copy`
- 工作副本包**不写入** `deploy/archive/`（避免挤掉版本归档），产物保留在 `deploy/out`；带 `--version` 时版本标识为 `<版本>-wc-<时间戳>`（VERSION.txt 与 versions.json 一致）
- **不会**自动更新基准（工作副本内容不对应任何 revision）；上线成功后应提交代码，再用 `--mark-deployed` 指向提交后的 revision
- `--worktree-diff` 与 `--to` 不能同时使用（目标固定为 working-copy）
- Git 请先提交后按 commit 打包（或用 `--from-worktree` 放宽一致性校验）

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
- **覆盖前校验目标**：拒绝目标为符号链接；父目录 `realpath` 必须在 Backend 根内（防止父目录软链逃逸）
- **覆盖前备份** 线上已有文件到 `Backend/.deploy-backups/<版本>/`（保持相对路径），并记录原权限
- **不覆盖** `.env` 与任意目录下的 `.env.*`
- **不覆盖** 包内 `PROTECT.txt` 列出且线上已存在的文件（首次部署仍写入）
- **拒绝** 包内绝对路径、`../` 逃逸路径与符号链接
- **不自动删除** `MANIFEST-deleted.txt` 中的文件（`--check` 也会提示）
- 按包内 `MODES.txt` 恢复可执行位（Windows 打包时 zip 无法携带 exec 位）
- 成功后清理 `runtime/cache`，并尝试 `php think clear`（`exec` 被禁用时自动跳过）
- 回滚时恢复旧文件及权限，并删除本次新增且部署后未被修改的文件（按 sha256 校验）

备份相关：

```bash
# 默认开启备份；跳过备份
php apply-update.php --no-backup /path/to/production-api

# 自定义备份根目录（仍会在其下创建 <版本>/ 子目录）
export PATCH_BACKUP_DIR=/data/backups/my-api
php apply-update.php /path/to/production-api

# 备份会话保留数量（默认 10，部署成功后自动清理更早的会话）
php apply-update.php --keep-backups=5 /path/to/production-api
export PATCH_KEEP_BACKUPS=5
```

同一版本重复部署时，备份目录会追加 `_<时间戳>` 后缀（如 `v1.2.2_2026-11-18_093000`）；
`--rollback=1.2.2` 会选用该版本最近一次备份。中断/没有元数据的会话不占用保留名额，
最多保留 5 个且 24 小时后自动清理。

备份目录若位于 Backend 根内，脚本会提示风险，并写入 `.htaccess`（Apache `Require all denied`）与 `index.html`；nginx 需自行在配置中禁止访问该路径。生产环境建议直接用 `PATCH_BACKUP_DIR` 指向站点根外。

回滚（恢复旧文件及权限，并删除本次新增且未被修改过的文件）：

```bash
php apply-update.php --list-backups /path/to/production-api
php apply-update.php --rollback /path/to/production-api
php apply-update.php --rollback=1.2.2 /path/to/production-api
```

子集包（`partial=1`）部署会记录在备份元数据中，回滚时会提示“仅恢复其中的文件”。

## CLI 参数

参数统一使用 `--name=value` 形式；未知参数会直接报错退出（避免拼写错误被静默忽略）。

| 参数 | 说明 |
| ------ | ------ |
| `--backend=php` | 后端类型（默认 php） |
| `--vcs=svn\|git` | 强制 VCS 类型 |
| `--source=<dir>` | PHP 项目根 |
| `--deploy=<dir>` | deploy 目录 |
| `--from=<ref>` | 起始基准 |
| `--to=<ref>` | 结束目标 |
| `--no-zip` | 只生成 patch 目录 |
| `--mark-deployed` | 更新基准 marker |
| `--init` | 初始化 deploy 目录 |
| `--skip-validation` | 跳过 PHP 项目结构校验 |
| `--zip-prefix=<前缀>` | zip 文件名前缀 |
| `--version=<版本>` | 安装版本号（写入 VERSION.txt、versions.json） |
| `--only=<文件>` | 仅打包指定文件（逗号分隔） |
| `--file-list=<文件>` | 文件列表（每行一个相对路径） |
| `--from-worktree` | 允许用工作区内容打包（跳过与目标版本的一致性校验） |
| `--worktree-diff` | SVN：直接打包工作副本改动（对比基准 revision，含未提交文件） |
| `--apply-script=<文件>` | 自定义 `apply-update.php` 模板 |
| `--profile=<名称>` | 多环境基准（`deploy/.last-deploy-marker.<名称>`） |
| `--protect=<路径>` | 受保护文件（逗号分隔，可重复；线上已存在则跳过覆盖） |
| `--protect-file=<文件>` | 受保护文件列表 |
| `--no-archive` | 跳过本地版本归档 |
| `--keep-versions=<N>` | 本地 archive 保留版本数（默认 10，完整包/子集包分别计算） |
| `--prune-out` | 构建后清理 `deploy/out` 旧产物 |
| `--keep-out=<N>` | `deploy/out` 保留数量（默认同 `--keep-versions`） |
| `--link-archive` | 归档优先使用硬链接（同一磁盘节省空间） |

### patch-extract

| 参数 | 说明 |
| ------ | ------ |
| `--version=<版本>` | 从已注册版本提取 |
| `--from-patch=<目录>` | 直接指定源 patch 目录（未传 `--version` 时沿用源包 VERSION） |
| `--only=<文件>` | 要提取的文件 |
| `--file-list=<文件>` | 文件列表 |
| `--apply-script=<文件>` | 自定义 apply 模板 |
| `--protect=<路径>` | 追加受保护文件（与源包 PROTECT.txt、deploy/protect.txt 合并） |
| `--protect-file=<文件>` | 追加受保护文件列表 |
| `--list-versions` | 列出 deploy/versions.json 中的版本 |
| `--register` | 将子集包注册到 versions.json |

提取时 `MANIFEST-deleted.txt` 会按本次提取范围过滤，子集包不会提示删除无关文件。

## 不会打进包的内容

`.env`、`vendor/`、`runtime/`、`public/uploads/`、`deploy/out/`、`deploy/versions.json`、`deploy/archive/`、`deploy/protect.txt` 等（见 `lib/backends/php.js`）。

若变更含 `composer.json` / `composer.lock`，上线后需在服务器执行 `composer install --no-dev`。

## 基准文件

| 文件 | 格式 |
| ------ | ------ |
| `deploy/.last-deploy-marker` | `svn:467` 或 `git:fullsha` |
| `deploy/.last-deploy-marker.<profile>` | 多环境基准（如 `deploy/.last-deploy-marker.php85`） |
| `deploy/.last-deploy-rev` | 兼容旧版 SVN 工具（仅数字，默认 profile） |
| `deploy/versions.json` | 版本号与 patch 目录映射 |
| `deploy/protect.txt` | 受保护文件清单（线上已存在则跳过覆盖） |

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

## 开发与测试

```bash
npm run check    # node --check 语法门禁（bin/lib/test/scripts）
npm test         # 单元测试 + CLI 帮助输出（自动先执行 check）
npm run test:php # 需要本机 php：apply-update.php 冒烟测试
```

## License

MIT
