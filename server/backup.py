#!/usr/bin/env python
"""每日一致性备份 + 保留最近 N 份。

为什么不用 cp：库在 WAL 模式，主文件 + -wal 才是完整状态，直接拷贝可能拿到
半截事务。sqlite3 的 backup API 会自己处理快照一致性，不需要停服务。

    python server/backup.py                 # 备份到 data/backups，保留 7 份
    python server/backup.py --keep 3 --dir /tmp/bk
"""

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone

import db


def snapshot(src_path, dest_path):
    src = sqlite3.connect(src_path, timeout=30)
    dest = sqlite3.connect(dest_path)
    try:
        with dest:
            src.backup(dest)
        check = dest.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("备份完整性检查失败：%s" % (check,))
    finally:
        dest.close()
        src.close()


def prune(folder, keep, keep_name=None):
    """按文件名时间戳保留最新 N 份。"""
    files = sorted(
        (f for f in os.listdir(folder) if f.startswith("dlsite-") and f.endswith(".db")),
        reverse=True,
    )
    removed = []
    for name in files[keep:]:
        if name == keep_name:
            continue
        os.remove(os.path.join(folder, name))
        removed.append(name)
    return removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "backups"))
    ap.add_argument("--keep", type=int, default=7)
    ap.add_argument("--db", default=db.db_path())
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print("数据库不存在：%s" % args.db)
        return 1

    os.makedirs(args.dir, exist_ok=True)
    name = "dlsite-%s.db" % datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(args.dir, name)

    snapshot(args.db, dest)
    size_mb = os.path.getsize(dest) / 1024.0 / 1024.0
    removed = prune(args.dir, args.keep, keep_name=name)

    print("备份完成：%s（%.1f MB）" % (dest, size_mb))
    if removed:
        print("清理旧备份：%s" % ", ".join(removed))

    left = sorted(f for f in os.listdir(args.dir) if f.endswith(".db"))
    print("当前保留 %d 份：%s" % (len(left), ", ".join(left)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
