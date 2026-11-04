#!/usr/bin/env bash
# 部署 / 热更新：打包 → 上传 → 解包 → 重启服务
#
#   bash deploy/deploy.sh              # 只更新代码（约 2 秒中断）
#   bash deploy/deploy.sh --db         # 同时同步数据库（一致性快照，会短暂停刷新任务）
#
# 依赖：Git Bash 的 scp/ssh，密钥路径见 DLDB_KEY。
set -euo pipefail

KEY="${DLDB_KEY:-F:/downloads/LightsailDefaultKey-ap-northeast-1.pem}"
HOST="${DLDB_HOST:-ubuntu@18.178.213.148}"
REMOTE_DIR="${DLDB_DIR:-/home/ubuntu/dldb}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

mkdir -p "$ROOT/temp"
PKG="$ROOT/temp/dldb-src.tgz"

echo "[1/4] 打包"
tar -czf "$PKG" -C "$ROOT" \
  --exclude='server/.venv' --exclude='server/data' --exclude='__pycache__' \
  server tests docs scripts extension deploy README.md PRIVACY.md LICENSE .gitignore .gitattributes

echo "[2/4] 上传代码"
scp -q "${SSH_OPTS[@]}" "$PKG" "$HOST:/home/ubuntu/dldb-src.tgz"

echo "[3/4] 解包"
ssh "${SSH_OPTS[@]}" "$HOST" \
  "mkdir -p $REMOTE_DIR && tar -xzf ~/dldb-src.tgz -C $REMOTE_DIR && rm -f ~/dldb-src.tgz"

if [[ "${1:-}" == "--db" ]]; then
  echo "[3.5/4] 同步数据库（一致性快照）"
  SNAP="$ROOT/temp/deploy.db"
  python - "$ROOT/server/data/dlsite.db" "$SNAP" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
with dst:
    src.backup(dst)
print("snapshot ok")
dst.close(); src.close()
PY
  ssh "${SSH_OPTS[@]}" "$HOST" "sudo systemctl stop dldb-refresh"
  scp -q "${SSH_OPTS[@]}" "$SNAP" "$HOST:$REMOTE_DIR/server/data/dlsite.db.tmp"
  ssh "${SSH_OPTS[@]}" "$HOST" \
    "rm -f $REMOTE_DIR/server/data/dlsite.db-wal $REMOTE_DIR/server/data/dlsite.db-shm && \
     mv $REMOTE_DIR/server/data/dlsite.db.tmp $REMOTE_DIR/server/data/dlsite.db"
  ssh "${SSH_OPTS[@]}" "$HOST" "sudo systemctl start dldb-refresh"
fi

echo "[4/4] 重启服务"
ssh "${SSH_OPTS[@]}" "$HOST" \
  "sudo systemctl restart dldb && sleep 1 && systemctl is-active dldb && \
   curl -s -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:8080/healthz"

echo "完成：https://dlsite.momo-yu.com"
