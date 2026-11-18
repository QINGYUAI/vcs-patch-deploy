<?php
declare(strict_types=1);

// PHP 7.4 兼容：str_starts_with / str_ends_with 是 PHP 8.0 才内置的函数
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool
    {
        return $needle === '' || strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with(string $haystack, string $needle): bool
    {
        return $needle === '' || substr($haystack, -strlen($needle)) === $needle;
    }
}

/**
 * 堡垒机增量部署：将 patch 包内文件覆盖到线上 Backend 根目录，并清理 ThinkPHP 缓存。
 *
 * 用法（Linux Web 终端，在解压后的 patch 目录内）：
 *   php apply-update.php /path/to/production-api
 * 或设置环境变量：
 *   PATCH_BACKEND_ROOT=/path/to/production-api php apply-update.php
 *
 * 安全：不会覆盖 .env（含 .env.*）；不会自动删除 MANIFEST-deleted.txt 中列出的文件；
 *       拒绝包内绝对路径、../ 逃逸路径与符号链接。
 * 保护：包内 PROTECT.txt 列出的文件，线上已存在时跳过覆盖（不存在时仍写入）。
 * 备份：覆盖前将线上已有文件复制到版本备份目录（默认 Backend/.deploy-backups/v1.2.2/ 或 r467/）。
 *       默认保留最近 10 个备份会话（--keep-backups=N / PATCH_KEEP_BACKUPS 调整）。
 * 回滚：php apply-update.php --rollback[=版本] <Backend根目录>
 *       回滚会恢复被覆盖的旧文件（含权限），并删除本次部署新增且未被修改过的文件。
 * 列表：php apply-update.php --list-backups <Backend根目录>
 *
 * 要求 PHP >= 7.4。
 */

/** patch 包根目录（本脚本所在目录） */
const PATCH_ROOT = __DIR__;

/** 默认备份目录名（位于 Backend 根下，可通过 PATCH_BACKUP_DIR 覆盖父路径） */
const BACKUP_DIR_BASENAME = '.deploy-backups';

/** 当前线上部署版本记录文件（位于 Backend 根下） */
const DEPLOY_VERSION_FILE = '.deploy-version';

/** 版本备份元数据文件名 */
const DEPLOY_META_FILE = 'DEPLOY-META.txt';

/** 备份会话标记文件（用于清理失败/无元数据的旧会话） */
const BACKUP_SESSION_MARKER = '.deploy-backup-session';

/** 部署时跳过的文件名（相对路径 basename 匹配或完整相对路径） */
const SKIP_FILES = [
    'apply-update.php',
    'MANIFEST.txt',
    'MANIFEST-deleted.txt',
    'VERSION.txt',
    'PROTECT.txt',
    'MODES.txt',
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
        if (str_starts_with($arg, '--keep-backups=')) {
            continue;
        }
        if ($arg !== '' && !str_starts_with($arg, '-')) {
            return rtrim($arg, "/\\");
        }
    }

    fwrite(STDERR, "用法: php apply-update.php [--check] [--rollback[=版本]] [--list-backups] [--keep-backups=N] [--files=<路径>] <Backend根目录>\n");
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
 * 判断包内相对路径是否安全（拒绝绝对路径、盘符、.. 逃逸与空字节）
 */
function isSafeRelativePath(string $rel): bool
{
    if ($rel === '' || strpos($rel, "\0") !== false) {
        return false;
    }

    $normalized = str_replace('\\', '/', $rel);
    if (str_starts_with($normalized, '/') || preg_match('#^[A-Za-z]:/#', $normalized) === 1) {
        return false;
    }

    foreach (explode('/', $normalized) as $segment) {
        if ($segment === '..') {
            return false;
        }
    }

    return true;
}

/**
 * 永不覆盖的生产配置（根目录与任意目录下的 .env / .env.*）
 */
function isProtectedRelativePath(string $rel): bool
{
    $normalized = str_replace('\\', '/', $rel);
    if (in_array($normalized, PROTECTED_RELATIVE, true)) {
        return true;
    }

    $base = basename($normalized);

    return $base === '.env' || str_starts_with($base, '.env.');
}

/**
 * 读取包内 PROTECT.txt（每行一个相对路径，# 为注释）
 *
 * 受保护语义：线上已存在则跳过覆盖；线上不存在时仍写入（便于首次部署）。
 *
 * @return array<string, bool>
 */
function readProtectList(): array
{
    static $cache = null;
    if (is_array($cache)) {
        return $cache;
    }

    $cache = [];
    $path = PATCH_ROOT . '/PROTECT.txt';
    if (!is_file($path)) {
        return $cache;
    }

    $lines = file($path, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        return $cache;
    }

    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '#')) {
            continue;
        }
        $rel = str_replace('\\', '/', $trimmed);
        if (!isSafeRelativePath($rel)) {
            fwrite(STDERR, "忽略 PROTECT.txt 中的不安全路径: {$rel}\n");
            continue;
        }
        $cache[$rel] = true;
    }

    return $cache;
}

/**
 * 是否在包内保护清单中
 */
function isProtectListed(string $rel): bool
{
    $list = readProtectList();

    return isset($list[str_replace('\\', '/', $rel)]);
}

/**
 * exec 是否可用（disable_functions 可能在堡垒机环境禁用）
 */
function isExecAvailable(): bool
{
    if (!function_exists('exec')) {
        return false;
    }

    $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));

    return !in_array('exec', $disabled, true);
}

/**
 * 读取包内 MODES.txt（可执行文件清单）
 *
 * @return array<string, int> 相对路径 -> 权限（如 0755）
 */
function readModesList(): array
{
    static $cache = null;
    if (is_array($cache)) {
        return $cache;
    }

    $cache = [];
    $path = PATCH_ROOT . '/MODES.txt';
    if (!is_file($path)) {
        return $cache;
    }

    $lines = file($path, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        return $cache;
    }

    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || str_starts_with($trimmed, '#')) {
            continue;
        }
        if (preg_match('/^([0-7]{3,4})\s+(.+)$/', $trimmed, $m) !== 1) {
            continue;
        }
        $rel = str_replace('\\', '/', trim($m[2]));
        if (!isSafeRelativePath($rel)) {
            continue;
        }
        $cache[$rel] = octdec($m[1]);
    }

    return $cache;
}

/**
 * 规范化路径用于比较（Windows 不区分大小写）
 */
function normalizeComparablePath(string $path): string
{
    $norm = str_replace('\\', '/', rtrim($path, "/\\"));
    if (DIRECTORY_SEPARATOR === '\\') {
        $norm = strtolower($norm);
    }

    return $norm;
}

/**
 * 判断路径是否位于某个目录之下
 */
function isPathInside(string $child, string $parent): bool
{
    $c = normalizeComparablePath($child);
    $p = normalizeComparablePath($parent);

    return $c === $p || str_starts_with($c . '/', $p . '/');
}

/**
 * 覆盖前校验目标路径：
 *   - 目标本身不能是符号链接（避免写到链接指向的任意文件）
 *   - 最近的已存在父目录 realpath 必须仍在 Backend 根内（避免父目录软链逃逸）
 */
function assertTargetInsideBackend(string $backendRoot, string $dst, string $rel): void
{
    if (is_link($dst)) {
        throw new RuntimeException('目标是符号链接（拒绝覆盖）');
    }

    $rootReal = realpath($backendRoot);
    if ($rootReal === false) {
        return;
    }

    $probe = dirname($dst);
    while (!is_dir($probe) && dirname($probe) !== $probe) {
        $probe = dirname($probe);
    }

    $probeReal = realpath($probe);
    if ($probeReal === false) {
        throw new RuntimeException('无法解析目标父目录');
    }

    if (!isPathInside($probeReal, $rootReal)) {
        throw new RuntimeException("目标路径越出 Backend 根目录（疑似符号链接）: {$rel}");
    }
}

/**
 * 备份会话保留数量（--keep-backups=N / PATCH_KEEP_BACKUPS，默认 10）
 */
function resolveKeepBackups(): int
{
    global $argv;

    foreach ($argv ?? [] as $arg) {
        if (str_starts_with($arg, '--keep-backups=')) {
            $n = (int) substr($arg, strlen('--keep-backups='));
            return $n > 0 ? $n : 10;
        }
    }

    $fromEnv = getenv('PATCH_KEEP_BACKUPS');
    if (is_string($fromEnv) && preg_match('/^\d+$/', $fromEnv) === 1) {
        $n = (int) $fromEnv;
        return $n > 0 ? $n : 10;
    }

    return 10;
}

/**
 * 递归删除目录（仅用于清理旧备份会话）
 */
function removeDirectoryTree(string $dir): bool
{
    if (!is_dir($dir)) {
        return true;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($iterator as $item) {
        $path = $item->getPathname();
        if ($item->isDir() && !$item->isLink()) {
            @rmdir($path);
        } else {
            @unlink($path);
        }
    }

    return @rmdir($dir);
}

/**
 * 清理超出保留数量的备份会话（含 DEPLOY-META.txt 或本工具写入的会话标记）
 *
 * @param string|null $excludeDir 当前部署刚创建的会话（始终保留）
 * @return list<string> 被删除的会话名
 */
function pruneBackupSessions(string $backendRoot, int $keep, ?string $excludeDir = null): array
{
    $backupRoot = resolveBackupRoot($backendRoot);
    if (!is_dir($backupRoot)) {
        return [];
    }

    /** @var list<array{dir: string, mtime: int}> $sessions */
    $sessions = [];
    /** @var list<array{dir: string, mtime: int}> $incomplete */
    $incomplete = [];
    foreach (scandir($backupRoot) ?: [] as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        $dir = $backupRoot . '/' . $name;
        if (!is_dir($dir)) {
            continue;
        }
        if ($excludeDir !== null && normalizeComparablePath($dir) === normalizeComparablePath($excludeDir)) {
            continue;
        }

        $item = ['dir' => $dir, 'mtime' => (int) @filemtime($dir)];
        if (is_file($dir . '/' . DEPLOY_META_FILE)) {
            $sessions[] = $item;
        } elseif (is_file($dir . '/' . BACKUP_SESSION_MARKER)) {
            // 中断/旧包的会话：没有元数据，不计入保留数量，单独按时间清理
            $incomplete[] = $item;
        }
    }

    usort($sessions, static function (array $a, array $b): int {
        $timeA = readDeployMeta($a['dir'])['backed_up_at'] ?? '';
        $timeB = readDeployMeta($b['dir'])['backed_up_at'] ?? '';
        if ($timeA !== $timeB) {
            return $timeA < $timeB ? 1 : -1;
        }
        if ($a['mtime'] !== $b['mtime']) {
            return $b['mtime'] <=> $a['mtime'];
        }
        return strcmp(basename($b['dir']), basename($a['dir']));
    });

    // 保留数量包含当前会话
    $keepOthers = max(0, max(1, $keep) - ($excludeDir !== null ? 1 : 0));
    /** @var list<string> $removed */
    $removed = [];
    foreach (array_slice($sessions, $keepOthers) as $item) {
        if (removeDirectoryTree($item['dir'])) {
            $removed[] = basename($item['dir']);
        }
    }

    // 中断会话最多保留 5 个，且只保留最近 24 小时
    $cutoff = time() - 86400;
    usort($incomplete, static function (array $a, array $b): int {
        return $b['mtime'] <=> $a['mtime'];
    });
    foreach ($incomplete as $index => $item) {
        if ($index < 5 && $item['mtime'] >= $cutoff) {
            continue;
        }
        if (removeDirectoryTree($item['dir'])) {
            $removed[] = basename($item['dir']);
        }
    }

    return $removed;
}

/**
 * 备份目录位于站点根内时，尽量阻止 Web 直接访问（Apache；nginx 需在配置中 deny）
 */
function protectBackupDir(string $backupRoot): void
{
    if (!is_dir($backupRoot) && !mkdir($backupRoot, 0755, true) && !is_dir($backupRoot)) {
        return;
    }

    $htaccess = $backupRoot . '/.htaccess';
    if (!is_file($htaccess)) {
        @file_put_contents(
            $htaccess,
            "# 备份包含历史源码，禁止 Web 访问\n<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Deny from all\n</IfModule>\n"
        );
    }

    $index = $backupRoot . '/index.html';
    if (!is_file($index)) {
        @file_put_contents($index, "Forbidden\n");
    }
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

    markBackupSession($sessionDir);

    return $sessionDir;
}

/**
 * 写入版本备份元数据
 *
 * @param list<string> $backedUpFiles 本次被覆盖的旧文件（已备份到本目录）
 * @param list<array{hash: string, rel: string}> $createdFiles 本次新增的文件（回滚时删除）
 * @param array<string, int> $modes 被覆盖文件的原始权限（回滚时恢复）
 * @param bool $partial 是否来自部分部署（子集包）
 */
function writeDeployMeta(
    string $backupSessionDir,
    string $versionLabel,
    ?string $replacedBy,
    array $backedUpFiles,
    array $createdFiles = [],
    array $modes = [],
    bool $partial = false
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
    if ($partial) {
        $lines[] = 'partial=1';
    }
    $lines[] = '';
    $lines[] = '# files';
    foreach ($backedUpFiles as $rel) {
        $lines[] = $rel;
    }

    if ($modes !== []) {
        $lines[] = '';
        $lines[] = '# modes';
        foreach ($modes as $rel => $mode) {
            $lines[] = sprintf('%04o  %s', $mode, $rel);
        }
    }

    if ($createdFiles !== []) {
        $lines[] = '';
        $lines[] = '# created';
        foreach ($createdFiles as $item) {
            $lines[] = $item['hash'] . '  ' . $item['rel'];
        }
    }

    file_put_contents($backupSessionDir . '/' . DEPLOY_META_FILE, implode("\n", $lines) . "\n");
}

/**
 * 读取 DEPLOY-META 中的 # modes 段（回滚恢复权限）
 *
 * @return array<string, int>
 */
function readMetaModes(string $backupSessionDir): array
{
    $path = $backupSessionDir . '/' . DEPLOY_META_FILE;
    if (!is_file($path)) {
        return [];
    }

    /** @var array<string, int> $modes */
    $modes = [];
    $inModes = false;

    foreach (file($path, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        $trimmed = trim($line);
        if ($trimmed === '# modes') {
            $inModes = true;
            continue;
        }
        if ($inModes && str_starts_with($trimmed, '#')) {
            break;
        }
        if ($inModes && preg_match('/^([0-7]{3,4})\s+(.+)$/', $trimmed, $m) === 1) {
            $rel = str_replace('\\', '/', trim($m[2]));
            if (isSafeRelativePath($rel)) {
                $modes[$rel] = octdec($m[1]);
            }
        }
    }

    return $modes;
}

/**
 * 读取元数据中本次部署新增的文件（用于回滚时删除）
 *
 * @return list<array{hash: string, rel: string}>
 */
function readMetaCreatedFiles(string $backupSessionDir): array
{
    $metaPath = $backupSessionDir . '/' . DEPLOY_META_FILE;
    if (!is_file($metaPath)) {
        return [];
    }

    $lines = file($metaPath, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        return [];
    }

    /** @var list<array{hash: string, rel: string}> $items */
    $items = [];
    $inCreated = false;

    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '# created') {
            $inCreated = true;
            continue;
        }
        if ($inCreated && str_starts_with($trimmed, '#')) {
            break;
        }
        if ($inCreated && $trimmed !== '' && preg_match('/^([0-9a-f]{64})\s+(.+)$/i', $trimmed, $m) === 1) {
            $rel = str_replace('\\', '/', trim($m[2]));
            if (isSafeRelativePath($rel)) {
                $items[] = ['hash' => strtolower($m[1]), 'rel' => $rel];
            }
        }
    }

    return $items;
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
        if (in_array(basename($relNorm), [DEPLOY_META_FILE, BACKUP_SESSION_MARKER, 'MANIFEST.txt'], true)) {
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
        // 没有元数据的中断会话不列入可回滚版本（仍会被保留策略清理）
        if ($meta === []) {
            continue;
        }
        $items[] = [
            'dir' => $dir,
            'meta' => $meta,
            'fileCount' => count(listBackupFiles($dir)),
        ];
    }

    usort($items, static function (array $a, array $b): int {
        $timeA = $a['meta']['backed_up_at'] ?? '';
        $timeB = $b['meta']['backed_up_at'] ?? '';
        if ($timeA !== $timeB) {
            return $timeA < $timeB ? 1 : -1;
        }
        $mA = (int) @filemtime($a['dir']);
        $mB = (int) @filemtime($b['dir']);
        if ($mA !== $mB) {
            return $mB <=> $mA;
        }
        // 同秒部署：带 _时间戳 后缀的会话更新，排在基础目录之前
        return strcmp(basename($b['dir']), basename($a['dir']));
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

        // 同一版本可能重复部署（目录会追加 _时间戳），取最近一次会话
        foreach (listVersionBackups($backendRoot) as $item) {
            $metaVersion = sanitizeVersionLabel($item['meta']['version'] ?? '');
            if ($metaVersion === $targetLabel) {
                return $item['dir'];
            }
        }

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
 * 恢复备份的旧文件；并删除本次部署新增的文件（仅当内容未被修改过）。
 *
 * @return array{ok: int, fail: int, removed: int, kept: int, targetVersion: string}
 */
function rollbackFromBackup(string $backendRoot, string $backupSessionDir): array
{
    $meta = readDeployMeta($backupSessionDir);
    $targetVersion = $meta['version'] ?? basename($backupSessionDir);
    $targetVersion = sanitizeVersionLabel($targetVersion);

    if (($meta['partial'] ?? '') === '1') {
        echo "注意: 该备份来自部分部署（子集包），只会恢复其中的文件。\n";
    }

    $files = listBackupFiles($backupSessionDir);
    $createdFiles = readMetaCreatedFiles($backupSessionDir);
    $modes = readMetaModes($backupSessionDir);
    if ($files === [] && $createdFiles === []) {
        throw new RuntimeException("备份目录无可用文件: {$backupSessionDir}");
    }

    $ok = 0;
    $fail = 0;
    foreach ($files as $rel) {
        $src = $backupSessionDir . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        $dst = $backendRoot . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        try {
            assertTargetInsideBackend($backendRoot, $dst, $rel);
            assertTargetWritable($dst, $rel);
            ensureParentDir($dst);
            if (!copy($src, $dst)) {
                throw new RuntimeException('copy 失败');
            }
            if (isset($modes[$rel])) {
                @chmod($dst, $modes[$rel]);
            }
            echo "OK  {$rel}\n";
            $ok++;
        } catch (Throwable $e) {
            echo "FAIL {$rel} — {$e->getMessage()}\n";
            $fail++;
        }
    }

    // 删除本次部署新增的文件；内容已变化则保留现场，避免误删后续改动
    $removed = 0;
    $kept = 0;
    foreach ($createdFiles as $item) {
        $rel = $item['rel'];
        if (isProtectedRelativePath($rel) || isProtectListed($rel)) {
            echo "SKIP {$rel} — 受保护路径\n";
            $kept++;
            continue;
        }

        $dst = $backendRoot . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
        if (!is_file($dst)) {
            echo "SKIP {$rel} — 已不存在\n";
            continue;
        }

        $currentHash = @hash_file('sha256', $dst);
        if (!is_string($currentHash) || !hash_equals($item['hash'], $currentHash)) {
            echo "SKIP {$rel} — 部署后已被修改，保留\n";
            $kept++;
            continue;
        }

        if (@unlink($dst)) {
            echo "DELETED {$rel}\n";
            $removed++;
        } else {
            echo "FAIL-DELETE {$rel} — 无法删除\n";
            $fail++;
        }
    }

    if ($fail === 0) {
        writeDeployedVersion($backendRoot, $targetVersion);
    }

    return [
        'ok' => $ok,
        'fail' => $fail,
        'removed' => $removed,
        'kept' => $kept,
        'targetVersion' => $targetVersion,
    ];
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
            if (!isSafeRelativePath($rel)) {
                throw new RuntimeException("MANIFEST.txt 含不安全路径（拒绝部署）: {$rel}");
            }
            $abs = PATCH_ROOT . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
            if (!is_file($abs)) {
                continue;
            }
            if (is_link($abs)) {
                throw new RuntimeException("patch 包内含符号链接（拒绝部署）: {$rel}");
            }
            if (isProtectedRelativePath($rel)) {
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

        if (!isSafeRelativePath($relNorm)) {
            throw new RuntimeException("patch 包内含不安全路径（拒绝部署）: {$relNorm}");
        }
        if ($fileInfo->isLink()) {
            throw new RuntimeException("patch 包内含符号链接（拒绝部署）: {$relNorm}");
        }

        if (in_array(basename($relNorm), SKIP_FILES, true)) {
            continue;
        }
        if (in_array($relNorm, SKIP_FILES, true)) {
            continue;
        }
        if (isProtectedRelativePath($relNorm)) {
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
 * 输出 MANIFEST-deleted.txt 提示（不自动删除线上文件）
 */
function printDeletedNotice(): void
{
    $deletedList = PATCH_ROOT . '/MANIFEST-deleted.txt';
    if (!is_file($deletedList)) {
        return;
    }

    echo "\n注意: 存在 MANIFEST-deleted.txt，未自动删除线上文件，请人工确认:\n";
    echo file_get_contents($deletedList);
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
    if (!function_exists('shell_exec')) {
        return 'php';
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

    markBackupSession($sessionDir);

    return $sessionDir;
}

/**
 * 标记本工具创建的备份会话（即使部署中断、没有 DEPLOY-META 也能被保留策略清理）
 */
function markBackupSession(string $sessionDir): void
{
    @file_put_contents(
        $sessionDir . '/' . BACKUP_SESSION_MARKER,
        "session=1\ncreated_at=" . date('Y-m-d H:i:s') . "\n"
    );
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

    if (!isExecAvailable()) {
        echo "提示: exec 被 disable_functions 禁用，跳过 php think clear（已清理 runtime/cache）\n";
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
    echo "\n已回滚至版本 {$result['targetVersion']}（恢复 {$result['ok']} 个文件，删除 {$result['removed']} 个新增文件）\n";
    if ($result['kept'] > 0) {
        echo "保留 {$result['kept']} 个新增文件（部署后已修改或受保护）\n";
    }
    exit(0);
}

try {
    $files = listPatchFiles();
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}

if ($files === []) {
    echo "patch 包内无待部署文件。\n";
    // 仅含删除项的包没有可部署文件，但仍需提示人工删除
    printDeletedNotice();
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
$patchMeta = readKeyValueFile(PATCH_ROOT . '/VERSION.txt');
$isPartialDeploy = ($patchMeta['partial'] ?? '') === '1';

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
if (readProtectList() !== []) {
    echo 'PROTECT: ' . count(readProtectList()) . " 个文件（线上已存在则跳过覆盖）\n";
}
if ($dryRun) {
    echo "MODE: check-only（不写入文件）\n";
}
if ($isPartialDeploy) {
    echo "PATCH_MODE: partial（子集包，回滚只覆盖其中的文件）\n";
}
if ($noBackup) {
    echo "BACKUP: disabled（--no-backup）\n";
} elseif ($versionBackupEnabled) {
    $backupLabel = $currentDeployedVersion ?? 'pre-deploy';
    echo "BACKUP: 按当前版本 {$backupLabel} 建立备份会话（重复部署追加时间戳）\n";
    echo "PATCH_VERSION: {$patchDeployVersion}\n";
    echo 'CURRENT_VERSION: ' . ($currentDeployedVersion ?? '(none)') . "\n";
} elseif ($backupEnabled) {
    echo "BACKUP: timestamp -> " . resolveBackupRoot($backendRoot) . "/<timestamp>/\n";
}

if ($backupEnabled) {
    $backupRootForCheck = resolveBackupRoot($backendRoot);
    if (isPathInside($backupRootForCheck, $backendRoot)) {
        echo "WARN: 备份目录位于 Backend 根内（{$backupRootForCheck}），历史源码可能被 Web 访问；\n";
        echo "      建议将 PATCH_BACKUP_DIR 指向站点根外，或在 Web 配置中禁止访问该目录\n";
        protectBackupDir($backupRootForCheck);
    }
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
    printDeletedNotice();
    exit(0);
}

$ok = 0;
$fail = 0;
$protectedSkipped = 0;
$blocked = [];
$backedUp = 0;
$modesList = readModesList();
/** @var array<string, int> 被覆盖文件的原始权限（回滚时恢复） */
$backedUpModes = [];
/** @var string|null 本次部署备份会话目录 */
$backupSessionDir = null;
/** @var list<string> 已备份文件列表（用于 DEPLOY-META） */
$backedUpFiles = [];
/** @var list<array{hash: string, rel: string}> 本次新增文件（用于回滚删除） */
$createdFiles = [];

foreach ($files as $rel) {
    $src = PATCH_ROOT . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);
    $dst = $backendRoot . '/' . str_replace('/', DIRECTORY_SEPARATOR, $rel);

    try {
        if (!isSafeRelativePath($rel)) {
            throw new RuntimeException('路径不安全');
        }

        // 受保护文件：线上已存在则不覆盖（保留运行时被程序改写的内容）
        if (isProtectListed($rel) && is_file($dst)) {
            echo "SKIP {$rel} — 受保护文件（线上已存在，未覆盖）\n";
            $protectedSkipped++;
            continue;
        }

        assertTargetInsideBackend($backendRoot, $dst, $rel);
        assertTargetWritable($dst, $rel);
        if ($dryRun) {
            $existsHint = is_file($dst) ? '，线上已有文件' : '';
            echo "OK  {$rel}（可写{$existsHint}）\n";
            $ok++;
            continue;
        }

        $isNewFile = !is_file($dst);

        // 本次部署的备份会话（覆盖旧文件或新增文件都需要，便于回滚时删除新增文件）
        if ($backupEnabled && $backupSessionDir === null) {
            $backupRoot = resolveBackupRoot($backendRoot);
            $backupSessionDir = $versionBackupEnabled
                ? createVersionBackupSessionDir($backupRoot, $currentDeployedVersion ?? 'pre-deploy')
                : createBackupSessionDir($backupRoot);
            echo "BACKUP_DIR: {$backupSessionDir}\n";
        }

        // 覆盖前先备份线上旧文件（有 patch 版本标识时用版本目录），并记录原权限
        if ($backupEnabled && !$isNewFile) {
            $origMode = @fileperms($dst);
            if ($origMode !== false) {
                $backedUpModes[$rel] = $origMode & 0777;
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
        if (isset($modesList[$rel]) && !@chmod($dst, $modesList[$rel])) {
            echo "WARN {$rel} — 无法设置权限 0" . decoct($modesList[$rel]) . "\n";
        }
        if ($isNewFile) {
            $hash = @hash_file('sha256', $dst);
            if (is_string($hash)) {
                $createdFiles[] = ['hash' => $hash, 'rel' => $rel];
            }
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
    echo "\n检查完成: 可写 {$ok}，不可写 {$fail}";
    if ($protectedSkipped > 0) {
        echo "，跳过 {$protectedSkipped}（受保护）";
    }
    echo "\n";
    printDeletedNotice();
    exit($fail > 0 ? 1 : 0);
}

if ($fail > 0) {
    echo "\n存在写入失败，已跳过清缓存（避免未更新代码却刷新缓存）。\n";
    echo "完成: 成功 {$ok}，失败 {$fail}";
    if ($protectedSkipped > 0) {
        echo "，跳过 {$protectedSkipped}（受保护）";
    }
    echo "\n";
    exit(1);
}

if (
    $backupSessionDir !== null
    && $backupEnabled
) {
    $backupVersionLabel = $currentDeployedVersion ?? 'pre-deploy';
    writeDeployMeta(
        $backupSessionDir,
        $backupVersionLabel,
        $patchDeployVersion,
        $backedUpFiles,
        $createdFiles,
        $backedUpModes,
        $isPartialDeploy
    );
}

clearRuntimeCache($backendRoot);
tryThinkClear($backendRoot);

if ($patchDeployVersion !== null) {
    writeDeployedVersion($backendRoot, $patchDeployVersion);
    echo "\nDEPLOY_VERSION: {$patchDeployVersion}\n";
}

// 备份会话保留策略（默认 10 个），避免 .deploy-backups 无限增长
if ($backupEnabled && $backupSessionDir !== null) {
    $keepBackups = resolveKeepBackups();
    $prunedSessions = pruneBackupSessions($backendRoot, $keepBackups, $backupSessionDir);
    if ($prunedSessions !== []) {
        echo "\n已清理旧备份会话 " . count($prunedSessions) . " 个（保留最近 {$keepBackups} 个）\n";
        echo '  删除: ' . implode(', ', $prunedSessions) . "\n";
    }
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

printDeletedNotice();

echo "\n完成: 成功 {$ok}，失败 {$fail}";
if ($protectedSkipped > 0) {
    echo "，跳过 {$protectedSkipped}（受保护）";
}
echo "\n";
exit($fail > 0 ? 1 : 0);
