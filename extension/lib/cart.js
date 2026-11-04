// カートページ用: 買い物カゴの読み取りと「どの分け方で買うのが一番安いか」の計算。
//
// 前提として確認した仕様:
//   - カートは 1 回の会計でしか精算できず、部分精算の UI はない。
//     したがって「分けて買う」は『稍后再买 (move_to_buylater) で一旦外す → 精算 → 戻す』で実現する。
//   - クーポンは 1 会計につき 1 枚 (内部名 selectedCoupon が単数)。
//   - 「N作品以上で利用可」の本数条件は condition.post_condition.count に入る。
//   - 定期券ではない券 (is_multiple_use=false) は 1 回しか使えないので、分けた各会計に
//     同じ券を重複して当てることはできない。
//
// 価格はすべて円。カート行の data-price が円建てなのでそのまま使える。
(function () {
  'use strict';

  const PDP = (globalThis.PDP = globalThis.PDP || {});

  /** カートの 1 行を data-* から読む。 DOM のテキストは使わない (通貨表記が揺れるため) */
  function parseRow(li) {
    const d = li.dataset || {};
    const workno = d.workno || d.productId;
    if (!workno) return null;
    let genres = [];
    try {
      genres = JSON.parse(d.customGenres || '[]');
    } catch (e) {
      genres = [];
    }
    // タイトルは最初の product_id リンクがサムネイル (テキスト無し) のことがあるので、
    // テキストを持つリンクが見つかるまで見る
    let title = '';
    for (const a of li.querySelectorAll('a[href*="product_id"]')) {
      const text = (a.textContent || '').trim();
      if (text) {
        title = text;
        break;
      }
    }
    return {
      workno,
      site: d.siteId || 'maniax',
      priceJpy: Number(d.price) || 0,
      listPriceJpy: Number(d.officialPrice) || Number(d.price) || 0,
      makerId: d.makerId || null,
      workType: d.workType || null,
      options: String(d.workOptions || ''),
      customGenres: new Set(genres),
      title,
      isBuyLater: !!li.closest('.cart_later_list, [class*="later"]'),
      node: li,
      removeHref: (li.querySelector('a.link_delete') || {}).href || null,
      laterHref: (li.querySelector('a.link_move_later') || {}).href || null,
    };
  }

  /**
   * カート行の data-* だけでは券の対象判定ができない。
   *
   * 実測: `data-custom-genres` は**常に空配列**、`data-work-options` も作品ページと
   * 一致しない (RJ01745012 はカートで "RegionHiddenFilter"、product.json では
   * "CHI_HANS#CHI#DLP")。この 2 つは custom_genre / options 条件の判定に使うため、
   * 作品 API で補う。**価格はカートの data-price を維持する** — 組合せ折扣が
   * 適用された実際の支払額なので、product.json の定価で上書きしてはいけない。
   */
  async function enrichItems(items) {
    await Promise.all(
      items.map(async (it) => {
        try {
          const p = await PDP.coupon.fetchProduct(it.site, it.workno);
          if (!p) return;
          if (p.customGenres && p.customGenres.size) it.customGenres = p.customGenres;
          if (p.options) it.options = p.options;
          if (p.workType) it.workType = p.workType;
          if (p.makerId) it.makerId = p.makerId;
          it.enriched = true;
        } catch (e) {
          // 取得できなければカートの値のまま判定する (券が当たらない側に倒れる)
        }
      })
    );
    return items;
  }

  /** カート内の商品 (稍后再买 に退避されたものを含む) を集める */
  function readCart(doc) {
    const d = doc || document;
    const rows = Array.from(d.querySelectorAll('li.cart_list_item, [data-workno]'));
    const items = [];
    const seen = new Set();
    for (const li of rows) {
      if (!li.dataset || (!li.dataset.workno && !li.dataset.productId)) continue;
      const item = parseRow(li);
      if (!item || seen.has(item.workno)) continue;
      seen.add(item.workno);
      items.push(item);
    }
    return items;
  }

  /** カート画面が表示している合計 (通貨つき) を読む。 表示通貨の判定に使う */
  function readCartTotal(doc) {
    const d = doc || document;
    const base = d.querySelector('#cart_right_total .work_price_base');
    const suffix = d.querySelector('#cart_right_total .work_price_suffix');
    const count = d.querySelector('#_total_count');
    const couponBase = d.querySelector('.coupon_available dd.total .work_price_base');
    return {
      totalText: base ? base.textContent.trim() : null,
      currency: suffix ? suffix.textContent.trim() : 'JPY',
      count: count ? Number(count.textContent.trim()) : null,
      couponText: couponBase ? couponBase.textContent.trim() : null,
    };
  }

  /**
   * 自分の持っているクーポン一覧。
   * 公開券プール (coupon.json) と違い、こちらは issues / conditions と複数形のキーで返るので
   * 単数形に寄せて coupon.js の判定関数をそのまま使えるようにする。
   */
  async function fetchMyCoupons(site) {
    const res = await fetch(`/${site || 'maniax'}/mypage/coupon/list/ajax`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.coupons || data.data || [];
    return list.map((c) => ({
      coupon_id: c.coupon_id,
      coupon_name: c.coupon_name || '',
      discount_type: c.discount_type,
      discount: c.discount,
      end_date: c.end_date,
      start_date: c.start_date,
      // 判定ロジックを共有するため単数形のキーに正規化する
      condition: c.conditions || c.condition || {},
      issue: c.issues || c.issue || {},
      is_multiple_use: !!c.is_multiple_use,
      is_limited_exceeded: !!c.is_limited_exceeded,
      condition_info: c.condition_info || '',
      is_affect_to_payment: !!c.is_affect_to_payment,
    })).filter((c) => c.coupon_id && !c.is_limited_exceeded);
  }

  /**
   * 1 つの会計 (商品のまとまり) に券を当てられるか。
   * 「対象作品だけをまとめて買う」前提を守るため、まとまりの全商品が券の対象であることを要求する。
   * 一部だけ対象の会計に券を使えるかは未検証なので、安く見積もりすぎない側に倒す。
   */
  function couponFitsSubset(coupon, subset, site) {
    const couponLib = PDP.coupon;
    if (!couponLib) return false;
    for (const item of subset) {
      const ctx = {
        workno: item.workno,
        site: item.site || site,
        priceJpy: item.priceJpy,
        listPriceJpy: item.listPriceJpy,
        qty: subset.length,
        workType: item.workType,
        makerId: item.makerId,
        options: item.options,
        customGenres: item.customGenres,
      };
      if (couponLib.rejectReason(coupon, ctx)) return false;
    }
    return true;
  }

  /** まとまり 1 つを、券なし/券ありで最安にする */
  function bestForSubset(subset, coupons, usedOnce) {
    const sumJpy = subset.reduce((a, it) => a + it.priceJpy, 0);
    let best = { totalJpy: sumJpy, coupon: null };
    for (const c of coupons) {
      // 1 回限りの券は他の会計で使っていたら候補から外す
      if (!c.is_multiple_use && usedOnce.has(c.coupon_id)) continue;
      if (!couponFitsSubset(c, subset, subset[0] && subset[0].site)) continue;
      const after = PDP.coupon.applyOrder(c, sumJpy);
      if (after === null) continue;
      if (after < best.totalJpy) {
        best = { totalJpy: after, coupon: c };
      }
    }
    return best;
  }

  /**
   * 最安の買い方を探す。
   *
   * 会計の分け方 (集合の分割) を全部試し、それぞれの会計に券を 1 枚ずつ当てる。
   * 商品が 9 件までなら分割の総数はベル数で 21,147 通りなので総当たりで足りる。
   * それ以上は貪欲法に落とす。
   *
   * 券の本数条件 (post_condition.count) は「対象作品が何作品あるか」で判定する。
   * 券面の但し書きも「割引対象作品を3作品以上ご購入の場合、全てに割引」なので、
   * まとまりの中の全商品が券の対象であることを条件にしている。
   */
  function optimize(items, coupons) {
    if (!items.length) return null;
    const n = items.length;
    const cache = new Map();

    const bestOfMask = (mask) => {
      if (cache.has(mask)) return cache.get(mask);
      const subset = [];
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) subset.push(items[i]);
      const plain = subset.reduce((a, it) => a + it.priceJpy, 0);
      let best = { totalJpy: plain, coupon: null };
      for (const c of coupons) {
        if (!couponFitsSubset(c, subset)) continue;
        const after = PDP.coupon.applyToItems(c, subset);
        if (after === null) continue;
        if (after < best.totalJpy) best = { totalJpy: after, coupon: c };
      }
      const entry = { mask, items: subset, totalJpy: best.totalJpy, coupon: best.coupon };
      cache.set(mask, entry);
      return entry;
    };

    const allInOne = bestOfMask((1 << n) - 1);

    // 商品が多すぎるときは総当たりを諦める
    if (n > 9) {
      const plans = greedyPlan(items, coupons);
      return { plans, allInOne, exhaustive: false };
    }

    let bestCost = Infinity;
    let bestMasks = null;
    const assign = new Array(n).fill(0);

    const walk = (i, maxGroup) => {
      if (i === n) {
        const masks = [];
        for (let g = 0; g <= maxGroup; g += 1) masks.push(0);
        for (let k = 0; k < n; k += 1) masks[assign[k]] |= 1 << k;
        let cost = 0;
        for (const m of masks) cost += bestOfMask(m).totalJpy;
        if (cost < bestCost - 0.5) {
          bestCost = cost;
          bestMasks = masks.slice();
        }
        return;
      }
      for (let g = 0; g <= maxGroup + 1; g += 1) {
        assign[i] = g;
        walk(i + 1, Math.max(maxGroup, g));
      }
    };
    walk(0, -1);

    let groups = (bestMasks || [(1 << n) - 1]).map((m) => bestOfMask(m));

    // 1 回限りの券が複数の会計で使われていたら、一番得な会計だけに残す
    groups = resolveOnceOnly(groups, items, coupons, bestOfMask);

    const plans = groups.map((g) => ({
      items: g.items.slice(),
      totalJpy: g.totalJpy,
      coupon: g.coupon,
      savedJpy: g.items.reduce((a, it) => a + it.priceJpy, 0) - g.totalJpy,
    }));
    plans.sort((a, b) => b.totalJpy - a.totalJpy);
    return { plans, allInOne, exhaustive: true };
  }

  /**
   * is_multiple_use=false の券は 1 回しか使えない。
   * 複数の会計に同じ券が割り当たっていたら、節約額が最大の会計にだけ残し、
   * 他は券なし (または別の券) で計算し直す。
   */
  function resolveOnceOnly(groups, items, coupons, bestOfMask) {
    const counts = new Map();
    for (const g of groups) {
      if (g.coupon && !g.coupon.is_multiple_use) {
        counts.set(g.coupon.coupon_id, (counts.get(g.coupon.coupon_id) || 0) + 1);
      }
    }
    const conflicted = Array.from(counts.entries()).filter(([, c]) => c > 1).map(([id]) => id);
    if (!conflicted.length) return groups;

    const result = groups.map((g) => Object.assign({}, g));
    for (const id of conflicted) {
      const users = result.filter((g) => g.coupon && g.coupon.coupon_id === id);
      users.sort((a, b) => b.totalJpy - a.totalJpy);
      // 一番高い会計に残す
      for (let i = 1; i < users.length; i += 1) {
        const g = users[i];
        const others = coupons.filter((c) => c.coupon_id !== id && c.is_multiple_use);
        let best = { totalJpy: g.items.reduce((a, it) => a + it.priceJpy, 0), coupon: null };
        for (const c of others) {
          if (!couponFitsSubset(c, g.items)) continue;
          const after = PDP.coupon.applyToItems(c, g.items);
          if (after !== null && after < best.totalJpy) best = { totalJpy: after, coupon: c };
        }
        g.totalJpy = best.totalJpy;
        g.coupon = best.coupon;
      }
    }
    return result;
  }

  /** 商品が多いときの簡易版: 券が当たるまとまりを優先して作る */
  function greedyPlan(items, coupons) {
    const remaining = items.slice();
    const plans = [];
    const usedOnce = new Set();
    while (remaining.length) {
      let best = null;
      for (let size = Math.min(remaining.length, 6); size >= 1; size -= 1) {
        const subset = remaining.slice(0, size);
        const r = bestForSubset(subset, coupons, usedOnce);
        const saving = subset.reduce((a, it) => a + it.priceJpy, 0) - r.totalJpy;
        if (!best || saving > best.saving) best = { subset, r, saving };
      }
      const group = {
        items: best.subset,
        totalJpy: best.r.totalJpy,
        coupon: best.r.coupon,
        savedJpy: best.saving,
      };
      if (group.coupon && !group.coupon.is_multiple_use) usedOnce.add(group.coupon.coupon_id);
      plans.push(group);
      for (const it of best.subset) remaining.splice(remaining.indexOf(it), 1);
    }
    return plans;
  }

  /** 表示通貨の接尾辞を ISO コードに寄せる (RMB → CNY など) */
  function mapCurrency(suffix) {
    const s = String(suffix || '').trim();
    const map = {
      JPY: 'JPY', 円: 'JPY',
      RMB: 'CNY', CNY: 'CNY',
      USD: 'USD', EUR: 'EUR', GBP: 'GBP',
      TWD: 'TWD', KRW: 'KRW', HKD: 'HKD',
      THB: 'THB', VND: 'VND', IDR: 'IDR',
      MYR: 'MYR', SGD: 'SGD', AUD: 'AUD',
      CAD: 'CAD', BRL: 'BRL', PHP: 'PHP',
      SEK: 'SEK', INR: 'INR', NZD: 'NZD', MXN: 'MXN',
    };
    return map[s] || 'JPY';
  }

  /** 1 外貨あたりの円 (exchangeConfig: {JPY:1, CNY:23.7161, ...}) */
  async function fetchExchange(site) {
    try {
      const res = await fetch(`/${site || 'maniax'}/api/=/exchangeConfig.json`, {
        credentials: 'include',
      });
      if (!res.ok) return null;
      const j = await res.json();
      return (j && j.data) || null;
    } catch (e) {
      return null;
    }
  }

  PDP.cart = {
    readCart,
    readCartTotal,
    fetchMyCoupons,
    fetchExchange,
    mapCurrency,
    enrichItems,
    couponFitsSubset,
    bestForSubset,
    optimize,
  };
})();
