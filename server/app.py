"""DLsite Coupon Plus 价格站。

单进程 Flask + SQLite，模板服务端渲染，价格曲线是内联 SVG（不依赖前端图表库）。
部署：waitress-serve --listen=127.0.0.1:8080 app:app，前置 Caddy/Nginx 与 Cloudflare。
"""

import os
import secrets
import sqlite3
from datetime import datetime, timezone

from flask import (
    Flask,
    Response,
    abort,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
)

import charts
import db
import i18n

BASE_URL = os.environ.get("DLDB_BASE_URL", "https://dlsite.momo-yu.com")
SITE_NAME = "DLsite Coupon Plus"
CACHE_SECONDS = int(os.environ.get("DLDB_CACHE_SECONDS", "300"))


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
        row = db.get_work(g.db, workno)
        if row is None:
            return _render("not_found.html", status=404, workno=workno, active="")

        history = db.get_history(g.db, workno)
        svg, chart_stats = charts.render(
            history, i18n.t(locale, "chart_alt", title=row["title"] or workno)
        )
        return _render(
            "work.html",
            active="work",
            work=row,
            history=history,
            chart=svg,
            chart_stats=chart_stats,
            title=row["title"],
            dl_url=db.dlsite_url(workno, row["site"]),
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
            rows=db.biggest_drops(g.db, 50),
            stats=db.coverage(g.db),
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
        row = db.get_work(g.db, workno)
        if row is None:
            return jsonify({"error": "not found", "workId": workno}), 404

        history = db.get_history(g.db, workno)
        payload = {
            "workId": workno,
            "url": "%s/%s/works/%s" % (BASE_URL, i18n.DEFAULT_LOCALE, workno),
            "title": row["title"],
            "circle": row["circle"],
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
                        "recordedAt": history[-1]["day"] if history else None,
                    },
                    "stats": {
                        "minPrice": row["min_price"],
                        "minPriceAt": row["min_at"],
                        "maxPrice": row["max_price"],
                        "firstSeenAt": row["first_seen"],
                        "points": row["points"],
                    },
                    "history": [[h["day"], h["price"]] for h in history],
                }
            ],
        }
        resp = jsonify(payload)
        resp.headers["Cache-Control"] = "public, max-age=%d" % CACHE_SECONDS
        return resp

    @app.get("/healthz")
    def healthz():
        try:
            g.db.execute("SELECT 1").fetchone()
        except sqlite3.Error:
            return jsonify({"ok": False}), 503
        return jsonify({"ok": True, "works": db.count_works(g.db)})

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
