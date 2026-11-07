"""每日券后价回填的单元测试（不联网）。"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import coupon_daily  # noqa: E402
import coupons  # noqa: E402
from import_history import SCHEMA  # noqa: E402

COUPON = {
    "coupon_id": "test.1",
    "coupon_name": "25%OFF",
    "discount_type": "rate",
    "discount": "25",
    "condition": {"site_ids": ["maniax"], "maximum_applicable_price": "660"},
    "issue": {"regist_present": True},
}


class TestCouponDaily(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dldb-daily-")
        self.db = os.path.join(self.tmp, "t.db")
        self.pool_path = os.path.join(self.tmp, "coupons.json")
        with open(self.pool_path, "w", encoding="utf-8") as fh:
            json.dump([COUPON], fh, ensure_ascii=False)

        conn = sqlite3.connect(self.db)
        conn.executescript(SCHEMA)
        conn.executemany(
            "INSERT INTO works(workno, site, current_price, points) VALUES(?,?,?,?)",
            [("RJ1", "maniax", 600, 10), ("RJ2", "maniax", 1000, 10)],
        )
        conn.commit()
        conn.close()

    def rows(self):
        conn = sqlite3.connect(self.db)
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(
                "SELECT workno, day, price, coupon_price, carried FROM price_samples ORDER BY workno"
            ).fetchall()
        finally:
            conn.close()

    def test_inserts_for_all_works(self):
        coupon_daily.run(path=self.db, pool_path=self.pool_path)
        rows = {r["workno"]: r for r in self.rows()}
        self.assertEqual(rows["RJ1"]["coupon_price"], 450)  # 600 × 75%
        self.assertEqual(rows["RJ1"]["price"], 600)
        # 价格是沿用的，必须打 carried 标记，否则会被当成实测点拉低可信度
        self.assertEqual(rows["RJ1"]["carried"], 1)
        # 1000 超过 660 上限，券不适用，券后价等于本体
        self.assertEqual(rows["RJ2"]["coupon_price"], 1000)

    def test_keeps_existing_price_of_the_day(self):
        conn = sqlite3.connect(self.db)
        today = __import__("datetime").datetime.now(
            __import__("datetime").timezone(__import__("datetime").timedelta(hours=9))
        ).strftime("%Y-%m-%d")
        # 当天已有 refresh 写入的价格（与 works.current_price 不同）
        conn.execute(
            "INSERT INTO price_samples(workno, day, price) VALUES('RJ1', ?, 580)", (today,)
        )
        conn.commit()
        conn.close()

        coupon_daily.run(path=self.db, pool_path=self.pool_path)
        row = [r for r in self.rows() if r["workno"] == "RJ1"][0]
        self.assertEqual(row["price"], 580, "已有价格不能被回填覆盖")
        self.assertEqual(row["coupon_price"], 435)  # 580 × 75%

    def test_empty_pool_is_noop(self):
        empty = os.path.join(self.tmp, "empty.json")
        with open(empty, "w", encoding="utf-8") as fh:
            json.dump([], fh)
        coupon_daily.run(path=self.db, pool_path=empty)
        self.assertEqual(len(self.rows()), 0)

    def test_dry_run_writes_nothing(self):
        coupon_daily.run(path=self.db, pool_path=self.pool_path, dry_run=True)
        self.assertEqual(len(self.rows()), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
