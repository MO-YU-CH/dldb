#!/usr/bin/env python
"""每天为全部作品补一条券后价，不访问 DLsite。

为什么需要它
------------
券后价 = f(当前价, 券池)。当前价我们库里有，券池每 6 小时拉一次，所以
「今天所有作品的券后价」完全可以在本地算出来，不需要逐件请求。

原来的问题是券后价绑在「扫到这件作品」的时刻上：20,226 部作品、一天只能扫
300 部左右，导致券后历史一周也攒不出几行。这个任务把券后价的采样从
「跟随价格扫描」解耦成「每天全量算一遍」。

写入策略
--------
只更新 coupon_price，不覆盖当天已有的 price——价格以 refresh 抓到的为准，
这里拿不到更新鲜的价格。当天没有行时才插入（用库里已知的 current_price）。
"""

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

import coupons
import db
import pricing

JST = timezone(timedelta(hours=9))


def run(path=None, pool_path=None, dry_run=False):
    conn = db.connect_rw() if path is None else _connect(path)
    try:
        pool_path = pool_path or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "data", "coupons.json"
        )
        pool = coupons.load_cached(pool_path)
        if not pool.all:
            print("券池为空，跳过（沿用昨天的券后价）")
            return 0

        day = datetime.now(JST).strftime("%Y-%m-%d")
        # 进行中的套装活动：券要作用在「套装价」上，不是单品价。
        # 是否套装对象由每件自己的 bulkbuy_end 决定（product.json 直接给的）。
        now = datetime.now(JST).strftime("%Y-%m-%dT%H:%M:%S")
        row = conn.execute(
            "SELECT MAX(rate) AS r FROM campaigns WHERE kind='bulkbuy' AND rate IS NOT NULL "
            "  AND (start IS NULL OR start='' OR start <= ?) "
            "  AND (end IS NULL OR end='' OR end >= ?)",
            (now, now),
        ).fetchone()
        bundle_rate = row["r"] if row and row["r"] else None
        rows = conn.execute(
            "SELECT workno, site, current_price, base_price, discount_rate, bulkbuy_end "
            "FROM works WHERE current_price IS NOT NULL"
        ).fetchall()

        updated = inserted = 0
        for row in rows:
            # 当天已有价格时，券必须作用在「那一天记录的价格」上，而不是 works 里的当前价
            existing = conn.execute(
                "SELECT price FROM price_samples WHERE workno=? AND day=?",
                (row["workno"], day),
            ).fetchone()
            base = existing["price"] if existing else row["current_price"]
            in_bundle = (
                bundle_rate if (bundle_rate and row["bulkbuy_end"] and row["bulkbuy_end"] >= now) else None
            )
            eff, _rate = pricing.effective_price(
                row["base_price"], row["discount_rate"], in_bundle
            )
            after, _coupon = pool.best(row["workno"], eff or base, row["site"])
            if after is None:
                continue
            if existing:
                conn.execute(
                    "UPDATE price_samples SET coupon_price=? WHERE workno=? AND day=?",
                    (after, row["workno"], day),
                )
                updated += 1
            else:
                # carried=1：价格是沿用上次实测值，不是今天的观测
                conn.execute(
                    "INSERT INTO price_samples(workno, day, price, coupon_price, carried) "
                    "VALUES(?,?,?,?,1)",
                    (row["workno"], day, base, after),
                )
                inserted += 1
        if dry_run:
            conn.rollback()
            print("[dry-run] 将更新 %d 行，新增 %d 行" % (updated, inserted))
            return updated + inserted
        conn.commit()
        cheaper = conn.execute(
            "SELECT COUNT(*) FROM price_samples WHERE day=? AND coupon_price < price",
            (day,),
        ).fetchone()[0]
        print(
            "券后价回填完成 %s：更新 %d，新增 %d，其中券后低于本体 %d"
            % (day, updated, inserted, cheaper)
        )
        return updated + inserted
    finally:
        conn.close()


def _connect(path):
    import sqlite3

    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    ap.add_argument("--pool", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    run(path=args.db, pool_path=args.pool, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
