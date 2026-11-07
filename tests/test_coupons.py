"""券引擎与历史定位的单元测试。

券的规则来自扩展 lib/coupon.js，本文件锁住三件最容易改坏的事：
  1. rate 券按单品向下取整（220 × 15% → 187，不是 187.0 → 186）
  2. price 券整单只减一次
  3. 拿不到判定字段的券宁可不算，也不能虚报折扣
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import coupons  # noqa: E402
import pricing  # noqa: E402


def coupon(**kwargs):
    base = {
        "coupon_id": "test.1",
        "coupon_name": "テストクーポン",
        "discount_type": "rate",
        "discount": "15",
        "condition": {},
        "issue": {},
    }
    base.update(kwargs)
    return base


class TestClassify(unittest.TestCase):
    def test_newuser_by_name(self):
        for name in ("新規ユーザー登録で500円", "新用户专享", "New user 10% off", "初回登録特典"):
            self.assertEqual(coupons.classify(coupon(coupon_name=name)), "newuser", name)

    def test_newuser_by_prefix(self):
        self.assertEqual(
            coupons.classify(coupon(coupon_name="なにか", coupon_id="ad_lp_123")), "newuser"
        )

    def test_campaign_when_regist_present_only(self):
        self.assertEqual(
            coupons.classify(coupon(issue={"regist_present": True})), "campaign"
        )

    def test_qualified_when_issue_requires_product(self):
        self.assertEqual(
            coupons.classify(coupon(issue={"product_id": "RJ000000"})), "qualified"
        )
        self.assertEqual(coupons.classify(coupon(issue={"baitai": 1})), "qualified")


class TestApplyPrice(unittest.TestCase):
    def test_rate_floors_per_item(self):
        c = coupon(discount_type="rate", discount="15")
        # 220 - floor(220*15/100)=220-33=187
        self.assertEqual(coupons.apply_price(c, 220), 187)
        # 扩展实测：小計 1,408 → 1,198（187+598+411），不是 floor(1408*0.85)=1196
        self.assertEqual(
            coupons.apply_price(c, 220) + coupons.apply_price(c, 704) + coupons.apply_price(c, 484),
            1198,
        )

    def test_price_coupon(self):
        c = coupon(discount_type="price", discount="300")
        self.assertEqual(coupons.apply_price(c, 880), 580)
        self.assertEqual(coupons.apply_price(c, 100), 0)  # 不会为负

    def test_bad_discount(self):
        self.assertIsNone(coupons.apply_price(coupon(discount="abc"), 500))


class TestApplies(unittest.TestCase):
    def ctx(self, **kwargs):
        base = {"workno": "RJ1", "price_jpy": 600, "site": "maniax", "qty": 1}
        base.update(kwargs)
        return base

    def test_price_sum_threshold(self):
        c = coupon(condition={"price_sum": [1000]})
        self.assertFalse(coupons.applies(c, self.ctx()))
        self.assertTrue(coupons.applies(c, self.ctx(price_jpy=1200)))

    def test_maximum_applicable_price(self):
        c = coupon(condition={"maximum_applicable_price": "660"})
        self.assertTrue(coupons.applies(c, self.ctx(price_jpy=660)))
        self.assertFalse(coupons.applies(c, self.ctx(price_jpy=661)))

    def test_product_targeting(self):
        c = coupon(condition={"product_id": ["RJ1"]})
        self.assertTrue(coupons.applies(c, self.ctx(workno="RJ1")))
        self.assertFalse(coupons.applies(c, self.ctx(workno="RJ2")))

    def test_site_restriction(self):
        c = coupon(condition={"site_ids": ["maniax", "home"]})
        self.assertTrue(coupons.applies(c, self.ctx(site="maniax")))
        self.assertFalse(coupons.applies(c, self.ctx(site="books")))

    def test_multi_count_coupon_rejected_for_single_item(self):
        c = coupon(condition={"post_condition": {"count": 3}})
        self.assertFalse(coupons.applies(c, self.ctx()))

    def test_maker_condition_without_data_is_rejected(self):
        # 作品侧没有 maker_id 时必须拒绝，否则会虚报折扣
        c = coupon(condition={"maker_id": ["RG01"]})
        self.assertFalse(coupons.applies(c, self.ctx()))
        self.assertTrue(coupons.applies(c, self.ctx(maker_id="RG01")))


class TestPool(unittest.TestCase):
    def build(self):
        return coupons.Pool(
            [
                coupon(
                    coupon_id="c1",
                    discount="25",
                    condition={
                        "site_ids": ["maniax"],
                        "price_sum": 0,
                        "maximum_applicable_price": "660",
                    },
                ),
                coupon(coupon_id="c2", discount_type="price", discount="300",
                       condition={"price_sum": [1000]}),
                coupon(coupon_id="c3", discount="50", condition={"product_id": ["RJ1"]}),
                coupon(coupon_id="c4", coupon_name="新規ユーザー限定", discount="90"),
            ]
        )

    def test_best_picks_cheapest_applicable(self):
        pool = self.build()
        after, best = pool.best("RJ1", 600)
        self.assertEqual(after, 300)  # c3 50% off
        self.assertEqual(best["coupon_id"], "c3")

    def test_site_inferred_from_prefix(self):
        pool = self.build()
        # RJ → maniax，c1 的 site 条件才能满足；否则只剩 600
        after, _ = pool.best("RJ2", 600)
        self.assertEqual(after, 450)

    def test_newuser_excluded(self):
        pool = self.build()
        after, best = pool.best("RJ2", 600)
        self.assertNotEqual(best["coupon_id"], "c4")
        self.assertEqual(pool.describe()["newuser"], 1)

    def test_no_coupon_returns_original(self):
        pool = coupons.Pool([])
        self.assertEqual(pool.best("RJ1", 600), (600, None))

    def test_maximum_price_blocks(self):
        pool = self.build()
        self.assertEqual(pool.best("RJ2", 700)[0], 700)


class TestPosition(unittest.TestCase):
    # 样本不足 5 天时 pct 一律为 None（新作品的分位数没有意义）
    SERIES = [100, 200, 300, 400, 500, 600]

    def test_not_low(self):
        pos = pricing.position(self.SERIES, 450)
        self.assertFalse(pos["is_low"])
        self.assertEqual(pos["pct"], 33)  # 6 天里 2 天（500/600）比它贵
        self.assertEqual(pos["min"], 100)

    def test_at_low(self):
        pos = pricing.position(self.SERIES, 100)
        self.assertTrue(pos["is_low"])
        # 6 天里 5 天比它贵，1 天与它同价 → 83%，不是 100%
        self.assertEqual(pos["pct"], 83)

    def test_below_low(self):
        pos = pricing.position(self.SERIES, 80)
        self.assertTrue(pos["is_low"])
        self.assertEqual(pos["gap"], 20)

    def test_few_points_never_claim_low(self):
        # 只有 1~4 个点就说「历史最低」是误导，宁可不说
        pos = pricing.position([100, 200], 80)
        self.assertFalse(pos["is_low"])
        self.assertIsNone(pos["pct"])

    def test_few_points_hides_pct(self):
        pos = pricing.position([100, 200], 150)
        self.assertIsNone(pos["pct"])

    def test_empty(self):
        self.assertIsNone(pricing.position([], 100))
        self.assertIsNone(pricing.position([100], None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
