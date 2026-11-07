#!/usr/bin/env python
"""把第三方价格历史一次性导入本地 SQLite。

设计要点
--------
1. 分三段，各自可断点续跑，任何时刻 Ctrl-C 都不会丢进度：
   sitemap → 收集作品页 URL（UUID）入队
   resolve → 抓作品页，从 JSON-LD 的 "sku" 取出作品号，回填队列
   fetch   → 调 lookup 接口取历史，落 works / price_samples
2. 单线程 + 固定间隔 + 随机抖动，遇 429/503 指数退避并尊重 Retry-After。
3. 只做一次性导入。线上服务不读这个脚本，也不在运行时访问第三方。

用法
----
    python server/import_history.py --stage all --limit 200
    python server/import_history.py --stage all --max-hours 6
    python server/import_history.py --stats
"""

import argparse
import gzip
import json
import os
import random
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

SITEMAP_INDEX = "https://price.maenohou.com/sitemap.xml"
LOOKUP = "https://price.maenohou.com/api/lookup/dlsite/{workno}"
UA = (
    "DLsiteCouponPlus/0.1 (history import; +https://dlsite.momo-yu.com/about) "
    "Python-urllib/{}.{}".format(*sys.version_info[:2])
)

SKU_RE = re.compile(r'"sku"\s*:\s*"([A-Z]{2}\d{6,8})"')
HANTAN_RE = re.compile(r"品番[:：]\s*([A-Z]{2}\d{6,8})")

SCHEMA = """
CREATE TABLE IF NOT EXISTS works (
    workno        TEXT PRIMARY KEY,
    title         TEXT,
    circle        TEXT,
    url           TEXT,
    site          TEXT,
    current_price INTEGER,
    base_price    INTEGER,
    discount_rate INTEGER,
    min_price     INTEGER,
    min_at        TEXT,
    max_price     INTEGER,
    first_seen    TEXT,
    points        INTEGER,
    updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS price_samples (
    workno      TEXT NOT NULL,
    day         TEXT NOT NULL,
    price       INTEGER NOT NULL,
    coupon_price INTEGER,          -- 当日券后价；历史导入的数据没有，只能从上线后积累
    PRIMARY KEY (workno, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS crawl_queue (
    page_url  TEXT PRIMARY KEY,
    workno    TEXT,
    status    TEXT NOT NULL DEFAULT 'new',
    tries     INTEGER NOT NULL DEFAULT 0,
    note      TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON crawl_queue(status);
CREATE INDEX IF NOT EXISTS idx_samples_day ON price_samples(day);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


# ---------------------------------------------------------------- 网络


class Fetcher:
    def __init__(self, delay, timeout):
        self.delay = delay
        self.timeout = timeout
        self.count = 0

    def _sleep(self):
        time.sleep(self.delay + random.uniform(0, self.delay * 0.5))

    def get(self, url, accept="text/html,*/*", max_retries=4):
        """返回 (status, bytes)；网络层失败抛 RuntimeError。"""
        self._sleep()
        headers = {
            "User-Agent": UA,
            "Accept": accept,
            "Accept-Encoding": "gzip",
        }
        last = None
        for attempt in range(max_retries):
            req = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    body = res.read()
                    if res.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                    self.count += 1
                    return res.status, body
            except urllib.error.HTTPError as exc:
                last = exc
                if exc.code == 404:
                    return 404, b""
                if exc.code in (429, 500, 502, 503, 504):
                    wait = exc.headers.get("Retry-After")
                    backoff = float(wait) if wait and wait.isdigit() else 2 ** attempt
                    time.sleep(min(backoff, 60))
                    continue
                return exc.code, b""
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last = exc
                time.sleep(min(2 ** attempt, 30))
        raise RuntimeError("GET 失败 %s: %s" % (url, last))


# ---------------------------------------------------------------- 数据库


def connect(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def set_meta(conn, key, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


# ---------------------------------------------------------------- 各段


def stage_sitemap(conn, fetcher):
    status, body = fetcher.get(SITEMAP_INDEX, accept="application/xml")
    if status != 200:
        raise RuntimeError("sitemap 索引返回 %s" % status)
    index = body.decode("utf-8", "replace")
    subs = re.findall(r"<loc>([^<]+sitemap-works/\d+\.xml)</loc>", index)
    if not subs:
        raise RuntimeError("未在索引中找到 sitemap-works，结构可能已变")

    added = 0
    for sub in subs:
        status, body = fetcher.get(sub, accept="application/xml")
        if status != 200:
            print("  跳过 %s（%s）" % (sub, status))
            continue
        urls = re.findall(r"<loc>(https://price\.maenohou\.com/works/[^<]+)</loc>", body.decode("utf-8", "replace"))
        conn.executemany(
            "INSERT OR IGNORE INTO crawl_queue(page_url, status) VALUES(?, 'new')",
            [(u,) for u in urls],
        )
        conn.commit()
        added += len(urls)
        print("  %s → %d 条" % (sub.rsplit("/", 1)[-1], len(urls)))
    set_meta(conn, "sitemap_at", int(time.time()))
    print("入队合计 %d 条（去重后以库内计数为准）" % added)


def _one(fetcher, url, accept):
    try:
        status, body = fetcher.get(url, accept=accept)
    except RuntimeError:
        status, body = 0, b""
    return url, status, body


def _iter_fetch(urls, fetcher, workers, accept="text/html,*/*"):
    """边抓边产出，调用方可以立刻写库。

    每个线程各自 sleep 同一个 delay，提高的是「等待网络」的并行度，
    单连接的请求间隔不变。
    """
    if workers <= 1:
        for url in urls:
            yield _one(fetcher, url, accept)
        return

    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = [pool.submit(_one, fetcher, u, accept) for u in urls]
        for fut in as_completed(futures):
            yield fut.result()
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def stage_resolve(conn, fetcher, limit, workers=3):
    rows = conn.execute(
        "SELECT page_url FROM crawl_queue WHERE status='new' ORDER BY page_url LIMIT ?",
        (limit,),
    ).fetchall()
    urls = [r[0] for r in rows]
    ok = fail = 0
    for page_url, status, body in _iter_fetch(urls, fetcher, workers):
        if status != 200:
            conn.execute(
                "UPDATE crawl_queue SET status='page_error', note=?, tries=tries+1, "
                "updated_at=datetime('now') WHERE page_url=?",
                (str(status), page_url),
            )
            fail += 1
            conn.commit()
            continue

        html = body.decode("utf-8", "replace")
        match = SKU_RE.search(html) or HANTAN_RE.search(html)
        if match:
            conn.execute(
                "UPDATE crawl_queue SET workno=?, status='ready', updated_at=datetime('now') "
                "WHERE page_url=?",
                (match.group(1), page_url),
            )
            ok += 1
        else:
            conn.execute(
                "UPDATE crawl_queue SET status='no_sku', updated_at=datetime('now') WHERE page_url=?",
                (page_url,),
            )
            fail += 1
        conn.commit()
        if (ok + fail) % 50 == 0:
            print("  … 已解析 %d 件" % (ok + fail), flush=True)
    print("resolve: 成功 %d，失败 %d" % (ok, fail))
    return ok


def stage_fetch(conn, fetcher, limit, workers=3):
    rows = conn.execute(
        "SELECT DISTINCT workno FROM crawl_queue WHERE status='ready' "
        "AND workno IS NOT NULL AND workno NOT IN (SELECT workno FROM works) LIMIT ?",
        (limit,),
    ).fetchall()
    worknos = [r[0] for r in rows]
    urls = [LOOKUP.format(workno=w) for w in worknos]
    ok = empty = 0
    for url, status, body in _iter_fetch(urls, fetcher, workers, "application/json"):
        workno = url.rsplit("/", 1)[-1]
        if status == 404:
            conn.execute(
                "UPDATE crawl_queue SET status='missing', updated_at=datetime('now') WHERE workno=?",
                (workno,),
            )
            empty += 1
            conn.commit()
            continue
        if status != 200:
            continue

        try:
            data = json.loads(body.decode("utf-8"))
        except ValueError:
            continue

        platforms = data.get("platforms") or []
        plat = next((p for p in platforms if p.get("platform") == "dlsite"), platforms[0] if platforms else None)
        if not plat:
            conn.execute(
                "UPDATE crawl_queue SET status='no_platform', updated_at=datetime('now') WHERE workno=?",
                (workno,),
            )
            conn.commit()
            empty += 1
            continue

        cur = plat.get("current") or {}
        site = None
        m = re.search(r"dlsite\.com/([a-z0-9]+)/", plat.get("url") or "")
        if m:
            site = m.group(1)

        samples = sorted(
            (d, p) for d, p in (plat.get("history") or []) if d and p is not None
        )
        # 统计值一律从自己的价格点重算：第三方 stats.maxPrice 混入了定価，
        # 直接用会把「长期促销」算成 90% 暴跌。
        prices = [p for _, p in samples]
        if prices:
            min_price = min(prices)
            max_price = max(prices)
            min_at = next(d for d, p in samples if p == min_price)
            first_seen = samples[0][0]
            points = len(samples)
        else:
            min_price = max_price = min_at = first_seen = points = None

        conn.execute(
            """
            INSERT INTO works(workno, title, circle, url, site, current_price, base_price,
                              discount_rate, min_price, min_at, max_price, first_seen, points, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(workno) DO UPDATE SET
                title=excluded.title, circle=excluded.circle, url=excluded.url, site=excluded.site,
                current_price=excluded.current_price, base_price=excluded.base_price,
                discount_rate=excluded.discount_rate, min_price=excluded.min_price,
                min_at=excluded.min_at, max_price=excluded.max_price,
                first_seen=excluded.first_seen, points=excluded.points,
                updated_at=excluded.updated_at
            """,
            (
                workno,
                data.get("title"),
                data.get("circle"),
                plat.get("url"),
                site,
                cur.get("price"),
                cur.get("basePrice"),
                cur.get("discountRate"),
                min_price,
                min_at,
                max_price,
                first_seen,
                points,
            ),
        )

        conn.executemany(
            "INSERT OR REPLACE INTO price_samples(workno, day, price) VALUES(?,?,?)",
            [(workno, d, p) for d, p in samples],
        )
        conn.execute(
            "UPDATE crawl_queue SET status='done', updated_at=datetime('now') WHERE workno=?",
            (workno,),
        )
        conn.commit()
        ok += 1
        if ok % 25 == 0:
            print("  … 已入库 %d 件" % ok, flush=True)

    print("fetch: 入库 %d，无数据 %d" % (ok, empty))
    return ok


# ---------------------------------------------------------------- 入口


def print_stats(conn):
    q = lambda sql: conn.execute(sql).fetchone()[0]
    print("队列：", dict(conn.execute("SELECT status, COUNT(*) FROM crawl_queue GROUP BY status")))
    print("作品：%d" % q("SELECT COUNT(*) FROM works"))
    print("价格点：%d" % q("SELECT COUNT(*) FROM price_samples"))
    print("日期跨度：", conn.execute("SELECT MIN(day), MAX(day) FROM price_samples").fetchone())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(os.path.dirname(__file__), "data", "dlsite.db"))
    ap.add_argument("--stage", default="all", choices=["all", "sitemap", "resolve", "fetch", "stats"])
    ap.add_argument("--limit", type=int, default=300, help="单次调用的条数上限")
    ap.add_argument("--batch", type=int, default=200, help="all 模式下每轮 解析→取值 的批大小")
    ap.add_argument("--workers", type=int, default=3, help="并发抓取线程数（写库仍串行）")
    ap.add_argument("--delay", type=float, default=0.4, help="请求间隔秒（另加 0~50%% 抖动）")
    ap.add_argument("--timeout", type=float, default=25)
    ap.add_argument("--max-hours", type=float, default=0, help=">0 时到点自动停")
    args = ap.parse_args()

    conn = connect(args.db)
    if args.stage == "stats":
        print_stats(conn)
        return

    print("PID=%d  库=%s  间隔=%.2fs" % (os.getpid(), args.db, args.delay))
    fetcher = Fetcher(args.delay, args.timeout)
    deadline = time.time() + args.max_hours * 3600 if args.max_hours > 0 else None

    try:
        if args.stage in ("all", "sitemap"):
            if conn.execute("SELECT COUNT(*) FROM crawl_queue").fetchone()[0] == 0:
                print("[1/3] 收集 sitemap")
                stage_sitemap(conn, fetcher)
            else:
                print("[1/3] 队列已有数据，跳过 sitemap")

        if args.stage == "resolve":
            stage_resolve(conn, fetcher, args.limit, args.workers)
        elif args.stage == "fetch":
            stage_fetch(conn, fetcher, args.limit, args.workers)
        elif args.stage == "all":
            # 交替推进：每轮先解析一小批页面，再立刻把这一批取回来。
            # 这样任何时刻中断，库里都是"可用的一部分"而不是一堆待解析 URL。
            rounds = 0
            while True:
                if deadline and time.time() > deadline:
                    print("已达时间上限，停止")
                    break
                new_n = conn.execute(
                    "SELECT COUNT(*) FROM crawl_queue WHERE status='new'"
                ).fetchone()[0]
                ready_n = conn.execute(
                    "SELECT COUNT(*) FROM crawl_queue WHERE status='ready' AND workno NOT IN (SELECT workno FROM works)"
                ).fetchone()[0]
                if new_n == 0 and ready_n == 0:
                    print("队列已处理完毕")
                    break
                rounds += 1
                print("--- 第 %d 轮：待解析 %d，待取值 %d ---" % (rounds, new_n, ready_n))
                if new_n:
                    stage_resolve(conn, fetcher, args.batch, args.workers)
                if ready_n:
                    stage_fetch(conn, fetcher, args.batch, args.workers)
    except KeyboardInterrupt:
        print("\n已中断，进度已保存。")
    finally:
        print_stats(conn)
        conn.close()
        print("请求总数：%d" % fetcher.count)
        if deadline and time.time() > deadline:
            print("已达时间上限")


if __name__ == "__main__":
    main()
