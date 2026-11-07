"""备份与保留策略的单元测试。"""

import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import backup  # noqa: E402
from import_history import SCHEMA  # noqa: E402


class TestBackup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dldb-backup-")
        self.src = os.path.join(self.tmp, "dlsite.db")
        conn = sqlite3.connect(self.src)
        conn.executescript(SCHEMA)
        conn.execute("INSERT INTO works(workno, title, points) VALUES('RJ1', 'テスト', 1)")
        conn.execute("INSERT INTO price_samples(workno, day, price) VALUES('RJ1', '2026-11-07', 500)")
        conn.commit()
        conn.close()

    def test_snapshot_is_readable(self):
        dest = os.path.join(self.tmp, "snap.db")
        backup.snapshot(self.src, dest)
        self.assertTrue(os.path.exists(dest))
        conn = sqlite3.connect(dest)
        try:
            self.assertEqual(conn.execute("SELECT title FROM works").fetchone()[0], "テスト")
            self.assertEqual(conn.execute("PRAGMA quick_check").fetchone()[0], "ok")
        finally:
            conn.close()

    def test_snapshot_takes_wal_into_account(self):
        # 未 checkpoint 的 WAL 内容也必须进备份
        conn = sqlite3.connect(self.src)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("INSERT INTO price_samples(workno, day, price) VALUES('RJ1', '2026-11-08', 480)")
        conn.commit()
        dest = os.path.join(self.tmp, "snap2.db")
        backup.snapshot(self.src, dest)
        conn.close()
        check = sqlite3.connect(dest)
        try:
            n = check.execute("SELECT COUNT(*) FROM price_samples").fetchone()[0]
        finally:
            check.close()
        self.assertEqual(n, 2, "WAL 里未 checkpoint 的行也应被备份")

    def test_prune_keeps_newest(self):
        folder = os.path.join(self.tmp, "backups")
        os.makedirs(folder)
        names = ["dlsite-20261101-000000.db", "dlsite-20261102-000000.db",
                 "dlsite-20261103-000000.db", "dlsite-20261104-000000.db"]
        for name in names:
            open(os.path.join(folder, name), "w").close()
        removed = backup.prune(folder, 2)
        left = sorted(os.listdir(folder))
        self.assertEqual(left, ["dlsite-20261103-000000.db", "dlsite-20261104-000000.db"])
        self.assertEqual(len(removed), 2)

    def test_prune_never_deletes_current(self):
        folder = os.path.join(self.tmp, "backups2")
        os.makedirs(folder)
        names = ["dlsite-20261101-000000.db", "dlsite-20261102-000000.db"]
        for name in names:
            open(os.path.join(folder, name), "w").close()
        # keep=1 且当前备份是最旧的那个（理论上不该发生，但保护要有）
        removed = backup.prune(folder, 1, keep_name=names[0])
        self.assertNotIn(names[0], removed)
        self.assertTrue(os.path.exists(os.path.join(folder, names[0])))


if __name__ == "__main__":
    unittest.main(verbosity=2)
