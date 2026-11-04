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
