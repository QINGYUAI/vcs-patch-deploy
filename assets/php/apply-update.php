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
 */

/** patch 包根目录（本脚本所在目录） */
const PATCH_ROOT = __DIR__;

/** 部署时跳过的文件名（相对路径 basename 匹配或完整相对路径） */
const SKIP_FILES = [
    'apply-update.php',
    'MANIFEST.txt',
    'MANIFEST-deleted.txt',
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
    $flags = ['--check', '--dry-run'];
    foreach ($argv as $i => $arg) {
        if ($i === 0) {
            continue;
        }
        if (in_array($arg, $flags, true)) {
            continue;
        }
        if ($arg !== '' && !str_starts_with($arg, '-')) {
            return rtrim($arg, "/\\");
        }
    }

    fwrite(STDERR, "用法: php apply-update.php [--check] <Backend根目录>\n");
    fwrite(STDERR, "示例: php apply-update.php /path/to/production-api\n");
    exit(1);
}

/**
 * @return list<string> 相对路径，使用 /
 */
function listPatchFiles(): array
{
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

    $cmd = 'php ' . escapeshellarg($think) . ' clear 2>&1';
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

$runUser = function_exists('posix_getpwuid')
    ? (posix_getpwuid(posix_geteuid())['name'] ?? 'unknown')
    : 'unknown';

echo "PATCH_ROOT: " . PATCH_ROOT . "\n";
echo "BACKEND_ROOT: {$backendRoot}\n";
echo "RUN_AS: {$runUser}\n";
if ($dryRun) {
    echo "MODE: check-only（不写入文件）\n";
}

$files = listPatchFiles();
if ($files === []) {
    echo "patch 包内无待部署文件。\n";
    exit(0);
}

$ok = 0;
$fail = 0;
$blocked = [];

foreach ($files as $rel) {
    $src = PATCH_ROOT . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
    $dst = $backendRoot . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);

    try {
        assertTargetWritable($dst, $rel);
        if ($dryRun) {
            echo "OK  {$rel}（可写）\n";
            $ok++;
            continue;
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

$deletedList = PATCH_ROOT . '/MANIFEST-deleted.txt';
if (is_file($deletedList)) {
    echo "\n注意: 存在 MANIFEST-deleted.txt，未自动删除线上文件，请人工确认:\n";
    echo file_get_contents($deletedList);
}

echo "\n完成: 成功 {$ok}，失败 {$fail}\n";
exit($fail > 0 ? 1 : 0);
