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
