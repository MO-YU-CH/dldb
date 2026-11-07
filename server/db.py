"""SQLite 访问层。

只做只读查询 + 一个受控的写入入口（refresh 用）。连接按请求复用，
WAL 模式下读多写少，单进程 waitress 足够。
"""

import os
import sqlite3

DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "dlsite.db")
# 兼容旧引用；连接时请用 db_path()，因为测试会在导入后才设置 DLDB_PATH
DB_PATH = os.environ.get("DLDB_PATH", DEFAULT_DB)


def db_path():
    return os.environ.get("DLDB_PATH", DEFAULT_DB)


def connect():
    conn = sqlite3.connect(db_path(), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def connect_rw():
    conn = sqlite3.connect(db_path(), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def get_work(conn, workno):
    return conn.execute("SELECT * FROM works WHERE workno = ?", (workno,)).fetchone()


def get_coupon_history(conn, workno):
    """只返回有券后价的日子。历史导入的数据没有这一列，所以长度通常远小于 get_history。"""
    return conn.execute(
        "SELECT day, coupon_price FROM price_samples "
        "WHERE workno = ? AND coupon_price IS NOT NULL ORDER BY day",
        (workno,),
    ).fetchall()


def get_history(conn, workno):
    return conn.execute(
        "SELECT day, price FROM price_samples WHERE workno = ? ORDER BY day", (workno,)
    ).fetchall()


def count_works(conn):
    return conn.execute("SELECT COUNT(*) AS n FROM works").fetchone()["n"]


def count_samples(conn):
    return conn.execute("SELECT COUNT(*) AS n FROM price_samples").fetchone()["n"]


def newest(conn, limit=12):
    return conn.execute(
        "SELECT workno, title, circle, current_price, min_price, updated_at "
        "FROM works WHERE title IS NOT NULL ORDER BY updated_at DESC, workno LIMIT ?",
        (limit,),
    ).fetchall()


def search(conn, q, limit=50):
    """作品号精确命中优先，其次标题模糊。"""
    q = (q or "").strip()
    if not q:
        return []
    rows = conn.execute(
        "SELECT workno, title, circle, current_price, min_price FROM works WHERE workno = ?",
        (q.upper(),),
    ).fetchall()
    if rows:
        return rows
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return conn.execute(
        "SELECT workno, title, circle, current_price, min_price FROM works "
        "WHERE title LIKE ? ESCAPE '\\' OR circle LIKE ? ESCAPE '\\' "
        "ORDER BY updated_at DESC LIMIT ?",
        (like, like, limit),
    ).fetchall()


def biggest_drops(conn, limit=30):
    """当前价相对历史最高价的跌幅榜。"""
    return conn.execute(
        """
        SELECT workno, title, circle, current_price, max_price,
               CAST(ROUND((max_price - current_price) * 100.0 / max_price) AS INTEGER) AS drop_pct
        FROM works
        WHERE max_price > 0 AND current_price IS NOT NULL AND current_price < max_price
        ORDER BY drop_pct DESC, max_price DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def dlsite_url(workno, site=None):
    """作品号前缀决定分区；未知前缀按同人（maniax）处理，DLsite 会自行跳转。"""
    if not site:
        site = {"BJ": "books", "VJ": "pro"}.get((workno or "")[:2], "maniax")
    return "https://www.dlsite.com/%s/work/=/product_id/%s.html" % (site, workno)


def coverage(conn):
    span = conn.execute("SELECT MIN(day) AS a, MAX(day) AS b FROM price_samples").fetchone()
    return {
        "works": count_works(conn),
        "samples": count_samples(conn),
        "first_day": span["a"],
        "last_day": span["b"],
    }
