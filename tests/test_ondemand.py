"""按需入库的单元测试（不联网，全部走 mock）。"""

import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import ondemand  # noqa: E402
from import_history import SCHEMA  # noqa: E402

ITEM = {
    "price": 742,
    "base_price": 1485,
    "title": "人生を台無しにする４つの方法",
    "circle": "茜新社",
    "site": "books",
    "discount_rate": 50,
}


class TestIngest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dldb-ondemand-")
        self.path = os.path.join(self.tmp, "t.db")
        conn = sqlite3.connect(self.path)
        conn.executescript(SCHEMA)
        conn.commit()
        conn.close()
        ondemand.reset_cache()
        ondemand.ENABLED = True
        # test_server 会通过环境变量全局关闭按需入库，这里先摘掉，测完还原
        self._env = os.environ.pop("DLDB_ONDEMAND", None)
        self._interval = ondemand.MIN_INTERVAL
        ondemand.MIN_INTERVAL = 0
        # 测试绝不联网：历史接口一律 mock 成空
        patcher = mock.patch.object(ondemand, "_fetch_history", return_value=[])
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        ondemand.MIN_INTERVAL = self._interval
        if self._env is not None:
            os.environ["DLDB_ONDEMAND"] = self._env

    def read(self, sql, args=()):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(sql, args).fetchall()
        finally:
            conn.close()

    def test_invalid_workno_rejected(self):
        # 小写会被规范化成大写，属于合法输入，不在此列
        bad = ("", "RJ", "../etc/passwd", "RJabc", "RJ12345", "123456", "RJ1234567890123")
        with mock.patch.object(ondemand, "_fetch") as fetch:
            for value in bad:
                self.assertFalse(ondemand.ingest(value, path=self.path), value)
            fetch.assert_not_called()

    def test_insert_with_single_sample(self):
        with mock.patch.object(ondemand, "_fetch", return_value=ITEM) as fetch:
            self.assertTrue(ondemand.ingest("BJ02228188", path=self.path))
            self.assertEqual(fetch.call_args[0][0], "BJ02228188")

        row = self.read("SELECT * FROM works WHERE workno='BJ02228188'")[0]
        self.assertEqual(row["current_price"], 742)
        self.assertEqual(row["base_price"], 1485)
        self.assertEqual(row["min_price"], 742)
        self.assertEqual(row["max_price"], 742)
        self.assertEqual(row["points"], 1)
        self.assertEqual(row["site"], "books")
        self.assertEqual(len(self.read("SELECT * FROM price_samples WHERE workno='BJ02228188'")), 1)

    def test_history_is_merged(self):
        with mock.patch.object(
            ondemand, "_fetch_history", return_value=[("2026-09-01", 900), ("2026-09-05", 1200)]
        ):
            with mock.patch.object(ondemand, "_fetch", return_value=ITEM):
                self.assertTrue(ondemand.ingest("RJ222222", path=self.path))
        rows = self.read("SELECT day, price FROM price_samples WHERE workno='RJ222222' ORDER BY day")
        self.assertEqual(len(rows), 3, "历史点 + 今天")
        self.assertEqual(rows[0]["price"], 900)
        work = self.read("SELECT min_price, max_price, points FROM works WHERE workno='RJ222222'")[0]
        self.assertEqual(work["min_price"], 742)  # 今天 742 低于 900/1200
        self.assertEqual(work["max_price"], 1200)
        self.assertEqual(work["points"], 3)

    def test_second_call_is_noop(self):
        with mock.patch.object(ondemand, "_fetch", return_value=ITEM):
            self.assertTrue(ondemand.ingest("BJ02228188", path=self.path))
        with mock.patch.object(ondemand, "_fetch", return_value=ITEM) as fetch:
            self.assertFalse(ondemand.ingest("BJ02228188", path=self.path))
            fetch.assert_not_called()

    def test_failure_is_cached(self):
        with mock.patch.object(ondemand, "_fetch", return_value=None) as fetch:
            self.assertFalse(ondemand.ingest("RJ999999", path=self.path))
            self.assertFalse(ondemand.ingest("RJ999999", path=self.path))
            self.assertEqual(fetch.call_count, 1, "失败结果应被缓存，避免反复打站")

    def test_site_fallback_to_maniax(self):
        calls = []

        def fake(workno, site, timeout=12):
            calls.append(site)
            return ITEM if site == "maniax" else _raise(_404())

        with mock.patch.object(ondemand, "_fetch", side_effect=fake):
            self.assertTrue(ondemand.ingest("BJ02228188", path=self.path))
        self.assertEqual(calls, ["books", "maniax"])

    def test_daily_cap(self):
        cap = ondemand.DAILY_CAP
        ondemand.DAILY_CAP = 1
        try:
            with mock.patch.object(ondemand, "_fetch", return_value=ITEM):
                self.assertTrue(ondemand.ingest("RJ111111", path=self.path))
                self.assertFalse(ondemand.ingest("RJ222222", path=self.path))
        finally:
            ondemand.DAILY_CAP = cap

    def test_disabled_switch(self):
        ondemand.ENABLED = False
        with mock.patch.object(ondemand, "_fetch", return_value=ITEM) as fetch:
            self.assertFalse(ondemand.ingest("RJ123456", path=self.path))
            fetch.assert_not_called()


def _404():
    import urllib.error

    return urllib.error.HTTPError("u", 404, "not found", {}, None)


def _raise(exc):
    raise exc


if __name__ == "__main__":
    unittest.main(verbosity=2)
