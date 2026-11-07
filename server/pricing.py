"""价格定位：把「当前券后价」换算成「处于历史的什么位置」。

网站与扩展回答的是同一个问题，但数据来源不同：
  网站：current_price 来自每日刷新，价历史来自 price_samples
  扩展：券后价来自页面 DOM（权威），价历史来自本站 API

因此这里只做纯函数，不碰数据库与 DOM，两边共用同一套语义。
"""


def effective_price(base_price, item_rate=None, bundle_rate=None):
    """套装折扣与单品折扣取较大者（DLsite 不叠加），返回 (有效价, 生效折扣率)。

    base_price  : 定価（official_price）
    item_rate   : 当前单品折扣率（0-100）
    bundle_rate : 套装活动折扣率（0-100），如「3本以上60%OFF」→ 60

    实测口径：单品 50% + 套装 60% → 只算 60%，不是 80%。
    """
    if base_price is None:
        return None, None
    rates = [r for r in (item_rate, bundle_rate) if r is not None]
    rate = max(rates) if rates else 0
    rate = max(0, min(100, int(rate)))
    return int(round(base_price * (100 - rate) / 100.0)), rate


def position(prices, current, min_points=5):
    """返回当前价在历史中的位置。

    prices  ：历史每日价格（整数円），可含重复
    current ：当前有效价（券后价，整数円）
    pct     ：比过去多少比例的日子更便宜（0-100 整数）；样本不足时为 None
    is_low  ：是否等于或低于历史最低；样本不足 5 天时恒为 False（没有可比的历史）
    """
    if current is None:
        return None
    series = [int(p) for p in prices if p is not None]
    if not series:
        return None

    lo = min(series)
    hi = max(series)
    n = len(series)
    cheaper_than = sum(1 for p in series if p > current)

    return {
        "min": lo,
        "max": hi,
        "points": n,
        "is_low": n >= min_points and current <= lo,
        "pct": int(round(cheaper_than * 100.0 / n)) if n >= min_points else None,
        "gap": lo - current,  # 低于历史最低多少円（负数表示还没到最低）
    }


def level_label(pos, keys):
    """把位置翻译成一个短标签键：low / near / mid / high。

    阈值刻意保守：只有真正等于最低才算 low，避免把「接近最低」说成「最低」。
    """
    if not pos:
        return None
    if pos["is_low"]:
        return "low"
    pct = pos.get("pct")
    if pct is None:
        return None
    if pct >= 90:
        return "near"
    if pct >= 50:
        return "mid"
    return "high"
