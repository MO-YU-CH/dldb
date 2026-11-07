"""批量接口与批量写库的单元测试（不联网）。"""

import os
import sqlite3
import sys
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import batch  # noqa: E402
import coupons  # noqa: E402
import refresh  # noqa: E402
from import_history import SCHEMA  # noqa: E402


class TestParse(unittest.TestCase):
    def test_parse_valid(self):
        item = batch.parse({"price": 616, "official_price": 880, "discount_rate": 30,
                            "bulkbuy_key": "set1", "is_sale": True})
        self.assertEqual(item["price"], 616)
        self.assertEqual(item["base"], 880)
        self.assertEqual(item["discount_rate"], 30)
        self.assertEqual(item["bulkbuy_key"], "set1")

    def test_parse_missing_price(self):
        self.assertIsNone(batch.parse({"official_price": 880}))
        self.assertIsNone(batch.parse(None))

    def test_parse_no_bulkbuy(self):
        item = batch.parse({"price": 275, "official_price": 550, "bulkbuy_key": None})
        self.assertIsNone(item["bulkbuy_key"])


class TestFetchBatchSplit(unittest.TestCase):
    def test_splits_on_414(self):
        calls = []

        def fake_urlopen(req, timeout=90):
            url = req.full_url
            n = url.count("%2C") + 1
            calls.append(n)
            if n > 2:
                raise urllib.error.HTTPError(url, 414, "too long", {}, None)

            class Resp:
                def __init__(self, body):
                    self._body = body

                def read(self):
                    return self._body.encode()

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

            ids = [w for w in url.split("product_id=")[1].split("%2C")]
            return Resp('{"%s": {"price": 100, "official_price": 200}}' % ids[0])

        with mock.patch.object(batch.urllib.request, "urlopen", side_effect=fake_urlopen):
            data = batch.fetch_batch(["RJ1", "RJ2", "RJ3", "RJ4", "RJ5"], "maniax")
        self.assertTrue(data, "二分后应拿到部分结果")
        self.assertTrue(all(n > 2 for n in calls[:1]), "首次应是整批请求")


class TestWriteBatch(unittest.TestCase):
    def setUp(self):
        self.tmp = __import__("tempfile").mkdtemp(prefix="dldb-batch-")
        self.path = os.path.join(self.tmp, "t.db")
        conn = sqlite3.connect(self.path)
        conn.executescript(SCHEMA)
        conn.execute(
            "INSERT INTO works(workno, site, current_price, base_price, discount_rate, "
            "bulkbuy_key, bulkbuy_items, bulkbuy_rate, bulkbuy_price, bulkbuy_end) "
            "VALUES('RJ1','maniax',600,1000,40,'set1',3,60,400,'2099-01-01 00:00:00')"
        )
        conn.commit()
        conn.close()

    def run_write(self, data, rows):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            ok, need = refresh._write_batch(conn, "maniax", rows, data, coupons.Pool([]), "2026-11-07")
            conn.commit()
            return ok, need
        finally:
            conn.close()

    def rows(self, sql, args=()):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(sql, args).fetchall()
        finally:
            conn.close()

    def test_clears_bulkbuy_when_campaign_ends(self):
        rows = [{"workno": "RJ1", "site": "maniax", "bulkbuy_key": "set1"}]
        ok, need = self.run_write({"RJ1": {"price": 700, "official_price": 1000, "bulkbuy_key": None}}, rows)
        self.assertEqual(ok, 1)
        self.assertEqual(need, [])
        work = self.rows("SELECT * FROM works WHERE workno='RJ1'")[0]
        self.assertEqual(work["current_price"], 700)
        self.assertIsNone(work["bulkbuy_key"], "活动结束必须清空，否则页面继续显示过期套装价")
        self.assertIsNone(work["bulkbuy_price"])

    def test_requests_rule_when_campaign_unknown(self):
        rows = [{"workno": "RJ1", "site": "maniax", "bulkbuy_key": "old"}]
        ok, pending = self.run_write(
            {"RJ1": {"price": 500, "official_price": 1000, "bulkbuy_key": "set2"}}, rows)
        self.assertEqual(ok, 1)
        self.assertEqual(pending, ["set2"], "未知活动要学一次规则（每个活动只学一次）")

    def test_uses_known_rule_to_derive_bundle_price(self):
        conn = sqlite3.connect(self.path)
        conn.execute(
            "INSERT INTO campaigns(key, site, kind, start, end, min_items, rate) "
            "VALUES('set2','maniax','bulkbuy','2026-10-30','2099-01-01',3,60)"
        )
        conn.commit()
        conn.close()
        rows = [{"workno": "RJ1", "site": "maniax", "bulkbuy_key": None}]
        ok, pending = self.run_write(
            {"RJ1": {"price": 700, "official_price": 1000, "bulkbuy_key": "set2"}}, rows)
        self.assertEqual(ok, 1)
        self.assertEqual(pending, [], "规则已知就不该再请求")
        work = self.rows("SELECT * FROM works WHERE workno='RJ1'")[0]
        self.assertEqual(work["bulkbuy_items"], 3)
        self.assertEqual(work["bulkbuy_rate"], 60)
        self.assertEqual(work["bulkbuy_price"], 400, "1000 × (1−60%) = 400")

    def test_missing_item_keeps_old_values(self):
        rows = [{"workno": "RJ1", "site": "maniax", "bulkbuy_key": "set1"}]
        ok, _ = self.run_write({}, rows)
        self.assertEqual(ok, 0)
        work = self.rows("SELECT * FROM works WHERE workno='RJ1'")[0]
        self.assertEqual(work["current_price"], 600)


if __name__ == "__main__":
    unittest.main(verbosity=2)
