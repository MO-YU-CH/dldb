#!/usr/bin/env python
"""每日价格刷新：从 DLsite 公开的 product.json 取当前价，追加到本站价格库。

速率约束（来自 https://www.dlsite.com/robots.txt）
------------------------------------------------
Crawl-delay: 10 → 单进程每 10 秒 1 次请求，理论上限 8,640 次/天。
单件接口下 2 万件要 68 小时一轮；改用 `batch.py` 的批量接口（500 件/请求）后，
2 万件约 41 次请求 / 8 分钟一轮。

用法
----
    python server/refresh.py --once --limit 500       # 刷 500 件（1 次请求）后退出
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

import batch
import coupons
import db
import migrate

JST = timezone(timedelta(hours=9))
UA = "DLsiteCouponPlus/0.1 (price refresh; +https://dlsite.momo-yu.com/about)"
API = "https://www.dlsite.com/{site}/api/=/product.json?workno={workno}"
POOL_URL = "https://www.dlsite.com/home/api/=/coupon.json?cdn_cache=1"
POOL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "coupons.json")
POOL_TTL = 6 * 3600
# 活动抓取运行时会创建这个文件；refresh 见到就让路，避免两个进程同时打 DLsite
# 把实际请求频率翻倍（robots 的 Crawl-delay 是共享的）
CAMPAIGN_LOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", ".campaign_lock")


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
    return {
        "price": int(price),
        "base": int(base) if base is not None else None,
        "discount_rate": item.get("discount_rate"),
        "bb_key": item.get("bulkbuy_key"),
        "bb_title": item.get("bulkbuy_title"),
        "bb_items": item.get("bulkbuy_per_items"),
        "bb_rate": item.get("bulkbuy_discount_rate"),
        "bb_price": item.get("bulkbuy_price"),
        "bb_start": item.get("bulkbuy_start"),
        "bb_end": item.get("bulkbuy_end"),
    }


def refresh_one(conn, workno, site, delay):
    ok = False
    try:
        got = fetch_price(workno, site)
        if got:
            price, base = got["price"], got["base"]
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
                       discount_rate=COALESCE(?, discount_rate),
                       bulkbuy_key=?, bulkbuy_title=?, bulkbuy_items=?, bulkbuy_rate=?,
                       bulkbuy_price=?, bulkbuy_start=?, bulkbuy_end=?,
                       min_price=?, max_price=?, first_seen=?, points=?,
                       updated_at=datetime('now')
                WHERE workno=?
                """,
                (price, base, got["discount_rate"],
                 got["bb_key"], got["bb_title"], got["bb_items"], got["bb_rate"],
                 got["bb_price"], got["bb_start"], got["bb_end"],
                 agg["lo"], agg["hi"], agg["first"], agg["n"], workno),
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


def _rules(conn, keys):
    """套装规则按活动维度缓存：同一活动下所有作品的件数/折扣率相同。"""
    if not keys:
        return {}
    marks = ",".join("?" * len(keys))
    rows = conn.execute(
        "SELECT key, min_items, rate, start, end FROM campaigns "
        "WHERE kind='bulkbuy' AND key IN (%s)" % marks, tuple(keys)
    ).fetchall()
    return {r["key"]: r for r in rows}


def _write_batch(conn, site, rows, data, pool, day):
    """把一批批量结果写库。返回 (成功数, 需要补规则的活动 key)。"""
    ok = 0
    pending = []
    parsed = []
    for row in rows:
        item = batch.parse(data.get(row["workno"]) or data.get(row["workno"].upper()))
        if not item:
            continue  # 下架 / 区域限制，保持原值
        parsed.append((row, item))

    rules = _rules(conn, {i["bulkbuy_key"] for _, i in parsed if i["bulkbuy_key"]})

    for row, item in parsed:
        workno, price, base = row["workno"], item["price"], item["base"]
        coupon_price = pool.best(workno, price, site)[0] if pool else None
        key = item["bulkbuy_key"]

        if key is None:
            # 活动结束：清空套装字段，否则页面会一直显示过期套装价
            conn.execute(
                "UPDATE works SET current_price=?, base_price=COALESCE(?, base_price), "
                "discount_rate=COALESCE(?, discount_rate), bulkbuy_key=NULL, bulkbuy_title=NULL, "
                "bulkbuy_items=NULL, bulkbuy_rate=NULL, bulkbuy_price=NULL, "
                "bulkbuy_start=NULL, bulkbuy_end=NULL, updated_at=datetime('now') WHERE workno=?",
                (price, base, item["discount_rate"], workno),
            )
        else:
            rule = rules.get(key)
            if rule and rule["rate"]:
                # 套装单价 = 定価 × (1 − 活动折扣率)，实测与 DLsite 一致（880→352）
                bb_price = (
                    int(round(base * (100 - rule["rate"]) / 100.0)) if base is not None else None
                )
                conn.execute(
                    "UPDATE works SET current_price=?, base_price=COALESCE(?, base_price), "
                    "discount_rate=COALESCE(?, discount_rate), bulkbuy_key=?, bulkbuy_items=?, "
                    "bulkbuy_rate=?, bulkbuy_price=?, bulkbuy_start=?, bulkbuy_end=?, "
                    "updated_at=datetime('now') WHERE workno=?",
                    (price, base, item["discount_rate"], key, rule["min_items"], rule["rate"],
                     bb_price, rule["start"], rule["end"], workno),
                )
            else:
                # 规则未知（新活动）或没有比例折扣（如「10本10000円」是固定总价）：
                # 只记会员身份，不臆造套装价；固定总价那类仍可在作品页看 DLsite 原价。
                conn.execute(
                    "UPDATE works SET current_price=?, base_price=COALESCE(?, base_price), "
                    "discount_rate=COALESCE(?, discount_rate), bulkbuy_key=?, "
                    "updated_at=datetime('now') WHERE workno=?",
                    (price, base, item["discount_rate"], key, workno),
                )
                if rule is None and key not in pending:
                    pending.append(key)

        conn.execute(
            "INSERT OR REPLACE INTO price_samples(workno, day, price, coupon_price, carried) "
            "VALUES(?,?,?,?,0)",
            (workno, day, price, coupon_price),
        )
        db.recompute_stats(conn, workno)
        ok += 1
    return ok, pending


def _learn_campaign(conn, conn_workno, site, key):
    """一个活动只学一次：取任意一件的 product.json，拿到件数/折扣率/起止。"""
    got = fetch_price(conn_workno, site)
    if not got:
        return False
    conn.execute(
        "INSERT INTO campaigns(key, site, kind, start, end, min_items, rate, updated_at) "
        "VALUES(?,?,'bulkbuy',?,?,?,?,datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET start=excluded.start, end=excluded.end, "
        "min_items=excluded.min_items, rate=excluded.rate, updated_at=excluded.updated_at",
        (key, site, got["bb_start"], got["bb_end"], got["bb_items"], got["bb_rate"]),
    )
    return True


def run_once(conn, limit, delay):
    rows = conn.execute(
        "SELECT workno, site, bulkbuy_key FROM works ORDER BY updated_at ASC LIMIT ?", (limit,)
    ).fetchall()
    if not rows:
        print("没有需要刷新的作品")
        return 0

    pool = coupons.load_cached(POOL_PATH)
    day = jst_today()
    by_site = {}
    for r in rows:
        by_site.setdefault(r["site"] or "maniax", []).append(r)

    ok = 0
    for site, group in by_site.items():
        for i in range(0, len(group), batch.BATCH_SIZE):
            chunk = group[i:i + batch.BATCH_SIZE]
            try:
                data = batch.fetch_batch([r["workno"] for r in chunk], site)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                    ValueError, OSError) as exc:
                print("  ! 批次失败 %s: %s" % (site, type(exc).__name__))
                continue
            written, pending = _write_batch(conn, site, chunk, data, pool, day)
            conn.commit()
            ok += written
            # 新活动才需要学规则：每个活动 1 次请求，最多学 2 个/批
            for key in pending[:2]:
                sample = next(r["workno"] for r in chunk
                              if (data.get(r["workno"]) or {}).get("bulkbuy_key") == key)
                time.sleep(delay)
                if _learn_campaign(conn, sample, site, key):
                    conn.commit()
            print("  %s 批 %d 件（返回 %d，新活动 %d）"
                  % (site, len(chunk), written, len(pending)), flush=True)
            time.sleep(delay + random.uniform(0, delay * 0.2))

    print("本轮成功 %d / %d（%d 次请求）" % (ok, len(rows), -(-len(rows) // batch.BATCH_SIZE)))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--limit", type=int, default=500, help="每轮刷新多少件（按批拉取）")
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
                if os.path.exists(CAMPAIGN_LOCK):
                    print("活动抓取进行中，刷新让路 60s", flush=True)
                    time.sleep(60)
                    continue
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
