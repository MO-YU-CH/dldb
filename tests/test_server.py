"""站点回归测试：多语渲染、接口结构、图表边界。

跑法：
    python tests/run_all.py
"""

import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")
sys.path.insert(0, SERVER)

_TMP = tempfile.mkdtemp(prefix="dldb-test-")
os.environ["DLDB_PATH"] = os.path.join(_TMP, "test.db")

import charts  # noqa: E402
import i18n  # noqa: E402
from import_history import SCHEMA  # noqa: E402

WORK_OK = "RJ159832"
WORK_MISSING = "RJ000000"


def seed():
    conn = sqlite3.connect(os.environ["DLDB_PATH"])
    conn.executescript(SCHEMA)
    conn.execute(
        "INSERT INTO works(workno,title,circle,site,current_price,base_price,min_price,"
        "min_at,max_price,first_seen,points,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (WORK_OK, "テスト作品", "テストサークル", "maniax", 275, 550, 198, "2026-09-01",
         550, "2026-08-15", 4, "2026-11-04 00:00:00"),
    )
    conn.executemany(
        "INSERT INTO price_samples(workno, day, price) VALUES(?,?,?)",
        [
            (WORK_OK, "2026-09-01", 198),
            (WORK_OK, "2026-10-01", 550),
            (WORK_OK, "2026-11-01", 385),
            (WORK_OK, "2026-11-02", 275),
        ],
    )
    conn.commit()
    conn.close()


seed()

from app import create_app  # noqa: E402


class TestLocales(unittest.TestCase):
    def setUp(self):
        self.client = create_app().test_client()

    def test_all_locales_render(self):
        for loc in i18n.LOCALES:
            res = self.client.get("/%s/" % loc["code"])
            self.assertEqual(res.status_code, 200, loc["code"])
            html = res.get_data(as_text=True)
            self.assertIn('lang="%s"' % loc["html_lang"], html)
            self.assertIn("hreflang", html)

    def test_key_parity(self):
        base = set(i18n.STRINGS[i18n.DEFAULT_LOCALE])
        for loc in i18n.LOCALES:
            self.assertEqual(
                set(i18n.STRINGS[loc["code"]]), base, "%s 缺键" % loc["code"]
            )

    def test_root_redirects(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 302)
        self.assertIn("/ja-jp/", res.headers["Location"])


class TestPages(unittest.TestCase):
    def setUp(self):
        self.client = create_app().test_client()

    def test_work_page(self):
        res = self.client.get("/ja-jp/works/%s" % WORK_OK)
        self.assertEqual(res.status_code, 200)
        html = res.get_data(as_text=True)
        self.assertIn("テスト作品", html)
        self.assertIn("275", html)
        self.assertIn("<svg", html)
        self.assertIn("application/ld+json", html)

    def test_missing_work(self):
        res = self.client.get("/ja-jp/works/%s" % WORK_MISSING)
        self.assertEqual(res.status_code, 404)

    def test_rank_and_search(self):
        self.assertEqual(self.client.get("/ja-jp/rank").status_code, 200)
        res = self.client.get("/ja-jp/search?q=%s" % WORK_OK)
        self.assertIn(WORK_OK, res.get_data(as_text=True))

    def test_robots_and_sitemap(self):
        robots = self.client.get("/robots.txt").get_data(as_text=True)
        self.assertIn("Disallow: /api/", robots)
        self.assertIn("Sitemap:", robots)
        sitemap = self.client.get("/sitemap.xml").get_data(as_text=True)
        self.assertIn(WORK_OK, sitemap)


class TestApi(unittest.TestCase):
    def setUp(self):
        self.client = create_app().test_client()

    def test_lookup_shape(self):
        res = self.client.get("/api/lookup/dlsite/%s" % WORK_OK)
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        for key in ("workId", "url", "title", "circle", "platforms"):
            self.assertIn(key, data)
        plat = data["platforms"][0]
        for key in ("platform", "platformId", "current", "stats", "history"):
            self.assertIn(key, plat)
        self.assertEqual(plat["history"][-1], ["2026-11-02", 275])
        self.assertEqual(plat["stats"]["points"], 4)
        # 扩展读的是这几个字段，缺一不可
        for key in ("price", "basePrice", "isOnSale", "recordedAt"):
            self.assertIn(key, plat["current"])

    def test_lookup_missing(self):
        self.assertEqual(
            self.client.get("/api/lookup/dlsite/%s" % WORK_MISSING).status_code, 404
        )

    def test_unsupported_store(self):
        self.assertEqual(
            self.client.get("/api/lookup/fanza/%s" % WORK_OK).status_code, 404
        )


class TestChart(unittest.TestCase):
    def test_too_few_points(self):
        self.assertEqual(charts.render([("2026-11-01", 100)]), (None, None))

    def test_flat_price(self):
        svg, stats = charts.render(
            [("2026-11-01", 500), ("2026-11-02", 500), ("2026-11-03", 500)]
        )
        self.assertIsNotNone(svg)
        self.assertEqual(stats["min"], 500)
        self.assertEqual(stats["max"], 500)

    def test_single_point_no_crash(self):
        svg, _ = charts.render(
            [("2026-11-01", 600), ("2026-11-01", 600)]
        )
        self.assertIsNone(svg)  # 同一天两个点 → x 跨度为 0，直接放弃


if __name__ == "__main__":
    unittest.main(verbosity=2)
