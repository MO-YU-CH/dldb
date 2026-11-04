// 設定ページ。表示言語の固定・記録の ON/OFF・記録済み作品の一覧と書き出し。
(function () {
  'use strict';

  const PDP = globalThis.PDP;
  const { i18n, history: historyLib } = PDP;

  const els = {
    title: document.getElementById('title'),
    subtitle: document.getElementById('subtitle'),
    tLangMode: document.getElementById('tLangMode'),
    langMode: document.getElementById('langMode'),
    optAuto: document.getElementById('optAuto'),
    optFixed: document.getElementById('optFixed'),
    langOverride: document.getElementById('langOverride'),
    langHint: document.getElementById('langHint'),
    tRecord: document.getElementById('tRecord'),
    tRecordOn: document.getElementById('tRecordOn'),
    record: document.getElementById('record'),
    recordHint: document.getElementById('recordHint'),
    saved: document.getElementById('saved'),
    tRecords: document.getElementById('tRecords'),
    export: document.getElementById('export'),
    clear: document.getElementById('clear'),
    count: document.getElementById('count'),
    cWork: document.getElementById('cWork'),
    cPlain: document.getElementById('cPlain'),
    cCoupon: document.getElementById('cCoupon'),
    cTheory: document.getElementById('cTheory'),
    cSamples: document.getElementById('cSamples'),
    cUpdated: document.getElementById('cUpdated'),
    rows: document.getElementById('rows'),
  };

  let settings = null;
  // 設定ページ自身は DLsite の言語を持たないので、ブラウザの言語で表示する
  let locale = i18n.normalizeLocale(navigator.language) || 'ja-jp';

  const t = (key, vars) => i18n.t(locale, key, vars);
  const money = (jpy) => (Number.isFinite(jpy) ? i18n.formatMoney(jpy, 'JPY', locale) : '-');

  function flashSaved() {
    els.saved.textContent = t('optSaved');
    els.saved.classList.add('on');
    setTimeout(() => els.saved.classList.remove('on'), 1400);
  }

  function paintStatic() {
    document.documentElement.lang = i18n.intlOf(locale);
    els.title.textContent = 'DLsite Coupon Plus';
    els.subtitle.textContent = t('optSubtitle');
    els.tLangMode.textContent = t('optLangMode');
    els.optAuto.textContent = t('optLangAuto');
    els.optFixed.textContent = t('optLangForce');
    els.tRecord.textContent = t('optRecord');
    els.recordHint.textContent = t('optRecordHint');
    els.tRecords.textContent = t('optRecords');
    els.export.textContent = t('optExport');
    els.clear.textContent = t('optClear');
    els.cWork.textContent = t('colWork');
    els.cPlain.textContent = t('colPlain');
    els.cCoupon.textContent = t('colCoupon');
    els.cTheory.textContent = t('colTheory');
    els.cSamples.textContent = t('colSamples');
    els.cUpdated.textContent = t('colUpdated');
    els.langHint.textContent = t('optLangHint');
  }

  function paintLangControls() {
    els.langMode.value = settings.langMode === 'fixed' ? 'fixed' : 'auto';
    els.langOverride.hidden = settings.langMode !== 'fixed';
    if (!els.langOverride.options.length) {
      for (const meta of i18n.LOCALES) {
        const opt = document.createElement('option');
        opt.value = meta.code;
        opt.textContent = `${meta.label} (${meta.code})`;
        els.langOverride.appendChild(opt);
      }
    }
    els.langOverride.value = settings.langOverride || locale;
  }

  async function paintRecords() {
    const all = await historyLib.getAll();
    const list = Object.values(all).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    els.count.textContent = list.length ? `${list.length}` : t('optEmpty');
    els.rows.replaceChildren();

    if (!list.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'empty';
      td.textContent = t('optEmpty');
      tr.appendChild(td);
      els.rows.appendChild(tr);
      return;
    }

    for (const rec of list) {
      const tr = document.createElement('tr');

      const tdWork = document.createElement('td');
      const strong = document.createElement('div');
      strong.textContent = rec.workno;
      tdWork.appendChild(strong);
      if (rec.title) {
        const sub = document.createElement('div');
        sub.className = 'work';
        sub.textContent = rec.title.length > 34 ? `${rec.title.slice(0, 34)}…` : rec.title;
        tdWork.appendChild(sub);
      }
      tr.appendChild(tdWork);

      const tdPlain = document.createElement('td');
      tdPlain.className = 'num';
      tdPlain.textContent = rec.plain && Number.isFinite(rec.plain.minJpy) ? money(rec.plain.minJpy) : '-';
      tr.appendChild(tdPlain);

      const tdCoupon = document.createElement('td');
      tdCoupon.className = 'num acc';
      tdCoupon.textContent =
        rec.coupon && Number.isFinite(rec.coupon.minJpy) ? money(rec.coupon.minJpy) : '-';
      if (rec.coupon && (rec.coupon.couponName || rec.coupon.minAt)) {
        tdCoupon.title = [rec.coupon.couponName, rec.coupon.minAt ? i18n.formatDate(rec.coupon.minAt, locale) : '']
          .filter(Boolean)
          .join(' / ');
      }
      tr.appendChild(tdCoupon);

      const tdTheory = document.createElement('td');
      tdTheory.className = 'num';
      tdTheory.textContent =
        rec.theory && Number.isFinite(rec.theory.minJpy) ? money(rec.theory.minJpy) : '-';
      if (rec.theory && rec.theory.couponName) tdTheory.title = rec.theory.couponName;
      tr.appendChild(tdTheory);

      const tdSamples = document.createElement('td');
      tdSamples.className = 'num';
      tdSamples.textContent = String(rec.samples || 0);
      tr.appendChild(tdSamples);

      const tdUpdated = document.createElement('td');
      tdUpdated.textContent = rec.lastSeenAt ? i18n.formatDate(rec.lastSeenAt, locale) : '-';
      tr.appendChild(tdUpdated);

      els.rows.appendChild(tr);
    }
  }

  // ---- イベント -----------------------------------------------------------

  els.langMode.addEventListener('change', async () => {
    settings = await historyLib.setSettings({ langMode: els.langMode.value });
    paintLangControls();
    flashSaved();
  });

  els.langOverride.addEventListener('change', async () => {
    settings = await historyLib.setSettings({ langOverride: els.langOverride.value });
    flashSaved();
  });

  els.record.addEventListener('change', async () => {
    settings = await historyLib.setSettings({ record: els.record.checked });
    flashSaved();
  });

  els.export.addEventListener('click', async () => {
    const data = await historyLib.exportJson();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dlsite-coupon-plus-records-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  els.clear.addEventListener('click', async () => {
    if (!confirm(`${t('optClear')}?`)) return;
    await historyLib.clearAll();
    await paintRecords();
  });

  (async function init() {
    settings = await historyLib.getSettings();
    if (settings.langMode === 'fixed') {
      const fixed = i18n.normalizeLocale(settings.langOverride);
      if (fixed) locale = fixed;
    }
    els.record.checked = settings.record !== false;
    paintStatic();
    paintLangControls();
    await paintRecords();
  })();
})();
