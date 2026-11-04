// 「这件作品现在是不是历史低位」——挂在 content.js 的面板下面。
//
// 为什么不直接改 content.js
// -------------------------
// content.js 仍在上游（H:\Dlsite\dl-ext\price-db-plus）持续开发，
// scripts/sync_extension.py 会用上游覆盖它。所以定位信息独立成模块，
// 只读页面与本站接口，不改绘面板既有逻辑。
//
// 口径
// ----
//   当前价：优先取页面「クーポン適用後」的官方价（DOM 权威），没有则取当前售价
//   历史  ：本站 /api/lookup 返回的日价格序列（円，不含券历史）
//   判定  ：券后价 ≤ 历史最低 → 历史新低；否则给出「比多少比例的记录日更便宜」
(function () {
  'use strict';

  const PDP = globalThis.PDP;
  if (!PDP || !PDP.i18n || !PDP.coupon) return;

  const { coupon: couponLib } = PDP;
  const PANEL_ID = 'pdp-coupon-panel';
  const BLOCK_ID = 'pdp-lowpos';
  const MIN_POINTS = 5; // 少于 5 天不给百分位，新作品的分位没有意义

  const STRINGS = {
    'ja-jp': ['過去最安', '記録日の {pct}% より安い', '最安 {price}（{days}日分）'],
    'en-us': ['All-time low', 'cheaper than {pct}% of days', 'low {price} ({days} days)'],
    'zh-cn': ['历史最低价', '比 {pct}% 的记录日更便宜', '最低 {price}（{days} 天）'],
    'zh-tw': ['歷史最低價', '比 {pct}% 的記錄日更便宜', '最低 {price}（{days} 天）'],
    'ko-kr': ['역대 최저', '기록일의 {pct}%보다 저렴', '최저 {price} ({days}일)'],
    'es-es': ['Mínimo histórico', 'más barato que el {pct}% de los días', 'mínimo {price} ({days} días)'],
    'de-de': ['Rekordtief', 'günstiger als {pct}% der Tage', 'Tief {price} ({days} Tage)'],
    'fr-fr': ['Plus bas historique', 'moins cher que {pct}% des jours', 'min. {price} ({days} j)'],
    'id-id': ['Terendah', 'lebih murah dari {pct}% hari', 'terendah {price} ({days} hari)'],
    'it-it': ['Minimo storico', 'più economico del {pct}% dei giorni', 'minimo {price} ({days} gg)'],
    'pt-br': ['Mínima histórica', 'mais barato que {pct}% dos dias', 'mínima {price} ({days} dias)'],
    'sv-se': ['Lägsta', 'billigare än {pct}% av dagarna', 'lägst {price} ({days} d)'],
    'th-th': ['ต่ำสุดเป็นประวัติการณ์', 'ถูกกว่าวันที่บันทึกไว้ {pct}%', 'ต่ำสุด {price} ({days} วัน)'],
    'vi-vn': ['Thấp nhất lịch sử', 'rẻ hơn {pct}% số ngày', 'thấp nhất {price} ({days} ngày)'],
  };

  function tr(locale, index, vars) {
    const row = STRINGS[locale] || STRINGS['en-us'];
    let text = row[index] || STRINGS['en-us'][index];
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
    );
  }

  function money(jpy) {
    return '¥' + Math.round(jpy).toLocaleString('ja-JP');
  }

  /** 显示货币 → 円。只有非 JPY 时才需要 product.currencyPrice 反算。 */
  function toJpy(value, currency, product) {
    if (!Number.isFinite(value)) return null;
    if (!currency || currency === 'JPY') return Math.round(value);
    const map = product && product.currencyPrice;
    if (!map) return null;
    const rate = Number(map[currency]);
    const base = Number(map.JPY);
    if (!Number.isFinite(rate) || !Number.isFinite(base) || rate <= 0) return null;
    return Math.round((value * base) / rate);
  }

  function position(prices, current) {
    if (!Number.isFinite(current) || !prices.length) return null;
    const lo = Math.min.apply(null, prices);
    const n = prices.length;
    const cheaper = prices.filter((p) => p > current).length;
    return {
      min: lo,
      points: n,
      isLow: current <= lo,
      pct: n >= MIN_POINTS ? Math.round((cheaper * 100) / n) : null,
    };
  }

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function loadRemote(target) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'lookup', store: target.store, id: target.workno },
          (res) => {
            if (chrome.runtime.lastError) return resolve(null);
            if (!res || !res.ok || res.status !== 200 || !res.data) return resolve(null);
            resolve(res.data);
          }
        );
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function buildBlock(locale) {
    const target = couponLib.parseTarget(location.href);
    if (!target) return null;

    const remote = await loadRemote(target);
    const plat =
      remote && Array.isArray(remote.platforms)
        ? remote.platforms.find((p) => p.platform === 'dlsite') || remote.platforms[0]
        : null;
    if (!plat || !Array.isArray(plat.history) || plat.history.length < 2) return null;

    const coupon = couponLib.readDomCoupon(document);
    const plain = couponLib.readDomPrice(document);

    let value = coupon && Number.isFinite(coupon.value) ? coupon.value : null;
    let currency = coupon && coupon.currency;
    if (!Number.isFinite(value) && plain) {
      value = plain.value;
      currency = plain.currency;
    }
    if (!Number.isFinite(value)) return null;

    let jpy = toJpy(value, currency, null);
    if (jpy === null) {
      const product = await couponLib.fetchProduct(target.site, target.workno).catch(() => null);
      jpy = toJpy(value, currency, product);
    }
    if (jpy === null) return null;

    const prices = plat.history.map((p) => Number(p[1])).filter((n) => Number.isFinite(n));
    const pos = position(prices, jpy);
    if (!pos) return null;

    const lastDay = plat.history[plat.history.length - 1][0];
    const useCoupon = !!(coupon && Number.isFinite(coupon.value));

    const block = el(
      'div',
      [
        'margin-top:8px',
        'padding-top:8px',
        'border-top:1px solid #383860',
        'font-size:12px',
        'line-height:1.5',
      ].join(';')
    );
    block.id = BLOCK_ID;

    let label = null;
    if (pos.isLow) label = tr(locale, 0);
    else if (pos.pct !== null) label = tr(locale, 1, { pct: pos.pct });
    if (!label) return null;

    const badge = el(
      'span',
      [
        'display:inline-block',
        'padding:1px 7px',
        'border-radius:9px',
        'font-weight:700',
        pos.isLow ? 'background:#4fd1c5;color:#08221f' : 'background:#2a2a4a;color:#c9c9e6',
      ].join(';'),
      label
    );
    block.appendChild(badge);

    const ref = el(
      'div',
      'color:#8b8bb0;margin-top:3px;',
      tr(locale, 2, { price: money(pos.min), days: pos.points }) + ' · ' + lastDay
    );
    block.appendChild(ref);

    if (useCoupon) {
      block.appendChild(el('div', 'color:#8b8bb0;font-size:11px;', '± ' + money(jpy)));
    }
    return block;
  }

  function attach(panel, locale) {
    let scheduled = false;

    const ensure = () => {
      scheduled = false;
      if (!panel.isConnected) return;
      const existing = panel.querySelector('#' + BLOCK_ID);
      if (existing) return;
      buildBlock(locale)
        .then((block) => {
          if (block && !panel.querySelector('#' + BLOCK_ID)) panel.appendChild(block);
        })
        .catch((err) => {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[DLsite Coupon Plus] lowpos failed:', err);
          }
        });
    };

    // content.js 每次 render 会重排子节点，把我们的块冲掉；观察后补回
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(ensure, 30);
    });
    observer.observe(panel, { childList: true });
    ensure();
  }

  function waitPanel(timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const panel = document.getElementById(PANEL_ID);
        if (panel) return resolve(panel);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  (async function main() {
    const panel = await waitPanel(15000);
    if (!panel) return;
    const settings = await PDP.history.getSettings().catch(() => ({}));
    const locale = PDP.i18n.resolveLocale(settings);
    attach(panel, locale);
  })();
})();
