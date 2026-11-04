#!/usr/bin/env python
"""按 price_samples 重算 works 的统计列。

背景：导入时曾直接采用第三方接口的 stats.maxPrice，而它把定価也算进了「历史最高」，
导致长期促销的作品被算成「从 2200 跌到 220，跌 90%」，榜单前 50 条全是 90%。

现在统计值的唯一事实来源是 price_samples。

    python server/rebuild_stats.py            # 只看会改多少
    python server/rebuild_stats.py --apply    # 实际执行
"""

import argparse
import os

import db

SQL = """
UPDATE works SET
    min_price = s.lo,
    max_price = s.hi,
    points    = s.n,
    first_seen = s.first_day,
    min_at = (
        SELECT p.day FROM price_samples p
        WHERE p.workno = works.workno
        ORDER BY p.price ASC, p.day ASC LIMIT 1
    )
FROM (
    SELECT workno, MIN(price) AS lo, MAX(price) AS hi,
           COUNT(*) AS n, MIN(day) AS first_day
    FROM price_samples GROUP BY workno
) AS s
WHERE works.workno = s.workno
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=db.DB_PATH)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    conn = db.connect_rw()
    bad = conn.execute(
        "SELECT COUNT(*) FROM works WHERE max_price > ("
        "  SELECT MAX(price) FROM price_samples p WHERE p.workno = works.workno)"
    ).fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM works").fetchone()[0]
    print("库：%s" % args.db)
    print("作品 %d，其中 max_price 高于实际最高价的有 %d 件" % (total, bad))

    if not args.apply:
        rows = conn.execute(
            "SELECT workno, max_price, (SELECT MAX(price) FROM price_samples p "
            "WHERE p.workno = works.workno) AS real_max FROM works "
            "WHERE max_price > (SELECT MAX(price) FROM price_samples p "
            "WHERE p.workno = works.workno) LIMIT 5"
        ).fetchall()
        for r in rows:
            print("  %s  max=%s → %s" % (r["workno"], r["max_price"], r["real_max"]))
        print("加 --apply 执行")
        conn.close()
        return

    cur = conn.execute(SQL)
    conn.commit()
    print("已重算 %d 行" % cur.rowcount)
    left = conn.execute(
        "SELECT COUNT(*) FROM works WHERE max_price > ("
        "  SELECT MAX(price) FROM price_samples p WHERE p.workno = works.workno)"
    ).fetchone()[0]
    print("残留异常：%d" % left)
    conn.close()


if __name__ == "__main__":
    main()
