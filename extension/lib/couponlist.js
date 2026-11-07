// 「条件付きクーポン（非公開券）」一覧。
//
// 前提をはっきりさせる
// -------------------
// DLsite の券に「受け取る」操作は無い。条件（購入済み・チャネル・本数・金額）を
// 満たすと自動で使えるようになる。したがってこのパネルが出せるのは
//   「この作品に使える条件付き券が何枚あるか／何が条件か」
// までで、取得ボタンのようなものは作らない。
//
// 対象の絞り方
// ------------
// 券池 539 枚のうち 300 枚以上が条件付き。全部出すと読めないので、
//   ・作品指定がある券 → この作品が対象のときだけ出す
//   ・作品指定が無い券 → 条件文だけ出す（maker/genre は判定できないので条件として明記）
// に限定し、割引の強い順に最大 8 枚。
(function () {
  'use strict';

  const PDP = globalThis.PDP;
  if (!PDP || !PDP.i18n || !PDP.coupon) return;

  const { coupon: couponLib } = PDP;
  const PANEL_ID = 'pdp-coupon-panel';
  const BLOCK_ID = 'pdp-couponlist';
  const MAX_ITEMS = 8;

  const STRINGS = {
    'ja-jp': {
      title: '条件付きクーポン',
      note: '条件を満たすと自動で使えます（受け取り操作はありません）。',
      needPurchase: '対象作品の購入が必要',
      needChannel: '配信チャネル限定',
      targetWork: '対象作品 {id}',
      targetMaker: '対象サークル限定',
      targetGenre: '対象ジャンル限定',
      minAmount: '合計 {n} 円以上',
      minCount: '{n} 点以上',
      maxPrice: '{n} 円以下',
      other: 'その他の条件あり',
      more: 'ほか {n} 件',
      link: 'マイページを開く →',
    },
    'en-us': {
      title: 'Restricted coupons',
      note: 'They unlock automatically once you qualify — there is nothing to claim.',
      needPurchase: 'requires owning the linked work',
      needChannel: 'channel-limited',
      targetWork: 'target work {id}',
      targetMaker: 'circle-limited',
      targetGenre: 'genre-limited',
      minAmount: 'order total ≥ ¥{n}',
      minCount: '≥ {n} items',
      maxPrice: 'price ≤ ¥{n}',
      other: 'other conditions',
      more: '{n} more',
      link: 'Open My Page →',
    },
    'zh-cn': {
      title: '非公开券（有条件）',
      note: '满足条件后自动可用，没有“领取”这一步。',
      needPurchase: '需已购买指定作品',
      needChannel: '限定渠道',
      targetWork: '限定作品 {id}',
      targetMaker: '限定社团',
      targetGenre: '限定分类',
      minAmount: '合计满 ¥{n}',
      minCount: '满 {n} 件',
      maxPrice: '价格不超过 ¥{n}',
      other: '还有其他条件',
      more: '另有 {n} 张',
      link: '打开我的页面 →',
    },
    'zh-tw': {
      title: '非公開券（有條件）',
      note: '符合條件後自動可用，沒有「領取」這一步。',
      needPurchase: '需已購買指定作品',
      needChannel: '限定通路',
      targetWork: '限定作品 {id}',
      targetMaker: '限定社團',
      targetGenre: '限定分類',
      minAmount: '合計滿 ¥{n}',
      minCount: '滿 {n} 件',
      maxPrice: '價格不超過 ¥{n}',
      other: '還有其他條件',
      more: '另有 {n} 張',
      link: '開啟我的頁面 →',
    },
    'ko-kr': {
      title: '조건부 쿠폰',
      note: '조건을 충족하면 자동으로 사용할 수 있으며, 별도의 수령 절차는 없습니다.',
      needPurchase: '지정 작품 구매 필요',
      needChannel: '채널 한정',
      targetWork: '대상 작품 {id}',
      targetMaker: '서클 한정',
      targetGenre: '장르 한정',
      minAmount: '합계 ¥{n} 이상',
      minCount: '{n}점 이상',
      maxPrice: '¥{n} 이하',
      other: '기타 조건 있음',
      more: '{n}장 더',
      link: '마이페이지 열기 →',
    },
  };

  function tr(locale, key, vars) {
    const dict = STRINGS[locale] || STRINGS['en-us'];
    let text = dict[key] !== undefined ? dict[key] : STRINGS['en-us'][key];
    if (text === undefined) return key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
    );
  }

  function discountText(coupon) {
    const raw = Number(coupon.discount);
    if (!Number.isFinite(raw)) return '';
    if (coupon.discount_type === 'price') return '−¥' + raw.toLocaleString('ja-JP');
    return raw + '%OFF';
  }

  function describe(coupon, t) {
    const parts = [];
    const issue = coupon.issue || {};
    const cond = coupon.condition || {};

    if (issue.product_id) parts.push(t('needPurchase'));
    if (issue.baitai) parts.push(t('needChannel'));

    if (Array.isArray(cond.product_id) && cond.product_id.length) {
      parts.push(t('targetWork', { id: cond.product_id[0] }));
    }
    if (Array.isArray(cond.maker_id) && cond.maker_id.length) parts.push(t('targetMaker'));
    if (Array.isArray(cond.custom_genre) && cond.custom_genre.length) parts.push(t('targetGenre'));

    const minSum = Array.isArray(cond.price_sum) ? Number(cond.price_sum[0]) : Number(cond.price_sum);
    if (Number.isFinite(minSum) && minSum > 0) parts.push(t('minAmount', { n: minSum }));

    const need = Math.max(
      Number((cond.post_condition || {}).count) || 0,
      Number((cond.prerequisite || {}).count) || 0
    );
    if (need > 0) parts.push(t('minCount', { n: need }));

    const cap = Number(cond.maximum_applicable_price);
    if (Number.isFinite(cap) && cap > 0) parts.push(t('maxPrice', { n: cap }));

    if (!parts.length) parts.push(t('other'));
    return parts.join(' · ');
  }

  /** 券池 → 这件作品可能用到的条件券 */
  function pick(coupons, workno, priceJpy) {
    const out = [];
    for (const coupon of coupons) {
      if (couponLib.classify(coupon) !== 'qualified') continue;
      const cond = coupon.condition || {};
      if (Array.isArray(cond.product_id) && cond.product_id.length) {
        if (!cond.product_id.includes(workno)) continue;
      }
      if (typeof cond.product_all === 'string' && cond.product_all !== workno) continue;
      const minSum = Array.isArray(cond.price_sum) ? Number(cond.price_sum[0]) : Number(cond.price_sum);
      if (Number.isFinite(minSum) && minSum > 0 && priceJpy < minSum) continue;
      const cap = Number(cond.maximum_applicable_price);
      if (Number.isFinite(cap) && cap > 0 && priceJpy > cap) continue;

      const raw = Number(coupon.discount);
      out.push({
        coupon,
        score: coupon.discount_type === 'price' ? raw : raw * 10,
        label: discountText(coupon),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function build(locale) {
    const target = couponLib.parseTarget(location.href);
    if (!target) return null;

    const plain = couponLib.readDomPrice(document);
    if (!plain || !Number.isFinite(plain.value)) return null;

    const pool = await couponLib.fetchCouponPool().catch(() => null);
    if (!Array.isArray(pool) || !pool.length) return null;

    const items = pick(pool, target.workno, plain.value);
    if (!items.length) return null;

    const t = (key, vars) => tr(locale, key, vars);
    const wrap = el('details', 'margin-top:8px;font-size:12px;color:#c9c9e6;');
    wrap.id = BLOCK_ID;

    const head = el(
      'summary',
      'cursor:pointer;color:#8b8bb0;outline:none;',
      t('title') + ' (' + items.length + ')'
    );
    wrap.appendChild(head);

    wrap.appendChild(el('div', 'color:#8b8bb0;margin:4px 0 6px;font-size:11px;', t('note')));

    for (const item of items.slice(0, MAX_ITEMS)) {
      const row = el('div', 'padding:4px 0;border-top:1px solid #2a2a44;');
      const top = el('div', 'display:flex;gap:6px;align-items:baseline;');
      top.appendChild(el('span', 'color:#ffd166;font-weight:700;white-space:nowrap;', item.label));
      top.appendChild(el('span', 'color:#e6e6f0;', item.coupon.coupon_name || ''));
      row.appendChild(top);
      row.appendChild(el('div', 'color:#8b8bb0;font-size:11px;', describe(item.coupon, t)));
      wrap.appendChild(row);
    }

    if (items.length > MAX_ITEMS) {
      wrap.appendChild(
        el('div', 'color:#8b8bb0;margin-top:4px;', t('more', { n: items.length - MAX_ITEMS }))
      );
    }

    const site = target.site || 'maniax';
    const link = el('a', 'display:inline-block;margin-top:6px;color:#4fd1c5;text-decoration:none;', t('link'));
    link.href = 'https://www.dlsite.com/' + site + '/mypage';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    wrap.appendChild(link);

    return wrap;
  }

  function attach(panel, locale) {
    let scheduled = false;
    const ensure = () => {
      scheduled = false;
      if (!panel.isConnected) return;
      if (panel.querySelector('#' + BLOCK_ID)) return;
      build(locale)
        .then((block) => {
          if (block && !panel.querySelector('#' + BLOCK_ID)) panel.appendChild(block);
        })
        .catch((err) => {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[DLsite Coupon Plus] couponlist failed:', err);
          }
        });
    };
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(ensure, 40);
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
    attach(panel, PDP.i18n.resolveLocale(settings));
  })();
})();
