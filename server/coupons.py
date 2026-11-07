"""券池与券后价计算（服务端版）。

为什么要有这一份
----------------
网站要回答「这件作品现在是不是低价」，必须把券算进去；而券的作用规则在
扩展的 lib/coupon.js 里已经用真实券集验证过。这里按同一口径移植，
只覆盖「单件作品」这一种场景（购物车的整单拆单逻辑留在扩展里）。

必须与扩展一致的三条
--------------------
1. rate 券按单品分别向下取整再相加：220×15% → 187，不是 floor(220×0.85)
2. price 券是整单只减一次，单品场景就是减一次
3. 券作用在「折扣后价格」上，即 DLsite 当前售价，不是定価

保守原则
--------
拿不到判定所需字段（maker_id / custom_genre / work_type / options）的券，
一律视为不可用 —— 宁可少算折扣，也不要把不可用的券算进去虚报低价。
"""

import json
import math
import os
import re

NEW_USER_RE = re.compile(
    r"新規ユーザー|新規登録|ユーザー登録|新用户|新用戶|new\s*user|初回登録", re.I
)

# 这些条件表示「不是谁都能用」，只进理论最低，不进最低价
QUALIFIED_ISSUES = {"product_id", "baitai", "specific_route", "price_sum"}


def _num(value):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _first_number(value):
    if isinstance(value, list):
        return _num(value[0]) if value else None
    return _num(value)


def classify(coupon):
    """newuser / qualified / campaign，规则与扩展 lib/coupon.js 一致。"""
    name = coupon.get("coupon_name") or ""
    cid = coupon.get("coupon_id") or ""
    if NEW_USER_RE.search(name) or re.match(r"^ad_lp_", cid, re.I):
        return "newuser"
    issue = coupon.get("issue")
    keys = list(issue.keys()) if isinstance(issue, dict) else []
    if not keys:
        return "campaign"
    if keys == ["regist_present"]:
        return "campaign"
    return "qualified"


def _post_count(cond):
    def pick(obj):
        if not isinstance(obj, dict):
            return 0
        n = _num(obj.get("count"))
        return int(n) if n and n > 0 else 0

    return max(pick(cond.get("post_condition")), pick(cond.get("prerequisite")))


def applies(coupon, ctx):
    """券能否用于「这件作品、买 1 件」。ctx 缺字段时按不可用处理。"""
    cond = coupon.get("condition") or {}
    price = ctx["price_jpy"]
    qty = max(1, int(ctx.get("qty") or 1))
    total = price * qty

    product_id = cond.get("product_id")
    if isinstance(product_id, list) and ctx["workno"] not in product_id:
        return False

    product_all = cond.get("product_all")
    if product_all is not None:
        if isinstance(product_all, list):
            if ctx["workno"] not in product_all:
                return False
        elif product_all is True:
            pass
        elif isinstance(product_all, str):
            if product_all != ctx["workno"]:
                return False
        else:
            return False

    maker = cond.get("maker_id")
    if isinstance(maker, list) and maker:
        if not ctx.get("maker_id") or ctx["maker_id"] not in [str(m) for m in maker]:
            return False

    site_ids = cond.get("site_ids")
    if isinstance(site_ids, list) and site_ids:
        if ctx.get("site") not in site_ids:
            return False

    genres = cond.get("custom_genre")
    if isinstance(genres, list) and genres:
        owned = set(ctx.get("custom_genres") or [])
        if not owned.intersection(genres):
            return False

    limit = _first_number(cond.get("maximum_applicable_price"))
    if limit is not None and price > limit:
        return False

    worktype = cond.get("worktype")
    if isinstance(worktype, list) and worktype:
        if ctx.get("work_type") not in worktype:
            return False

    options = cond.get("options")
    if isinstance(options, list) and options:
        owned = set(ctx.get("options") or [])
        if not owned.intersection(options):
            return False

    min_sum = _first_number(cond.get("price_sum"))
    if min_sum is not None and min_sum > 0 and total < min_sum:
        return False

    need = _post_count(cond)
    if need > 0 and qty < need:
        return False

    if cond.get("payment_route"):
        return False
    if cond.get("best_price_flg"):
        return False
    if cond.get("discount_limit"):
        return False

    return True


def apply_price(coupon, price_jpy, qty=1):
    """券后应付金额（整数円）。"""
    raw = _num(coupon.get("discount"))
    if raw is None:
        return None
    total = int(price_jpy) * qty
    if coupon.get("discount_type") == "price":
        return max(0, total - int(raw))
    if coupon.get("discount_type") == "rate":
        per = int(price_jpy) - math.floor(int(price_jpy) * raw / 100)
        return max(0, per * qty)
    return None


class Pool:
    """券池。按「是否能用于单件」预分桶，避免每件作品都遍历 500 多张券。"""

    SITE_BY_PREFIX = {"RJ": "maniax", "BJ": "books", "VJ": "pro", "RE": "maniax", "VE": "pro"}

    def __init__(self, coupons):
        self.all = coupons or []
        self.global_campaign = []  # 无作品级条件，只受金额门槛约束
        self.by_work = {}  # workno -> [coupon]
        self.counts = {"total": len(self.all), "campaign": 0, "qualified": 0, "newuser": 0}
        for coupon in self.all:
            kind = classify(coupon)
            self.counts[kind] = self.counts.get(kind, 0) + 1
            if kind != "campaign":
                continue
            cond = coupon.get("condition") or {}
            targets = cond.get("product_id")
            if isinstance(targets, list) and targets:
                for workno in targets:
                    self.by_work.setdefault(str(workno), []).append(coupon)
                continue
            if isinstance(cond.get("product_all"), str):
                self.by_work.setdefault(cond["product_all"], []).append(coupon)
                continue
            # 带 maker / genre / worktype 条件的券暂不参与（作品侧缺字段，宁可不算）
            if any(cond.get(k) for k in ("maker_id", "custom_genre", "worktype", "options")):
                continue
            self.global_campaign.append(coupon)

    def best(self, workno, price_jpy, site=None, qty=1):
        """返回 (券后价, 券)。没有可用券时返回 (原价, None)。"""
        best_price, best_coupon = int(price_jpy), None
        if not site:
            site = self.SITE_BY_PREFIX.get(str(workno)[:2])
        ctx = {"workno": workno, "price_jpy": int(price_jpy), "site": site, "qty": qty}
        for coupon in self.global_campaign + self.by_work.get(str(workno), []):
            if not applies(coupon, ctx):
                continue
            after = apply_price(coupon, price_jpy, qty)
            if after is not None and after < best_price:
                best_price, best_coupon = after, coupon
        return best_price, best_coupon

    def describe(self):
        return dict(self.counts)


def load(path):
    """从本地 JSON 载入券池；文件缺失或损坏时返回空池。"""
    if not path or not os.path.exists(path):
        return Pool([])
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return Pool([])
    return Pool(data if isinstance(data, list) else [])


_cache = {"path": None, "mtime": None, "pool": None}


def load_cached(path):
    """按文件 mtime 热加载：券池换了，下一次调用即生效。"""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return Pool([])
    if _cache["path"] != path or _cache["mtime"] != mtime:
        _cache.update(path=path, mtime=mtime, pool=load(path))
    return _cache["pool"]


def main():
    """命令行自测：python server/coupons.py --work RJ159832 --price 275"""
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", default=os.path.join(os.path.dirname(__file__), "data", "coupons.json"))
    ap.add_argument("--work", required=True)
    ap.add_argument("--price", type=int, required=True)
    args = ap.parse_args()

    pool = load(args.pool)
    print("券池：", pool.describe())
    after, coupon = pool.best(args.work, args.price)
    if coupon:
        print(
            "最優：%s → %d 円（%s %s）"
            % (coupon.get("coupon_name"), after, coupon.get("discount_type"), coupon.get("discount"))
        )
    else:
        print("无可用券：%d 円" % after)


if __name__ == "__main__":
    main()
