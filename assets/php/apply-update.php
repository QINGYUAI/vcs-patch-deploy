<?php
declare(strict_types=1);

/**
 * 堡垒机增量部署：将 patch 包内文件覆盖到线上 Backend 根目录，并清理 ThinkPHP 缓存。
 *
 * 用法（Linux Web 终端，在解压后的 patch 目录内）：
 *   php apply-update.php /path/to/production-api
 * 或设置环境变量：
 *   PATCH_BACKEND_ROOT=/path/to/production-api php apply-update.php
 *
 * 安全：不会覆盖 .env；不会自动删除 MANIFEST-deleted.txt 中列出的文件。
 * 备份：覆盖前将线上已有文件复制到版本备份目录（默认 Backend/.deploy-backups/v1.2.2/ 或 r467/）。
 * 回滚：php apply-update.php --rollback[=版本] <Backend根目录>
 * 列表：php apply-update.php --list-backups <Backend根目录>
 */

/** patch 包根目录（本脚本所在目录） */
const PATCH_ROOT = __DIR__;

/** 默认备份目录名（位于 Backend 根下，可通过 PATCH_BACKUP_DIR 覆盖父路径） */
const BACKUP_DIR_BASENAME = '.deploy-backups';

/** 当前线上部署版本记录文件（位于 Backend 根下） */
const DEPLOY_VERSION_FILE = '.deploy-version';

/** 版本备份元数据文件名 */
const DEPLOY_META_FILE = 'DEPLOY-META.txt';

/** 部署时跳过的文件名（相对路径 basename 匹配或完整相对路径） */
const SKIP_FILES = [
    'apply-update.php',
    'MANIFEST.txt',
    'MANIFEST-deleted.txt',
    'VERSION.txt',
];

/** 永不覆盖的相对路径（保护生产配置与运行时数据） */
const PROTECTED_RELATIVE = [
    '.env',
    '.env.local',
    '.env.production',
];

/** 本地产物路径前缀（误打进 zip 时跳过，避免污染 Backend） */
const SKIP_PATH_PREFIXES = [
    'deploy/out/',
    'out/_verify/',
    'out/patch-',
];

/**
 * 解析线上 Backend 根目录（含 app、config、public、vendor 的 trunk 根）。
 */
function resolveBackendRoot(): string
{
    foreach (['PATCH_BACKEND_ROOT'] as $envKey) {
        $fromEnv = getenv($envKey);
        if (is_string($fromEnv) && $fromEnv !== '') {
            return rtrim($fromEnv, "/\\");
        }
    }

    global $argv;
    $flags = ['--check', '--dry-run', '--no-backup', '--list-backups', '--rollback'];
    foreach ($argv as $i => $arg) {
        if ($i === 0) {
            continue;
        }
        if (in_array($arg, $flags, true)) {
            continue;
        }
        if (str_starts_with($arg, '--files=') || str_starts_with($arg, '--file-list=')) {
            continue;
        }
        if (str_starts_with($arg, '--rollback=')) {
            continue;
        }
        if ($arg !== '' && !str_starts_with($arg, '-')) {
            return rtrim($arg, "/\\");
        }
    }

    fwrite(STDERR, "用法: php apply-update.php [--check] [--rollback[=版本]] [--list-backups] [--files=<路径>] <Backend根目录>\n");
    fwrite(STDERR, "示例: php apply-update.php /path/to/production-api\n");
    fwrite(STDERR, "      php apply-update.php --rollback /path/to/production-api\n");
    fwrite(STDERR, "      php apply-update.php --rollback=1.2.2 /path/to/production-api\n");
    fwrite(STDERR, "      php apply-update.php --list-backups /path/to/production-api\n");
    exit(1);
}

/**
 * 解析 --rollback[=版本] 参数
 *
 * @return array{enabled: bool, target: string|null}
 */
function resolveRollbackOption(): array
{
    global $argv;

    foreach ($argv ?? [] as $arg) {
        if ($arg === '--rollback') {
            return ['enabled' => true, 'target' => null];
        }
        if (str_starts_with($arg, '--rollback=')) {
            $target = trim(substr($arg, 11));
            if ($target === '') {
                throw new RuntimeException('--rollback= 需要指定版本号');
            }
            return ['enabled' => true, 'target' => $target];
        }
    }

    return ['enabled' => false, 'target' => null];
}

/**
 * 清洗版本标识（与 Node sanitizeVersionLabel 对齐）
 */
function sanitizeVersionLabel(string $version): string
{
    $label = trim($version);
    $label = preg_replace('/^v/i', '', $label) ?? $label;
    $label = preg_replace('/[^a-zA-Z0-9._-]/', '_', $label) ?? $label;

    return $label;
}

/**
 * 读取 key=value 多行元数据文件（忽略 # 注释行）
 *
 * @return array<string, string>
 */
function readKeyValueFile(string $filePath): array
{
    if (!is_file($filePath)) {
        return [];
    }

    $lines = file($filePath, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        return [];
    }

    /** @var array<string, string> $meta */
    $meta = [];
    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '#')) {
            continue;
        }
        $pos = strpos($trimmed, '=');
        if ($pos === false) {
            continue;
        }
        $key = trim(substr($trimmed, 0, $pos));
        $value = trim(substr($trimmed, $pos + 1));
        if ($key !== '') {
            $meta[$key] = $value;
        }
    }

    return $meta;
}

/**
 * 从 patch 包解析本次部署版本（VERSION.txt 优先，兼容 MANIFEST revision 包）
 */
function resolvePatchDeployVersion(): ?string
{
    $versionMeta = readKeyValueFile(PATCH_ROOT . '/VERSION.txt');
    if (isset($versionMeta['version']) && $versionMeta['version'] !== '') {
        return sanitizeVersionLabel($versionMeta['version']);
    }

    $manifestMeta = readKeyValueFile(PATCH_ROOT . '/MANIFEST.txt');
    if (isset($manifestMeta['version']) && $manifestMeta['version'] !== '') {
        return sanitizeVersionLabel($manifestMeta['version']);
    }
    if (($manifestMeta['vcs'] ?? '') === 'svn' && isset($manifestMeta['to_revision']) && $manifestMeta['to_revision'] !== '') {
        return 'r' . $manifestMeta['to_revision'];
    }
    if (isset($manifestMeta['to_commit']) && $manifestMeta['to_commit'] !== '') {
        return substr($manifestMeta['to_commit'], 0, 12);
    }

    return null;
}

/**
 * 备份目录名：v1.2.3 / r467 / pre-deploy
 */
function formatBackupDirName(string $versionLabel): string
{
    $label = sanitizeVersionLabel($versionLabel);
    if ($label === 'pre-deploy') {
        return 'pre-deploy';
    }
    if (preg_match('/^r\d+$/i', $label) === 1) {
        return strtolower($label);
    }
    if (preg_match('/^\d/', $label) === 1) {
        return 'v' . $label;
    }

    return $label;
}

/**
 * 读取当前线上部署版本
 */
function readDeployedVersion(string $backendRoot): ?string
{
    $path = $backendRoot . '/' . DEPLOY_VERSION_FILE;
    if (!is_file($path)) {
        return null;
    }

    $value = trim((string) file_get_contents($path));
    if ($value === '') {
        return null;
    }

    return sanitizeVersionLabel($value);
}

/**
 * 写入当前线上部署版本
 */
function writeDeployedVersion(string $backendRoot, string $versionLabel): void
{
    $path = $backendRoot . '/' . DEPLOY_VERSION_FILE;
    file_put_contents($path, sanitizeVersionLabel($versionLabel) . "\n");
}

/**
 * 创建版本备份会话目录（无版本标识时降级为时间戳目录）
 */
function createVersionBackupSessionDir(string $backupRoot, ?string $currentVersionLabel): string
{
    if ($currentVersionLabel === null || $currentVersionLabel === '') {
        return createBackupSessionDir($backupRoot);
    }

    $sessionDir = $backupRoot . '/' . formatBackupDirName($currentVersionLabel);
    if (is_dir($sessionDir)) {
        // 同版本重复部署：追加时间戳子目录，避免覆盖历史备份
        $sessionDir .= '_' . date('Y-m-d_His');
    }
    if (!is_dir($sessionDir) && !mkdir($sessionDir, 0755, true) && !is_dir($sessionDir)) {
        throw new RuntimeException("无法创建版本备份目录: {$sessionDir}");
    }

    return $sessionDir;
}

/**
 * 写入版本备份元数据
 *
 * @param list<string> $backedUpFiles
 */
function writeDeployMeta(
    string $backupSessionDir,
    string $versionLabel,
    ?string $replacedBy,
    array $backedUpFiles
): void {
    $lines = [
        'version=' . sanitizeVersionLabel($versionLabel),
        'backup_label=' . basename($backupSessionDir),
        'backed_up_at=' . date('Y-m-d H:i:s'),
        'file_count=' . count($backedUpFiles),
    ];
    if ($replacedBy !== null && $replacedBy !== '') {
        $lines[] = 'replaced_by=' . sanitizeVersionLabel($replacedBy);
    }
    $lines[] = '';
    $lines[] = '# files';
    foreach ($backedUpFiles as $rel) {
        $lines[] = $rel;
    }

    file_put_contents($backupSessionDir . '/' . DEPLOY_META_FILE, implode("\n", $lines) . "\n");
}

/**
 * 读取备份目录元数据
 *
 * @return array<string, string>
 */
function readDeployMeta(string $backupSessionDir): array
{
    return readKeyValueFile($backupSessionDir . '/' . DEPLOY_META_FILE);
}

/**
 * 列出备份目录内可恢复文件（排除元数据）
 *
 * @return list<string>
 */
function listBackupFiles(string $backupSessionDir): array
{
    if (!is_dir($backupSessionDir)) {
        return [];
    }

    /** @var list<string> $files */
    $files = [];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($backupSessionDir, FilesystemIterator::SKIP_DOTS)
    );

    foreach ($iterator as $fileInfo) {
        if (!$fileInfo->isFile()) {
            continue;
        }
        $abs = $fileInfo->getPathname();
        $rel = substr($abs, strlen($backupSessionDir) + 1);
        $relNorm = str_replace('\\', '/', $rel);
        if (in_array(basename($relNorm), [DEPLOY_META_FILE, 'MANIFEST.txt'], true)) {
            continue;
        }
        $files[] = $relNorm;
    }

    sort($files);

    return $files;
}

/**
 * 列出所有版本备份
 *
 * @return list<array{dir: string, meta: array<string, string>, fileCount: int}>
 */
function listVersionBackups(string $backendRoot): array
{
    $backupRoot = resolveBackupRoot($backendRoot);
    if (!is_dir($backupRoot)) {
        return [];
    }

    /** @var list<array{dir: string, meta: array<string, string>, fileCount: int}> $items */
    $items = [];
    foreach (scandir($backupRoot) ?: [] as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        $dir = $backupRoot . '/' . $name;
        if (!is_dir($dir)) {
            continue;
        }
        $meta = readDeployMeta($dir);
        $items[] = [
            'dir' => $dir,
            'meta' => $meta,
            'fileCount' => count(listBackupFiles($dir)),
        ];
    }

    usort($items, static function (array $a, array $b): int {
        $timeA = $a['meta']['backed_up_at'] ?? '';
        $timeB = $b['meta']['backed_up_at'] ?? '';
        return $timeA < $timeB ? 1 : -1;
    });

    return $items;
}

/**
 * 解析回滚目标备份目录
 */
function resolveRollbackBackupDir(string $backendRoot, ?string $targetVersion): string
{
    $backupRoot = resolveBackupRoot($backendRoot);
    $currentVersion = readDeployedVersion($backendRoot);

    if ($targetVersion !== null && $targetVersion !== '') {
        $targetLabel = sanitizeVersionLabel($targetVersion);
        $candidate = $backupRoot . '/' . formatBackupDirName($targetLabel);
        if (!is_dir($candidate)) {
            throw new RuntimeException("未找到版本 {$targetLabel} 的备份目录: {$candidate}");
        }
        return $candidate;
    }

    if ($currentVersion === null) {
        throw new RuntimeException('当前无 .deploy-version，请使用 --rollback=<版本> 指定目标');
    }

    foreach (listVersionBackups($backendRoot) as $item) {
        $replacedBy = $item['meta']['replaced_by'] ?? '';
        if ($replacedBy !== '' && sanitizeVersionLabel($replacedBy) === $currentVersion) {
            return $item['dir'];
        }
    }

    throw new RuntimeException("未找到可回滚到上一版本的备份（当前版本 {$currentVersion}）");
}

/**
 * 从版本备份恢复文件
 *
 * @return array{ok: int, fail: int, targetVersion: string}
 */
function rollbackFromBackup(string $backendRoot, string $backupSessionDir): array
{
    $meta = readDeployMeta($backupSessionDir);
    $targetVersion = $meta['version'] ?? basename($backupSessionDir);
    $targetVersion = sanitizeVersionLabel($targetVersion);

    $files = listBackupFiles($backupSessionDir);
    if ($files === []) {
        throw new RuntimeException("备份目录无可用文件: {$backupSessionDir}");
    }

    $ok = 0;
    $fail = 0;
    foreach ($files as $rel) {
        $src = $backupSessionDir . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        $dst = $backendRoot . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        try {
            assertTargetWritable($dst, $rel);
            ensureParentDir($dst);
            if (!copy($src, $dst)) {
                throw new RuntimeException('copy 失败');
            }
            echo "OK  {$rel}\n";
            $ok++;
        } catch (Throwable $e) {
            echo "FAIL {$rel} — {$e->getMessage()}\n";
            $fail++;
        }
    }

    if ($fail === 0) {
        writeDeployedVersion($backendRoot, $targetVersion);
    }

    return ['ok' => $ok, 'fail' => $fail, 'targetVersion' => $targetVersion];
}

/**
 * 优先从 MANIFEST.txt 读取文件列表，避免大 patch 全目录扫描
 *
 * @return list<string>|null
 */
function readManifestFileList(): ?array
{
    $manifestPath = PATCH_ROOT . '/MANIFEST.txt';
    if (!is_file($manifestPath)) {
        return null;
    }

    $lines = file($manifestPath, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        return null;
    }

    /** @var list<string> $files */
    $files = [];
    $inFiles = false;

    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '# files') {
            $inFiles = true;
            continue;
        }
        if ($inFiles && str_starts_with($trimmed, '#')) {
            break;
        }
        if ($inFiles && $trimmed !== '') {
            $files[] = str_replace('\\', '/', $trimmed);
        }
    }

    return $files === [] ? null : $files;
}

/**
 * @return list<string> 相对路径，使用 /
 */
function listPatchFiles(): array
{
    $fromManifest = readManifestFileList();
    if ($fromManifest !== null) {
        /** @var list<string> $files */
        $files = [];
        foreach ($fromManifest as $rel) {
            $abs = PATCH_ROOT . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
            if (!is_file($abs)) {
                continue;
            }
            if (in_array($rel, PROTECTED_RELATIVE, true)) {
                continue;
            }
            $files[] = $rel;
        }
        sort($files);
        return $files;
    }

    $files = [];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator(PATCH_ROOT, FilesystemIterator::SKIP_DOTS)
    );

    foreach ($iterator as $fileInfo) {
        if (!$fileInfo->isFile()) {
            continue;
        }

        $abs = $fileInfo->getPathname();
        $rel = substr($abs, strlen(PATCH_ROOT) + 1);
        $relNorm = str_replace('\\', '/', $rel);

        if (in_array(basename($relNorm), SKIP_FILES, true)) {
            continue;
        }
        if (in_array($relNorm, SKIP_FILES, true)) {
            continue;
        }
        if (in_array($relNorm, PROTECTED_RELATIVE, true)) {
            continue;
        }

        $skipArtifact = false;
        foreach (SKIP_PATH_PREFIXES as $prefix) {
            if (str_starts_with($relNorm, $prefix) || str_starts_with($relNorm, 'out/')) {
                $skipArtifact = true;
                break;
            }
        }
        if ($skipArtifact) {
            continue;
        }

        $files[] = $relNorm;
    }

    sort($files);

    return $files;
}

/**
 * 解析 --files / --file-list / PATCH_DEPLOY_FILES，用于单独部署部分文件
 *
 * @return list<string>|null null 表示部署全部
 */
function resolveDeployFileFilter(): ?array
{
    global $argv;

    /** @var list<string> $selected */
    $selected = [];

    $fromEnv = getenv('PATCH_DEPLOY_FILES');
    if (is_string($fromEnv) && $fromEnv !== '') {
        foreach (explode(',', $fromEnv) as $item) {
            $item = trim(str_replace('\\', '/', $item));
            if ($item !== '') {
                $selected[] = $item;
            }
        }
    }

    foreach ($argv ?? [] as $arg) {
        if (str_starts_with($arg, '--files=')) {
            foreach (explode(',', substr($arg, 8)) as $item) {
                $item = trim(str_replace('\\', '/', $item));
                if ($item !== '') {
                    $selected[] = $item;
                }
            }
        }
        if (str_starts_with($arg, '--file-list=')) {
            $listPath = substr($arg, 12);
            if (!is_file($listPath)) {
                throw new RuntimeException("文件列表不存在: {$listPath}");
            }
            foreach (file($listPath, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
                $line = trim($line);
                if ($line === '' || str_starts_with($line, '#')) {
                    continue;
                }
                $selected[] = str_replace('\\', '/', $line);
            }
        }
    }

    if ($selected === []) {
        return null;
    }

    return array_values(array_unique($selected));
}

/**
 * 按筛选条件过滤待部署文件；支持目录前缀（以 / 结尾）
 *
 * @param list<string> $allFiles
 * @param list<string> $selected
 * @return array{matched: list<string>, missing: list<string>}
 */
function filterDeployFiles(array $allFiles, array $selected): array
{
    /** @var array<string, true> $matchedMap */
    $matchedMap = [];
    /** @var list<string> $missing */
    $missing = [];

    foreach ($selected as $sel) {
        if (str_ends_with($sel, '/')) {
            $hits = array_values(array_filter($allFiles, static fn(string $f): bool => str_starts_with($f, $sel)));
            if ($hits === []) {
                $missing[] = $sel;
            } else {
                foreach ($hits as $hit) {
                    $matchedMap[$hit] = true;
                }
            }
            continue;
        }

        if (in_array($sel, $allFiles, true)) {
            $matchedMap[$sel] = true;
        } else {
            $missing[] = $sel;
        }
    }

    $matched = array_keys($matchedMap);
    sort($matched);

    return ['matched' => $matched, 'missing' => $missing];
}

function detectPhpBinary(): string
{
    if (defined('PHP_BINARY') && PHP_BINARY !== '') {
        return PHP_BINARY;
    }
    $which = trim((string) shell_exec('command -v php 2>/dev/null'));
    if ($which !== '') {
        return $which;
    }

    return 'php';
}

function formatOctalPerm(string $path): string
{
    $mode = @fileperms($path);
    if ($mode === false) {
        return '?';
    }

    return substr(sprintf('%o', $mode), -4);
}

/**
 * 读取文件属主（Linux 下便于排查 Permission denied）。
 */
function formatFileOwner(string $path): string
{
    if (!function_exists('posix_getpwuid')) {
        return '';
    }
    $uid = @fileowner($path);
    if ($uid === false) {
        return '';
    }
    $info = posix_getpwuid($uid);

    return is_array($info) ? (string) ($info['name'] ?? '') : '';
}

/**
 * 部署前检查目标是否可写；不可写时给出运维排查提示。
 */
function assertTargetWritable(string $dst, string $rel): void
{
    $dir = dirname($dst);
    if (!is_dir($dir)) {
        if (!is_writable(dirname($dir)) && is_dir(dirname($dir))) {
            $owner = formatFileOwner(dirname($dir));
            $perm = formatOctalPerm(dirname($dir));
            $who = function_exists('posix_getpwuid')
                ? (posix_getpwuid(posix_geteuid())['name'] ?? 'unknown')
                : 'unknown';
            throw new RuntimeException(
                "目录不可写: {$rel}（父目录 {$dir} owner={$owner} perm={$perm}，当前用户={$who}）"
            );
        }
        return;
    }

    if (is_file($dst) && !is_writable($dst)) {
        $owner = formatFileOwner($dst);
        $perm = formatOctalPerm($dst);
        $who = function_exists('posix_getpwuid')
            ? (posix_getpwuid(posix_geteuid())['name'] ?? 'unknown')
            : 'unknown';
        throw new RuntimeException(
            "Permission denied（owner={$owner} perm={$perm}，当前用户={$who}）"
        );
    }

    if (!is_file($dst) && !is_writable($dir)) {
        $owner = formatFileOwner($dir);
        $perm = formatOctalPerm($dir);
        $who = function_exists('posix_getpwuid')
            ? (posix_getpwuid(posix_geteuid())['name'] ?? 'unknown')
            : 'unknown';
        throw new RuntimeException(
            "目录不可写: {$dir}（owner={$owner} perm={$perm}，当前用户={$who}）"
        );
    }
}

function ensureParentDir(string $path): void
{
    $dir = dirname($path);
    if ($dir !== '' && $dir !== '.' && !is_dir($dir)) {
        if (!mkdir($dir, 0755, true) && !is_dir($dir)) {
            throw new RuntimeException("无法创建目录: {$dir}");
        }
    }
}

/**
 * 解析备份根目录：PATCH_BACKUP_DIR 优先，否则 Backend/.deploy-backups
 */
function resolveBackupRoot(string $backendRoot): string
{
    $fromEnv = getenv('PATCH_BACKUP_DIR');
    if (is_string($fromEnv) && $fromEnv !== '') {
        return rtrim($fromEnv, "/\\");
    }

    return $backendRoot . '/' . BACKUP_DIR_BASENAME;
}

/**
 * 创建本次部署的备份会话目录（按时间戳区分）
 */
function createBackupSessionDir(string $backupRoot): string
{
    $timestamp = date('Y-m-d_His');
    $sessionDir = $backupRoot . '/' . $timestamp;
    if (!is_dir($sessionDir) && !mkdir($sessionDir, 0755, true) && !is_dir($sessionDir)) {
        throw new RuntimeException("无法创建备份目录: {$sessionDir}");
    }

    return $sessionDir;
}

/**
 * 将被覆盖的线上文件复制到备份目录（保持相对路径结构）
 *
 * @return bool 是否执行了备份（目标文件不存在则 false）
 */
function backupExistingFile(string $dst, string $rel, string $backupSessionDir): bool
{
    if (!is_file($dst)) {
        return false;
    }

    $backupPath = $backupSessionDir . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
    ensureParentDir($backupPath);
    if (!copy($dst, $backupPath)) {
        throw new RuntimeException("备份失败: {$rel}");
    }

    return true;
}

function clearRuntimeCache(string $backendRoot): void
{
    $cacheDir = $backendRoot . '/runtime/cache';
    if (!is_dir($cacheDir)) {
        echo "跳过清缓存（目录不存在）: runtime/cache\n";
        return;
    }

    $items = scandir($cacheDir);
    if ($items === false) {
        echo "警告: 无法读取 runtime/cache\n";
        return;
    }

    $removed = 0;
    foreach ($items as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        $path = $cacheDir . '/' . $name;
        if (is_file($path)) {
            unlink($path);
            $removed++;
        } elseif (is_dir($path)) {
            // 递归删除子目录（ThinkPHP 缓存偶见子文件夹）
            $it = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
                RecursiveIteratorIterator::CHILD_FIRST
            );
            foreach ($it as $fi) {
                $fi->isDir() ? rmdir($fi->getPathname()) : unlink($fi->getPathname());
            }
            rmdir($path);
            $removed++;
        }
    }

    echo "已清理 runtime/cache（{$removed} 项）\n";
}

function tryThinkClear(string $backendRoot): void
{
    $think = $backendRoot . '/think';
    if (!is_file($think)) {
        return;
    }

    $phpBin = detectPhpBinary();
    $cmd = escapeshellarg($phpBin) . ' ' . escapeshellarg($think) . ' clear 2>&1';
    $output = [];
    $code = 0;
    exec($cmd, $output, $code);
    if ($code === 0) {
        echo "已执行 php think clear\n";
    } else {
        echo "提示: php think clear 未成功（可忽略，已手动清 runtime/cache）\n";
    }
}

/**
 * 识别 Backend 根目录布局
 * - ThinkPHP 6+：app/
 * - ThinkPHP 5：application/
 * - 兜底：config/、think、composer.json，或 patch 首级目录与线上对齐
 *
 * @param list<string> $patchFiles
 * @return array{valid: bool, layout: string, markers: list<string>}
 */
function validateBackendRoot(string $backendRoot, array $patchFiles = []): array
{
    /** @var list<string> $markers */
    $markers = [];

    if (is_dir($backendRoot . '/app')) {
        $markers[] = 'app/';
    }
    if (is_dir($backendRoot . '/application')) {
        $markers[] = 'application/';
    }
    if (is_dir($backendRoot . '/config')) {
        $markers[] = 'config/';
    }
    if (is_file($backendRoot . '/think')) {
        $markers[] = 'think';
    }
    if (is_file($backendRoot . '/composer.json')) {
        $markers[] = 'composer.json';
    }

    if (is_dir($backendRoot . '/app')) {
        return ['valid' => true, 'layout' => 'thinkphp6', 'markers' => $markers];
    }
    if (is_dir($backendRoot . '/application')) {
        return ['valid' => true, 'layout' => 'thinkphp5', 'markers' => $markers];
    }
    if (is_file($backendRoot . '/think') || is_dir($backendRoot . '/config')) {
        return ['valid' => true, 'layout' => 'thinkphp-legacy', 'markers' => $markers];
    }
    if (is_file($backendRoot . '/composer.json')) {
        return ['valid' => true, 'layout' => 'php-composer', 'markers' => $markers];
    }

    // 根据 patch 内路径首段推断（兼容非标准旧版目录）
    /** @var array<string, true> $topLevels */
    $topLevels = [];
    foreach ($patchFiles as $rel) {
        $parts = explode('/', $rel, 2);
        if ($parts[0] !== '') {
            $topLevels[$parts[0]] = true;
        }
    }
    /** @var list<string> $matchedTops */
    $matchedTops = [];
    foreach (array_keys($topLevels) as $top) {
        $candidate = $backendRoot . '/' . str_replace('/', DIRECTORY_SEPARATOR, $top);
        if (is_dir($candidate) || is_file($candidate)) {
            $matchedTops[] = $top . '/';
        }
    }
    if ($matchedTops !== []) {
        return [
            'valid' => true,
            'layout' => 'patch-inferred',
            'markers' => array_values(array_unique([...$markers, ...$matchedTops])),
        ];
    }

    return ['valid' => false, 'layout' => 'unknown', 'markers' => $markers];
}

// --- main ---

$listBackups = in_array('--list-backups', $argv ?? [], true);
try {
    $rollbackOption = resolveRollbackOption();
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}

$backendRoot = resolveBackendRoot();

if (!is_dir($backendRoot)) {
    fwrite(STDERR, "Backend 根目录不存在: {$backendRoot}\n");
    exit(1);
}

if ($listBackups) {
    $currentVersion = readDeployedVersion($backendRoot);
    echo "BACKEND_ROOT: {$backendRoot}\n";
    echo 'CURRENT_VERSION: ' . ($currentVersion ?? '(none)') . "\n";
    echo "BACKUP_ROOT: " . resolveBackupRoot($backendRoot) . "\n\n";

    $backups = listVersionBackups($backendRoot);
    if ($backups === []) {
        echo "暂无版本备份。\n";
        exit(0);
    }

    foreach ($backups as $item) {
        $version = $item['meta']['version'] ?? basename($item['dir']);
        $replacedBy = $item['meta']['replaced_by'] ?? '-';
        $backedUpAt = $item['meta']['backed_up_at'] ?? '-';
        echo "- {$version}  文件:{$item['fileCount']}  升级至:{$replacedBy}  时间:{$backedUpAt}\n";
        echo "  目录: {$item['dir']}\n";
    }
    exit(0);
}

if ($rollbackOption['enabled']) {
    try {
        $backupDir = resolveRollbackBackupDir($backendRoot, $rollbackOption['target']);
    } catch (Throwable $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    }

    echo "BACKEND_ROOT: {$backendRoot}\n";
    echo "ROLLBACK_FROM_BACKUP: {$backupDir}\n";

    $result = rollbackFromBackup($backendRoot, $backupDir);
    if ($result['fail'] > 0) {
        echo "\n回滚未完成: 成功 {$result['ok']}，失败 {$result['fail']}\n";
        exit(1);
    }

    clearRuntimeCache($backendRoot);
    tryThinkClear($backendRoot);
    echo "\n已回滚至版本 {$result['targetVersion']}（成功 {$result['ok']} 个文件）\n";
    exit(0);
}

$files = listPatchFiles();
if ($files === []) {
    echo "patch 包内无待部署文件。\n";
    exit(0);
}

$rootCheck = validateBackendRoot($backendRoot, $files);
if (!$rootCheck['valid']) {
    fwrite(STDERR, "目标不像 Backend 根目录（缺少 app/、application/ 或与 patch 对应的首级目录）: {$backendRoot}\n");
    if ($rootCheck['markers'] !== []) {
        fwrite(STDERR, '已检测到: ' . implode(', ', $rootCheck['markers']) . "\n");
    }
    $sample = $files[0] ?? '';
    if ($sample !== '') {
        fwrite(STDERR, "patch 示例路径: {$sample}，请确认 SITE_ROOT 指向该路径的父级项目根\n");
    }
    exit(1);
}

$dryRun = in_array('--check', $argv ?? [], true) || in_array('--dry-run', $argv ?? [], true);
$noBackup = in_array('--no-backup', $argv ?? [], true);
$backupEnabled = !$dryRun && !$noBackup;
$patchDeployVersion = resolvePatchDeployVersion();
$currentDeployedVersion = readDeployedVersion($backendRoot);
$versionBackupEnabled = $backupEnabled && $patchDeployVersion !== null;

$runUser = function_exists('posix_getpwuid')
    ? (posix_getpwuid(posix_geteuid())['name'] ?? 'unknown')
    : 'unknown';

echo "PATCH_ROOT: " . PATCH_ROOT . "\n";
echo "BACKEND_ROOT: {$backendRoot}\n";
echo "LAYOUT: {$rootCheck['layout']}";
if ($rootCheck['markers'] !== []) {
    echo ' (' . implode(', ', $rootCheck['markers']) . ')';
}
echo "\n";
echo "RUN_AS: {$runUser}\n";
if ($dryRun) {
    echo "MODE: check-only（不写入文件）\n";
}
if ($noBackup) {
    echo "BACKUP: disabled（--no-backup）\n";
} elseif ($versionBackupEnabled) {
    $backupLabel = $currentDeployedVersion ?? 'pre-deploy';
    echo "BACKUP: version -> " . resolveBackupRoot($backendRoot) . '/' . formatBackupDirName($backupLabel) . "/\n";
    echo "PATCH_VERSION: {$patchDeployVersion}\n";
    echo 'CURRENT_VERSION: ' . ($currentDeployedVersion ?? '(none)') . "\n";
} elseif ($backupEnabled) {
    echo "BACKUP: timestamp -> " . resolveBackupRoot($backendRoot) . "/<timestamp>/\n";
}

try {
    $fileFilter = resolveDeployFileFilter();
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}

if ($fileFilter !== null) {
    $filterResult = filterDeployFiles($files, $fileFilter);
    if ($filterResult['missing'] !== []) {
        fwrite(STDERR, "以下文件不在 patch 包内:\n  - " . implode("\n  - ", $filterResult['missing']) . "\n");
        exit(1);
    }
    $files = $filterResult['matched'];
    echo "DEPLOY_FILTER: " . count($files) . " 个文件（单独部署模式）\n";
}

if ($files === []) {
    echo "筛选后无待部署文件。\n";
    exit(0);
}

$ok = 0;
$fail = 0;
$blocked = [];
$backedUp = 0;
/** @var string|null 本次部署备份会话目录 */
$backupSessionDir = null;
/** @var list<string> 已备份文件列表（用于 DEPLOY-META） */
$backedUpFiles = [];

foreach ($files as $rel) {
    $src = PATCH_ROOT . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
    $dst = $backendRoot . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);

    try {
        assertTargetWritable($dst, $rel);
        if ($dryRun) {
            $existsHint = is_file($dst) ? '，线上已有文件' : '';
            echo "OK  {$rel}（可写{$existsHint}）\n";
            $ok++;
            continue;
        }

        // 覆盖前先备份线上旧文件（有 patch 版本标识时用版本目录）
        if ($backupEnabled && is_file($dst)) {
            if ($backupSessionDir === null) {
                $backupRoot = resolveBackupRoot($backendRoot);
                $backupSessionDir = $versionBackupEnabled
                    ? createVersionBackupSessionDir($backupRoot, $currentDeployedVersion ?? 'pre-deploy')
                    : createBackupSessionDir($backupRoot);
                echo "BACKUP_DIR: {$backupSessionDir}\n";
            }
            if (backupExistingFile($dst, $rel, $backupSessionDir)) {
                $backedUp++;
                $backedUpFiles[] = $rel;
            }
        }

        ensureParentDir($dst);
        if (!copy($src, $dst)) {
            throw new RuntimeException('copy 失败');
        }
        echo "OK  {$rel}\n";
        $ok++;
    } catch (Throwable $e) {
        echo "FAIL {$rel} — {$e->getMessage()}\n";
        $fail++;
        $blocked[] = $rel;
    }
}

if ($fail > 0) {
    $phpBin = detectPhpBinary();
    $sampleRel = $blocked[0] ?? ($files[0] ?? 'path/to/file.php');
    echo "\n--- 权限排查 ---\n";
    echo "当前终端用户「{$runUser}」无法覆盖源码文件（runtime/cache 可写不代表源码可写）。\n";
    echo "源码属主与 PHP-FPM 不一致时较常见：Web 终端用户与 php-fpm 运行用户不同。\n";
    echo "建议: sudo chown -R {$runUser}:{$runUser} {$backendRoot} 后，再以 {$runUser} 执行本脚本；或 sudo cp 覆盖。\n";
    echo "请在 Backend 根目录执行：\n";
    echo "  whoami\n";
    echo "  ls -ln {$sampleRel}\n";
    echo "  ps aux | grep php-fpm | head -3\n";
    echo "  command -v php\n";
    echo "常见处理方式（择一，需运维配合）：\n";
    echo "  1) sudo chown -R {$runUser}:{$runUser} {$backendRoot} && {$phpBin} apply-update.php {$backendRoot}\n";
    echo "  2) sudo cp -f {$sampleRel} {$backendRoot}/{$sampleRel}（在 patch 目录内）\n";
    echo "  3) 请运维在面板/堡垒机代为覆盖 patch 内文件\n";
    echo "注意: 勿假设固定系统用户（如 nginx/www），以 whoami 与 ls -ln 实际属主为准。\n";
    if ($blocked !== []) {
        echo "\n未写入文件数: " . count($blocked) . "\n";
    }
}

if ($dryRun) {
    echo "\n检查完成: 可写 {$ok}，不可写 {$fail}\n";
    exit($fail > 0 ? 1 : 0);
}

if ($fail > 0) {
    echo "\n存在写入失败，已跳过清缓存（避免未更新代码却刷新缓存）。\n";
    echo "完成: 成功 {$ok}，失败 {$fail}\n";
    exit(1);
}

if ($backupSessionDir !== null && $backedUpFiles !== [] && $versionBackupEnabled) {
    $backupVersionLabel = $currentDeployedVersion ?? 'pre-deploy';
    writeDeployMeta($backupSessionDir, $backupVersionLabel, $patchDeployVersion, $backedUpFiles);
}

clearRuntimeCache($backendRoot);
tryThinkClear($backendRoot);

if ($patchDeployVersion !== null) {
    writeDeployedVersion($backendRoot, $patchDeployVersion);
    echo "\nDEPLOY_VERSION: {$patchDeployVersion}\n";
}

if ($backupSessionDir !== null) {
    $sampleRel = $backedUpFiles[0] ?? ($files[0] ?? 'path/to/file.php');
    echo "\n已备份 {$backedUp} 个旧文件至: {$backupSessionDir}\n";
    if ($versionBackupEnabled) {
        echo "回滚示例: php apply-update.php --rollback " . escapeshellarg($backendRoot) . "\n";
    } else {
        echo "回滚示例: cp -f {$backupSessionDir}/{$sampleRel} {$backendRoot}/{$sampleRel}\n";
    }
}

$deletedList = PATCH_ROOT . '/MANIFEST-deleted.txt';
if (is_file($deletedList)) {
    echo "\n注意: 存在 MANIFEST-deleted.txt，未自动删除线上文件，请人工确认:\n";
    echo file_get_contents($deletedList);
}

echo "\n完成: 成功 {$ok}，失败 {$fail}\n";
exit($fail > 0 ? 1 : 0);
