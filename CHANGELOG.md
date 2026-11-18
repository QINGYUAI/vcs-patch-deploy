# Changelog

## 1.3.0

### 新增

- **自定义 apply 脚本**：`--apply-script=<文件>` / `PATCH_APPLY_SCRIPT`，项目无需再写包装脚本即可使用自己的 `apply-update.php`
- **多环境基准**：`--profile=<名称>` / `PATCH_PROFILE`，使用 `deploy/.last-deploy-marker.<名称>`，生产与预发（如 php85）互不影响；指定 profile 时不回退默认 marker
- **受保护文件**：`deploy/protect.txt`、`--protect=`、`--protect-file=`、`PATCH_PROTECT`；包内生成 `PROTECT.txt`，`apply-update.php` 对线上已存在的受保护文件跳过覆盖（首次部署仍写入），`--check` 与回滚同样生效；`patch-extract` 支持追加保护文件并与源包清单合并
- **SVN 工作副本打包**：`--worktree-diff` / `PATCH_DIFF_WORKTREE=true`，合并 `svn diff -r <from>` 与 `svn status`，支持未提交改动、未纳入版本控制的文件与新增目录；产物 `patch-wc-<时间戳>`，不自动更新基准，存在冲突时拒绝打包
- **exec 禁用保护**：`apply-update.php` 检测 `disable_functions`，`exec` 不可用时跳过 `php think clear` 并提示
- **可执行位跨平台保留**：从 Git 索引（`100755`）/ SVN `svn:executable`（XML 属性输出）识别可执行文件，zip 内写 `0755`，并生成包内 `MODES.txt`；服务器端部署后据此 `chmod`；非 Windows 上同时参考实际文件权限
- **备份会话保留策略**：`--keep-backups=N` / `PATCH_KEEP_BACKUPS`（默认 10），部署成功后自动清理更早的备份；中断会话单独限额（最多 5 个、24 小时）
- **备份目录防 Web 访问**：默认备份目录位于站点根内时给出告警，并写入 `.htaccess`（deny）与 `index.html`
- **子集包独立版本标识**：`version=<源版本>-partial-<hash>` + `partial=1`（`--only` 打包与 `patch-extract` 均生效），服务器端回滚时提示“仅恢复其中的文件”
- **同版本重建告警**：目标版本不同却复用同一 `--version` 时提示产物将被覆盖
- **deploy/out 自动清理**：`--prune-out` / `PATCH_PRUNE_OUT`，构建后按 `--keep-out`（默认同 `--keep-versions`）清理旧的 `patch-*` 目录与 zip；当前构建始终保留，不触碰其他文件，中断残留的 staging 目录超过 1 小时后清理
- **归档硬链接**：`--link-archive` / `PATCH_ARCHIVE_LINK`，`deploy/archive/` 优先硬链接 out 产物以节省磁盘；跨盘或不支持硬链接时自动退回复制

### 修复

- **子集包版本语义**：`patch-build --only` 之前仍写完整版本号且无 `partial=1`，服务器会按完整包装处理，可能导致回滚静默只恢复子集文件；现与 `patch-extract` 统一
- **工作副本版本标签**：带 `--version` 时 VERSION.txt 不再丢失版本前缀（与目录名、versions.json 一致）
- **部署端路径校验**：`apply-update.php` 拒绝目标为符号链接，并要求父目录 `realpath` 位于 Backend 根内（防止目录软链逃逸）
- **备份/回滚保留权限**：备份元数据记录原 `mode`，回滚恢复文件后按记录 `chmod`
- **备份保留完整性**：无元数据的中断/旧包会话不再永久堆积；`--list-backups` 不再列出空会话
- **同版本回滚**：重复部署产生的 `_<时间戳>` 会话会被正确选中（取最近一次）
- **SVN 工作副本扫描剪枝**：未纳入版本控制的目录按排除规则跳过（`node_modules/`、`runtime/`、`deploy/out/` 等），并限制文件数上限
- **工作副本包不写版本归档**：`--worktree-diff` 产物只保留在 `deploy/out`，不占用 `archive/` 的 `keepVersions` 名额；带 `--version` 时使用独立版本标识
- **参数冲突**：`--worktree-diff` 与 `--to` 同时使用时直接报错
- **未知 CLI 参数**：不再只告警继续，改为直接失败并提示 `--name=value` 形式，避免拼写错误生成非预期包
- **patch-extract 删除清单**：按提取范围过滤，子集包不再继承完整包的无关删除提示；`--from-patch` 未传版本号时沿用源包 VERSION
- **zip 原子写入**：先写临时文件再替换，失败时不会留下截断的 zip 或提前销毁旧产物
- **SVN 可执行位**：读取失败不再静默降级为 0644，会给出告警；属性输出改用 XML，避免路径含 ` - ` 时误解析
- **打包内容一致性**：打包前校验工作区与目标版本是否一致（Git 比对目标 commit，SVN 比对目标 revision），不一致时中止，避免 zip 内容与 MANIFEST 声明不符；可用 `--from-worktree` / `PATCH_FROM_WORKTREE=true` 显式跳过
- **子集包不再覆盖完整包**：`--only` / `--file-list` 产物使用 `patch-v1.2.3-partial-<hash>`（无版本号时 `patch-r467-partial-<hash>`）独立命名，`versions.json` 与 `archive/` 同步区分
- **Git 子目录源码**：`--source` 指向仓库子目录时，diff 路径会正确映射（支持中文路径，`core.quotepath=false`）
- **SVN**：识别 `R`（替换）状态；跳过目录条目，避免把目录递归复制进补丁包
- **patch-extract**：`--list-versions` / `--from-patch` 不再要求当前目录是 VCS 工作区
- **deploy 元数据排除**：`deploy/.last-deploy-*`、`deploy/versions.json`、`deploy/protect.txt`、`deploy/archive/`、`.deploy-backups/` 不再进入补丁包
- **归档与登记表**：`versions.json` / `archive/index.json` 保存相对 deploy 的路径（项目迁移后仍可用）；完整包与子集包分别保留；工作副本登记只保留最近 5 条

### 改进

- **服务器脚本**：兼容 PHP 7.4（内置 `str_starts_with` / `str_ends_with` polyfill，要求 PHP >= 7.4）；CI 增加 PHP 7.4/8.3 语法检查与冒烟测试（`test/php-smoke.sh`）
- **本地检查**：`npm run check`（`node --check` 覆盖 `bin/`、`lib/`、`test/`、`scripts/`），`npm test` 自动前置执行
- **路径安全**：`apply-update.php` 与 MANIFEST 解析拒绝绝对路径、`../` 逃逸与符号链接；任意目录下的 `.env` / `.env.*` 均不覆盖
- **回滚更完整**：记录本次新增文件及其 sha256，回滚时删除未被修改过的新增文件（修改过的保留并提示）
- **仅删除项的包**：服务器端仍会提示 `MANIFEST-deleted.txt`，不再因无文件可部署而漏掉提示

## 1.2.0

### 新增

- **版本备份（服务器）**：部署时按版本号备份至 `.deploy-backups/v1.2.2/` 或 `r467/`，写入 `.deploy-version`
- **回滚与列表**：`apply-update.php --rollback` / `--list-backups`
- **本地版本归档**：打包后自动归档至 `deploy/archive/`，默认保留 10 个版本（`--keep-versions` / `--no-archive`）
- 所有 patch 包写入 `VERSION.txt`，revision 包自动使用 `r467` 标识

## 1.1.1

### 修复

- `apply-update.php`：兼容 ThinkPHP 5（`application/`）及 patch 路径推断，不再强制要求 `app/`
- `validatePhpBackend`：识别 `application/` 旧版目录结构

## 1.1.0

### 新增

- **版本号部署**：`patch-build --version=1.2.3` 写入 `VERSION.txt` 与 `deploy/versions.json`
- **单独文件提取**：`patch-extract --version=1.2.3 --only=<文件>` 从完整包提取子集
- **按文件打包/部署**：`--only` / `--file-list`（打包端）、`--files` / `PATCH_DEPLOY_FILES`（服务器端）
- 新增 CLI：`patch-extract`
- 单元测试（`npm test`）与 GitHub Actions CI

### 改进

- `apply-update.php`：部署前自动备份；优先读 MANIFEST 减少目录扫描
- `versions.json`：原子写入、损坏时告警、子集版本去重
- `build-patch`：staging 目录构建，失败不破坏旧 patch；SVN revision NaN 校验
- `git.js`：Git 未安装时 `detectVcs` 不再崩溃；支持类型变更 diff
- zip 默认压缩级别 6（可通过 `PATCH_ZIP_LEVEL` 调整）

## 1.0.1

- 文档与示例改用通用占位路径，移除项目专有目录名
- `apply-update.php` 仅保留 `PATCH_BACKEND_ROOT` 环境变量
- 补充 GitHub 仓库链接

## 1.0.0

- 首次发布：PHP 后端增量部署，支持 SVN / Git
