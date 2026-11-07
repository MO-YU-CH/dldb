"""活动页解析与入库的单元测试（不联网）。"""

import json
import os
import sqlite3
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import campaigns  # noqa: E402
import coupons  # noqa: E402
from import_history import SCHEMA  # noqa: E402

# 结构取自真实活动页：链接锚点带 title，现价在 work_price_base，定価在 strike 块里
FIXTURE = """
<ul>
  <li>
    <a href="https://www.dlsite.com/maniax/work/=/product_id/RJ01345621.html" title="惚れ薬で豹変した最強騎士">惚れ薬…</a>
    <dd class="work_price_wrap"><span class="work_price"><span class="work_price_parts">
      <span class="work_price_base">792</span><span class="work_price_suffix">円</span>
    </span></span>
    <span class="strike"><span class="work_price_parts"><span class="work_price_base">990</span></span></span>
    </dd>
  </li>
  <li>
    <a href="https://www.dlsite.com/maniax/work/=/product_id/VJ01000207.html" title="トリスティア">トリスティア</a>
    <dd class="work_price_wrap"><span class="work_price"><span class="work_price_parts">
      <span class="work_price_base">2244</span>
    </span></span>
    <span class="strike"><span class="work_price_parts"><span class="work_price_base">2640</span></span></span>
    </dd>
  </li>
</ul>
"""

BANNERS = [
    {"start": "2026-10-30T12:00:00+09:00", "end": "2026-10-12T14:00:00+09:00",
     "url": "https://www.dlsite.com/maniax-touch/campaign/discount?key=sale20261030anniv&show_type=g"},
    {"start": "2026-10-30T12:00:00+09:00", "end": "2026-11-12T14:00:00+09:00",
     "url": "https://www.dlsite.com/modpub/founding-festival2026/"},  # 无 key，应跳过
]


class TestParse(unittest.TestCase):
    def test_parse_cards(self):
        cards = campaigns.parse_cards(FIXTURE)
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0]["workno"], "RJ01345621")
        self.assertEqual(cards[0]["price"], 792)
        self.assertEqual(cards[0]["base"], 990)
        self.assertTrue(cards[0]["title"].startswith("惚れ薬"))
        self.assertEqual(cards[1]["workno"], "VJ01000207")
        self.assertEqual(cards[1]["price"], 2244)

    def test_parse_empty(self):
        self.assertEqual(campaigns.parse_cards("<html>nothing</html>"), [])

    def test_banners_skip_url_without_key(self):
        with mock.patch.object(campaigns, "_get", return_value=json.dumps(BANNERS)):
            rows = campaigns.banners("maniax")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["key"], "sale20261030anniv")


BULK_FIXTURE = """
<div><a href="https://www.dlsite.com/girls/work/=/product_id/RJ01258201.html">セフレの市原</a>
<dd class="maker_name"><a href="/x">きゃぺふろ</a></dd>
<dd class="work_price_wrap"><span class="work_price discount">616<i>円</i></span>
<span class="strike">880<i>円</i></span></dd></div>
<div><a href="https://www.dlsite.com/maniax/work/=/product_id/RJ01067308.html">別の作品</a>
<dd class="work_price_wrap"><span class="work_price discount">770<i>円</i></span></dd></div>
<h1>創業祭記念 3本以上60%OFFセット割</h1>
"""


class TestBulkbuy(unittest.TestCase):
    def test_parse_cards(self):
        cards = campaigns.parse_bulkbuy(BULK_FIXTURE)
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0]["workno"], "RJ01258201")
        self.assertEqual(cards[0]["price"], 616)
        self.assertEqual(cards[0]["base"], 880)
        self.assertIsNone(cards[1]["base"], "没有定価时不应瞎填")

    def test_parse_rule(self):
        self.assertEqual(campaigns.parse_bulkbuy_rule(BULK_FIXTURE), (3, 60))
        self.assertEqual(campaigns.parse_bulkbuy_rule("<html></html>"), (None, None))


class TestCrawlAndSave(unittest.TestCase):
    def setUp(self):
        self.tmp = __import__("tempfile").mkdtemp(prefix="dldb-camp-")
        self.path = os.path.join(self.tmp, "t.db")
        conn = sqlite3.connect(self.path)
        conn.executescript(SCHEMA)
        conn.commit()
        conn.close()

    def test_crawl_stops_on_repeat(self):
        pages = [FIXTURE, FIXTURE]  # 第二页与第一页重复 → 应停止
        with mock.patch.object(campaigns, "_get", side_effect=pages):
            cards, used = campaigns.crawl("maniax", "k", max_pages=5, page_delay=0)
        self.assertEqual(len(cards), 2)
        self.assertEqual(used, 2)

    def test_save_writes_price_and_membership(self):
        from datetime import datetime, timedelta, timezone

        day = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        pool = coupons.Pool([])
        n = campaigns.save(conn, "maniax", "sale1", "2026-10-30", "2026-11-12",
                           campaigns.parse_cards(FIXTURE), pool)
        self.assertEqual(n, 2)

        row = conn.execute("SELECT * FROM price_samples WHERE workno='RJ01345621'").fetchone()
        self.assertEqual(row["day"], day)
        self.assertEqual(row["price"], 792)
        self.assertEqual(row["carried"], 0, "活动页价格是真实观测，不能标 carried")

        camp = conn.execute("SELECT * FROM campaigns WHERE key='sale1'").fetchone()
        self.assertEqual(camp["end"], "2026-11-12")
        members = conn.execute("SELECT COUNT(*) FROM campaign_works WHERE key='sale1'").fetchone()[0]
        self.assertEqual(members, 2)

        # 从卡片价与定価反推的单品折扣（792/990 → 20%）要落库，否则套装比对会丢单品折扣
        rate = conn.execute("SELECT discount_rate FROM works WHERE workno='RJ01345621'").fetchone()[0]
        self.assertEqual(rate, 20)
        conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
