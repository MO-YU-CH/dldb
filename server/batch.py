"""批量价格抓取：一次请求拿 500 件作品的当前价。

为什么要有它
------------
`product.json` 一次只能查一件，按 robots 的 Crawl-delay 10 算，2 万件要 68 小时一轮。
`/product/info/ajax?product_id=A,B,C...` 实测支持 **500 个唯一 ID / 请求**
（2.5 MB / 10.9 秒；1000 个会 414 URI Too Long）。

字段差异
--------
批量接口返回 81 个字段，含 `price` / `official_price` / `discount_rate` /
`bulkbuy_key` / `discount_end_date` / timesale，**但不含**套装的件数、折扣率、
套装单价。这三项仍要 `product.json` 补——只在 `bulkbuy_key` 变化时才补，频率很低。
"""

import json
import urllib.error
import urllib.parse
import urllib.request

BATCH_SIZE = 500
URL = "https://www.dlsite.com/{site}/product/info/ajax?product_id={ids}"
UA = "DLsiteCouponPlus/0.1 (batch refresh; +https://dlsite.momo-yu.com/about)"


def fetch_batch(worknos, site="maniax", timeout=90):
    """返回 {workno: item}。URL 过长时自动二分重试。"""
    worknos = [w for w in worknos if w]
    if not worknos:
        return {}
    ids = urllib.parse.quote(",".join(worknos), safe="")
    req = urllib.request.Request(
        URL.format(site=site, ids=ids),
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 414 and len(worknos) > 1:
            mid = len(worknos) // 2
            out = fetch_batch(worknos[:mid], site, timeout)
            out.update(fetch_batch(worknos[mid:], site, timeout))
            return out
        raise
    if not isinstance(data, dict):
        return {}
    return data


def parse(item):
    """把批量接口的单条记录转成写库用的结构。"""
    if not isinstance(item, dict):
        return None
    price = item.get("price")
    if price is None:
        return None
    base = item.get("official_price")
    return {
        "price": int(price),
        "base": int(base) if base is not None else None,
        "discount_rate": item.get("discount_rate"),
        "bulkbuy_key": item.get("bulkbuy_key"),
        "is_sale": bool(item.get("is_sale")),
        "is_timesale": bool(item.get("is_timesale")),
    }
