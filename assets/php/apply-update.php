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
 * 备份：覆盖前将线上已有文件复制到备份目录（默认 Backend/.deploy-backups/<时间戳>/）。
 */

/** patch 包根目录（本脚本所在目录） */
const PATCH_ROOT = __DIR__;

/** 默认备份目录名（位于 Backend 根下，可通过 PATCH_BACKUP_DIR 覆盖父路径） */
const BACKUP_DIR_BASENAME = '.deploy-backups';

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
    $flags = ['--check', '--dry-run', '--no-backup'];
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
        if ($arg !== '' && !str_starts_with($arg, '-')) {
            return rtrim($arg, "/\\");
        }
    }

    fwrite(STDERR, "用法: php apply-update.php [--check] [--files=<路径>] [--file-list=<列表>] <Backend根目录>\n");
    fwrite(STDERR, "示例: php apply-update.php /path/to/production-api\n");
    fwrite(STDERR, "      php apply-update.php --files=app/service/Foo.php /path/to/production-api\n");
    exit(1);
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

// --- main ---

$backendRoot = resolveBackendRoot();

if (!is_dir($backendRoot)) {
    fwrite(STDERR, "Backend 根目录不存在: {$backendRoot}\n");
    exit(1);
}

if (!is_dir($backendRoot . '/app')) {
    fwrite(STDERR, "目标不像 Backend 根目录（缺少 app/）: {$backendRoot}\n");
    exit(1);
}

$dryRun = in_array('--check', $argv ?? [], true) || in_array('--dry-run', $argv ?? [], true);
$noBackup = in_array('--no-backup', $argv ?? [], true);
$backupEnabled = !$dryRun && !$noBackup;

$runUser = function_exists('posix_getpwuid')
    ? (posix_getpwuid(posix_geteuid())['name'] ?? 'unknown')
    : 'unknown';

echo "PATCH_ROOT: " . PATCH_ROOT . "\n";
echo "BACKEND_ROOT: {$backendRoot}\n";
echo "RUN_AS: {$runUser}\n";
if ($dryRun) {
    echo "MODE: check-only（不写入文件）\n";
}
if ($noBackup) {
    echo "BACKUP: disabled（--no-backup）\n";
} elseif ($backupEnabled) {
    echo "BACKUP: enabled -> " . resolveBackupRoot($backendRoot) . "/<timestamp>/\n";
}

$files = listPatchFiles();

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
    echo "patch 包内无待部署文件。\n";
    exit(0);
}

$ok = 0;
$fail = 0;
$blocked = [];
$backedUp = 0;
/** @var string|null 本次部署备份会话目录 */
$backupSessionDir = null;

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

        // 覆盖前先备份线上旧文件
        if ($backupEnabled && is_file($dst)) {
            if ($backupSessionDir === null) {
                $backupSessionDir = createBackupSessionDir(resolveBackupRoot($backendRoot));
                echo "BACKUP_DIR: {$backupSessionDir}\n";
            }
            if (backupExistingFile($dst, $rel, $backupSessionDir)) {
                $backedUp++;
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
    echo "\n--- 权限排查 ---\n";
    echo "当前终端用户「{$runUser}」无法覆盖 app/ 下 PHP 文件（runtime/cache 可写不代表源码可写）。\n";
    echo "源码属主与 PHP-FPM 不一致时较常见：Web 终端用户与 php-fpm 运行用户不同。\n";
    echo "建议: sudo chown -R {$runUser}:{$runUser} {$backendRoot}/app 后，再以 {$runUser} 执行本脚本；或 sudo cp 覆盖。\n";
    echo "请在 Backend 根目录执行：\n";
    echo "  whoami\n";
    echo "  ls -ln app/service/admin/AdminAuthService.php\n";
    echo "  ps aux | grep php-fpm | head -3\n";
    echo "  command -v php\n";
    echo "常见处理方式（择一，需运维配合）：\n";
    echo "  1) sudo chown -R {$runUser}:{$runUser} {$backendRoot}/app && {$phpBin} apply-update.php {$backendRoot}\n";
    echo "  2) sudo cp -f app/service/... {$backendRoot}/app/service/...（在 patch 目录内）\n";
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

clearRuntimeCache($backendRoot);
tryThinkClear($backendRoot);

if ($backupSessionDir !== null) {
    echo "\n已备份 {$backedUp} 个旧文件至: {$backupSessionDir}\n";
    echo "回滚示例: cp -f {$backupSessionDir}/app/... {$backendRoot}/app/...\n";
}

$deletedList = PATCH_ROOT . '/MANIFEST-deleted.txt';
if (is_file($deletedList)) {
    echo "\n注意: 存在 MANIFEST-deleted.txt，未自动删除线上文件，请人工确认:\n";
    echo file_get_contents($deletedList);
}

echo "\n完成: 成功 {$ok}，失败 {$fail}\n";
exit($fail > 0 ? 1 : 0);
