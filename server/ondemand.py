"""按需入库：用户访问的作品若不在库里，现场用 DLsite 公开接口取一次。

为什么需要它
------------
历史数据靠第三方 sitemap 一次性导入，但那份 sitemap 只覆盖同人（RJ）与视频（VJ），
书籍区（BJ）一部都没有。结果就是 BJ 作品在扩展面板里既没有曲线也没有「查看完整价格趋势」。

与其等一个不存在的枚举源，不如在第一次被访问时按作品号取一次：DLsite 的
product.json 是公开接口，页面自己也在用。取到后写进库，此后由 refresh.py 照常滚动刷新。

约束
----
1. 只接受形如 RJ123456 的作品号，避免被当成任意 URL 代理
2. 全局串行 + 最小间隔，宁可慢也不并发打站
3. 失败结果缓存 1 小时，防止反复 404 的作品被反复请求
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import db

JST = timezone(timedelta(hours=9))
WORKNO_RE = re.compile(r"^[A-Z]{2}\d{6,10}$")
API = "https://www.dlsite.com/{site}/api/=/product.json?workno={workno}"
UA = "DLsiteCouponPlus/0.1 (on-demand lookup; +https://dlsite.momo-yu.com/about)"

SITE_BY_PREFIX = {"RJ": "maniax", "BJ": "books", "VJ": "pro", "RE": "maniax", "VE": "pro"}
MIN_INTERVAL = 2.0  # 秒；全局串行下的最小请求间隔
NEGATIVE_TTL = 3600
DAILY_CAP = 500  # 每天最多按需入库多少件，防止被枚举作品号刷库
ENABLED = True  # 运行时可关（测试用）；环境变量在调用时判断，见 enabled()


def enabled():
    return ENABLED and os.environ.get("DLDB_ONDEMAND", "1") != "0"

_lock = threading.Lock()
_last_call = [0.0]
_negative = {}
_daily = {"day": "", "count": 0}


def _site_for(workno):
    return SITE_BY_PREFIX.get(workno[:2], "maniax")


def _fetch(workno, site, timeout=12):
    req = urllib.request.Request(
        API.format(site=site, workno=workno),
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        data = json.loads(res.read().decode("utf-8"))
    if not isinstance(data, list) or not data:
        return None
    item = data[0]
    price = item.get("price")
    if price is None:
        return None
    return {
        "price": int(price),
        "base_price": int(item["official_price"]) if item.get("official_price") is not None else None,
        "title": item.get("work_name"),
        "circle": item.get("maker_name"),
        "site": item.get("site_id") or site,
        "discount_rate": item.get("discount_rate"),
    }


def _today():
    return datetime.now(JST).strftime("%Y-%m-%d")


def _within_cap():
    today = _today()
    if _daily["day"] != today:
        _daily["day"] = today
        _daily["count"] = 0
    return _daily["count"] < DAILY_CAP


def ingest(workno, path=None):
    """把作品写进库（含今天的一个价格点）。成功返回 True。"""
    workno = (workno or "").strip().upper()
    if not enabled() or not WORKNO_RE.match(workno):
        return False
    if not _within_cap():
        return False
    if _negative.get(workno, 0) > time.time() - NEGATIVE_TTL:
        return False

    conn = db.connect_rw() if path is None else _connect(path)
    try:
        if conn.execute("SELECT 1 FROM works WHERE workno=?", (workno,)).fetchone():
            return False  # 别的请求刚写进去

        with _lock:
            wait = _last_call[0] + MIN_INTERVAL - time.time()
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.time()
            site = _site_for(workno)
            try:
                item = _fetch(workno, site)
            except urllib.error.HTTPError as exc:
                if exc.code == 404 and site != "maniax":
                    try:
                        item = _fetch(workno, "maniax")
                    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, OSError):
                        item = None
                else:
                    item = None
            except (urllib.error.URLError, TimeoutError, ValueError, OSError):
                item = None

        if not item:
            _negative[workno] = time.time()
            return False

        day = datetime.now(JST).strftime("%Y-%m-%d")
        conn.execute(
            """
            INSERT INTO works(workno, title, circle, site, current_price, base_price,
                              discount_rate, min_price, min_at, max_price, first_seen, points, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
            ON CONFLICT(workno) DO NOTHING
            """,
            (
                workno,
                item["title"],
                item["circle"],
                item["site"],
                item["price"],
                item["base_price"],
                item["discount_rate"],
                item["price"],
                day,
                item["price"],
                day,
                1,
            ),
        )
        conn.execute(
            "INSERT OR REPLACE INTO price_samples(workno, day, price) VALUES(?,?,?)",
            (workno, day, item["price"]),
        )
        conn.commit()
        _daily["count"] += 1
        return True
    finally:
        conn.close()


def _connect(path):
    import sqlite3

    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def reset_cache():
    """测试用。"""
    _negative.clear()
    _last_call[0] = 0.0
    _daily["day"] = ""
    _daily["count"] = 0
