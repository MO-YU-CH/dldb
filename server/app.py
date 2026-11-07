"""DLsite Coupon Plus 价格站。

单进程 Flask + SQLite，模板服务端渲染，价格曲线是内联 SVG（不依赖前端图表库）。
部署：waitress-serve --listen=127.0.0.1:8080 app:app，前置 Caddy/Nginx 与 Cloudflare。
"""

import json
import os
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone

from flask import (
    Flask,
    Response,
    abort,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)

import charts
import coupons
import db
import i18n
import migrate
import ondemand
import pricing

BASE_URL = os.environ.get("DLDB_BASE_URL", "https://dlsite.momo-yu.com")
SITE_NAME = "DLsite Coupon Plus"
CACHE_SECONDS = int(os.environ.get("DLDB_CACHE_SECONDS", "300"))


def _userscript_version():
    """产物版本号。Cloudflare 对 .js 走 4 小时边缘缓存，链接里带上版本才能立即生效。"""
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "extension",
        "manifest.json",
    )
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh).get("version", "0")
    except (OSError, ValueError):
        return "0"


USERSCRIPT_VERSION = _userscript_version()

POOL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "coupons.json")
_pool_cache = {"mtime": None, "pool": coupons.Pool([])}


def bundle_rates(conn):
    """进行中的套装活动 → {workno: 最大折扣率}。缓存 5 分钟。"""
    if _bundle_cache["map"] and time.time() - _bundle_cache["at"] < BUNDLE_TTL:
        return _bundle_cache["map"]
    now = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%dT%H:%M:%S")
    rows = conn.execute(
        "SELECT cw.workno AS workno, MAX(c.rate) AS rate "
        "FROM campaign_works cw JOIN campaigns c ON c.key = cw.key "
        "WHERE c.kind='bulkbuy' AND c.rate IS NOT NULL "
        "  AND (c.start IS NULL OR c.start='' OR c.start <= ?) "
        "  AND (c.end IS NULL OR c.end='' OR c.end >= ?) "
        "GROUP BY cw.workno",
        (now, now),
    ).fetchall()
    mapping = {r["workno"]: r["rate"] for r in rows}
    _bundle_cache.update({"at": time.time(), "map": mapping})
    return mapping


def get_pool():
    """券池按文件 mtime 热加载，实现见 coupons.load_cached。"""
    return coupons.load_cached(POOL_PATH)


_rank_cache = {"key": None, "rows": [], "at": 0.0}
_health_cache = {"at": 0.0, "data": None}
_bundle_cache = {"at": 0.0, "map": {}}
BUNDLE_TTL = 300
RANK_TTL = 300


def coupon_new_lows(conn, pool, limit=50, min_points=30):
    """券后价低于历史最低的作品。20k 行 × 几张券，算一次缓存 5 分钟。"""
    key = (round(time.time() / RANK_TTL), _pool_cache["mtime"], limit, min_points)
    if _rank_cache["key"] == key:
        return _rank_cache["rows"]

    bmap = bundle_rates(conn)
    rows = conn.execute(
        "SELECT w.workno, w.title, w.circle, w.site, w.current_price, w.min_price, w.points, "
        "       w.base_price, w.discount_rate, "
        "       c.cmin AS coupon_min, c.cn AS coupon_points "
        "FROM works w LEFT JOIN ("
        "  SELECT workno, MIN(coupon_price) AS cmin, COUNT(coupon_price) AS cn "
        "  FROM price_samples WHERE coupon_price IS NOT NULL GROUP BY workno"
        ") c ON c.workno = w.workno "
        "WHERE w.points >= ? AND w.current_price IS NOT NULL AND w.min_price IS NOT NULL",
        (min_points,),
    ).fetchall()

    out = []
    for row in rows:
        eff_price, _ = pricing.effective_price(
            row["base_price"], row["discount_rate"], bmap.get(row["workno"])
        )
        after, coupon = pool.best(row["workno"], eff_price or row["current_price"], row["site"])
        if after is None:
            continue
        # 券后历史够 7 天就用券后最低做基准，否则退回本体最低
        if row["coupon_points"] and row["coupon_points"] >= 7:
            base, basis = row["coupon_min"], "coupon"
        else:
            base, basis = row["min_price"], "plain"
        # 严格低于基准才算「新低」；持平只是「处于最低」，不进榜
        if after >= base:
            continue
        out.append(
            {
                "workno": row["workno"],
                "title": row["title"],
                "circle": row["circle"],
                "coupon_price": after,
                "min_price": base,
                "basis": basis,
                "points": row["points"],
                "gap": base - after,
                "gap_pct": int(round((base - after) * 100.0 / base)) if base else 0,
                "coupon_name": coupon.get("coupon_name") if coupon else None,
            }
        )
    # 按相对跌幅排序：绝对额排序会被一张 15% 券刷屏（2640→2244 全是 396 円）
    out.sort(key=lambda r: (-r["gap_pct"], -r["points"], -r["gap"], r["min_price"]))
    out = out[:limit]

    _rank_cache.update({"key": key, "rows": out, "at": time.time()})
    return out


def create_app():
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config.update(JSON_AS_ASCII=False, SEND_FILE_MAX_AGE_DEFAULT=86400)

    # ---------------------------------------------------------------- 钩子

    @app.before_request
    def _open_db():
        g.db = db.connect()
        g.csp_nonce = secrets.token_urlsafe(16)

    @app.teardown_request
    def _close_db(exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    @app.url_defaults
    def _add_locale(endpoint, values):
        if "locale" in values or endpoint == "static":
            return
        code = getattr(g, "locale", None)
        if code:
            values["locale"] = code

    @app.url_value_preprocessor
    def _pull_locale(endpoint, values):
        g.locale = None
        if values and "locale" in values:
            code = values["locale"]
            if code not in i18n.BY_CODE:
                abort(404)
            g.locale = code

    @app.context_processor
    def _inject():
        locale = getattr(g, "locale", None) or i18n.DEFAULT_LOCALE
        meta = i18n.BY_CODE[locale]

        def T(key, **kwargs):
            return i18n.t(locale, key, **kwargs)

        def alt_url(code):
            parts = request.path.split("/")
            if len(parts) > 1 and parts[1] in i18n.BY_CODE:
                parts[1] = code
                path = "/".join(parts)
            else:
                path = "/%s/" % code
            qs = request.query_string.decode("utf-8")
            return path + ("?" + qs if qs else "")

        return {
            "T": T,
            "alt_url": alt_url,
            "locale": locale,
            "locale_meta": meta,
            "locales": i18n.LOCALES,
            "site_name": SITE_NAME,
            "base_url": BASE_URL,
            "current_path": request.path,
            "csp_nonce": getattr(g, "csp_nonce", ""),
            "userscript_version": USERSCRIPT_VERSION,
            "now_year": datetime.now(timezone.utc).year,
        }

    @app.after_request
    def _headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'nonce-%s'; frame-ancestors 'none'" % getattr(g, "csp_nonce", ""),
        )
        if request.path.startswith("/api/"):
            resp.headers.setdefault("Access-Control-Allow-Origin", "*")
        return resp

    @app.template_filter("num")
    def _num(value):
        try:
            return "{:,}".format(int(value))
        except (TypeError, ValueError):
            return "-"

    # ---------------------------------------------------------------- 页面

    def _render(template, status=200, **ctx):
        html = render_template(template, **ctx)
        resp = Response(html, status=status, mimetype="text/html; charset=utf-8")
        if status == 200:
            resp.headers["Cache-Control"] = "public, max-age=%d" % CACHE_SECONDS
        return resp

    def load_work(workno):
        """库里没有就现场取一次——第三方 sitemap 不覆盖书籍区（BJ）。"""
        row = db.get_work(g.db, workno)
        if row is None and ondemand.ingest(workno):
            row = db.get_work(g.db, workno)
        return row

    @app.get("/")
    def root():
        return redirect(url_for("home", locale=i18n.pick(request)), code=302)

    @app.get("/<locale>/")
    def home(locale):
        stats = db.coverage(g.db)
        return _render(
            "home.html",
            active="home",
            stats=stats,
            latest=db.newest(g.db, 12),
        )

    @app.get("/<locale>/works/<workno>")
    def work(locale, workno):
        workno = (workno or "").strip().upper()
        row = load_work(workno)
        if row is None:
            return _render("not_found.html", status=404, workno=workno, active="")

        history = db.get_history(g.db, workno)
        svg, chart_stats = charts.render(
            history, i18n.t(locale, "chart_alt", title=row["title"] or workno)
        )

        # 券后价与历史定位：券是公开券池口径，比用户个人持券保守
        bundle_rate = bundle_rates(g.db).get(workno)
        eff_price, eff_rate = pricing.effective_price(
            row["base_price"], row["discount_rate"], bundle_rate
        )
        coupon_after, coupon = (None, None)
        base_for_coupon = eff_price or row["current_price"]
        if base_for_coupon:
            coupon_after, coupon = get_pool().best(workno, base_for_coupon, row["site"])
        # 券后价历史只有上线后才开始积累；样本够 7 天才用它做判定
        c_hist = db.get_coupon_history(g.db, workno)
        c_prices = [r["coupon_price"] for r in c_hist]
        if len(c_prices) >= 7:
            pos = pricing.position(c_prices, coupon_after)
            basis = "coupon"
        else:
            pos = pricing.position([h["price"] for h in history], coupon_after)
            basis = "plain"

        return _render(
            "work.html",
            active="work",
            work=row,
            history=history,
            chart=svg,
            chart_stats=chart_stats,
            title=row["title"],
            dl_url=db.dlsite_url(workno, row["site"]),
            coupon_after=coupon_after,
            coupon=coupon,
            pos=pos,
            basis=basis,
            eff_price=eff_price,
            eff_rate=eff_rate,
            bundle_rate=bundle_rate,
            coupon_min=min(c_prices) if c_prices else None,
            coupon_points=len(c_prices),
        )

    @app.get("/<locale>/search")
    def search(locale):
        q = (request.args.get("q") or "").strip()
        rows = db.search(g.db, q) if q else []
        return _render("search.html", active="search", q=q, rows=rows)

    @app.get("/<locale>/rank")
    def rank(locale):
        return _render(
            "rank.html",
            active="rank",
            rows=coupon_new_lows(g.db, get_pool(), 50),
            stats=db.coverage(g.db),
            pool=get_pool().describe(),
        )

    @app.get("/<locale>/about")
    def about(locale):
        return _render("about.html", active="about", stats=db.coverage(g.db))

    @app.get("/<locale>/privacy")
    def privacy(locale):
        return _render("privacy.html", active="")

    # ---------------------------------------------------------------- 接口

    @app.get("/api/lookup/<store>/<workno>")
    def api_lookup(store, workno):
        """兼容现有扩展的响应结构，字段名与第三方实现保持一致。"""
        if store != "dlsite":
            return jsonify({"error": "unsupported store"}), 404
        workno = workno.strip().upper()
        row = load_work(workno)
        if row is None:
            return jsonify({"error": "not found", "workId": workno}), 404

        history = db.get_history(g.db, workno)
        bundle_rate = bundle_rates(g.db).get(workno)
        eff_price, eff_rate = pricing.effective_price(
            row["base_price"], row["discount_rate"], bundle_rate
        )
        coupon_after, coupon = (None, None)
        base_for_coupon = eff_price or row["current_price"]
        if base_for_coupon:
            coupon_after, coupon = get_pool().best(workno, base_for_coupon, row["site"])
        c_hist = db.get_coupon_history(g.db, workno)
        c_prices = [r["coupon_price"] for r in c_hist]
        if len(c_prices) >= 7:
            pos = pricing.position(c_prices, coupon_after)
            basis = "coupon"
        else:
            pos = pricing.position([h["price"] for h in history], coupon_after)
            basis = "plain"

        payload = {
            "workId": workno,
            "url": "%s/%s/works/%s" % (BASE_URL, i18n.DEFAULT_LOCALE, workno),
            "title": row["title"],
            "circle": row["circle"],
            "position": pos,
            "platforms": [
                {
                    "platform": "dlsite",
                    "platformId": workno,
                    "current": {
                        "price": row["current_price"],
                        "basePrice": row["base_price"],
                        "discountRate": row["discount_rate"],
                        "isOnSale": bool(
                            row["base_price"]
                            and row["current_price"]
                            and row["current_price"] < row["base_price"]
                        ),
                        "couponRate": None,
                        "bundleRate": bundle_rate,
                        "effectivePrice": eff_price,
                        "effectiveRate": eff_rate,
                        "couponPrice": coupon_after,
                        "couponName": coupon.get("coupon_name") if coupon else None,
                        "recordedAt": history[-1]["day"] if history else None,
                    },
                    "stats": {
                        "minPrice": row["min_price"],
                        "minPriceAt": row["min_at"],
                        "maxPrice": row["max_price"],
                        "firstSeenAt": row["first_seen"],
                        "points": row["points"],
                        "couponMinPrice": min(c_prices) if c_prices else None,
                        "couponPoints": len(c_prices),
                        "couponBasis": basis,
                    },
                    "history": [[h["day"], h["price"]] for h in history],
                    "couponHistory": [
                        [r["day"], r["coupon_price"]] for r in c_hist
                    ],
                }
            ],
        }
        resp = jsonify(payload)
        resp.headers["Cache-Control"] = "public, max-age=%d" % CACHE_SECONDS
        return resp

    @app.get("/dlsite-coupon-plus.user.js")
    def userscript():
        """油猴一键安装：Tampermonkey 会识别 .user.js 后缀并弹出安装页。"""
        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "userscript",
            "dist",
            "dlsite-coupon-plus.user.js",
        )
        if not os.path.exists(path):
            resp = Response("// build not deployed\n", status=404, mimetype="text/javascript")
            resp.headers["Cache-Control"] = "no-store"
            return resp
        resp = send_file(path, mimetype="text/javascript", conditional=True)
        # 60 秒即可：发版后尽快生效，又不至于每次访问都回源
        resp.headers["Cache-Control"] = "public, max-age=60"
        return resp

    @app.get("/healthz")
    def healthz():
        """健康与容量信息。聚合查询较慢，缓存 60 秒。"""
        cached = _health_cache.get("data")
        if cached and time.time() - _health_cache["at"] < 60:
            return jsonify(cached)

        try:
            row = g.db.execute(
                "SELECT (SELECT COUNT(*) FROM works) AS works, "
                "(SELECT COUNT(*) FROM price_samples) AS samples, "
                "(SELECT COUNT(*) FROM price_samples WHERE coupon_price IS NOT NULL) AS coupon_samples, "
                "(SELECT MAX(day) FROM price_samples) AS last_day"
            ).fetchone()
        except sqlite3.Error:
            return jsonify({"ok": False}), 503

        path = db.db_path()
        size = os.path.getsize(path) if os.path.exists(path) else 0
        wal_path = path + "-wal"
        wal = os.path.getsize(wal_path) if os.path.exists(wal_path) else 0

        backups = {"count": 0, "latest": None, "age_hours": None}
        folder = os.path.join(os.path.dirname(path), "backups")
        if os.path.isdir(folder):
            files = sorted(
                (f for f in os.listdir(folder) if f.startswith("dlsite-") and f.endswith(".db")),
                reverse=True,
            )
            if files:
                newest = os.path.join(folder, files[0])
                backups = {
                    "count": len(files),
                    "latest": files[0],
                    "age_hours": round((time.time() - os.path.getmtime(newest)) / 3600.0, 1),
                }

        data = {
            "ok": True,
            "works": row["works"],
            "samples": row["samples"],
            "coupon_samples": row["coupon_samples"],
            "last_day": row["last_day"],
            "db_mb": round(size / 1024.0 / 1024.0, 1),
            "wal_mb": round(wal / 1024.0 / 1024.0, 1),
            "backups": backups,
        }
        _health_cache.update({"at": time.time(), "data": data})
        return jsonify(data)

    # ---------------------------------------------------------------- 爬虫

    @app.get("/robots.txt")
    def robots():
        body = (
            "User-agent: *\n"
            "Allow: /\n"
            "Disallow: /api/\n"
            "Sitemap: %s/sitemap.xml\n" % BASE_URL
        )
        return Response(body, mimetype="text/plain")

    @app.get("/sitemap.xml")
    def sitemap():
        rows = g.db.execute(
            "SELECT workno, updated_at FROM works WHERE title IS NOT NULL "
            "ORDER BY updated_at DESC LIMIT 40000"
        ).fetchall()
        items = ["%s/%s/" % (BASE_URL, i18n.DEFAULT_LOCALE), "%s/%s/rank" % (BASE_URL, i18n.DEFAULT_LOCALE)]
        for r in rows:
            items.append("%s/%s/works/%s" % (BASE_URL, i18n.DEFAULT_LOCALE, r["workno"]))
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "".join("<url><loc>%s</loc></url>\n" % u for u in items)
            + "</urlset>\n"
        )
        return Response(body, mimetype="application/xml")

    # ---------------------------------------------------------------- 错误

    @app.errorhandler(404)
    def not_found(err):
        if request.path.startswith("/api/"):
            return jsonify({"error": "not found"}), 404
        try:
            return _render("not_found.html", status=404, workno=None, active="")
        except Exception:
            return Response("404", status=404)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8080, debug=True)
