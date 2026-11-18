#!/usr/bin/env bash
#
# apply-update.php 冒烟测试（CI / 本地有 php 时运行）
# 覆盖：部署、版本备份元数据、子集包 partial、--check 只读、按版本回滚
#
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APPLY="$ROOT/assets/php/apply-update.php"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BACKEND="$TMP/backend"
mkdir -p "$BACKEND/app" "$BACKEND/config"
echo 'old' > "$BACKEND/app/a.php"

make_patch() {
  local dir="$1" version="$2" content="$3" partial="${4:-}"
  mkdir -p "$dir/app"
  printf '%s\n' "$content" > "$dir/app/a.php"
  {
    printf 'version=%s\n' "$version"
    printf 'file_count=1\n'
    if [ -n "$partial" ]; then printf 'partial=1\n'; fi
  } > "$dir/VERSION.txt"
  printf '# files\napp/a.php\n' > "$dir/MANIFEST.txt"
  cp "$APPLY" "$dir/apply-update.php"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# 1) 完整包部署：写入版本、生成带元数据的备份
make_patch "$TMP/p1" '1.0.1' 'new-1'
php "$TMP/p1/apply-update.php" --keep-backups=10 "$BACKEND" > "$TMP/out1.txt"
[ "$(cat "$BACKEND/app/a.php")" = 'new-1' ] || fail '完整包部署内容不正确'
[ "$(cat "$BACKEND/.deploy-version")" = '1.0.1' ] || fail '.deploy-version 未写入'
META1=$(find "$BACKEND/.deploy-backups" -name DEPLOY-META.txt -print -quit)
[ -n "$META1" ] || fail '未生成备份元数据'
grep -q '^version=pre-deploy$' "$META1" || fail '备份版本标签应为 pre-deploy'
grep -q '^replaced_by=1.0.1$' "$META1" || fail '备份 replaced_by 不正确'

# 2) 子集包部署：服务器识别 partial，备份元数据标记 partial=1
make_patch "$TMP/p2" '1.0.1-partial-abc123' 'new-2' partial
php "$TMP/p2/apply-update.php" --keep-backups=10 "$BACKEND" > "$TMP/out2.txt"
grep -q 'PATCH_MODE: partial' "$TMP/out2.txt" || fail '未识别 partial 包'
META2="$BACKEND/.deploy-backups/v1.0.1/DEPLOY-META.txt"
[ -f "$META2" ] || fail '未找到 v1.0.1 备份元数据'
grep -q '^partial=1$' "$META2" || fail '备份元数据缺少 partial=1'

# 3) --check 不写入文件
echo 'live' > "$BACKEND/app/a.php"
php "$TMP/p2/apply-update.php" --check "$BACKEND" > "$TMP/out3.txt"
grep -q 'MODE: check-only' "$TMP/out3.txt" || fail '--check 未进入只读模式'
[ "$(cat "$BACKEND/app/a.php")" = 'live' ] || fail '--check 修改了文件'

# 4) 按版本回滚：恢复部署 1.0.1 之前的备份
echo 'new-2' > "$BACKEND/app/a.php"
php "$TMP/p2/apply-update.php" --rollback=1.0.1 "$BACKEND" > "$TMP/out4.txt"
grep -q '已回滚至版本 1.0.1' "$TMP/out4.txt" || fail '回滚提示不正确'
[ "$(cat "$BACKEND/app/a.php")" = 'new-1' ] || fail '回滚内容不正确'
[ "$(cat "$BACKEND/.deploy-version")" = '1.0.1' ] || fail '回滚后 .deploy-version 不正确'

echo 'php-smoke: OK'
