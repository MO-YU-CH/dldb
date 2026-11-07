#!/usr/bin/env python
"""每日价格刷新：从 DLsite 公开的 product.json 取当前价，追加到本站价格库。

速率约束（来自 https://www.dlsite.com/robots.txt）
------------------------------------------------
Crawl-delay: 10 → 单进程每 10 秒 1 次请求，理论上限 8,640 次/天。
2 万件作品无法做到「一天全刷一遍」，因此这里按 updated_at 最旧优先滚动刷新：
同一件作品大致每 2~3 天更新一次，而不是每天。

用法
----
    python server/refresh.py --once --limit 50        # 刷 50 件后退出
    python server/refresh.py --loop                   # 常驻，按 10 秒间隔滚动

部署时用 systemd 常驻 + 每日日志轮转，不要用 cron 每分钟拉起（冷启动开销大于收益）。
"""

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import coupons
import db
import migrate

JST = timezone(timedelta(hours=9))
UA = "DLsiteCouponPlus/0.1 (price refresh; +https://dlsite.momo-yu.com/about)"
API = "https://www.dlsite.com/{site}/api/=/product.json?workno={workno}"
POOL_URL = "https://www.dlsite.com/home/api/=/coupon.json?cdn_cache=1"
POOL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "coupons.json")
POOL_TTL = 6 * 3600


def jst_today():
    return datetime.now(JST).strftime("%Y-%m-%d")


def refresh_pool(path=POOL_PATH, timeout=25):
    """公开券池一天会变好几次，但没必要每次都拉；失败时保留旧池。"""
    req = urllib.request.Request(
        POOL_URL, headers={"User-Agent": UA, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        print("  券池刷新失败（沿用旧池）：%s" % exc)
        return 0
    if not isinstance(data, list) or not data:
        return 0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, path)
    return len(data)


def fetch_price(workno, site, timeout=20):
    url = API.format(site=site or "maniax", workno=workno)
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        data = json.loads(res.read().decode("utf-8"))
    if not isinstance(data, list) or not data:
        return None
    item = data[0]
    price = item.get("price")
    base = item.get("official_price")
    if price is None:
        return None
    return int(price), int(base) if base is not None else None


def refresh_one(conn, workno, site, delay):
    ok = False
    try:
        got = fetch_price(workno, site)
        if got:
            price, base = got
            day = jst_today()
            after, _coupon = coupons.load_cached(POOL_PATH).best(workno, price, site)
            conn.execute(
                "INSERT OR REPLACE INTO price_samples(workno, day, price, coupon_price) "
                "VALUES(?,?,?,?)",
                (workno, day, price, after),
            )
            agg = conn.execute(
                "SELECT MIN(price) AS lo, MAX(price) AS hi, MIN(day) AS first, "
                "COUNT(*) AS n FROM price_samples WHERE workno=? AND carried=0",
                (workno,),
            ).fetchone()
            conn.execute(
                """
                UPDATE works SET current_price=?, base_price=COALESCE(?, base_price),
                       min_price=?, max_price=?, first_seen=?, points=?,
                       updated_at=datetime('now')
                WHERE workno=?
                """,
                (price, base, agg["lo"], agg["hi"], agg["first"], agg["n"], workno),
            )
            conn.commit()
            ok = True
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            print("  ! %s HTTP %s" % (workno, exc.code))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        print("  ! %s %s" % (workno, exc))

    time.sleep(delay + random.uniform(0, delay * 0.2))
    return ok


def run_once(conn, limit, delay):
    rows = conn.execute(
        "SELECT workno, site FROM works ORDER BY updated_at ASC LIMIT ?", (limit,)
    ).fetchall()
    ok = 0
    for r in rows:
        if refresh_one(conn, r["workno"], r["site"], delay):
            ok += 1
        if ok and ok % 25 == 0:
            print("  已刷新 %d/%d" % (ok, limit))
    print("本轮成功 %d / %d" % (ok, len(rows)))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--delay", type=float, default=10.0)
    args = ap.parse_args()

    print("PID=%d 间隔=%.1fs 库=%s" % (os.getpid(), args.delay, db.db_path()))
    conn = db.connect_rw()
    migrate.apply(conn)
    pool_n = refresh_pool()
    print("券池：%s" % ("%d 张" % pool_n if pool_n else "未更新，沿用旧池"))
    last_pool = time.time()
    try:
        if args.once or not args.loop:
            run_once(conn, args.limit, args.delay)
        else:
            while True:
                if time.time() - last_pool > POOL_TTL:
                    refresh_pool()
                    last_pool = time.time()
                run_once(conn, args.limit, args.delay)
    except KeyboardInterrupt:
        print("已中断")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
