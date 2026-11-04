// 作品ページに「クーポン適用後の最安値」と価格推移を出すパネル。
//
// データは 3 系統を突き合わせる:
//   1. 自前の価格 DB (dlsite.momo-yu.com) — 過去の価格推移。クーポンは考慮しない
//   2. ページ内の券 API + 作品 API — いま使える券と、券適用後の円価格
//   3. chrome.storage.local — この端末で観測した最安値
//
// 最低価格は 2 本立て:
//   最低価格 … 新規ユーザー券を除く (誰でも条件を満たせば使える券だけ)
//   理論最低 … 購入履歴・チャネル限定の券も含む
// どちらもクリックすると算出過程 (定価→割引→券→多部) を開ける。
(function () {
  'use strict';

  const PDP = globalThis.PDP;
  if (!PDP || !PDP.i18n || !PDP.coupon || !PDP.history) return;

  const { i18n, coupon: couponLib, history: historyLib } = PDP;

  const BRAND = 'DLsite Coupon Plus';
  const PANEL_ID = 'pdp-coupon-panel';
  const OVERLAY_ID = 'pdp-detail-overlay';
  const REMOTE_TIMEOUT_MS = 8000;

  const COLOR = {
    bg: '#161629',
    border: '#383860',
    text: '#e6e6f0',
    dim: '#8b8bb0',
    accent: '#ffd166',
    good: '#4fd1c5',
    new: '#ff6b8a',
  };

  // ---- DOM ヘルパー -------------------------------------------------------

  function el(tag, styleText, text) {
    const node = document.createElement(tag);
    if (styleText) node.style.cssText = styleText;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function row(label, value, opts) {
    const o = opts || {};
    const wrap = el('div', 'display:flex;justify-content:space-between;gap:8px;line-height:1.6;');
    wrap.appendChild(el('span', `color:${o.labelColor || COLOR.dim};flex:0 0 auto;`, label));
    wrap.appendChild(
      el(
        'span',
        `text-align:right;word-break:break-word;font-weight:${o.bold ? '700' : '400'};color:${
          o.valueColor || COLOR.text
        };`,
        value
      )
    );
    return wrap;
  }

  function divider() {
    return el('div', `border-top:1px solid ${COLOR.border};margin:7px 0;`);
  }

  function chip(text, color) {
    return el(
      'span',
      `display:inline-block;font-size:10px;line-height:1.5;padding:0 4px;margin-left:4px;` +
        `border:1px solid ${color || COLOR.border};border-radius:3px;color:${color || COLOR.dim};`,
      text
    );
  }

  // ---- リモート照会 -------------------------------------------------------

  function lookupRemote(store, workno) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const timer = setTimeout(() => done(null), REMOTE_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type: 'lookup', store, id: workno }, (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return done(null);
          if (!res || !res.ok) return done(null);
          if (res.status === 404) return done(null);
          if (res.status < 200 || res.status >= 300) return done(null);
          done(res.data);
        });
      } catch (e) {
        clearTimeout(timer);
        done(null);
      }
    });
  }

  // ---- スパークライン -----------------------------------------------------

  function buildSparkline(platforms, currency, product, locale) {
    const width = 216;
    const height = 44;
    const colors = { dlsite: '#6da7ff', dmm: '#ff7a90' };
    const series = platforms
      .filter((p) => Array.isArray(p.history) && p.history.length >= 2)
      .map((p) => ({
        color: colors[p.platform] || COLOR.good,
        points: p.history
          .map((point) => {
            const t = Date.parse(point[0]);
            const display = couponLib.toDisplay(Number(point[1]), currency, product);
            return [t, display === null ? Number(point[1]) : display];
          })
          .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1])),
      }))
      .filter((s) => s.points.length >= 2);
    if (!series.length) return null;

    const times = [];
    const prices = [];
    for (const s of series) {
      for (const [t, p] of s.points) {
        times.push(t);
        prices.push(p);
      }
    }
    const tMin = Math.min(...times);
    const tRange = Math.max(...times) - tMin || 1;
    const pMin = Math.min(...prices);
    const pRange = Math.max(...prices) - pMin || 1;

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.cssText = 'display:block;width:100%;height:auto;margin-top:2px;';

    for (const s of series) {
      const points = s.points
        .map(([t, p]) => {
          const x = ((t - tMin) / tRange) * width;
          const y = height - ((p - pMin) / pRange) * height;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', points);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', s.color);
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
    }
    return svg;
  }

  // ---- パネル -------------------------------------------------------------

  function findAnchor() {
    return document.querySelector('#work_price') || document.querySelector('.work_buy_content');
  }

  function createPanel() {
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();

    const panel = el(
      'div',
      [
        `background:${COLOR.bg}`,
        `color:${COLOR.text}`,
        `border:1px solid ${COLOR.border}`,
        'border-radius:8px',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Kaku Gothic ProN","Microsoft YaHei",sans-serif',
        'font-size:12px',
        'line-height:1.55',
        'padding:10px 12px',
        'text-align:left',
        'max-width:360px',
      ].join(';')
    );
    panel.id = PANEL_ID;

    const anchor = findAnchor();
    if (anchor && anchor.parentNode) {
      panel.style.margin = '8px 0';
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    } else {
      panel.style.position = 'fixed';
      panel.style.right = '16px';
      panel.style.bottom = '16px';
      panel.style.zIndex = '2147483647';
      panel.style.width = '280px';
      panel.style.boxShadow = '0 4px 16px rgba(0,0,0,0.45)';
      document.body.appendChild(panel);
    }
    return panel;
  }

  function buildHeader(locale) {
    const header = el(
      'div',
      'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;'
    );
    header.appendChild(el('strong', 'font-size:12px;color:#fff;', BRAND));
    const right = el('div', 'display:flex;align-items:center;gap:6px;flex:0 0 auto;');
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
    right.appendChild(closeBtn);
    header.appendChild(right);
    return { header, closeBtn };
  }

  function linkButton(text) {
    const btn = el(
      'button',
      `background:none;border:none;padding:0;margin:6px 0 0;cursor:pointer;` +
        `color:${COLOR.good};font:inherit;text-decoration:underline;`,
      text
    );
    btn.type = 'button';
    return btn;
  }

  function renderLoading(panel, locale) {
    panel.replaceChildren();
    const { header, closeBtn } = buildHeader(locale);
    closeBtn.addEventListener('click', () => panel.remove());
    panel.appendChild(header);
    panel.appendChild(el('div', `color:${COLOR.dim};`, i18n.t(locale, 'loading')));
  }

  // ---- 内訳オーバーレイ ---------------------------------------------------

  function closeOverlay() {
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
  }

  function openOverlay(title, bodyBuilder) {
    closeOverlay();
    const mask = el('div', `position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646;`);
    mask.id = OVERLAY_ID;
    mask.addEventListener('click', (e) => {
      if (e.target === mask) closeOverlay();
    });

    const box = el(
      'div',
      [
        'position:fixed',
        'right:20px',
        'top:72px',
        'width:360px',
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

    const header = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;');
    header.appendChild(el('strong', 'color:#fff;font-size:13px;', title));
    const close = el(
      'button',
      `background:none;border:none;color:${COLOR.dim};cursor:pointer;font-size:16px;line-height:1;padding:0;`,
      '×'
    );
    close.type = 'button';
    close.addEventListener('click', closeOverlay);
    header.appendChild(close);
    box.appendChild(header);
    bodyBuilder(box);

    mask.appendChild(box);
    document.body.appendChild(mask);
  }

  /** 金額表示のための小さなフォーマッタ束 */
  function moneyKit(currency, product, locale) {
    return (jpy) => {
      const display = couponLib.toDisplay(jpy, currency, product);
      if (display === null) return i18n.formatMoney(jpy, 'JPY', locale);
      return i18n.formatMoney(display, currency, locale);
    };
  }

  // ---- 内訳: 価格の組み立て ----------------------------------------------

  function buildComposeBody(box, view) {
    const { locale, compose, money } = view;
    const t = (k, vars) => i18n.t(locale, k, vars);
    const { listPriceJpy, priceJpy, campaignBest, officialJpy, officialSource, excluded } = compose;

    // 定価 → 店頭割引 → 券 の順に並べる (券は割引後の価格に当たる: 実測で確認済み)
    if (listPriceJpy && listPriceJpy > priceJpy) {
      box.appendChild(row(t('listPrice'), money(listPriceJpy)));
      const rate = Math.round(((listPriceJpy - priceJpy) / listPriceJpy) * 1000) / 10;
      box.appendChild(row(`${t('shopDiscount')} ${rate}%`, `− ${money(listPriceJpy - priceJpy)}`));
      box.appendChild(row(t('current'), money(priceJpy), { bold: true }));
    } else {
      box.appendChild(row(t('current'), money(priceJpy), { bold: true }));
    }

    box.appendChild(divider());

    if (campaignBest) {
      const label =
        campaignBest.discountType === 'price'
          ? `${money(campaignBest.discount)} OFF`
          : `${campaignBest.discount}% OFF`;
      const meta = [];
      if (campaignBest.endDate) meta.push(campaignBest.endDate.slice(0, 10));
      if (campaignBest.needCount > 1) meta.push(t('needCountBadge', { n: campaignBest.needCount }));
      box.appendChild(
        el(
          'div',
          `color:${COLOR.text};font-size:11.5px;word-break:break-word;`,
          `${label} · ${campaignBest.couponName || campaignBest.couponId}`
        )
      );
      if (meta.length) {
        box.appendChild(el('div', `color:${COLOR.dim};font-size:11px;`, meta.join(' · ')));
      }
      box.appendChild(
        row(t('lowestCoupon'), money(campaignBest.totalAfterJpy), {
          bold: true,
          valueColor: COLOR.accent,
        })
      );
    } else {
      box.appendChild(el('div', `color:${COLOR.dim};`, t('couponNone')));
    }

    if (officialJpy !== null) {
      box.appendChild(divider());
      box.appendChild(row(t('officialNote', { price: money(officialJpy) }), ''));
      if (campaignBest && officialJpy < campaignBest.totalAfterJpy - 1) {
        box.appendChild(el('div', `color:${COLOR.dim};font-size:11px;`, t('officialDiff')));
      }
    }

    // 条件で落ちた券。何が使えて何が使えないかが分かるように種類別にまとめる
    if (excluded && excluded.length) {
      box.appendChild(divider());
      box.appendChild(
        el('div', `color:${COLOR.dim};font-size:11px;margin-bottom:2px;`, `${t('excludedTitle')} (${excluded.length})`)
      );
      const byKind = new Map();
      for (const item of excluded) {
        const key = item.kind === 'newuser' ? 'kindNewUser' : item.kind === 'qualified' ? 'kindQualified' : 'kindBlocked';
        if (!byKind.has(key)) byKind.set(key, []);
        byKind.get(key).push(item);
      }
      for (const [key, items] of byKind) {
        box.appendChild(
          el('div', `color:${COLOR.text};font-size:11px;margin-top:4px;`, `${t(key)} · ${items.length}`)
        );
        for (const item of items.slice(0, 4)) {
          box.appendChild(
            el(
              'div',
              `color:${COLOR.dim};font-size:11px;padding-left:8px;word-break:break-word;`,
              `· ${item.coupon.coupon_name || item.coupon.coupon_id}`
            )
          );
        }
        if (items.length > 4) {
          box.appendChild(el('div', `color:${COLOR.dim};font-size:11px;padding-left:8px;`, `· … +${items.length - 4}`));
        }
      }
    }
  }

  // ---- 内訳: 多部数 -------------------------------------------------------

  function buildMultiBody(box, view) {
    const { locale, multi, money } = view;
    const t = (k, vars) => i18n.t(locale, k, vars);
    if (!multi || !multi.length) {
      box.appendChild(el('div', `color:${COLOR.dim};`, t('never')));
      return;
    }
    const bestUnit = Math.min(...multi.map((r) => r.unitJpy));
    for (const r of multi) {
      const line = el(
        'div',
        `display:flex;justify-content:space-between;gap:8px;padding:3px 0;line-height:1.6;` +
          (r.unitJpy === bestUnit ? `border-left:2px solid ${COLOR.accent};padding-left:6px;margin-left:-8px;` : '')
      );
      const left = el('span', `color:${r.unitJpy === bestUnit ? COLOR.accent : COLOR.text};`);
      left.textContent = `${r.qty}${t('qtyUnit')}`;
      if (r.type === 'coupon' && r.coupon) {
        left.appendChild(chip(t('kindCampaign'), COLOR.good));
      } else if (r.type === 'volumeSet') {
        left.appendChild(chip(`${r.rate}%`, COLOR.accent));
      }
      line.appendChild(left);

      const right = el('span', 'text-align:right;');
      right.appendChild(el('strong', `color:${r.unitJpy === bestUnit ? COLOR.accent : COLOR.text};`, money(r.totalJpy)));
      right.appendChild(
        el(
          'span',
          `color:${COLOR.dim};font-size:11px;display:block;`,
          `${t('unitPrice')} ${money(r.unitJpy)}`
        )
      );
      line.appendChild(right);
      box.appendChild(line);
    }
    box.appendChild(divider());
    box.appendChild(el('div', `color:${COLOR.dim};font-size:11px;`, t('multiHint')));
  }

  // ---- 本体描画 -----------------------------------------------------------

  function render(panel, view) {
    const { locale, currency, product, campaignBest, officialJpy, remote, rec } = view;
    const money = moneyKit(currency, product, locale);
    const t = (key, vars) => i18n.t(locale, key, vars);

    panel.replaceChildren();
    const { header, closeBtn } = buildHeader(locale);
    closeBtn.addEventListener('click', () => panel.remove());
    panel.appendChild(header);

    // ページが表示している券後価格 (いま買う場合の実額)
    if (officialJpy !== null) {
      const line = el(
        'div',
        'display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:2px 0 1px;'
      );
      line.appendChild(el('span', `color:${COLOR.dim};`, t('couponAfter')));
      line.appendChild(
        el('span', `font-size:15px;font-weight:700;color:${COLOR.accent};`, money(officialJpy))
      );
      panel.appendChild(line);
      const name = view.officialCouponName;
      if (name) {
        panel.appendChild(
          el('div', `color:${COLOR.dim};font-size:11px;word-break:break-word;margin-bottom:3px;`, `${t('couponUsed')}: ${name}`)
        );
      }
    }

    if (product && product.priceJpy > 0) {
      panel.appendChild(row(t('current'), money(product.priceJpy)));
    }

    // この端末の記録 (2 本立て)
    if (rec) {
      panel.appendChild(divider());
      panel.appendChild(el('div', `color:${COLOR.dim};font-size:11px;margin-bottom:2px;`, t('history')));

      const lowest = rec.coupon && Number.isFinite(rec.coupon.minJpy) ? rec.coupon.minJpy : null;
      panel.appendChild(
        row(
          t('lowestCoupon'),
          lowest !== null ? `${money(lowest)} (${i18n.formatDate(rec.coupon.minAt, locale)})` : t('never'),
          { valueColor: COLOR.accent, bold: true }
        )
      );

      const theory = rec.theory && Number.isFinite(rec.theory.minJpy) ? rec.theory.minJpy : null;
      panel.appendChild(
        row(
          t('theoryLowest'),
          theory !== null ? `${money(theory)} (${i18n.formatDate(rec.theory.minAt, locale)})` : t('never')
        )
      );

      if (rec.plain && Number.isFinite(rec.plain.minJpy)) {
        panel.appendChild(
          row(t('lowestPlain'), `${money(rec.plain.minJpy)} (${i18n.formatDate(rec.plain.minAt, locale)})`)
        );
      }
      if (Number.isFinite(rec.samples)) {
        panel.appendChild(row(t('samples', { n: rec.samples }), ''));
      }
    }

    // 内訳を開くボタン
    panel.appendChild(divider());
    const btns = el('div', 'display:flex;gap:12px;flex-wrap:wrap;');
    const btnCompose = linkButton(t('viewBreakdown'));
    btnCompose.addEventListener('click', () => {
      openOverlay(t('breakdownTitle'), (box) => buildComposeBody(box, view));
    });
    btns.appendChild(btnCompose);
    if (view.multi && view.multi.length > 1) {
      // 多部で単価が下がるなら、開かなくても分かるようボタンに添える
      const bestRow = view.multi.reduce((a, b) => (b.unitJpy < a.unitJpy ? b : a));
      const single = view.multi[0];
      const hint = bestRow.qty > 1 && bestRow.unitJpy < single.unitJpy ? bestRow : null;
      const label = hint
        ? `${t('multiBuy')} · ${hint.qty}${t('qtyUnit')} ${money(hint.unitJpy)}`
        : t('multiBuy');
      const btnMulti = linkButton(label);
      btnMulti.addEventListener('click', () => {
        openOverlay(t('multiTitle'), (box) => buildMultiBody(box, view));
      });
      btns.appendChild(btnMulti);
    }
    panel.appendChild(btns);

    // 自前の価格 DB の履歴
    if (remote && Array.isArray(remote.platforms) && remote.platforms.length) {
      panel.appendChild(divider());
      const spark = buildSparkline(remote.platforms, currency, product, locale);
      if (spark) panel.appendChild(spark);

      const priced = remote.platforms.filter((p) => p.current && Number.isFinite(p.current.price));
      if (priced.length >= 2) {
        const cheapest = priced.reduce((a, b) => (b.current.price < a.current.price ? b : a));
        const allSame = priced.every((p) => p.current.price === cheapest.current.price);
        panel.appendChild(
          el(
            'div',
            `color:${COLOR.accent};font-weight:700;margin-top:2px;`,
            allSame
              ? t('samePrice')
              : t('cheapest', { store: cheapest.platform.toUpperCase(), price: money(cheapest.current.price) })
          )
        );
      }

      for (const entry of remote.platforms) {
        if (!entry.stats) continue;
        panel.appendChild(
          row(
            `${t('lowestEver')} · ${entry.platform.toUpperCase()}`,
            `${money(entry.stats.minPrice)} (${i18n.formatDate(entry.stats.minPriceAt, locale)})`
          )
        );
        panel.appendChild(row(t('firstSeen'), i18n.formatDate(entry.stats.firstSeenAt, locale)));
      }
    } else {
      panel.appendChild(divider());
      panel.appendChild(el('div', `color:${COLOR.dim};`, t('noData')));
    }

    if (remote && remote.url) {
      try {
        const target = new URL(remote.url, 'https://dlsite.momo-yu.com');
        if (target.hostname === 'dlsite.momo-yu.com' || target.hostname.endsWith('.momo-yu.com')) {
          const link = el(
            'a',
            `display:inline-block;margin-top:6px;color:${COLOR.good};text-decoration:none;`,
            t('linkSite')
          );
          link.href = target.toString();
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          panel.appendChild(link);
        }
      } catch (e) {
        // URL が壊れていればリンクは出さない
      }
    }
  }

  // ---- 待ち合わせ ---------------------------------------------------------

  /**
   * ページの券表示が描画されるまで待つ。.coupon_available が出て、かつ中身
   * (金額、または「利用できません」等の文言) が入った時点で返す。
   */
  function waitForCouponBlock(timeoutMs) {
    const ready = () => {
      const block = document.querySelector('.coupon_available');
      if (!block) return false;
      const base = block.querySelector('dd.total .work_price_base');
      if (base && base.textContent.trim()) return true;
      return block.textContent.trim().length > 0;
    };
    return new Promise((resolve) => {
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

  // ---- 本体 ---------------------------------------------------------------

  async function main() {
    const target = couponLib.parseTarget(location.href);
    if (!target) return;

    const settings = await historyLib.getSettings();
    const locale = i18n.resolveLocale(settings);

    const panel = createPanel();
    renderLoading(panel, locale);

    const [product, pool, remote] = await Promise.all([
      couponLib.fetchProduct(target.site, target.workno).catch(() => null),
      couponLib.fetchCouponPool().catch(() => null),
      lookupRemote(target.store, target.workno),
    ]);

    await waitForCouponBlock(6000);

    const currency = couponLib.detectCurrency(document);
    const domCoupon = couponLib.readDomCoupon(document);
    const domPrice = couponLib.readDomPrice(document);

    // ページが出している券後価格を円に直す (比率換算なので桁区切りの違いに強い)
    let officialJpy = null;
    if (
      product &&
      product.priceJpy > 0 &&
      domCoupon.value !== null &&
      domCoupon.value > 0 &&
      domPrice &&
      domPrice.value > 0 &&
      domCoupon.value < domPrice.value
    ) {
      officialJpy = Math.round((product.priceJpy * domCoupon.value) / domPrice.value);
    }

    const ctx = product
      ? {
          workno: target.workno,
          site: target.site,
          priceJpy: product.priceJpy,
          listPriceJpy: product.listPriceJpy,
          qty: 1,
          workType: product.workType,
          makerId: product.makerId,
          options: product.options,
          customGenres: product.customGenres,
          volumeSet: product.volumeSet,
        }
      : null;

    let campaignBest = null;
    let theoryBest = null;
    let excluded = [];
    let multi = [];
    if (product && pool && ctx) {
      const campaign = couponLib.computeBest(pool, ctx, 'campaign');
      campaignBest = campaign.best;
      const all = couponLib.computeBest(pool, ctx, 'all');
      theoryBest = all.best;
      excluded = all.excluded;
      multi = couponLib.computeMulti(pool, ctx, Math.min(9, Math.max(2, settings.multiMax || 5)), 'campaign');
    }

    // 最低価格 (新規ユーザー券を除く)
    const campaignJpy = campaignBest
      ? campaignBest.totalAfterJpy
      : product
        ? product.priceJpy
        : null;

    // 理論最低 (資格券・個人券も含む)。ページの表示がさらに安ければそちらを採る
    let theoryJpy = theoryBest ? theoryBest.totalAfterJpy : product ? product.priceJpy : null;
    if (officialJpy !== null && theoryJpy !== null) {
      theoryJpy = Math.min(theoryJpy, officialJpy);
    }

    let rec = null;
    let isNewLow = false;
    if (settings.record && product) {
      const saved = await historyLib
        .record({
          workno: target.workno,
          site: target.site,
          title: product.title,
          priceJpy: product.priceJpy,
          couponJpy: campaignJpy,
          coupon: campaignBest,
          theoryJpy,
          theoryCoupon: theoryBest,
        })
        .catch(() => null);
      if (saved && saved.record) {
        rec = saved.record;
        isNewLow = !!saved.couponLow;
      }
    } else {
      const all = await historyLib.getAll().catch(() => ({}));
      rec = all[target.workno] || null;
    }

    const money = moneyKit(currency, product, locale);
    const view = {
      locale,
      currency,
      product,
      campaignBest,
      theoryBest,
      officialJpy,
      officialCouponName: domCoupon.name || '',
      remote,
      rec,
      isNewLow,
      multi,
      money,
      compose: {
        listPriceJpy: product ? product.listPriceJpy : null,
        priceJpy: product ? product.priceJpy : 0,
        campaignBest,
        officialJpy,
        officialSource: domCoupon.present,
        excluded,
      },
    };

    render(panel, view);

    // 言語が切り替わったらパネルも追従させる
    const langWatcher = new MutationObserver(() => {
      const next = i18n.resolveLocale(settings);
      if (next !== locale) {
        langWatcher.disconnect();
        closeOverlay();
        main();
      }
    });
    langWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
