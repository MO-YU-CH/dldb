// ==UserScript==
// @name         DLsite Coupon Plus
// @name:ja      DLsite Coupon Plus 券後価格
// @namespace    https://dlsite.momo-yu.com/
// @version      2.1.1
// @description  DLsite 作品页与购物车页显示券后价、价格走势与拆单对比
// @description:ja  DLsite の作品ページとカートで、クーポン適用後の価格・価格推移・分割購入の比較を表示します
// @author       momo-yu
// @homepageURL  https://dlsite.momo-yu.com/
// @supportURL   https://dlsite.momo-yu.com/ja-jp/about
// @license      MIT
// @match        https://www.dlsite.com/*/work/=/product_id/*
// @match        https://www.dlsite.com/*/cart
// @match        https://www.dlsite.com/*/cart/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      dlsite.momo-yu.com
// @run-at       document-idle
// @noframes
// ==/UserScript==
/*
 * DLsite Coupon Plus v2.1.1
 * 单文件构建产物，请勿直接编辑；改动请改 extension/ 或 userscript/src/ 后重新构建。
 * 数据源：https://dlsite.momo-yu.com （本脚本不在运行时请求第三方价格服务）
 * 许可：MIT。本项目非 DLsite 官方产品。
 */

// ---------------------------------------------------------------- Chrome API 兼容层
// userscript/src/shim.js
// Chrome 扩展 API 的油猴兼容层。
//
// 扩展侧真实调用点只有 9 处：
//   lib/history.js   storage.local.get([v2, v1]) / get(settingsKey) / set(...) ×4
//   content.js       runtime.sendMessage({type:'lookup'}) / runtime.lastError
//   background.js    runtime.onMessage（油猴下不需要，直连即可）
//
// 因此这里不做通用实现，只覆盖上述三种形态：
//   get(string) / get(string[]) / get(object 带默认值)
//   set(object)
//   sendMessage(message, callback) + lastError 语义
(function () {
  'use strict';

  const API_BASE = 'https://dlsite.momo-yu.com';
  // 扩展本身的 key 已带 pdp: 命名空间（pdp:records:v2 等），这里不再重复加前缀
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function readRaw(key) {
    if (hasGM) {
      const value = GM_getValue(key, undefined);
      return value === null ? undefined : value;
    }
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }

  function writeRaw(key, value) {
    if (hasGM) {
      GM_setValue(key, value);
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // 配额满时静默失败：调用方拿到的是「没存上」，与扩展行为一致
    }
  }

  function removeRaw(key) {
    if (typeof GM_deleteValue === 'function') {
      GM_deleteValue(key);
      return;
    }
    try {
      localStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
  }

  function normalizeKeys(keys) {
    if (typeof keys === 'string') return { list: [keys], defaults: null };
    if (Array.isArray(keys)) return { list: keys, defaults: null };
    if (keys && typeof keys === 'object') return { list: Object.keys(keys), defaults: keys };
    return { list: null, defaults: null };
  }

  const local = {
    get(keys) {
      return new Promise((resolve) => {
        const { list, defaults } = normalizeKeys(keys);
        const out = {};
        if (list === null) {
          // get() / get(null)：扩展未使用，返回空对象以免误判
          resolve(out);
          return;
        }
        for (const key of list) {
          const value = readRaw(key);
          if (value !== undefined) out[key] = value;
          else if (defaults && Object.prototype.hasOwnProperty.call(defaults, key)) {
            out[key] = defaults[key];
          }
        }
        resolve(out);
      });
    },

    set(items) {
      return new Promise((resolve) => {
        for (const [key, value] of Object.entries(items || {})) writeRaw(key, value);
        resolve();
      });
    },

    remove(keys) {
      const list = typeof keys === 'string' ? [keys] : keys || [];
      return new Promise((resolve) => {
        for (const key of list) removeRaw(key);
        resolve();
      });
    },

    clear() {
      return new Promise((resolve) => {
        for (const key of ['pdp:records:v2', 'pdp:records:v1', 'pdp:settings:v1']) removeRaw(key);
        resolve();
      });
    },
  };

  const runtime = {
    lastError: undefined,
    sendMessage,
  };

  /**
   * 与 background.js 等价：请求本站 lookup 接口，把结果按 {ok,status,data} 回传。
   * 网络层失败时置 lastError（content.js 会据此降级为「无数据」）。
   */
  function sendMessage(message, callback) {
    const cb = typeof callback === 'function' ? callback : function () {};

    const reply = (result, error) => {
      runtime.lastError = error || undefined;
      try {
        cb(result);
      } finally {
        runtime.lastError = undefined;
      }
    };

    if (!message || message.type !== 'lookup') {
      setTimeout(() => reply(undefined), 0);
      return;
    }
    if (!message.store || !message.id) {
      setTimeout(() => reply({ ok: true, status: 400, data: null }), 0);
      return;
    }

    const url =
      API_BASE +
      '/api/lookup/' +
      encodeURIComponent(message.store) +
      '/' +
      encodeURIComponent(message.id);

    const handle = (status, text) => {
      if (!status) {
        reply(null, { message: 'network' });
        return;
      }
      if (status < 200 || status >= 300) {
        reply({ ok: true, status, data: null });
        return;
      }
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {
        reply({ ok: true, status: 502, data: null });
        return;
      }
      reply({ ok: true, status, data });
    };

    if (typeof GM_xmlhttpRequest === 'function') {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: { Accept: 'application/json' },
          timeout: 8000,
          onload: (res) => handle(res.status, res.responseText),
          onerror: () => reply(null, { message: 'network' }),
          ontimeout: () => reply(null, { message: 'timeout' }),
        });
      } catch (e) {
        setTimeout(() => reply(null, { message: 'exception' }), 0);
      }
      return;
    }

    // 未授予 GM_xmlhttpRequest 时的退路：本站接口带 CORS 头，普通 fetch 也能用
    fetch(url, { headers: { Accept: 'application/json' } })
      .then((res) => res.text().then((text) => handle(res.status, text)))
      .catch(() => reply(null, { message: 'network' }));
  }

  const target =
    globalThis.chrome && typeof globalThis.chrome === 'object' ? globalThis.chrome : {};
  target.storage = target.storage || {};
  target.storage.local = local;
  target.runtime = runtime;
  globalThis.chrome = target;
})();

// ---------------------------------------------------------------- 14 语字典与语言判定
// extension/lib/i18n.js
// 多言語辞書と DLsite 表示言語の検出。
//
// 表示言語は「ユーザーが DLsite で選んでいる言語」に従う。DLsite 側の真実は
// <html lang> と URL の ?locale= で、cookie の locale は locale 切り替え時に
// 更新されない（実測: ?locale=zh_CN で開いても cookie は ja-jp のまま）ため
// 最下位の手がかりとしてのみ使う。
(function () {
  'use strict';

  const PDP = (globalThis.PDP = globalThis.PDP || {});

  // DLsite の言語切り替え UI が持つ 14 言語（value は dlsite の locale 表記）
  const LOCALES = [
    { code: 'ja-jp', intl: 'ja-JP', label: '日本語' },
    { code: 'en-us', intl: 'en-US', label: 'English' },
    { code: 'zh-cn', intl: 'zh-CN', label: '简体中文' },
    { code: 'zh-tw', intl: 'zh-TW', label: '繁體中文' },
    { code: 'ko-kr', intl: 'ko-KR', label: '한국어' },
    { code: 'es-es', intl: 'es-ES', label: 'Español' },
    { code: 'de-de', intl: 'de-DE', label: 'Deutsch' },
    { code: 'fr-fr', intl: 'fr-FR', label: 'Français' },
    { code: 'id-id', intl: 'id-ID', label: 'Bahasa Indonesia' },
    { code: 'it-it', intl: 'it-IT', label: 'Italiano' },
    { code: 'pt-br', intl: 'pt-BR', label: 'Português' },
    { code: 'sv-se', intl: 'sv-SE', label: 'Svenska' },
    { code: 'th-th', intl: 'th-TH', label: 'ภาษาไทย' },
    { code: 'vi-vn', intl: 'vi-VN', label: 'Tiếng Việt' },
  ];

  const JA = {
    loading: '価格履歴を確認中...',
    noData: 'この作品の価格情報はまだ収集できていません',
    current: '現在価格',
    couponAfter: 'クーポン適用後',
    couponNone: '利用できるクーポンはありません',
    couponUsed: '適用クーポン',
    lowestCoupon: '最低価格（活動クーポン込み）',
    theoryLowest: '理論最安（限定配布込み）',
    viewBreakdown: '内訳を見る',
    multiBuy: 'まとめ買いを試算',
    breakdownTitle: '価格の組み立て',
    multiTitle: 'まとめ買いの試算',
    listPrice: '定価',
    shopDiscount: 'ストア割引',
    excludedTitle: '使えなかったクーポン',
    kindNewUser: '新規ユーザー券',
    kindCampaign: '活動券',
    kindQualified: '資格が必要な券',
    kindBlocked: '条件不一致',
    needCountBadge: '{n}点以上で利用可',
    officialNote: 'ページ表示 {price}',
    officialHint: 'この価格を正とする',
    officialDiff: 'ページは口径外の券（新規ユーザー券など）で算出しています',
    qtyUnit: '点',
    unitPrice: '1点あたり',
    multiHint: '券の本数条件を満たす部数だけが反映されます。まとめ買い・セット割のデータがあれば安い方を表示します。',
    cartNowAll: 'このまますべて買う',
    cartBestSplit: '分割が得（{n}回）',
    cartSaving: '{amount} お得',
    cartSplitNoGain: '分割しても安くならない',
    cartKeepAsIs: 'このまままとめて買うのが最安',
    cartPlanView: '分割の内訳と手順を見る',
    cartPlanTitle: '最安の買い方',
    cartOrderN: '第{n}回の会計',
    cartUseCoupon: 'クーポン',
    cartNoCoupon: 'クーポンなし',
    cartHowTo: '手順',
    cartStepMove: '第{n}回: 「{items}」だけ残して他を稍后再买へ → 会計',
    cartStepNote: 'これを{n}回繰り返し、最後に稍后再买から全部カートへ戻します。',
    cartPageShows: 'ページ表示のクーポン適用後: {price}',
    cartEstimateNote: '概算です。確定金額は購入手続き画面で確認してください。',
    cartBatchHint: '＝カート左側の番号。同じ番号をまとめて会計します。',
    cartCampaignNote: 'セット割・まとめ買いは同じ会計でないと適用されません。分けると割引が外れます。',
    cartSplitCost: '分けた場合（{n}回）',
    cartSplitSame: '同額',
    cartNoCoupons: '所持クーポンを取得できませんでした',
    lowestPlain: '通常最安',
    lowestEver: '全期間最安',
    firstSeen: '収集開始日',
    samples: '記録 {n} 回',
    never: 'まだ記録がありません',
    cheapest: 'いま安いのは {store}（{price}）',
    samePrice: '現在は両売り場とも同価格',
    linkSite: '価格推移を詳しく見る →',
    error: '価格情報を取得できませんでした',
    recorded: '今回の価格を記録しました',
    recordOff: '記録は無効です',
    jpyBasis: '記録は日本円換算で保存します',
    history: 'この端末の記録',
    optTitle: '設定',
    optSubtitle: 'DLsite の作品ページで、クーポン適用後の最安値をこの端末に記録します。',
    optLangHint: '「合わせる」ではページの html lang と ?locale= から表示言語を判定します。',
    optLangMode: '表示言語',
    optLangAuto: 'DLsite の表示言語に合わせる',
    optLangForce: '言語を固定する',
    optRecord: '価格を記録する',
    optRecordHint: '作品ページを開くたびに、クーポン適用後の価格をこの端末に記録します。',
    optRecords: '記録した作品',
    optExport: 'JSON で書き出す',
    optClear: 'すべて削除',
    optEmpty: '記録はありません',
    optSaved: '保存しました',
    colWork: '作品',
    colPlain: '通常最安',
    colCoupon: '最低価格',
    colTheory: '理論最安',
    colSamples: '回数',
    colUpdated: '最終記録',
  };

  const EN = {
    loading: 'Checking price history...',
    noData: 'No price data has been collected for this work yet',
    current: 'Current price',
    couponAfter: 'After coupon',
    couponNone: 'No coupon available',
    couponUsed: 'Applied coupon',
    lowestCoupon: 'Lowest (campaign coupons)',
    theoryLowest: 'Theoretical low (qualified coupons)',
    viewBreakdown: 'How it is composed',
    multiBuy: 'Bulk estimate',
    breakdownTitle: 'How the price is built',
    multiTitle: 'Bulk purchase estimate',
    listPrice: 'List price',
    shopDiscount: 'Store discount',
    excludedTitle: 'Coupons not applied',
    kindNewUser: 'New-user coupons',
    kindCampaign: 'Campaign',
    kindQualified: 'Qualified coupons',
    kindBlocked: 'Conditions not met',
    needCountBadge: 'Needs {n}+ items',
    officialNote: 'Page shows {price}',
    officialHint: 'taken as authoritative',
    officialDiff: 'The page price is calculated with coupons outside this scope (new-user etc.)',
    qtyUnit: ' pcs',
    unitPrice: 'each',
    multiHint: 'Only coupons whose item-count condition is met apply. If bulk/set discount data exists, the cheaper one is shown.',
    cartNowAll: 'Buy all in one order',
    cartBestSplit: 'Splitting saves ({n} orders)',
    cartSaving: 'save {amount}',
    cartSplitNoGain: 'Splitting does not help',
    cartKeepAsIs: 'One order is already the cheapest',
    cartPlanView: 'See the split and the steps',
    cartPlanTitle: 'Cheapest way to buy',
    cartOrderN: 'Order {n}',
    cartUseCoupon: 'Coupon',
    cartNoCoupon: 'No coupon',
    cartHowTo: 'Steps',
    cartStepMove: 'Order {n}: keep only "{items}", move the rest to buy-later → checkout',
    cartStepNote: 'Repeat {n} times, then move everything back from buy-later.',
    cartPageShows: 'Page shows after coupon: {price}',
    cartEstimateNote: 'Estimate only. Confirm the final amount on the checkout screen.',
    cartBatchHint: '= the number on the left; check out the same numbers together.',
    cartCampaignNote: 'Set/bulk discounts only apply within one order — splitting removes the discount.',
    cartSplitCost: 'If split into {n} orders',
    cartSplitSame: 'same price',
    cartNoCoupons: 'Could not load your coupons',
    lowestPlain: 'Lowest without coupon',
    lowestEver: 'All-time low',
    firstSeen: 'Tracking since',
    samples: '{n} records',
    never: 'No records yet',
    cheapest: 'Cheapest now: {store} ({price})',
    samePrice: 'Both stores are at the same price',
    linkSite: 'View full price history →',
    error: 'Could not load price information',
    recorded: 'Price recorded',
    recordOff: 'Recording is off',
    jpyBasis: 'Records are stored converted to JPY',
    history: 'Records on this device',
    optTitle: 'Settings',
    optSubtitle: 'Records the lowest coupon-adjusted price on DLsite work pages, on this device.',
    optLangHint: 'Auto mode reads the page html lang attribute and the ?locale= parameter.',
    optLangMode: 'Display language',
    optLangAuto: 'Follow DLsite display language',
    optLangForce: 'Force a language',
    optRecord: 'Record prices',
    optRecordHint: 'Each time you open a work page, the coupon-adjusted price is recorded on this device.',
    optRecords: 'Recorded works',
    optExport: 'Export JSON',
    optClear: 'Clear all',
    optEmpty: 'No records',
    optSaved: 'Saved',
    colWork: 'Work',
    colPlain: 'Lowest',
    colCoupon: 'Lowest',
    colTheory: 'Theoretical',
    colSamples: 'Samples',
    colUpdated: 'Updated',
  };

  const ZH_CN = {
    loading: '正在获取价格历史…',
    noData: '尚未收录该作品的价格信息',
    current: '当前价格',
    couponAfter: '券后价格',
    couponNone: '当前无可用优惠券',
    couponUsed: '已用优惠券',
    lowestCoupon: '最低价（含活动券）',
    theoryLowest: '理论最低（含资格券）',
    viewBreakdown: '查看组合',
    multiBuy: '多部购买',
    breakdownTitle: '价格组合',
    multiTitle: '多部购买试算',
    listPrice: '定价',
    shopDiscount: '店铺折扣',
    excludedTitle: '未采用的券',
    kindNewUser: '新用户券',
    kindCampaign: '活动券',
    kindQualified: '需资格券',
    kindBlocked: '条件不符',
    needCountBadge: '需 {n} 部以上',
    officialNote: '页面显示 {price}',
    officialHint: '以此为准',
    officialDiff: '页面价格使用了本口径外的券（新用户券等）',
    qtyUnit: ' 部',
    unitPrice: '单部',
    multiHint: '只有满足券的部数条件时才计入；若有まとめ買い/套装折扣数据，显示更便宜的一种。',
    cartNowAll: '一起买（当前）',
    cartBestSplit: '拆单更省（{n} 单）',
    cartSaving: '省 {amount}',
    cartSplitNoGain: '拆单不会更便宜',
    cartKeepAsIs: '保持一起买最省',
    cartPlanView: '查看拆分方案与操作步骤',
    cartPlanTitle: '最省的买法',
    cartOrderN: '第 {n} 单',
    cartUseCoupon: '用券',
    cartNoCoupon: '不用券',
    cartHowTo: '操作顺序',
    cartStepMove: '第 {n} 单：只留「{items}」，其余移到「稍后再买」→ 结算',
    cartStepNote: '按此重复 {n} 次，最后把「稍后再买」里的全部移回购物车。',
    cartPageShows: '页面显示券后：{price}',
    cartEstimateNote: '这是估算，最终金额以确认购买页为准。',
    cartBatchHint: '＝商品左侧的编号，同号的合并结算。',
    cartCampaignNote: '组合折扣（套装/多件优惠）只在同一单内生效，拆开就会失去折扣。',
    cartSplitCost: '拆成 {n} 单的话',
    cartSplitSame: '同价',
    cartNoCoupons: '读取不到你的优惠券',
    lowestPlain: '无券历史最低',
    lowestEver: '全期间最低',
    firstSeen: '开始收录',
    samples: '已记录 {n} 次',
    never: '暂无记录',
    cheapest: '目前 {store} 更便宜（{price}）',
    samePrice: '当前两家同价',
    linkSite: '查看完整价格走势 →',
    error: '无法获取价格信息',
    recorded: '已记录本次价格',
    recordOff: '记录已关闭',
    jpyBasis: '记录以日元为基准换算保存',
    history: '本机记录',
    optTitle: '设置',
    optSubtitle: '在 DLsite 作品页记录含优惠券的最低价，数据仅保存在本机。',
    optLangHint: '“跟随”模式依据页面的 html lang 与 ?locale= 参数判定语言。',
    optLangMode: '显示语言',
    optLangAuto: '跟随 DLsite 显示语言',
    optLangForce: '固定为指定语言',
    optRecord: '记录价格',
    optRecordHint: '每次打开作品页，都会把券后价格记录在本机。',
    optRecords: '已记录的作品',
    optExport: '导出 JSON',
    optClear: '全部清空',
    optEmpty: '暂无记录',
    optSaved: '已保存',
    colWork: '作品',
    colPlain: '无券最低',
    colCoupon: '最低价',
    colTheory: '理论最低',
    colSamples: '次数',
    colUpdated: '最后记录',
  };

  const ZH_TW = {
    loading: '正在取得價格歷史…',
    noData: '尚未收錄此作品的價格資訊',
    current: '目前價格',
    couponAfter: '折價券後價格',
    couponNone: '目前沒有可用的折價券',
    couponUsed: '已使用折價券',
    lowestCoupon: '最低價（含活動券）',
    theoryLowest: '理論最低（含資格券）',
    viewBreakdown: '查看組合',
    multiBuy: '多部購買',
    breakdownTitle: '價格組合',
    multiTitle: '多部購買試算',
    listPrice: '定價',
    shopDiscount: '店鋪折扣',
    excludedTitle: '未採用的券',
    kindNewUser: '新用戶券',
    kindCampaign: '活動券',
    kindQualified: '需資格券',
    kindBlocked: '條件不符',
    needCountBadge: '需 {n} 部以上',
    officialNote: '頁面顯示 {price}',
    officialHint: '以此為準',
    officialDiff: '頁面價格使用了本口徑外的券（新用戶券等）',
    qtyUnit: ' 部',
    unitPrice: '單部',
    multiHint: '只有符合券的部數條件時才計入；若有まとめ買い/套裝折扣資料，顯示較便宜的一種。',
    cartNowAll: '一起買（目前）',
    cartBestSplit: '拆單更省（{n} 單）',
    cartSaving: '省 {amount}',
    cartSplitNoGain: '拆單不會更便宜',
    cartKeepAsIs: '保持一起買最省',
    cartPlanView: '查看拆分方案與操作步驟',
    cartPlanTitle: '最省的買法',
    cartOrderN: '第 {n} 單',
    cartUseCoupon: '用券',
    cartNoCoupon: '不用券',
    cartHowTo: '操作順序',
    cartStepMove: '第 {n} 單：只留「{items}」，其餘移到「稍後再買」→ 結帳',
    cartStepNote: '依此重複 {n} 次，最後把「稍後再買」裡的全部移回購物車。',
    cartPageShows: '頁面顯示折價券後：{price}',
    cartEstimateNote: '這是估算，最終金額以確認購買頁為準。',
    cartBatchHint: '＝商品左側的編號，同號的合併結帳。',
    cartCampaignNote: '組合折扣只在同一單內生效，拆開就會失去折扣。',
    cartSplitCost: '拆成 {n} 單的話',
    cartSplitSame: '同價',
    cartNoCoupons: '讀取不到你的折價券',
    lowestPlain: '無券歷史最低',
    lowestEver: '全期間最低',
    firstSeen: '開始收錄',
    samples: '已記錄 {n} 次',
    never: '尚無記錄',
    cheapest: '目前 {store} 較便宜（{price}）',
    samePrice: '目前兩家同價',
    linkSite: '查看完整價格走勢 →',
    error: '無法取得價格資訊',
    recorded: '已記錄本次價格',
    recordOff: '記錄已關閉',
    jpyBasis: '記錄以日圓為基準換算保存',
    history: '本機記錄',
    optTitle: '設定',
    optSubtitle: '在 DLsite 作品頁記錄含折價券的最低價，資料僅保存在本機。',
    optLangHint: '「跟隨」模式依頁面的 html lang 與 ?locale= 參數判定語言。',
    optLangMode: '顯示語言',
    optLangAuto: '跟隨 DLsite 顯示語言',
    optLangForce: '固定為指定語言',
    optRecord: '記錄價格',
    optRecordHint: '每次開啟作品頁，都會把折價券後價格記錄在本機。',
    optRecords: '已記錄的作品',
    optExport: '匯出 JSON',
    optClear: '全部清除',
    optEmpty: '尚無記錄',
    optSaved: '已儲存',
    colWork: '作品',
    colPlain: '無券最低',
    colCoupon: '最低價',
    colTheory: '理論最低',
    colSamples: '次數',
    colUpdated: '最後記錄',
  };

  const KO_KR = {
    loading: '가격 기록을 확인하는 중...',
    noData: '아직 이 작품의 가격 정보가 수집되지 않았습니다',
    current: '현재 가격',
    couponAfter: '쿠폰 적용 후',
    couponNone: '사용 가능한 쿠폰이 없습니다',
    couponUsed: '적용 쿠폰',
    lowestCoupon: '최저가 (이벤트 쿠폰 포함)',
    theoryLowest: '이론 최저가 (자격 쿠폰 포함)',
    viewBreakdown: '구성 보기',
    multiBuy: '여러 개 구매',
    breakdownTitle: '가격 구성',
    multiTitle: '여러 개 구매 계산',
    listPrice: '정가',
    shopDiscount: '상점 할인',
    excludedTitle: '적용되지 않은 쿠폰',
    kindNewUser: '신규 유저 쿠폰',
    kindCampaign: '이벤트 쿠폰',
    kindQualified: '자격 필요 쿠폰',
    kindBlocked: '조건 불일치',
    needCountBadge: '{n}개 이상 필요',
    officialNote: '페이지 표시 {price}',
    officialHint: '이 가격을 기준으로 함',
    officialDiff: '페이지 가격은 이 기준 밖의 쿠폰(신규 유저 쿠폰 등)을 사용합니다',
    qtyUnit: '개',
    unitPrice: '개당',
    multiHint: '쿠폰의 개수 조건을 충족하는 수량만 반영됩니다. 묶음 구매/세트 할인 데이터가 있으면 더 저렴한 쪽을 표시합니다.',
    cartNowAll: '한 번에 모두 구매',
    cartBestSplit: '분할이 이득 ({n}회)',
    cartSaving: '{amount} 절약',
    cartSplitNoGain: '분할해도 저렴해지지 않음',
    cartKeepAsIs: '한 번에 사는 것이 최저가',
    cartPlanView: '분할 내역과 절차 보기',
    cartPlanTitle: '가장 저렴한 구매법',
    cartOrderN: '{n}번째 결제',
    cartUseCoupon: '쿠폰',
    cartNoCoupon: '쿠폰 없음',
    cartHowTo: '절차',
    cartStepMove: '{n}번째: "{items}"만 남기고 나머지를 나중에 구매로 이동 → 결제',
    cartStepNote: '{n}회 반복한 뒤, 나중에 구매에 있는 것을 모두 장바구니로 되돌립니다.',
    cartPageShows: '페이지 표시 쿠폰 적용 후: {price}',
    cartEstimateNote: '추정치입니다. 최종 금액은 구매 확인 화면에서 확인하세요.',
    cartBatchHint: '= 상품 왼쪽 번호. 같은 번호끼리 함께 결제합니다.',
    cartCampaignNote: '세트/묶음 할인은 같은 주문에서만 적용됩니다. 나누면 할인이 사라집니다.',
    cartSplitCost: '{n}회로 나눌 경우',
    cartSplitSame: '동일',
    cartNoCoupons: '보유 쿠폰을 가져오지 못했습니다',
    lowestPlain: '일반 최저가',
    lowestEver: '전체 기간 최저가',
    firstSeen: '수집 시작일',
    samples: '{n}회 기록됨',
    never: '아직 기록이 없습니다',
    cheapest: '현재 {store}이(가) 더 저렴합니다 ({price})',
    samePrice: '현재 두 상점 가격이 같습니다',
    linkSite: '전체 가격 추이 보기 →',
    error: '가격 정보를 가져올 수 없습니다',
    recorded: '이번 가격을 기록했습니다',
    recordOff: '기록이 꺼져 있습니다',
    jpyBasis: '기록은 엔화 기준으로 환산해 저장합니다',
    history: '이 기기의 기록',
    optTitle: '설정',
    optSubtitle: 'DLsite 작품 페이지에서 쿠폰 적용 후 최저가를 이 기기에 기록합니다.',
    optLangHint: '자동 모드는 페이지의 html lang 속성과 ?locale= 값을 사용합니다.',
    optLangMode: '표시 언어',
    optLangAuto: 'DLsite 표시 언어 따르기',
    optLangForce: '언어 고정',
    optRecord: '가격 기록',
    optRecordHint: '작품 페이지를 열 때마다 쿠폰 적용 후 가격을 이 기기에 기록합니다.',
    optRecords: '기록된 작품',
    optExport: 'JSON 내보내기',
    optClear: '모두 삭제',
    optEmpty: '기록 없음',
    optSaved: '저장했습니다',
    colWork: '작품',
    colPlain: '일반 최저',
    colCoupon: '쿠폰 포함 최저',
    colTheory: '이론 최저가',
    colSamples: '횟수',
    colUpdated: '최종 기록',
  };

  const ES_ES = {
    loading: 'Consultando el historial de precios...',
    noData: 'Aún no hay datos de precio para esta obra',
    current: 'Precio actual',
    couponAfter: 'Precio con cupón',
    couponNone: 'No hay cupones disponibles',
    couponUsed: 'Cupón aplicado',
    lowestCoupon: 'Mínimo (cupones de campaña)',
    theoryLowest: 'Mínimo teórico (cupones restringidos)',
    viewBreakdown: 'Ver desglose',
    multiBuy: 'Compra múltiple',
    lowestPlain: 'Mínimo sin cupón',
    lowestEver: 'Mínimo histórico',
    firstSeen: 'Seguimiento desde',
    samples: '{n} registros',
    never: 'Aún sin registros',
    cheapest: 'Ahora más barato: {store} ({price})',
    samePrice: 'Ambas tiendas al mismo precio',
    linkSite: 'Ver historial completo →',
    error: 'No se pudo obtener la información de precios',
    recorded: 'Precio registrado',
    recordOff: 'El registro está desactivado',
    jpyBasis: 'Los registros se guardan convertidos a yenes',
    history: 'Registros en este dispositivo',
  };

  const DE_DE = {
    loading: 'Preisverlauf wird geladen...',
    noData: 'Für dieses Werk liegen noch keine Preisdaten vor',
    current: 'Aktueller Preis',
    couponAfter: 'Preis mit Gutschein',
    couponNone: 'Kein Gutschein verfügbar',
    couponUsed: 'Angewendeter Gutschein',
    lowestCoupon: 'Tiefstpreis (Aktionsgutscheine)',
    theoryLowest: 'Theoretischer Tiefstpreis (Qualifikationsgutscheine)',
    viewBreakdown: 'Aufschlüsselung',
    multiBuy: 'Mehrfachkauf',
    lowestPlain: 'Tiefstpreis ohne Gutschein',
    lowestEver: 'Allzeit-Tiefstpreis',
    firstSeen: 'Erfasst seit',
    samples: '{n} Einträge',
    never: 'Noch keine Einträge',
    cheapest: 'Günstiger jetzt: {store} ({price})',
    samePrice: 'Beide Shops zum gleichen Preis',
    linkSite: 'Vollen Preisverlauf ansehen →',
    error: 'Preisinformationen konnten nicht geladen werden',
    recorded: 'Preis gespeichert',
    recordOff: 'Erfassung ist aus',
    jpyBasis: 'Einträge werden in Yen umgerechnet gespeichert',
    history: 'Einträge auf diesem Gerät',
  };

  const FR_FR = {
    loading: "Vérification de l'historique des prix...",
    noData: 'Aucune donnée de prix pour cette œuvre',
    current: 'Prix actuel',
    couponAfter: 'Prix avec coupon',
    couponNone: 'Aucun coupon disponible',
    couponUsed: 'Coupon appliqué',
    lowestCoupon: 'Minimum (coupons promotionnels)',
    theoryLowest: 'Minimum théorique (coupons restreints)',
    viewBreakdown: 'Voir le détail',
    multiBuy: 'Achat multiple',
    lowestPlain: 'Minimum sans coupon',
    lowestEver: 'Minimum historique',
    firstSeen: 'Suivi depuis',
    samples: '{n} relevés',
    never: 'Aucun relevé',
    cheapest: 'Moins cher maintenant : {store} ({price})',
    samePrice: 'Les deux boutiques au même prix',
    linkSite: "Voir l'historique complet →",
    error: 'Impossible de récupérer les prix',
    recorded: 'Prix enregistré',
    recordOff: "L'enregistrement est désactivé",
    jpyBasis: 'Les relevés sont conservés convertis en yens',
    history: 'Relevés sur cet appareil',
  };

  const ID_ID = {
    loading: 'Memeriksa riwayat harga...',
    noData: 'Data harga karya ini belum terkumpul',
    current: 'Harga saat ini',
    couponAfter: 'Harga setelah kupon',
    couponNone: 'Tidak ada kupon tersedia',
    couponUsed: 'Kupon yang dipakai',
    lowestCoupon: 'Terendah (kupon kampanye)',
    theoryLowest: 'Terendah teoretis (kupon bersyarat)',
    viewBreakdown: 'Lihat rincian',
    multiBuy: 'Beli banyak',
    lowestPlain: 'Harga terendah tanpa kupon',
    lowestEver: 'Harga terendah sepanjang waktu',
    firstSeen: 'Dilacak sejak',
    samples: '{n} catatan',
    never: 'Belum ada catatan',
    cheapest: 'Lebih murah sekarang: {store} ({price})',
    samePrice: 'Kedua toko berharga sama',
    linkSite: 'Lihat riwayat harga lengkap →',
    error: 'Gagal memuat informasi harga',
    recorded: 'Harga telah dicatat',
    recordOff: 'Pencatatan nonaktif',
    jpyBasis: 'Catatan disimpan setelah dikonversi ke yen',
    history: 'Catatan di perangkat ini',
  };

  const IT_IT = {
    loading: 'Verifica dello storico prezzi...',
    noData: "Nessun dato di prezzo per quest'opera",
    current: 'Prezzo attuale',
    couponAfter: 'Prezzo con coupon',
    couponNone: 'Nessun coupon disponibile',
    couponUsed: 'Coupon applicato',
    lowestCoupon: 'Minimo (coupon campagna)',
    theoryLowest: 'Minimo teorico (coupon con requisiti)',
    viewBreakdown: 'Vedi dettaglio',
    multiBuy: 'Acquisto multiplo',
    lowestPlain: 'Minimo senza coupon',
    lowestEver: 'Minimo storico',
    firstSeen: 'Monitorato dal',
    samples: '{n} rilevazioni',
    never: 'Ancora nessuna rilevazione',
    cheapest: 'Ora più conveniente: {store} ({price})',
    samePrice: 'Entrambi gli store allo stesso prezzo',
    linkSite: 'Vedi lo storico completo →',
    error: 'Impossibile recuperare i prezzi',
    recorded: 'Prezzo registrato',
    recordOff: 'La registrazione è disattivata',
    jpyBasis: 'Le rilevazioni sono salvate convertite in yen',
    history: 'Rilevazioni su questo dispositivo',
  };

  const PT_BR = {
    loading: 'Verificando o histórico de preços...',
    noData: 'Ainda não há dados de preço para esta obra',
    current: 'Preço atual',
    couponAfter: 'Preço com cupom',
    couponNone: 'Nenhum cupom disponível',
    couponUsed: 'Cupom aplicado',
    lowestCoupon: 'Mínimo (cupons de campanha)',
    theoryLowest: 'Mínimo teórico (cupons restritos)',
    viewBreakdown: 'Ver detalhes',
    multiBuy: 'Compra múltipla',
    lowestPlain: 'Menor preço sem cupom',
    lowestEver: 'Menor preço histórico',
    firstSeen: 'Monitorado desde',
    samples: '{n} registros',
    never: 'Ainda sem registros',
    cheapest: 'Mais barato agora: {store} ({price})',
    samePrice: 'Ambas as lojas com o mesmo preço',
    linkSite: 'Ver histórico completo →',
    error: 'Não foi possível obter os preços',
    recorded: 'Preço registrado',
    recordOff: 'O registro está desativado',
    jpyBasis: 'Os registros são salvos convertidos em ienes',
    history: 'Registros neste dispositivo',
  };

  const SV_SE = {
    loading: 'Kontrollerar prishistorik...',
    noData: 'Inga prisuppgifter för detta verk ännu',
    current: 'Aktuellt pris',
    couponAfter: 'Pris med kupong',
    couponNone: 'Ingen kupong tillgänglig',
    couponUsed: 'Använd kupong',
    lowestCoupon: 'Lägsta (kampanjkuponger)',
    theoryLowest: 'Teoretiskt lägsta (kvalificerade kuponger)',
    viewBreakdown: 'Visa uppdelning',
    multiBuy: 'Flerköp',
    lowestPlain: 'Lägsta pris utan kupong',
    lowestEver: 'Lägsta pris någonsin',
    firstSeen: 'Spårat sedan',
    samples: '{n} poster',
    never: 'Inga poster ännu',
    cheapest: 'Billigast nu: {store} ({price})',
    samePrice: 'Båda butikerna till samma pris',
    linkSite: 'Se hela prishistoriken →',
    error: 'Kunde inte hämta prisuppgifter',
    recorded: 'Pris sparat',
    recordOff: 'Inspelning är avstängd',
    jpyBasis: 'Poster sparas omräknade till yen',
    history: 'Poster på den här enheten',
  };

  const TH_TH = {
    loading: 'กำลังตรวจสอบประวัติราคา...',
    noData: 'ยังไม่มีข้อมูลราคาของผลงานนี้',
    current: 'ราคาปัจจุบัน',
    couponAfter: 'ราคาหลังใช้คูปอง',
    couponNone: 'ไม่มีคูปองที่ใช้ได้',
    couponUsed: 'คูปองที่ใช้',
    lowestCoupon: 'ต่ำสุด (คูปองแคมเปญ)',
    theoryLowest: 'ต่ำสุดตามทฤษฎี (คูปองมีเงื่อนไข)',
    viewBreakdown: 'ดูรายละเอียด',
    multiBuy: 'ซื้อหลายชิ้น',
    lowestPlain: 'ราคาต่ำสุดเมื่อไม่ใช้คูปอง',
    lowestEver: 'ราคาต่ำสุดตลอดกาล',
    firstSeen: 'เริ่มเก็บข้อมูล',
    samples: 'บันทึกแล้ว {n} ครั้ง',
    never: 'ยังไม่มีบันทึก',
    cheapest: 'ตอนนี้ {store} ถูกกว่า ({price})',
    samePrice: 'ตอนนี้ทั้งสองร้านราคาเท่ากัน',
    linkSite: 'ดูประวัติราคาทั้งหมด →',
    error: 'ไม่สามารถดึงข้อมูลราคาได้',
    recorded: 'บันทึกราคาแล้ว',
    recordOff: 'ปิดการบันทึกอยู่',
    jpyBasis: 'บันทึกโดยแปลงเป็นเงินเยน',
    history: 'บันทึกในเครื่องนี้',
  };

  const VI_VN = {
    loading: 'Đang kiểm tra lịch sử giá...',
    noData: 'Chưa có dữ liệu giá cho tác phẩm này',
    current: 'Giá hiện tại',
    couponAfter: 'Giá sau khi dùng phiếu',
    couponNone: 'Không có phiếu giảm giá khả dụng',
    couponUsed: 'Phiếu đã áp dụng',
    lowestCoupon: 'Thấp nhất (phiếu chiến dịch)',
    theoryLowest: 'Thấp nhất lý thuyết (phiếu có điều kiện)',
    viewBreakdown: 'Xem chi tiết',
    multiBuy: 'Mua nhiều',
    lowestPlain: 'Giá thấp nhất không phiếu',
    lowestEver: 'Giá thấp nhất mọi thời đại',
    firstSeen: 'Theo dõi từ',
    samples: '{n} bản ghi',
    never: 'Chưa có bản ghi',
    cheapest: 'Hiện {store} rẻ hơn ({price})',
    samePrice: 'Hiện cả hai cửa hàng cùng giá',
    linkSite: 'Xem toàn bộ lịch sử giá →',
    error: 'Không lấy được thông tin giá',
    recorded: 'Đã ghi lại giá lần này',
    recordOff: 'Tính năng ghi đang tắt',
    jpyBasis: 'Bản ghi được quy đổi sang yên',
    history: 'Bản ghi trên thiết bị này',
  };

  const DICT = {
    'ja-jp': JA,
    'en-us': EN,
    'zh-cn': ZH_CN,
    'zh-tw': ZH_TW,
    'ko-kr': KO_KR,
    'es-es': ES_ES,
    'de-de': DE_DE,
    'fr-fr': FR_FR,
    'id-id': ID_ID,
    'it-it': IT_IT,
    'pt-br': PT_BR,
    'sv-se': SV_SE,
    'th-th': TH_TH,
    'vi-vn': VI_VN,
  };

  /** 表記ゆれ (zh_CN / zh-CN / ZH_cn) を dlsite 形式の小文字ハイフンに寄せる */
  function normalizeLocale(value) {
    if (!value) return null;
    const raw = String(value).trim().toLowerCase().replace(/_/g, '-');
    if (DICT[raw]) return raw;
    // 地域だけ違う場合 (zh-hk → zh-cn 等) は言語部分で寄せる
    const lang = raw.split('-')[0];
    const alias = {
      ja: 'ja-jp',
      en: 'en-us',
      zh: 'zh-cn',
      ko: 'ko-kr',
      es: 'es-es',
      de: 'de-de',
      fr: 'fr-fr',
      id: 'id-id',
      it: 'it-it',
      pt: 'pt-br',
      sv: 'sv-se',
      th: 'th-th',
      vi: 'vi-vn',
    };
    if (lang === 'zh') {
      if (raw.includes('tw') || raw.includes('hk') || raw.includes('hant')) return 'zh-tw';
      return 'zh-cn';
    }
    return alias[lang] || null;
  }

  /**
   * いま表示されている DLsite の言語を推定する。
   *
   * 優先順:
   *   1. URL の ?locale= (ユーザーが明示的に選んだ結果が URL に残る)
   *   2. <html lang> (サーバー / クライアントが実際に描画した言語。実測で追従する)
   *   3. cookie locale (切り替え時に更新されないため弱い手がかり)
   *   4. navigator.language
   */
  function detectLocale(doc, loc) {
    const d = doc || document;
    const l = loc || location;

    try {
      const param = new URL(l.href).searchParams.get('locale');
      const hit = normalizeLocale(param);
      if (hit) return hit;
    } catch (e) {
      // URL が壊れていても以降の手がかりで判定できる
    }

    const hit = normalizeLocale(d.documentElement.lang);
    if (hit) return hit;

    const cookie = String(d.cookie || '').match(/(?:^|;\s*)locale=([^;]+)/);
    if (cookie) {
      const c = normalizeLocale(decodeURIComponent(cookie[1]));
      if (c) return c;
    }

    return normalizeLocale(navigator.language) || 'ja-jp';
  }

  /** 設定 (言語固定) を踏まえた最終的な表示言語 */
  function resolveLocale(settings) {
    const mode = settings && settings.langMode;
    if (mode === 'fixed') {
      const fixed = normalizeLocale(settings.langOverride);
      if (fixed) return fixed;
    }
    return detectLocale();
  }

  function intlOf(code) {
    const meta = LOCALES.find((x) => x.code === code);
    return meta ? meta.intl : 'ja-JP';
  }

  /** 辞書引き。無い言語 / 無いキーは英語 → 日本語の順で落とす */
  function t(code, key, vars) {
    const dict = DICT[code] || DICT['ja-jp'];
    // 未訳のキーは英語を優先する (日本語に落ちると読み手を選ぶため)
    let text = dict[key];
    if (text === undefined) text = EN[key];
    if (text === undefined && code !== 'ja-jp') text = JA[key];
    if (text === undefined) return key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
    );
  }

  /**
   * 金額の整形。円は DLsite の日本語表示に合わせて「880円」、
   * それ以外は Intl の通貨書式に任せる。
   */
  function formatMoney(value, currency, code) {
    const cur = currency || 'JPY';
    const intl = intlOf(code);
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    const isInteger = Math.abs(n - Math.round(n)) < 0.005;
    if (cur === 'JPY' && code === 'ja-jp') {
      return `${Math.round(n).toLocaleString(intl)}円`;
    }
    try {
      return new Intl.NumberFormat(intl, {
        style: 'currency',
        currency: cur,
        maximumFractionDigits: cur === 'JPY' || isInteger ? 0 : 2,
      }).format(n);
    } catch (e) {
      return `${n.toLocaleString(intl)} ${cur}`;
    }
  }

  /** 日付 (YYYY-MM-DD or ISO) の表示 */
  function formatDate(value, code) {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat(intlOf(code), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  PDP.i18n = {
    LOCALES,
    normalizeLocale,
    detectLocale,
    resolveLocale,
    t,
    formatMoney,
    formatDate,
    intlOf,
  };
})();

// ---------------------------------------------------------------- 券分类与整单计算
// extension/lib/coupon.js
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

// ---------------------------------------------------------------- 本机价格记录
// extension/lib/history.js
// 価格サンプルの永続記録。
//
// 「クーポン込み最安」を出すには、ページを開いた時点の券後価格を貯めていくしかない
// (サーバー側の履歴はクーポンを考慮しない)。保存先は chrome.storage.local なので
// 端末内に閉じる。金額はすべて円で持つ — 表示通貨が変わっても比較が壊れない。
//
// 記録する最低価格は 2 本立て:
//   coupon … 新規ユーザー券を除いた「いま誰でも条件を満たせば使える券」での最安 (= 最低価格)
//   theory … 購入履歴やチャネル限定の券も含めた最安 (= 理論最低)
// 新規ユーザー券は一度きりのうえ新規登録が前提なので、最低価格には入れない。
(function () {
  'use strict';

  const PDP = (globalThis.PDP = globalThis.PDP || {});

  const KEY = 'pdp:records:v2';
  const LEGACY_KEY = 'pdp:records:v1';
  const SETTINGS_KEY = 'pdp:settings:v1';
  const MAX_HISTORY = 240;

  const DEFAULT_SETTINGS = {
    langMode: 'auto', // auto = DLsite の表示言語に従う / fixed = 固定
    langOverride: '',
    record: true,
    multiMax: 5, // 多部数のシミュレーション上限
  };

  async function getAll() {
    const obj = await chrome.storage.local.get([KEY, LEGACY_KEY]);
    const current = obj[KEY];
    if (current) return current;
    // v1 からの移行: coupon 欄をそのまま最低価格として引き継ぐ
    const legacy = obj[LEGACY_KEY];
    if (legacy && typeof legacy === 'object') {
      const migrated = {};
      for (const [workno, rec] of Object.entries(legacy)) {
        migrated[workno] = Object.assign({}, rec, { theory: rec.theory || null });
      }
      await chrome.storage.local.set({ [KEY]: migrated });
      return migrated;
    }
    return {};
  }

  async function writeAll(records) {
    await chrome.storage.local.set({ [KEY]: records });
  }

  async function getSettings() {
    const obj = await chrome.storage.local.get(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, obj[SETTINGS_KEY] || {});
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const next = Object.assign({}, current, patch);
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  function dayKey(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  /** 1 本の「最安」レーンを更新する。返り値は最安を更新したか */
  function updateLane(lane, jpy, at, coupon) {
    const target = lane || { minJpy: null, minAt: null, lastJpy: null, lastAt: null };
    let isLow = false;
    if (Number.isFinite(jpy)) {
      if (target.minJpy === null || target.minJpy === undefined || jpy < target.minJpy) {
        isLow = target.minJpy !== null && target.minJpy !== undefined;
        target.minJpy = jpy;
        target.minAt = at;
        if (coupon) {
          target.couponId = coupon.couponId || null;
          target.couponName = coupon.couponName || '';
          target.discount = coupon.discount;
          target.discountType = coupon.discountType;
          target.kind = coupon.kind || null;
          target.endDate = coupon.endDate || null;
        }
      }
      target.lastJpy = jpy;
      target.lastAt = at;
    }
    return { lane: target, isLow };
  }

  /**
   * 1 回分の観測を記録する。
   * sample: { workno, site, title, priceJpy, couponJpy, coupon, theoryJpy, theoryCoupon }
   */
  async function record(sample) {
    const workno = sample.workno;
    if (!workno || !Number.isFinite(sample.priceJpy) || sample.priceJpy <= 0) {
      return { skipped: true };
    }
    const now = Date.now();
    const records = await getAll();
    const prev = records[workno];

    const rec = prev
      ? Object.assign({}, prev)
      : {
          workno,
          site: sample.site,
          title: sample.title || '',
          firstSeenAt: now,
          samples: 0,
          plain: { minJpy: null, minAt: null, lastJpy: null, lastAt: null },
          coupon: { minJpy: null, minAt: null, lastJpy: null, lastAt: null },
          theory: { minJpy: null, minAt: null, lastJpy: null, lastAt: null },
          history: [],
        };

    rec.site = sample.site || rec.site;
    if (sample.title) rec.title = sample.title;
    rec.lastSeenAt = now;
    rec.samples = (rec.samples || 0) + 1;

    const plainUpd = updateLane(rec.plain, sample.priceJpy, now, null);
    rec.plain = plainUpd.lane;

    const couponUpd = updateLane(rec.coupon, sample.couponJpy, now, sample.coupon);
    rec.coupon = couponUpd.lane;

    const theoryUpd = updateLane(rec.theory, sample.theoryJpy, now, sample.theoryCoupon);
    rec.theory = theoryUpd.lane;

    // 履歴は「同じ日・同じ価格」を重複させない。日次で十分な粒度
    const history = Array.isArray(rec.history) ? rec.history : [];
    const today = dayKey(now);
    const last = history[history.length - 1];
    const sameDay = last && dayKey(last.t) === today;
    if (!sameDay || last.priceJpy !== sample.priceJpy || last.couponJpy !== sample.couponJpy) {
      history.push({
        t: now,
        priceJpy: sample.priceJpy,
        couponJpy: Number.isFinite(sample.couponJpy) ? sample.couponJpy : null,
        theoryJpy: Number.isFinite(sample.theoryJpy) ? sample.theoryJpy : null,
      });
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
      rec.history = history;
    }

    records[workno] = rec;
    await writeAll(records);
    return {
      skipped: false,
      record: rec,
      couponLow: couponUpd.isLow,
      plainLow: plainUpd.isLow,
      theoryLow: theoryUpd.isLow,
    };
  }

  async function clearAll() {
    await chrome.storage.local.set({ [KEY]: {}, [LEGACY_KEY]: {} });
  }

  async function remove(workno) {
    const records = await getAll();
    delete records[workno];
    await writeAll(records);
  }

  async function exportJson() {
    const records = await getAll();
    return {
      exportedAt: new Date().toISOString(),
      note: 'All prices are stored in JPY. coupon = lowest with coupons anyone can use; theory = lowest including qualified/new-user coupons.',
      records,
    };
  }

  PDP.history = {
    KEY,
    SETTINGS_KEY,
    DEFAULT_SETTINGS,
    getAll,
    getSettings,
    setSettings,
    record,
    clearAll,
    remove,
    exportJson,
  };
})();

// ---------------------------------------------------------------- 作品页面板
// extension/content.js
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

// ---------------------------------------------------------------- 历史低位判定（面板下方）
// extension/lib/lowpos.js
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
      isLow: n >= MIN_POINTS && current <= lo,
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

// ---------------------------------------------------------------- 购物车拆单优化器
// extension/lib/cart.js
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
      // 組合せ折扣 (セット割 / まとめ買い) の適用実額。割引は会計単位なので、
      // 同じ campaign の商品を別会計に分けるとこの価格は維持されない。
      soloPriceJpy: null, // 作品 API の price (単品価格)。enrichItems で埋める
      discountCampaignId: d.discountCampaignId || d.discount_campaign_id || null,
      isDiscount: d.isDiscount || d.is_discount || '',
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
    // 一度に大量のリクエストを投げると待たされるので、少しずつ処理する
    const queue = items.slice();
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          const p = await PDP.coupon.fetchProduct(it.site, it.workno);
          if (!p) continue;
          if (p.customGenres && p.customGenres.size) it.customGenres = p.customGenres;
          if (p.options) it.options = p.options;
          if (p.workType) it.workType = p.workType;
          if (p.makerId) it.makerId = p.makerId;
          // 単品価格 (組合せ折扣が外れたときに戻る価格)
          if (p.priceJpy > 0) it.soloPriceJpy = p.priceJpy;
          if (p.listPriceJpy > 0) it.listPriceJpy = p.listPriceJpy;
          it.enriched = true;
        } catch (e) {
          // 取得できなければカートの値のまま判定する (券が当たらない側に倒れる)
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return items;
  }

  /** カート内の商品 (稍后再买 に退避されたものを含む) を集める */
  function readCart(doc) {
    const d = doc || document;
    const rows = Array.from(d.querySelectorAll('li.cart_list_item, [data-workno]'));
    const byWorkno = new Map();
    for (const li of rows) {
      if (!li.dataset || (!li.dataset.workno && !li.dataset.productId)) continue;
      const item = parseRow(li);
      if (!item) continue;
      const prev = byWorkno.get(item.workno);
      if (prev) {
        // 同じ作品が PC 用/スマホ用で二重に存在し、片方には
        // data-discount_campaign_id などが入っていないことがある。
        // 情報量の多い方を残す (欠けている項目だけ補う)。
        if (!prev.discountCampaignId && item.discountCampaignId) {
          prev.discountCampaignId = item.discountCampaignId;
        }
        if (!prev.title && item.title) prev.title = item.title;
        if (!prev.laterHref && item.laterHref) prev.laterHref = item.laterHref;
        if (!prev.removeHref && item.removeHref) prev.removeHref = item.removeHref;
        continue;
      }
      byWorkno.set(item.workno, item);
    }
    return Array.from(byWorkno.values());
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

  /**
   * あるまとまりを 1 回の会計にしたときの支払額を返す関数を作る。
   *
   * **組合せ折扣 (セット割 / まとめ買い) は会計単位の割引**なので、同じ
   * `discountCampaignId` を持つ商品を別々の会計に分けると、その割引は失われて
   * 単品価格 (`soloPriceJpy`) に戻る。実測: 「3本以上60%OFFセット割」の 3 冊を
   * 3+1 に割ると、カート表示 220 円の本が単品価格 275 円に戻り、合計はむしろ高くなる。
   * ここを取り違えると「分けた方が安い」と誤判定する。
   */
  function makeSubsetPricer(allItems) {
    const members = new Map();
    for (const it of allItems) {
      const cid = it.discountCampaignId;
      if (!cid) continue;
      const set = members.get(cid) || new Set();
      set.add(it.workno);
      members.set(cid, set);
    }
    const keepsDiscount = (it, inSubset) => {
      const cid = it.discountCampaignId;
      if (!cid) return false;
      const all = members.get(cid);
      return !!all && Array.from(all).every((w) => inSubset.has(w));
    };
    const effective = (it, inSubset) =>
      keepsDiscount(it, inSubset)
        ? it.priceJpy
        : Number.isFinite(it.soloPriceJpy)
          ? it.soloPriceJpy
          : it.priceJpy;
    return {
      /** 券を当てる前の、商品ごとの実効単価 (券の逐件計算に渡す) */
      priced: (subset) => {
        const inSubset = new Set(subset.map((s) => s.workno));
        return subset.map((it) => ({ priceJpy: effective(it, inSubset) }));
      },
      /** 券を当てる前の合計 */
      total: (subset) => {
        const inSubset = new Set(subset.map((s) => s.workno));
        return subset.reduce((a, it) => a + effective(it, inSubset), 0);
      },
    };
  }

  /** まとまり 1 つを、券なし/券ありで最安にする */
  function bestForSubset(subset, coupons, usedOnce, pricer) {
    const priced = pricer ? pricer.priced(subset) : subset;
    const sumJpy = priced.reduce((a, it) => a + it.priceJpy, 0);
    let best = { totalJpy: sumJpy, coupon: null };
    for (const c of coupons) {
      // 1 回限りの券は他の会計で使っていたら候補から外す
      if (!c.is_multiple_use && usedOnce.has(c.coupon_id)) continue;
      if (!couponFitsSubset(c, subset, subset[0] && subset[0].site)) continue;
      // 券は商品ごとに割り引かれるので、実効単価の配列で計算する
      const after = PDP.coupon.applyToItems(c, priced);
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
    const priceOf = makeSubsetPricer(items);

    const bestOfMask = (mask) => {
      if (cache.has(mask)) return cache.get(mask);
      const subset = [];
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) subset.push(items[i]);
      const plain = priceOf.total(subset);
      let best = { totalJpy: plain, coupon: null };
      for (const c of coupons) {
        if (!couponFitsSubset(c, subset)) continue;
        // 券は逐件割引なので、組合せ折扣が外れた商品は単品価格で計算する
        const after = PDP.coupon.applyToItems(c, priceOf.priced(subset));
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
      const plans = greedyPlan(items, coupons, priceOf);
      return { plans, allInOne, exhaustive: false };
    }

    let bestCost = Infinity;
    let bestMasks = null;
    // 「分けた場合いくらになるか」を必ず出せるよう、2 分割以上に限定した
    // 最良解も同時に拾っておく (結論だけでなく根拠の数字を見せるため)
    let bestSplitCost = Infinity;
    let bestSplitMasks = null;
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
        if (masks.length >= 2 && cost < bestSplitCost - 0.5) {
          bestSplitCost = cost;
          bestSplitMasks = masks.slice();
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
    groups = resolveOnceOnly(groups, items, coupons, priceOf);

    const toPlan = (g) => ({
      items: g.items.slice(),
      totalJpy: g.totalJpy,
      coupon: g.coupon,
      savedJpy: priceOf.total(g.items) - g.totalJpy,
    });

    const plans = groups.map(toPlan);
    plans.sort((a, b) => b.totalJpy - a.totalJpy);

    // 分割案 (最良が 1 回でも、分けた場合の実額を出せるように)
    let splitPlans = null;
    if (bestSplitMasks && bestSplitMasks.length >= 2) {
      const splitGroups = resolveOnceOnly(
        bestSplitMasks.map((m) => bestOfMask(m)),
        items,
        coupons,
        priceOf
      );
      splitPlans = splitGroups.map(toPlan);
      splitPlans.sort((a, b) => b.totalJpy - a.totalJpy);
    }

    return { plans, allInOne, splitPlans, exhaustive: true };
  }

  /**
   * is_multiple_use=false の券は 1 回しか使えない。
   * 複数の会計に同じ券が割り当たっていたら、節約額が最大の会計にだけ残し、
   * 他は券なし (または別の券) で計算し直す。
   */
  function resolveOnceOnly(groups, items, coupons, pricer) {
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
        const priced = pricer ? pricer.priced(g.items) : g.items;
        let best = { totalJpy: priced.reduce((a, it) => a + it.priceJpy, 0), coupon: null };
        for (const c of others) {
          if (!couponFitsSubset(c, g.items)) continue;
          const after = PDP.coupon.applyToItems(c, priced);
          if (after !== null && after < best.totalJpy) best = { totalJpy: after, coupon: c };
        }
        g.totalJpy = best.totalJpy;
        g.coupon = best.coupon;
      }
    }
    return result;
  }

  /** 商品が多いときの簡易版: 券が当たるまとまりを優先して作る */
  function greedyPlan(items, coupons, pricer) {
    const remaining = items.slice();
    const plans = [];
    const usedOnce = new Set();
    while (remaining.length) {
      let best = null;
      for (let size = Math.min(remaining.length, 6); size >= 1; size -= 1) {
        const subset = remaining.slice(0, size);
        const r = bestForSubset(subset, coupons, usedOnce, pricer);
        const base = pricer ? pricer.total(subset) : subset.reduce((a, it) => a + it.priceJpy, 0);
        const saving = base - r.totalJpy;
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

// ---------------------------------------------------------------- 购物车面板
// extension/cart-content.js
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

// ---------------------------------------------------------------- 设置面板（Shadow DOM）
// userscript/src/options-panel.js
// 油猴环境下的设置面板。
//
// 扩展用 options.html 整页承载设置，但那个页面的 CSS 直接写 body / * / h1，
// 注入到 DLsite 会污染整页样式。所以这里用 Shadow DOM 重做一个面板，
// 逻辑（读写设置、记录表、导出、清空）全部复用 PDP.history，不重复实现。
(function () {
  'use strict';

  const PDP = globalThis.PDP;
  if (!PDP || !PDP.i18n || !PDP.history) return;

  const { i18n, history } = PDP;
  const HOST_ID = 'pdp-settings-host';
  const MENU_LABEL = 'DLsite Coupon Plus — 設定 / Settings';

  const CSS = `
    :host { all: initial; }
    .mask {
      position: fixed; inset: 0; background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center; padding: 24px;
      font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN",
        "Microsoft YaHei", sans-serif;
    }
    .panel {
      width: min(880px, 100%); max-height: 86vh; overflow: auto;
      background: #161629; color: #e6e6f0;
      border: 1px solid #383860; border-radius: 10px;
      box-shadow: 0 12px 48px rgba(0,0,0,.6); padding: 18px 20px 20px;
    }
    .head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
    .head h1 { font-size: 15px; margin: 0 0 2px; color: #fff; font-weight: 700; }
    .head p { margin: 0; font-size: 12px; color: #8b8bb0; }
    .x {
      margin-left: auto; background: none; border: 0; color: #8b8bb0;
      font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px;
    }
    .x:hover { color: #fff; }
    section { border: 1px solid #383860; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
    h2 { font-size: 13px; margin: 0 0 8px; color: #fff; font-weight: 700; }
    label.row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    label.field { display: block; margin-bottom: 8px; }
    select {
      font: inherit; background: #1a1a2e; color: #e6e6f0;
      border: 1px solid #383860; border-radius: 6px; padding: 4px 8px;
    }
    .hint { font-size: 11px; color: #8b8bb0; margin: 6px 0 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid #2a2a44; }
    th { color: #8b8bb0; font-weight: 400; font-size: 11px; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.acc { color: #ffd166; }
    .work { color: #8b8bb0; font-size: 11px; }
    .empty { text-align: center; color: #8b8bb0; padding: 14px 0; }
    .actions { display: flex; align-items: center; gap: 10px; }
    button.act {
      font: inherit; background: #1a1a2e; color: #e6e6f0; border: 1px solid #383860;
      border-radius: 6px; padding: 5px 12px; cursor: pointer;
    }
    button.act:hover { border-color: #6b6ba0; }
    button.danger { color: #ff8f8f; border-color: #5a2a3a; }
    .saved { font-size: 12px; color: #4fd1c5; opacity: 0; transition: opacity .2s; }
    .saved.on { opacity: 1; }
  `;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function applyStyle(root) {
    if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function') {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        return;
      } catch (e) {
        // 老版本浏览器退回 <style>
      }
    }
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = el('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;';
    (document.body || document.documentElement).appendChild(host);
    host.attachShadow({ mode: 'open' });
    return host;
  }

  /** 构建面板骨架，返回需要填数据的引用。 */
  function build(root, settings, locale) {
    applyStyle(root);
    const t = (key) => i18n.t(locale, key);
    const mask = el('div', 'mask');
    const panel = el('div', 'panel');

    const head = el('div', 'head');
    const headText = el('div');
    headText.appendChild(el('h1', '', 'DLsite Coupon Plus'));
    headText.appendChild(el('p', '', t('optSubtitle')));
    head.appendChild(headText);
    const close = el('button', 'x', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'close');
    head.appendChild(close);
    panel.appendChild(head);

    // 表示言語
    const secLang = el('section');
    secLang.appendChild(el('h2', '', t('optLangMode')));
    const mode = el('select');
    const optAuto = el('option', '', t('optLangAuto'));
    optAuto.value = 'auto';
    const optFixed = el('option', '', t('optLangForce'));
    optFixed.value = 'fixed';
    mode.appendChild(optAuto);
    mode.appendChild(optFixed);
    mode.value = settings.langMode === 'fixed' ? 'fixed' : 'auto';
    const langRow = el('label', 'field');
    const lang = el('select');
    for (const meta of i18n.LOCALES) {
      const opt = el('option', '', `${meta.label} (${meta.code})`);
      opt.value = meta.code;
      lang.appendChild(opt);
    }
    lang.value = settings.langOverride || locale;
    langRow.appendChild(lang);
    langRow.hidden = settings.langMode !== 'fixed';
    secLang.appendChild(mode);
    secLang.appendChild(langRow);
    secLang.appendChild(el('p', 'hint', t('optLangHint')));
    panel.appendChild(secLang);

    // 記録
    const secRec = el('section');
    secRec.appendChild(el('h2', '', t('optRecord')));
    const recLabel = el('label', 'row');
    const rec = el('input');
    rec.type = 'checkbox';
    rec.checked = settings.record !== false;
    recLabel.appendChild(rec);
    recLabel.appendChild(el('span', '', t('optRecord')));
    secRec.appendChild(recLabel);
    secRec.appendChild(el('p', 'hint', t('optRecordHint')));
    panel.appendChild(secRec);

    // 記録一覧
    const secList = el('section');
    const listHead = el('h2', '', t('optRecords'));
    secList.appendChild(listHead);
    const table = el('table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const key of ['colWork', 'colPlain', 'colCoupon', 'colTheory', 'colSamples', 'colUpdated']) {
      headRow.appendChild(el('th', '', t(key)));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    table.appendChild(tbody);
    secList.appendChild(table);
    panel.appendChild(secList);

    // 操作
    const actions = el('div', 'actions');
    const exportBtn = el('button', 'act', t('optExport'));
    exportBtn.type = 'button';
    const clearBtn = el('button', 'act danger', t('optClear'));
    clearBtn.type = 'button';
    const savedMsg = el('span', 'saved', t('optSaved'));
    actions.appendChild(exportBtn);
    actions.appendChild(clearBtn);
    actions.appendChild(savedMsg);
    panel.appendChild(actions);

    mask.appendChild(panel);
    root.appendChild(mask);
    return {
      mask,
      panel,
      close,
      mode,
      langRow,
      lang,
      rec,
      tbody,
      listHead,
      exportBtn,
      clearBtn,
      savedMsg,
      t,
    };
  }

  function paintRecords(refs, records, locale, t) {
    const list = Object.values(records).sort(
      (a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0)
    );
    refs.listHead.textContent = list.length
      ? `${t('optRecords')} (${list.length})`
      : t('optRecords');
    refs.tbody.replaceChildren();

    if (!list.length) {
      const tr = el('tr');
      const td = el('td', 'empty', t('optEmpty'));
      td.colSpan = 6;
      tr.appendChild(td);
      refs.tbody.appendChild(tr);
      return;
    }

    const money = (jpy) =>
      Number.isFinite(jpy) ? i18n.formatMoney(jpy, 'JPY', locale) : '-';

    for (const rec of list) {
      const tr = el('tr');

      const tdWork = el('td');
      tdWork.appendChild(el('div', '', rec.workno));
      if (rec.title) {
        const sub = el('div', 'work', rec.title.length > 34 ? `${rec.title.slice(0, 34)}…` : rec.title);
        tdWork.appendChild(sub);
      }
      tr.appendChild(tdWork);

      tr.appendChild(el('td', 'num', rec.plain && Number.isFinite(rec.plain.minJpy) ? money(rec.plain.minJpy) : '-'));

      const tdCoupon = el('td', 'num acc', rec.coupon && Number.isFinite(rec.coupon.minJpy) ? money(rec.coupon.minJpy) : '-');
      if (rec.coupon && (rec.coupon.couponName || rec.coupon.minAt)) {
        tdCoupon.title = [rec.coupon.couponName, rec.coupon.minAt ? i18n.formatDate(rec.coupon.minAt, locale) : '']
          .filter(Boolean)
          .join(' / ');
      }
      tr.appendChild(tdCoupon);

      const tdTheory = el('td', 'num', rec.theory && Number.isFinite(rec.theory.minJpy) ? money(rec.theory.minJpy) : '-');
      if (rec.theory && rec.theory.couponName) tdTheory.title = rec.theory.couponName;
      tr.appendChild(tdTheory);

      tr.appendChild(el('td', 'num', String(rec.samples || 0)));
      tr.appendChild(el('td', '', rec.lastSeenAt ? i18n.formatDate(rec.lastSeenAt, locale) : '-'));
      refs.tbody.appendChild(tr);
    }
  }

  let opened = null;

  async function open() {
    if (opened) {
      opened.host.style.display = 'block';
      return;
    }
    const settings = await history.getSettings().catch(() => ({}));
    const locale = i18n.resolveLocale(settings);
    const host = ensureHost();
    const root = host.shadowRoot;
    root.replaceChildren();
    const refs = build(root, settings, locale);
    let current = settings;

    root.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') close();
      },
      true
    );

    refs.close.addEventListener('click', close);
    refs.mask.addEventListener('click', (e) => {
      if (e.target === refs.mask) close();
    });

    refs.mode.addEventListener('change', async () => {
      current = await history.setSettings({ langMode: refs.mode.value });
      refs.langRow.hidden = refs.mode.value !== 'fixed';
      flash();
    });

    refs.lang.addEventListener('change', async () => {
      current = await history.setSettings({ langOverride: refs.lang.value });
      flash();
    });

    refs.rec.addEventListener('change', async () => {
      current = await history.setSettings({ record: refs.rec.checked });
      flash();
    });

    refs.exportBtn.addEventListener('click', async () => {
      const data = await history.exportJson();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dlsite-coupon-plus-records-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });

    refs.clearBtn.addEventListener('click', async () => {
      if (!confirm(`${refs.t('optClear')}?`)) return;
      await history.clearAll();
      paintRecords(refs, await history.getAll(), locale, refs.t);
    });

    function flash() {
      refs.savedMsg.classList.add('on');
      setTimeout(() => refs.savedMsg.classList.remove('on'), 1400);
    }

    function close() {
      host.style.display = 'none';
    }

    host.style.display = 'block';
    paintRecords(refs, await history.getAll().catch(() => ({})), locale, refs.t);
    opened = { host, close };
  }

  const report = (err) => {
    // 面板出错不能静默：留一条日志，避免用户以为「菜单没反应」
    if (typeof console !== 'undefined' && console.error) {
      console.error('[DLsite Coupon Plus] settings panel failed:', err);
    }
  };

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand(MENU_LABEL, () => open().catch(report));
  } else {
    // 没有菜单命令时（例如开发调试），用 Alt+Shift+P 打开
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        open().catch(report);
      }
    });
  }
})();

