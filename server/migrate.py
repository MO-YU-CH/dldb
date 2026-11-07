"""轻量迁移：只做「加列」这种可重复执行的改动。

为什么不用迁移框架：整个库就一个文件、一次上线，加一个可空列 + 回填不存在的
历史数据（券后价历史上没有），用不到 alembic 那一套。
"""

import sqlite3

import db

# 新建表也放这里，保证老库升级后结构一致
TABLES = """
CREATE TABLE IF NOT EXISTS campaigns (
    key TEXT PRIMARY KEY, site TEXT, kind TEXT, start TEXT, end TEXT,
    min_items INTEGER, rate INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS campaign_works (
    key TEXT NOT NULL, workno TEXT NOT NULL, day TEXT, price INTEGER, base INTEGER,
    PRIMARY KEY (key, workno)
) WITHOUT ROWID;
"""

COLUMNS = [
    ("price_samples", "coupon_price", "INTEGER"),
    ("price_samples", "carried", "INTEGER NOT NULL DEFAULT 0"),
    ("campaigns", "kind", "TEXT"),
    ("campaigns", "min_items", "INTEGER"),
    ("campaigns", "rate", "INTEGER"),
]


def apply(conn=None):
    own = conn is None
    if own:
        conn = db.connect_rw()
    try:
        conn.executescript(TABLES)
        for table, column, ctype in COLUMNS:
            existing = {row[1] for row in conn.execute("PRAGMA table_info(%s)" % table)}
            if column not in existing:
                conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, ctype))
                print("迁移：%s 增加列 %s" % (table, column))
        conn.commit()
    except sqlite3.OperationalError as exc:
        # 表还不存在（全新库由 SCHEMA 建），交给建表脚本
        print("迁移跳过：%s" % exc)
    finally:
        if own:
            conn.close()


if __name__ == "__main__":
    apply()
