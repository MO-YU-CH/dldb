#!/usr/bin/env python
"""活动（セール）抓取：一次请求拿 50 件作品的价格。

为什么值得单独做
----------------
`/campaign/discount?key=<key>&page=N` 是服务端分页的活动页，每页 50 张卡片，
每张卡片同时带作品号、标题、现价、定価。相比之下 product.json 是一次一件。
实测同一批作品：活动页 1 请求/50 件，单件接口 50 请求/50 件。

数据来源（都是页面/接口里出现的，不是猜的）
  · 活动索引：/{site}/api/=/campaignBanner.json  → start/end + 带 key 的 url
  · 活动商品：/{site}/campaign/discount?key=...&page=N → 50 件/页
  · 单件核对：/{site}/api/=/product.json?workno=...（--verify 用）

    python server/campaigns.py --banners
    python server/campaigns.py --key sale20261030anniv --pages 2
    python server/campaigns.py --key sale20261030anniv --pages 1 --verify 5
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import coupons
import db
import migrate

JST = timezone(timedelta(hours=9))
UA = "DLsiteCouponPlus/0.1 (campaign scan; +https://dlsite.momo-yu.com/about)"
BANNER = "https://www.dlsite.com/{site}/api/=/campaignBanner.json?cdn_cache=1"
PAGE = "https://www.dlsite.com/{site}/campaign/discount?key={key}&page={page}"
PRODUCT = "https://www.dlsite.com/{site}/api/=/product.json?workno={workno}"
DELAY = 10.0  # robots.txt: Crawl-delay 10

# 卡片：链接锚点 → 现价；定価在后面的 strike 块里
CARD = re.compile(
    r'product_id/([A-Z]{2}\d+)\.html"[^>]*?title="([^"]*)"[\s\S]{0,2500}?work_price_base">(\d+)<'
)
STRIKE = re.compile(r'class="strike[\s\S]{0,300}?work_price_base">(\d+)<')
# discount 用 ?key=xxx，bulkbuy 用 /key/xxx/，两种都要认
KEY_IN_URL = re.compile(r"campaign/(?:discount|bulkbuy)[^\"']*?[?&/]key[/=]([A-Za-z0-9_]+)")


def _get(url, accept="text/html", timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", "replace")


def parse_cards(html):
    """从活动页解析卡片。返回 [{workno,title,price,base}]，按页内顺序。"""
    matches = list(CARD.finditer(html))
    cards = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else m.start() + 3000
        seg = html[m.end():end]
        strike = STRIKE.search(seg)
        cards.append(
            {
                "workno": m.group(1),
                "title": m.group(2),
                "price": int(m.group(3)),
                "base": int(strike.group(1)) if strike else None,
            }
        )
    return cards


def banners(site="maniax"):
    """活动索引。key 从 url 里解析；拿不到 key 的条目跳过（多为纯宣传页）。"""
    out = []
    for item in json.loads(_get(BANNER.format(site=site), "application/json")):
        url = item.get("url") or ""
        m = KEY_IN_URL.search(url)
        if not m:
            continue
        out.append(
            {
                "key": m.group(1),
                "url": url,
                "start": (item.get("start") or "")[:19],
                "end": (item.get("end") or "")[:19],
            }
        )
    return out


def crawl(site, key, max_pages=400, page_delay=DELAY):
    """翻页直到空页。返回 (卡片列表, 实际页数)。"""
    seen = {}
    pages = 0
    for page in range(1, max_pages + 1):
        html = _get(PAGE.format(site=site, key=key, page=page))
        cards = parse_cards(html)
        if not cards:
            break
        pages += 1
        fresh = 0
        for card in cards:
            if card["workno"] not in seen:
                seen[card["workno"]] = card
                fresh += 1
        if fresh == 0:
            break  # 翻到重复页，说明已经到底
        time.sleep(page_delay + (page_delay * 0.2))
    return list(seen.values()), pages


def verify(site, cards, sample=5, delay=DELAY):
    """抽若干张卡片，用单件接口核对价格。返回不一致列表。"""
    bad = []
    for card in cards[:sample]:
        try:
            data = json.loads(_get(PRODUCT.format(site=site, workno=card["workno"]), "application/json"))
            real = int(data[0]["price"])
        except (urllib.error.URLError, TimeoutError, ValueError, KeyError, IndexError) as exc:
            bad.append((card["workno"], card["price"], "ERR:%s" % type(exc).__name__))
            continue
        if real != card["price"]:
            bad.append((card["workno"], card["price"], real))
        time.sleep(delay)
    return bad


def save(conn, site, key, start, end, cards, pool=None):
    """落库：活动元数据、参加作品、以及当天价格（carried=0，这是真实观测）。"""
    day = datetime.now(JST).strftime("%Y-%m-%d")
    conn.execute(
        "INSERT INTO campaigns(key, site, start, end, updated_at) VALUES(?,?,?,?,datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET start=excluded.start, end=excluded.end, "
        "updated_at=excluded.updated_at",
        (key, site, start, end),
    )
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    for card in cards:
        conn.execute(
            "INSERT INTO campaign_works(key, workno, day, price, base) VALUES(?,?,?,?,?) "
            "ON CONFLICT(key, workno) DO UPDATE SET day=excluded.day, price=excluded.price, "
            "base=excluded.base",
            (key, card["workno"], day, card["price"], card["base"]),
        )
        coupon_price = pool.best(card["workno"], card["price"], site)[0] if pool else None
        conn.execute(
            "INSERT INTO price_samples(workno, day, price, coupon_price, carried) VALUES(?,?,?,?,0) "
            "ON CONFLICT(workno, day) DO UPDATE SET price=excluded.price, "
            "coupon_price=COALESCE(excluded.coupon_price, price_samples.coupon_price), carried=0",
            (card["workno"], day, card["price"], coupon_price),
        )
        db.recompute_stats(conn, card["workno"])
        conn.execute(
            "INSERT INTO works(workno, title, site, current_price, base_price, min_price, min_at, "
            "max_price, first_seen, points, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,1,?) "
            "ON CONFLICT(workno) DO UPDATE SET title=COALESCE(excluded.title, works.title), "
            "current_price=excluded.current_price, base_price=COALESCE(excluded.base_price, works.base_price), "
            "updated_at=excluded.updated_at",
            (card["workno"], card["title"], site, card["price"], card["base"], card["price"], day,
             card["price"], day, now),
        )
    conn.commit()
    return len(cards)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="maniax")
    ap.add_argument("--banners", action="store_true")
    ap.add_argument("--key", default=None)
    ap.add_argument("--all", action="store_true", help="扫描 campaignBanner 里的全部活动")
    ap.add_argument("--pages", type=int, default=2)
    ap.add_argument("--verify", type=int, default=0)
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--delay", type=float, default=DELAY)
    args = ap.parse_args()

    if args.banners:
        rows = banners(args.site)
        for row in rows:
            print("%-28s %s → %s" % (row["key"], row["start"], row["end"]))
        return 0

    if args.all:
        rows = banners(args.site)
        if not rows:
            print("没有发现带 key 的活动")
            return 0
        conn = None
        if args.save:
            conn = db.connect_rw()
            migrate.apply(conn)
        pool = coupons.load_cached(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "coupons.json")
        )
        now = datetime.now(JST).strftime("%Y-%m-%dT%H:%M:%S")
        total = 0
        for row in rows:
            if row["end"] and row["end"] < now:
                print("%-28s 已结束（%s），跳过" % (row["key"], row["end"]))
                continue
            cards, pages = crawl(args.site, row["key"], max_pages=args.pages, page_delay=args.delay)
            print("%-28s %d 页 / %d 件  %s → %s" % (row["key"], pages, len(cards),
                                                   row["start"][:10], row["end"][:10]))
            if args.save and cards:
                total += save(conn, args.site, row["key"], row["start"], row["end"], cards, pool)
        if conn:
            conn.close()
            print("合计入库 %d 件" % total)
        return 0

    if not args.key:
        ap.print_help()
        return 1

    meta = next((b for b in banners(args.site) if b["key"] == args.key), {})
    cards, pages = crawl(args.site, args.key, max_pages=args.pages, page_delay=args.delay)
    print("抓取 %d 页，解析 %d 件（去重后）" % (pages, len(cards)))
    if cards:
        sample = cards[0]
        print("示例：%s %s → %d 円（定価 %s）" % (sample["workno"], sample["title"][:16],
                                              sample["price"], sample["base"]))

    if args.verify:
        bad = verify(args.site, cards, args.verify, args.delay)
        if bad:
            print("价格不一致 %d/%d：" % (len(bad), min(args.verify, len(cards))))
            for row in bad:
                print("   ", row)
        else:
            print("价格核对通过：%d 件与单件接口一致" % min(args.verify, len(cards)))

    if args.save and cards:
        conn = db.connect_rw()
        migrate.apply(conn)
        pool = coupons.load_cached(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                "data", "coupons.json"))
        n = save(conn, args.site, args.key, meta.get("start", ""), meta.get("end", ""), cards, pool)
        conn.close()
        print("已入库 %d 件" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
