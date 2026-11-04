// カートページ用パネル: 「このまますべて買う」vs「何回かに分けて買う」を比べる。
//
// 分けて買うときの操作方法まで出す。カートは部分精算できないので、
// 実際の手順は「稍后再买 に退避 → 精算 → 戻す」になる。
(function () {
  'use strict';

  const PDP = globalThis.PDP;
  if (!PDP || !PDP.cart || !PDP.i18n || !PDP.coupon) return;

  const { i18n, cart: cartLib } = PDP;

  const PANEL_ID = 'pdp-cart-panel';
  const BRAND = 'DLsite Coupon Plus';

  const COLOR = {
    bg: '#161629',
    border: '#383860',
    text: '#e6e6f0',
    dim: '#8b8bb0',
    accent: '#ffd166',
    good: '#4fd1c5',
    new: '#ff6b8a',
  };

  function el(tag, styleText, text) {
    const node = document.createElement(tag);
    if (styleText) node.style.cssText = styleText;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function divider() {
    return el('div', `border-top:1px solid ${COLOR.border};margin:7px 0;`);
  }

  function row(label, value, opts) {
    const o = opts || {};
    const wrap = el('div', 'display:flex;justify-content:space-between;gap:8px;line-height:1.6;');
    wrap.appendChild(el('span', `color:${o.labelColor || COLOR.dim};`, label));
    wrap.appendChild(
      el('span', `text-align:right;font-weight:${o.bold ? '700' : '400'};color:${o.valueColor || COLOR.text};`, value)
    );
    return wrap;
  }

  function buildPanel() {
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();
    const panel = el(
      'div',
      [
        `background:${COLOR.bg}`,
        `color:${COLOR.text}`,
        `border:1px solid ${COLOR.border}`,
        'border-radius:8px',
        'padding:10px 12px',
        'margin:10px 0',
        'text-align:left',
        'font:12px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Kaku Gothic ProN","Microsoft YaHei",sans-serif',
        'max-width:520px',
      ].join(';')
    );
    panel.id = PANEL_ID;

    // カート一覧の直前か、合計欄の前に差し込む
    const anchor =
      document.querySelector('#cart_wrapper .cart_list') ||
      document.querySelector('#cart_right_total') ||
      document.querySelector('#cart_wrapper');
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(panel, anchor);
    } else {
      document.body.appendChild(panel);
    }
    return panel;
  }

  function moneyFormatter(currency, exchange, locale) {
    return (jpy) => {
      if (!Number.isFinite(jpy)) return '-';
      if (currency === 'JPY' || !exchange) return i18n.formatMoney(jpy, 'JPY', locale);
      const rate = Number(exchange[currency]);
      if (!Number.isFinite(rate) || rate <= 0) return i18n.formatMoney(jpy, 'JPY', locale);
      return i18n.formatMoney(jpy / rate, currency, locale);
    };
  }

  // 会計 (批次) ごとの色。同じ会計に属する見出し・商品・手順を同じ色で結び、
  // どこからどこまでが 1 回の精算かをひと目で追えるようにする。
  const BATCH_COLORS = [
    '#6da7ff', // 青
    '#ffd166', // 金
    '#4fd1c5', // 青緑
    '#ff7a90', // 赤
    '#c792ea', // 紫
    '#a3e635', // 黄緑
    '#f97316', // 橙
    '#38bdf8', // 水色
  ];

  function batchColor(index) {
    return BATCH_COLORS[index % BATCH_COLORS.length];
  }

  /** 批次を示す小さな色ブロック */
  function swatch(color, size) {
    const px = size || 9;
    return el(
      'span',
      `display:inline-block;width:${px}px;height:${px}px;border-radius:2px;` +
        `background:${color};margin-right:6px;vertical-align:middle;flex:0 0 auto;`,
      ''
    );
  }

  /**
   * カートの商品行そのものに批次を描く。
   * ポップアップを開かなくても「この商品は何回目の会計か」が分かるようにするのが目的。
   * 同じ作品番号の行が PC 用/スマホ用で二重に存在するので、該当する行すべてに付ける。
   */
  function markRows(plans, locale) {
    // 前回のマークを消す
    document.querySelectorAll('[data-pdp-batch]').forEach((li) => {
      li.removeAttribute('data-pdp-batch');
      li.style.borderLeft = '';
    });
    document.querySelectorAll('.pdp-batch-badge').forEach((n) => n.remove());

    // 1 回の会計で済むなら分ける必要が無いのでマークしない
    if (!plans || plans.length < 2) return;

    plans.forEach((plan, i) => {
      const color = batchColor(i);
      for (const it of plan.items) {
        const rows = document.querySelectorAll(
          'li.cart_list_item[data-workno="' + it.workno + '"], [data-workno="' + it.workno + '"].cart_list_item'
        );
        for (const li of rows) {
          li.setAttribute('data-pdp-batch', String(i + 1));
          li.style.borderLeft = `4px solid ${color}`;
          if (getComputedStyle(li).position === 'static') li.style.position = 'relative';
          if (li.querySelector('.pdp-batch-badge')) continue;
          const badge = el(
            'span',
            `position:absolute;left:0;top:0;z-index:6;background:${color};color:#12121f;` +
              `font:700 11px/1.5 -apple-system,"Segoe UI",sans-serif;padding:0 6px;` +
              `border-radius:0 0 6px 0;pointer-events:none;`,
            String(i + 1)
          );
          badge.className = 'pdp-batch-badge';
          badge.title = i18n.t(locale || 'ja-jp', 'cartOrderN', { n: i + 1 });
          li.appendChild(badge);
        }
      }
    });
  }

  function renderPlanDetail(box, view) {
    const { locale, plans, money, items, allInOneTotalJpy, allInOneCoupon, splitTotalJpy } = view;
    const t = (k, vars) => i18n.t(locale, k, vars);

    // まず「まとめて買う」と「分ける」の差を出す。分割が得でない場合も、
    // いくらになるのかを数字で見せる (判定だけ信じさせない)。
    const diff = (allInOneTotalJpy || 0) - (splitTotalJpy || 0);
    const cmp = el('div', 'margin-bottom:8px;');
    const allCouponLabel = allInOneCoupon
      ? allInOneCoupon.coupon_name || allInOneCoupon.coupon_id
      : t('cartNoCoupon');
    cmp.appendChild(row(t('cartNowAll'), money(allInOneTotalJpy), { bold: true }));
    cmp.appendChild(el('div', `color:${COLOR.dim};font-size:11px;margin:0 0 4px;`, allCouponLabel));
    cmp.appendChild(
      row(t('cartBestSplit', { n: plans.length }), money(splitTotalJpy), {
        bold: true,
        valueColor: diff > 0.5 ? COLOR.accent : COLOR.text,
      })
    );
    cmp.appendChild(
      el(
        'div',
        `color:${diff > 0.5 ? COLOR.accent : COLOR.dim};font-size:11px;`,
        diff > 0.5 ? t('cartSaving', { amount: money(diff) }) : t('cartSplitNoGain')
      )
    );
    box.appendChild(cmp);
    box.appendChild(divider());

    plans.forEach((plan, i) => {
      const color = batchColor(i);
      const head = el(
        'div',
        `display:flex;justify-content:space-between;align-items:center;gap:8px;margin:${i ? '10px' : '0'} 0 2px;` +
          `border-top:${i ? '1px solid ' + COLOR.border : 'none'};padding-top:${i ? '8px' : '0'};`
      );
      const headLeft = el('span', 'display:flex;align-items:center;flex:0 0 auto;');
      headLeft.appendChild(swatch(color, 10));
      headLeft.appendChild(el('strong', `color:${color};`, t('cartOrderN', { n: i + 1 })));
      head.appendChild(headLeft);
      head.appendChild(el('strong', '', money(plan.totalJpy)));
      box.appendChild(head);

      for (const it of plan.items) {
        const line = el('div', 'display:flex;align-items:baseline;font-size:11.5px;padding-left:2px;word-break:break-word;');
        line.appendChild(swatch(color));
        if (it.title) {
          line.appendChild(el('span', `color:${COLOR.text};`, it.title));
          line.appendChild(el('span', `color:${COLOR.dim};font-size:10.5px;margin-left:6px;`, it.workno));
        } else {
          // タイトルが取れない場合は作品番号だけを 1 回出す (二重表示を避ける)
          line.appendChild(el('span', `color:${COLOR.text};`, it.workno));
        }
        box.appendChild(line);
      }
      const couponLabel = plan.coupon
        ? plan.coupon.coupon_name || plan.coupon.coupon_id
        : t('cartNoCoupon');
      const couponLine = el('div', 'display:flex;align-items:baseline;font-size:11px;padding-left:2px;');
      couponLine.appendChild(swatch(color));
      couponLine.appendChild(el('span', `color:${COLOR.dim};`, `${t('cartUseCoupon')}: ${couponLabel}`));
      box.appendChild(couponLine);
      if (plan.savedJpy > 0) {
        const saveLine = el('div', 'display:flex;align-items:baseline;font-size:11px;padding-left:2px;');
        saveLine.appendChild(swatch(color));
        saveLine.appendChild(el('span', `color:${COLOR.good};`, `− ${money(plan.savedJpy)}`));
        box.appendChild(saveLine);
      }
    });

    // 実際の操作手順。カートは部分精算できないので退避と復帰の順序まで書く
    box.appendChild(divider());
    box.appendChild(el('div', `color:${COLOR.dim};font-size:11px;margin-bottom:2px;`, t('cartHowTo')));
    plans.forEach((plan, i) => {
      const color = batchColor(i);
      const names = plan.items.map((it) => it.title || it.workno).join(' / ');
      const step = el('div', 'display:flex;align-items:baseline;font-size:11.5px;margin-bottom:3px;word-break:break-word;');
      step.appendChild(swatch(color));
      step.appendChild(el('span', `color:${COLOR.text};`, t('cartStepMove', { n: i + 1, items: names })));
      box.appendChild(step);
    });
    box.appendChild(
      el('div', `color:${COLOR.dim};font-size:11px;`, t('cartStepNote', { n: plans.length }))
    );
  }

  function openOverlay(title, builder) {
    const old = document.getElementById(PANEL_ID + '-overlay');
    if (old) old.remove();
    const mask = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646;');
    mask.id = PANEL_ID + '-overlay';
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.remove();
    });
    const box = el(
      'div',
      [
        'position:fixed',
        'right:20px',
        'top:72px',
        'width:380px',
        'max-height:78vh',
        'overflow:auto',
        `background:${COLOR.bg}`,
        `border:1px solid ${COLOR.border}`,
        'border-radius:10px',
        'padding:14px 16px',
        `color:${COLOR.text}`,
        'font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Kaku Gothic ProN","Microsoft YaHei",sans-serif',
        'z-index:2147483647',
        'box-shadow:0 8px 32px rgba(0,0,0,.6)',
        'text-align:left',
      ].join(';')
    );
    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;');
    head.appendChild(el('strong', 'color:#fff;font-size:13px;', title));
    const close = el(
      'button',
      `background:none;border:none;color:${COLOR.dim};cursor:pointer;font-size:16px;line-height:1;padding:0;`,
      '×'
    );
    close.type = 'button';
    close.addEventListener('click', () => mask.remove());
    head.appendChild(close);
    box.appendChild(head);
    builder(box);
    mask.appendChild(box);
    document.body.appendChild(mask);
  }

  /**
   * カートの商品行が描画されるまで待つ。
   * ページがまだ読み込み中だと、商品 API とクーポン API の取得が
   * ネットワーク待ちで遅れるため、先に土台を整える。
   */
  function waitForCartRows(timeoutMs) {
    return new Promise((resolve) => {
      const ready = () => document.querySelectorAll('li.cart_list_item, [data-workno]').length > 0;
      if (ready()) return resolve(true);
      const start = Date.now();
      const timer = setInterval(() => {
        if (ready()) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 250);
    });
  }

  /**
   * 分割案が組合せ折扣のまとまりを崩しているか。
   * 同じ campaign の商品が複数の会計に散らばっていたら true。
   */
  function campaignsBroken(items, plans) {
    const members = new Map();
    for (const it of items) {
      const cid = it.discountCampaignId;
      if (!cid) continue;
      const set = members.get(cid) || new Set();
      set.add(it.workno);
      members.set(cid, set);
    }
    for (const set of members.values()) {
      const groups = new Set();
      for (const workno of set) {
        const idx = plans.findIndex((p) => p.items.some((i) => i.workno === workno));
        if (idx >= 0) groups.add(idx);
      }
      if (groups.size > 1) return true;
    }
    return false;
  }

  async function main() {
    if (!/\/cart(\/|$|\?)/.test(location.pathname + location.search)) return;

    await waitForCartRows(10000);

    const settings = await PDP.history.getSettings();
    const locale = i18n.resolveLocale(settings);
    const t = (k, vars) => i18n.t(locale, k, vars);

    const items = cartLib.readCart(document);
    if (!items.length) return; // 空のカートには何も出さない

    const total = cartLib.readCartTotal(document);
    const currency = cartLib.mapCurrency(total.currency);
    const site = items[0].site || 'maniax';

    const panel = buildPanel();
    panel.appendChild(el('div', `color:${COLOR.dim};`, t('loading')));

    // 1 本の遅いリクエストでパネルが「読み込み中」のまま固まらないよう、
    // 前置きのデータ取得には全体の上限を設ける
    const withTimeout = (promise, ms, fallback) =>
      Promise.race([
        Promise.resolve(promise).catch(() => fallback),
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);

    const [coupons, exchange] = await Promise.all([
      withTimeout(cartLib.fetchMyCoupons(site), 14000, null),
      withTimeout(cartLib.fetchExchange(site), 8000, null),
      // カート行だけでは custom_genres / options が欠けるので作品 API で補う
      withTimeout(cartLib.enrichItems(items), 20000, items),
    ]);
    const money = moneyFormatter(currency, exchange, locale);

    if (!coupons) {
      panel.replaceChildren(
        el('div', `color:${COLOR.dim};`, t('cartNoCoupons'))
      );
      return;
    }

    const result = cartLib.optimize(items, coupons);
    if (!result) return;
    const { plans, allInOne, splitPlans } = result;
    const allTotal = plans.reduce((a, p) => a + p.totalJpy, 0);
    const saveJpy = allInOne.totalJpy - allTotal;
    const view = {
      locale,
      currency,
      plans,
      items,
      money,
      allInOneTotalJpy: allInOne.totalJpy,
      allInOneCoupon: allInOne.coupon,
      splitTotalJpy: allTotal,
    };
    // カートの商品行に直接マークを付ける (ポップアップを開かなくても分かるように)
    markRows(plans, locale);

    panel.replaceChildren();
    // ヘッダ
    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;');
    head.appendChild(el('strong', 'color:#fff;font-size:12px;', BRAND));
    const right = el('div', 'display:flex;align-items:center;gap:6px;');
    right.appendChild(
      el(
        'span',
        `font-size:10px;color:${COLOR.dim};border:1px solid ${COLOR.border};border-radius:3px;padding:0 4px;`,
        locale.toUpperCase()
      )
    );
    const closeBtn = el(
      'button',
      `background:none;border:none;color:${COLOR.dim};cursor:pointer;font-size:14px;line-height:1;padding:0;`,
      '×'
    );
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => panel.remove());
    right.appendChild(closeBtn);
    head.appendChild(right);
    panel.appendChild(head);

    panel.appendChild(row(t('cartNowAll'), money(allInOne.totalJpy), { bold: true }));

    if (saveJpy > 0.5) {
      panel.appendChild(
        row(
          t('cartBestSplit', { n: plans.length }),
          `${money(allTotal)}  (${t('cartSaving', { amount: money(saveJpy) })})`,
          { bold: true, valueColor: COLOR.accent }
        )
      );
    } else {
      panel.appendChild(
        row(t('cartSplitNoGain'), t('cartKeepAsIs'), { valueColor: COLOR.good })
      );
      // 分けた場合の実額も出す。結論だけ見せて根拠を隠さない
      const comparePlans = plans.length > 1 ? plans : splitPlans;
      if (comparePlans && comparePlans.length > 1) {
        const splitTotal = comparePlans.reduce((a, p) => a + p.totalJpy, 0);
        const extra = splitTotal - allInOne.totalJpy;
        const deltaText = extra > 0.5 ? `+${money(extra)}` : t('cartSplitSame');
        panel.appendChild(
          row(t('cartSplitCost', { n: comparePlans.length }), `${money(splitTotal)}  (${deltaText})`)
        );

        // 組合せ折扣が実際に崩れる場合だけ理由を書く。
        // 「3 冊セットを丸ごと 1 会計に残し、別の 1 冊だけ分ける」ような
        // 崩れない分け方もあるので、無条件に書くと誤解になる。
        if (campaignsBroken(items, comparePlans)) {
          panel.appendChild(el('div', `color:${COLOR.dim};font-size:11px;margin-top:2px;`, t('cartCampaignNote')));
        }
      }
    }

    // 行に付けたマークの読み方と、各回の会計の中身をパネル内で完結させる。
    // (内訳をいちいちポップアップで開かなくても判断できるようにする)
    if (plans.length > 1) {
      const legend = el('div', 'margin-top:6px;');
      plans.forEach((plan, i) => {
        const color = batchColor(i);
        const line = el('div', 'display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:1.75;');
        line.appendChild(swatch(color, 9));
        line.appendChild(el('span', `color:${color};font-weight:700;flex:0 0 auto;`, String(i + 1)));
        const couponShort = plan.coupon
          ? plan.coupon.discount_type === 'price'
            ? `${money(plan.coupon.discount)} OFF`
            : `${plan.coupon.discount}% OFF`
          : t('cartNoCoupon');
        line.appendChild(
          el('span', `color:${COLOR.text};flex:1 1 auto;word-break:break-word;`, `${plan.items.length}${t('qtyUnit')} · ${couponShort}`)
        );
        line.appendChild(el('span', `color:${COLOR.text};font-weight:700;flex:0 0 auto;`, money(plan.totalJpy)));
        legend.appendChild(line);
      });
      legend.appendChild(
        el('div', `color:${COLOR.dim};font-size:10.5px;margin-top:2px;`, t('cartBatchHint'))
      );
      panel.appendChild(legend);
    }

    // 内訳はいつでも開けるようにする。分割が得でない場合も「なぜ得しないか」を
    // 自分の目で確認できるようにしておく (判定を信じるしかない状態にしない)。
    const btnView = el(
      'button',
      `background:none;border:none;padding:0;margin:7px 0 0;cursor:pointer;color:${COLOR.good};font:inherit;text-decoration:underline;`,
      t('cartPlanView')
    );
    btnView.type = 'button';
    btnView.addEventListener('click', () => {
      openOverlay(t('cartPlanTitle'), (box) => renderPlanDetail(box, view));
    });
    panel.appendChild(btnView);

    // 画面が表示している券後価格と突き合わせて、推測が外れていないか示す
    if (total.couponText) {
      const shown = Number(String(total.couponText).replace(/[^\d.]/g, ''));
      if (Number.isFinite(shown) && shown > 0) {
        panel.appendChild(
          el(
            'div',
            `color:${COLOR.dim};font-size:11px;margin-top:4px;`,
            t('cartPageShows', { price: `${total.couponText} ${total.currency}` })
          )
        );
      }
    }
    panel.appendChild(el('div', `color:${COLOR.dim};font-size:11px;margin-top:2px;`, t('cartEstimateNote')));
  }

  // テストと再利用のために内部関数を公開しておく
  PDP.cartUi = { renderPlanDetail, openOverlay, moneyFormatter, batchColor, BATCH_COLORS };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
