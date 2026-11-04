"""服务端渲染价格曲线（纯 SVG，无前端图表库）。

理由：页面首屏不依赖 JS，SEO 与 Lighthouse 都占优；点数上限已在查询侧控制。
"""

from datetime import date

W, H = 640.0, 200.0
PAD_L, PAD_R, PAD_T, PAD_B = 56.0, 12.0, 12.0, 26.0


def _ordinal(day):
    try:
        y, m, d = day.split("-")
        return date(int(y), int(m), int(d)).toordinal()
    except (ValueError, AttributeError):
        return None


def _fmt(n):
    return "{:,}".format(int(n))


def render(points, aria=""):
    """points: [(day, price)]，返回 (svg_string, stats) 或 (None, None)。"""
    data = []
    for day, price in points:
        o = _ordinal(day)
        if o is None or price is None:
            continue
        data.append((o, int(price), day))
    if len(data) < 2:
        return None, None

    xs = [p[0] for p in data]
    ys = [p[1] for p in data]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    if x1 == x0:
        return None, None
    if y1 == y0:
        y1 = y0 + 1  # 价格恒定时给一条水平线

    span = y1 - y0
    y0 -= span * 0.08
    y1 += span * 0.08

    plot_w = W - PAD_L - PAD_R
    plot_h = H - PAD_T - PAD_B

    def sx(o):
        return PAD_L + (o - x0) / (x1 - x0) * plot_w

    def sy(v):
        return PAD_T + (1 - (v - y0) / (y1 - y0)) * plot_h

    coords = [(sx(o), sy(v)) for o, v, _ in data]
    line = " ".join("%.1f,%.1f" % c for c in coords)
    area = "%.1f,%.1f %s %.1f,%.1f" % (
        coords[0][0],
        PAD_T + plot_h,
        line,
        coords[-1][0],
        PAD_T + plot_h,
    )

    ticks = [min(ys), (min(ys) + max(ys)) // 2, max(ys)]
    grid = []
    for v in ticks:
        y = sy(v)
        grid.append(
            '<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" class="grid"/>'
            '<text x="%.1f" y="%.1f" class="tick" text-anchor="end" dominant-baseline="central">%s</text>'
            % (PAD_L, y, W - PAD_R, y, PAD_L - 8, y, _fmt(v))
        )

    first_day, last_day = data[0][2], data[-1][2]
    x_labels = (
        '<text x="%.1f" y="%.1f" class="tick" text-anchor="start">%s</text>'
        '<text x="%.1f" y="%.1f" class="tick" text-anchor="end">%s</text>'
        % (PAD_L, H - 8, first_day, W - PAD_R, H - 8, last_day)
    )

    dot = coords[-1]
    svg = (
        '<svg viewBox="0 0 %.0f %.0f" class="price-chart" role="img" aria-label="%s">'
        "<title>%s</title>"
        "%s%s"
        '<polygon points="%s" class="area"/>'
        '<polyline points="%s" class="line"/>'
        '<circle cx="%.1f" cy="%.1f" r="3.2" class="dot"/>'
        "</svg>"
        % (
            W,
            H,
            aria,
            aria,
            "".join(grid),
            x_labels,
            area,
            line,
            dot[0],
            dot[1],
        )
    )
    return svg, {"min": min(ys), "max": max(ys), "first": first_day, "last": last_day, "n": len(ys)}
