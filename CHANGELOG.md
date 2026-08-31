# Changelog

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

## Unreleased

## 1.0.1

- 文档与示例改用通用占位路径，移除项目专有目录名
- `apply-update.php` 仅保留 `PATCH_BACKEND_ROOT` 环境变量
- 补充 GitHub 仓库链接

## 1.0.0

- 首次发布：PHP 后端增量部署，支持 SVN / Git
