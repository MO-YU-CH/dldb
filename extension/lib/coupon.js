// クーポンの分類・適用判定・多部数計算。
//
// 価格の基準は常に日本円。クーポンの割引はストア側が円で定義しており、表示通貨が
// USD でも CNY でも同じ割引が効くため、円で計算してから表示通貨へ換算する。
//
// 券は 3 種類に分ける。ユーザーの口径に合わせ、最低価格の記録に使うのは
// campaign だけ:
//   newuser   … 新規ユーザー登録が条件の券。一度きりなので最低価格から除外
//   qualified … 購入履歴・チャネル・媒体などの資格が要る券。理論最低にのみ算入
//   campaign  … 上記以外。誰でも条件を満たせば使える券 (期間限定を含む)
//
// issue の実測分布 (538 枚): product_id 276 / baitai 234 / regist_present 15 /
// specific_route 8 / price_sum 5。regist_present だけが「登録すれば誰でも」
// で、それ以外は資格が要る。
(function () {
  'use strict';

  const PDP = (globalThis.PDP = globalThis.PDP || {});

  const COUPON_API = '/home/api/=/coupon.json?cdn_cache=1';

  /** URL から売り場 (maniax / home / girls / ...) と作品番号を取り出す */
  function parseTarget(href) {
    const m = String(href).match(
      /^https:\/\/www\.dlsite\.com\/([a-z]+)(?:touch)?\/work\/=\/product_id\/([A-Z]{2}\d+)/
    );
    if (!m) return null;
    return { store: 'dlsite', site: m[1], workno: m[2] };
  }

  /**
   * 作品 API などを取る。**必ずタイムアウトを付ける** — これが無いと 1 本の
   * 遅いリクエストで呼び出し側 (カートのパネルなど) が永久に待ちになる。
   */
  async function fetchJson(url, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const limit = Number(timeoutMs) || 8000;
    const timer = controller ? setTimeout(() => controller.abort(), limit) : null;
    try {
      const res = await fetch(url, {
        credentials: 'include',
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 作品の正確な情報 (円価格・種別・options・custom_genres・系列) を取る */
  async function fetchProduct(site, workno) {
    const data = await fetchJson(
      `https://www.dlsite.com/${site}/api/=/product.json?workno=${encodeURIComponent(workno)}`
    );
    const product = Array.isArray(data) ? data[0] : data;
    if (!product) return null;
    return {
      priceJpy: Number(product.price) || 0,
      listPriceJpy: Number(product.official_price) || Number(product.price) || 0,
      isDiscount: !!product.is_discount_work || !!product.discount_rate,
      discountRate: Number(product.discount_rate) || 0,
      workType: product.work_type || null,
      makerId: product.maker_id || null,
      makerName: product.maker_name || '',
      seriesId: product.series_id || product.title_id || null,
      seriesName: product.series_name || product.title_name || '',
      options: String(product.options || ''),
      customGenres: new Set((product.custom_genres || []).map((g) => g.genre_key).filter(Boolean)),
      currencyPrice: product.currency_price || null,
      title: product.work_name || '',
      // まとめ買い / セット割 (活動時のみ値が入る)
      bulkbuy: product.is_bulkbuy
        ? {
            key: product.bulkbuy_key,
            title: product.bulkbuy_title,
            perItems: Number(product.bulkbuy_per_items) || 0,
            price: Number(product.bulkbuy_price_tax || product.bulkbuy_price) || 0,
            discountRate: Number(product.bulkbuy_discount_rate) || 0,
          }
        : null,
      volumeSet: product.has_specified_volume_set
        ? {
            maxRate: Number(product.specified_volume_set_max_discount_rate) || 0,
            sets: product.specified_volume_sets || [],
          }
        : null,
    };
  }

  async function fetchCouponPool() {
    const data = await fetchJson(COUPON_API);
    return Array.isArray(data) ? data : [];
  }

  // ---- 分類 ---------------------------------------------------------------

  // 「新規ユーザー登録でプレゼント」系。券名で判定する (id の接頭辞は
  // marketing_register / ad_lp_ など複数あるが、名前は必ずこの語を含む)。
  // 「ユーザー登録特典」のように 新規 を省いた表記も同じ扱いにする
  const NEW_USER_PATTERN = /新規ユーザー|新規登録|ユーザー登録|新用户|新用戶|new\s*user|初回登録/i;

  function classify(coupon) {
    const name = coupon.coupon_name || '';
    const id = coupon.coupon_id || '';
    if (NEW_USER_PATTERN.test(name) || /^ad_lp_/i.test(id)) {
      return 'newuser';
    }
    const issue = coupon.issue;
    const keys = issue && typeof issue === 'object' ? Object.keys(issue) : [];
    if (keys.length === 0) return 'campaign';
    // 登録すれば誰でももらえる券だけが campaign
    if (keys.length === 1 && keys[0] === 'regist_present') return 'campaign';
    return 'qualified';
  }

  // ---- 適用判定 -----------------------------------------------------------

  function firstNumber(value) {
    if (Array.isArray(value)) return Number(value[0]);
    return Number(value);
  }

  /**
   * 券がこの作品・この買い方に使えるか。使えるなら null、駄目なら理由を返す。
   * ctx: { workno, site, priceJpy, qty, workType, makerId, options, customGenres }
   */
  function rejectReason(coupon, ctx) {
    const cond = coupon.condition || {};
    const issue = coupon.issue || {};
    const qty = Math.max(1, Number(ctx.qty) || 1);
    const totalJpy = ctx.priceJpy * qty;

    // 資格 (issue) は券の種類判定で扱う。ここでは「対象作品か」だけを見る
    if (Array.isArray(cond.product_id) && !cond.product_id.includes(ctx.workno)) {
      return 'product_id';
    }

    if (cond.product_all !== undefined && cond.product_all !== null) {
      if (Array.isArray(cond.product_all)) {
        if (!cond.product_all.includes(ctx.workno)) return 'product_all';
      } else if (cond.product_all === true) {
        // 全作品対象
      } else if (typeof cond.product_all === 'string') {
        if (cond.product_all !== ctx.workno) return 'product_all';
      } else {
        return 'product_all';
      }
    }

    if (Array.isArray(cond.maker_id) && cond.maker_id.length && !cond.maker_id.includes(ctx.makerId)) {
      return 'maker_id';
    }

    if (Array.isArray(cond.site_ids) && cond.site_ids.length && !cond.site_ids.includes(ctx.site)) {
      return 'site_ids';
    }

    if (Array.isArray(cond.custom_genre) && cond.custom_genre.length) {
      const hit = cond.custom_genre.some((key) => ctx.customGenres.has(key));
      if (!hit) return 'custom_genre';
    }

    if (cond.maximum_applicable_price !== undefined && cond.maximum_applicable_price !== null) {
      const limit = firstNumber(cond.maximum_applicable_price);
      if (Number.isFinite(limit) && ctx.priceJpy > limit) return 'maximum_applicable_price';
    }

    if (Array.isArray(cond.worktype) && cond.worktype.length && !cond.worktype.includes(ctx.workType)) {
      return 'worktype';
    }

    if (Array.isArray(cond.options) && cond.options.length) {
      const hit = cond.options.some((opt) => ctx.options.includes(opt));
      if (!hit) return 'options';
    }

    // 合計金額の下限 (配列で来る場合がある: [0] / [1001])
    if (cond.price_sum !== undefined && cond.price_sum !== null) {
      const min = firstNumber(cond.price_sum);
      if (Number.isFinite(min) && min > 0 && totalJpy < min) return 'price_sum';
    }

    // 本数の条件。「3作品以上購入で利用可」などは post_condition / prerequisite に入る
    const need = postCount(cond);
    if (need > 0 && qty < need) return 'need_count';

    if (cond.payment_route && cond.payment_route.length) return 'payment_route';
    if (cond.best_price_flg) return 'best_price_flg';
    if (cond.discount_limit) return 'discount_limit';

    return null;
  }

  /** 券が要求する購入本数 (post_condition / prerequisite の count) */
  function postCount(cond) {
    const pick = (obj) => {
      if (!obj) return 0;
      const n = Number(obj.count);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return Math.max(pick(cond.post_condition), pick(cond.prerequisite));
  }

  /**
   * 券を使ったときの支払額 (円)。
   *
   * **rate 券は商品ごとに割り引き、商品ごとに切り捨てて合計する。**
   * 実測: 小計 1,408 円 (220 + 704 + 484) に 15% 券を当てたときページ表示は 1,198 円。
   *   合計に対して floor(1408 × 0.85) = 1,196 では 2 円足りないが、
   *   Σ(price − floor(price × 15 / 100)) = 187 + 598 + 411 = 1,198 で一致する。
   * 定額券 (discount_type: "price") は会計ごとに 1 回だけ引く。
   */
  function applyToItems(coupon, items) {
    const raw = Number(coupon.discount);
    if (!Number.isFinite(raw)) return null;
    const list = Array.isArray(items) ? items : [{ priceJpy: Number(items) || 0 }];
    const total = list.reduce((a, it) => a + (Number(it.priceJpy) || 0), 0);
    if (coupon.discount_type === 'price') {
      return Math.max(0, total - raw);
    }
    let sum = 0;
    for (const it of list) {
      const price = Number(it.priceJpy) || 0;
      sum += price - Math.floor((price * raw) / 100);
    }
    return Math.max(0, sum);
  }

  /** 合計金額しか手元に無い場面用の薄いラッパー (1 商品とみなす) */
  function applyOrder(coupon, totalJpy) {
    return applyToItems(coupon, [{ priceJpy: Number(totalJpy) || 0 }]);
  }

  /**
   * 券プールから最良の 1 枚を選ぶ。
   * scope: 'campaign' (最低価格用) / 'all' (理論最低用)
   * excluded は「この作品に使える条件は満たしたが、資格や本数で落ちた券」だけを返す。
   * 別作品むけの券 (product_id / maker_id / custom_genre 不一致) は数百枚あるので
   * 内訳には出さない — 出しても読み手の判断材料にならないため。
   */
  const NOISE_REASONS = new Set([
    'product_id',
    'product_all',
    'custom_genre',
    'maker_id',
    'site_ids',
    'worktype',
    'options',
  ]);

  function computeBest(pool, ctx, scope) {
    const wanted = scope === 'all' ? null : 'campaign';
    const candidates = [];
    const excluded = [];

    for (const coupon of pool) {
      const kind = classify(coupon);
      const reason = rejectReason(coupon, ctx);
      if (reason) {
        if (!NOISE_REASONS.has(reason)) excluded.push({ coupon, kind, reason });
        continue;
      }
      if (wanted && kind !== wanted) {
        excluded.push({ coupon, kind, reason: kind });
        continue;
      }
      const qty = Math.max(1, Number(ctx.qty) || 1);
      const items = Array.from({ length: qty }, () => ({ priceJpy: ctx.priceJpy }));
      const afterJpy = applyToItems(coupon, items);
      if (afterJpy === null) continue;
      candidates.push({
        couponId: coupon.coupon_id,
        couponName: coupon.coupon_name || '',
        discountType: coupon.discount_type,
        discount: Number(coupon.discount),
        kind,
        endDate: coupon.end_date || null,
        needCount: postCount(coupon.condition || {}),
        totalAfterJpy: afterJpy,
        unitAfterJpy: Math.round(afterJpy / qty),
      });
    }

    candidates.sort((a, b) => a.totalAfterJpy - b.totalAfterJpy || b.discount - a.discount);
    return { best: candidates[0] || null, candidates, excluded };
  }

  /**
   * 1..maxQty 部買ったときの最良価格を並べる。券の本数条件を満たすものだけが
   * その部数で使える。まとめ買い / セット割 のデータがある場合はそちらが
   * 優先される (公式: 成立時は他の割引が適用されない) ので、比較して安い方を採る。
   */
  function computeMulti(pool, ctx, maxQty, scope) {
    const rows = [];
    const listPrice = ctx.listPriceJpy || ctx.priceJpy;
    const volumeSet = ctx.volumeSet;

    for (let qty = 1; qty <= maxQty; qty += 1) {
      const singleTotal = ctx.priceJpy * qty;
      const subCtx = Object.assign({}, ctx, { qty });
      const { best } = computeBest(pool, subCtx, scope);

      const options = [
        { type: 'plain', totalJpy: singleTotal, unitJpy: Math.round(singleTotal / qty), coupon: null },
      ];
      if (best) {
        options.push({
          type: 'coupon',
          totalJpy: best.totalAfterJpy,
          unitJpy: best.unitAfterJpy,
          coupon: best,
        });
      }

      // セット割: 定価に対して割引率が適用される (公式仕様)
      if (volumeSet && volumeSet.maxRate > 0 && qty >= 2) {
        const total = Math.floor((listPrice * qty * (100 - volumeSet.maxRate)) / 100);
        options.push({
          type: 'volumeSet',
          totalJpy: total,
          unitJpy: Math.round(total / qty),
          rate: volumeSet.maxRate,
        });
      }

      options.sort((a, b) => a.totalJpy - b.totalJpy);
      const winner = options[0];
      rows.push({
        qty,
        type: winner.type,
        totalJpy: winner.totalJpy,
        unitJpy: winner.unitJpy,
        coupon: winner.coupon || null,
        rate: winner.rate || null,
        plainTotalJpy: singleTotal,
        needCount: best ? best.needCount : 0,
      });
    }
    return rows;
  }

  // ---- DOM 読み取り -------------------------------------------------------

  // 長い接尾辞を先に置く。"RMB" は "RM" を含むため順序を誤ると通貨を誤認する
  const CURRENCY_BY_SUFFIX = [
    ['NT$', 'TWD'],
    ['HK$', 'HKD'],
    ['CA$', 'CAD'],
    ['A$', 'AUD'],
    ['S$', 'SGD'],
    ['MX$', 'MXN'],
    ['NZ$', 'NZD'],
    ['RMB', 'CNY'],
    ['R$', 'BRL'],
    ['Rp', 'IDR'],
    ['RM', 'MYR'],
    ['USD', 'USD'],
    ['GBP', 'GBP'],
    ['EUR', 'EUR'],
    ['THB', 'THB'],
    ['INR', 'INR'],
    ['PHP', 'PHP'],
    ['円', 'JPY'],
    ['€', 'EUR'],
    ['£', 'GBP'],
    ['₩', 'KRW'],
    ['฿', 'THB'],
    ['₫', 'VND'],
    ['₹', 'INR'],
    ['₱', 'PHP'],
    ['kr', 'SEK'],
  ];

  function detectCurrency(root) {
    const doc = root || document;
    const node =
      doc.querySelector('#work_price .work_price_suffix') ||
      doc.querySelector('.work_price_suffix');
    const text = node ? node.textContent.trim() : '';
    if (!text) return 'JPY';
    for (const [suffix, code] of CURRENCY_BY_SUFFIX) {
      if (text.indexOf(suffix) !== -1) return code;
    }
    return 'JPY';
  }

  /**
   * 表示金額の数値化。
   * 桁区切りと小数点は国によって入れ替わる (24.46 / 4,53 / 100.894) ため、
   * 「区切りの後ろがちょうど 3 桁」なら桁区切り、それ以外は小数点として読む。
   */
  function parseAmount(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).replace(/[^\d.,]/g, '');
    if (!s) return null;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    const sepIndex = Math.max(lastDot, lastComma);
    if (sepIndex === -1) return Number(s);
    const sep = s[sepIndex];
    const head = s.slice(0, sepIndex);
    const tail = s.slice(sepIndex + 1);
    const otherSep = sep === '.' ? lastComma : lastDot;
    const onlyOnce = s.indexOf(sep) === sepIndex && otherSep === -1;
    if (tail.length === 3 && onlyOnce) return Number(head + tail);
    return Number(`${head.replace(/[.,]/g, '')}.${tail}`);
  }

  /** ページが表示している「一番お得なクーポン利用価格」 */
  function readDomCoupon(root) {
    const doc = root || document;
    const block = doc.querySelector('.coupon_available');
    if (!block) return { present: false, value: null, currency: 'JPY', raw: '', name: '' };
    const base = block.querySelector('dd.total .work_price_base');
    const nameNode = block.querySelector('.coupon_name');
    const name = nameNode ? nameNode.textContent.trim() : '';
    if (!base) return { present: true, value: null, currency: detectCurrency(doc), raw: '', name };
    const raw = base.textContent.trim();
    const value = parseAmount(raw);
    return {
      present: true,
      value: Number.isFinite(value) ? value : null,
      currency: detectCurrency(doc),
      raw,
      name,
    };
  }

  /** ページが表示している現在価格 */
  function readDomPrice(root) {
    const doc = root || document;
    const base = doc.querySelector('#work_price .work_buy_content .work_price_base');
    if (!base) return null;
    const currency = detectCurrency(doc);
    const raw = base.textContent.trim();
    const value = parseAmount(raw);
    return Number.isFinite(value) ? { value, currency, raw } : null;
  }

  /** ページに表示される定価 (打ち消し線の価格) */
  function readDomListPrice(root) {
    const doc = root || document;
    const node = doc.querySelector('#work_price .strike .work_price_base, #work_price .strike');
    if (!node) return null;
    const value = parseAmount(node.textContent.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** 円 → 表示通貨。currency_price の比を使うので為替の揺れを持ち込まない */
  function toDisplay(jpy, currency, product) {
    if (!Number.isFinite(jpy)) return null;
    if (!currency || currency === 'JPY') return jpy;
    const map = product && product.currencyPrice;
    if (!map) return null;
    const rate = Number(map[currency]);
    const base = Number(map.JPY);
    if (!Number.isFinite(rate) || !Number.isFinite(base) || base <= 0) return null;
    return (jpy * rate) / base;
  }

  PDP.coupon = {
    parseTarget,
    fetchProduct,
    fetchCouponPool,
    classify,
    rejectReason,
    postCount,
    applyToItems,
    applyOrder,
    computeBest,
    computeMulti,
    detectCurrency,
    parseAmount,
    readDomCoupon,
    readDomPrice,
    readDomListPrice,
    toDisplay,
  };
})();
