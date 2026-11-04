// 油猴脚本的离线测试：shim 语义 + 构建产物不变量。
//
//   node tests/test_userscript.mjs
//
// shim 用 vm 沙箱跑，GM_* 全部用 mock 替代，不碰真实浏览器与网络。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHIM = readFileSync(join(ROOT, 'userscript/src/shim.js'), 'utf8');
const BUNDLE = readFileSync(join(ROOT, 'userscript/dist/dlsite-coupon-plus.user.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

/** 建一个带 GM_* mock 的沙箱，返回 chrome 门面与调用记录 */
function loadShim(options = {}) {
  const store = options.store || new Map();
  const calls = [];

  const sandbox = {
    console,
    setTimeout,
    JSON,
    Promise,
    GM_getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    GM_setValue: (key, value) => store.set(key, value),
    GM_deleteValue: (key) => store.delete(key),
    GM_xmlhttpRequest: (opts) => {
      calls.push(opts);
      if (options.onRequest) options.onRequest(opts);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SHIM, sandbox, { filename: 'shim.js' });
  return { chrome: sandbox.chrome, store, calls };
}

console.log('shim:');

// vm 里创建的对象走的是另一个 realm，strict deepEqual 会因原型不同报错，
// 所以统一用 JSON 结构比较。
const plain = (value) => JSON.parse(JSON.stringify(value));

await testAsync('storage.get 未命中返回空对象', async () => {
  const { chrome } = loadShim();
  assert.deepEqual(plain(await chrome.storage.local.get(['a', 'b'])), {});
});

await testAsync('storage 写入后可读回（含对象键）', async () => {
  const { chrome, store } = loadShim();
  await chrome.storage.local.set({ 'pdp:records:v2': { RJ1: { title: 'x' } } });
  assert.ok(store.has('pdp:records:v2'));
  const got = await chrome.storage.local.get(['pdp:records:v2']);
  assert.equal(got['pdp:records:v2'].RJ1.title, 'x');
});

await testAsync('storage.get 支持字符串键（settings 用法）', async () => {
  const { chrome } = loadShim();
  await chrome.storage.local.set({ 'pdp:settings:v1': { record: false } });
  const got = await chrome.storage.local.get('pdp:settings:v1');
  assert.equal(got['pdp:settings:v1'].record, false);
});

await testAsync('storage.get 支持带默认值的对象形式', async () => {
  const { chrome } = loadShim();
  const got = await chrome.storage.local.get({ missing: 'fallback' });
  assert.equal(got.missing, 'fallback');
});

await testAsync('storage.remove 与 clear 生效', async () => {
  const { chrome } = loadShim();
  await chrome.storage.local.set({ a: 1, 'pdp:records:v2': { x: 1 } });
  await chrome.storage.local.remove('a');
  assert.deepEqual(plain(await chrome.storage.local.get(['a'])), {});
  await chrome.storage.local.clear();
  assert.deepEqual(plain(await chrome.storage.local.get(['pdp:records:v2'])), {});
});

await testAsync('sendMessage 命中 200：回传 {ok,status,data}', async () => {
  const { chrome, calls } = loadShim({
    onRequest: (opts) =>
      opts.onload({ status: 200, responseText: JSON.stringify({ workId: 'RJ159832' }) }),
  });
  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'lookup', store: 'dlsite', id: 'RJ159832' }, (res) => {
      assert.equal(chrome.runtime.lastError, undefined, 'lastError 应为空');
      resolve(res);
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.data.workId, 'RJ159832');
  assert.equal(
    calls[0].url,
    'https://dlsite.momo-yu.com/api/lookup/dlsite/RJ159832',
    '必须打本站接口'
  );
});

await testAsync('sendMessage 404：ok 但 data 为空（触发降级）', async () => {
  const { chrome } = loadShim({ onRequest: (opts) => opts.onload({ status: 404, responseText: '' }) });
  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'lookup', store: 'dlsite', id: 'RJ000000' }, resolve);
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 404);
  assert.equal(result.data, null);
});

await testAsync('sendMessage 网络失败：置 lastError 并回 null', async () => {
  const { chrome } = loadShim({ onRequest: (opts) => opts.onerror({}) });
  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'lookup', store: 'dlsite', id: 'RJ1' }, (res) => {
      assert.ok(chrome.runtime.lastError, 'lastError 应有值');
      resolve(res);
    });
  });
  assert.equal(result, null);
});

await testAsync('sendMessage 非法消息不抛异常', async () => {
  const { chrome } = loadShim();
  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'other' }, resolve);
  });
  assert.equal(result, undefined);
});

console.log('bundle:');

test('元数据块完整', () => {
  const meta = BUNDLE.slice(0, BUNDLE.indexOf('// ==/UserScript=='));
  for (const line of [
    '@name         DLsite Coupon Plus',
    '@version      2.0.0',
    '@match        https://www.dlsite.com/*/work/=/product_id/*',
    '@match        https://www.dlsite.com/*/cart',
    '@grant        GM_xmlhttpRequest',
    '@grant        GM_registerMenuCommand',
    '@connect      dlsite.momo-yu.com',
  ]) {
    assert.ok(meta.includes(line), `缺少 ${line}`);
  }
});

test('不使用远程 @require', () => {
  assert.ok(!/^\/\/\s*@require\b/m.test(BUNDLE));
});

test('不残留第三方接口与旧品牌', () => {
  assert.ok(!BUNDLE.includes('maenohou'), '仍引用 maenohou');
  assert.ok(!BUNDLE.includes('価格DB'), '仍含旧品牌');
});

test('依赖顺序正确（i18n 先于 coupon，cart 先于 cart-content）', () => {
  const idx = (needle) => BUNDLE.indexOf(needle);
  assert.ok(idx('PDP.i18n = {') < idx('PDP.coupon = {'), 'i18n 必须先于 coupon');
  assert.ok(idx('PDP.coupon = {') < idx('PDP.history = {'), 'coupon 必须先于 history');
  assert.ok(idx('PDP.cart = {') < idx('cart-content.js'), 'cart 必须先于 cart-content');
});

test('设置面板注册菜单命令', () => {
  assert.ok(BUNDLE.includes('GM_registerMenuCommand'));
  assert.ok(BUNDLE.includes('pdp-settings-host'));
});

console.log('options panel:');

// 极简 DOM 桩：只覆盖设置面板用到的方法。它不是浏览器，只用来抓
// ReferenceError / 拼写错误 / 结构塌陷这类「一跑就炸」的问题，
// 真实样式与交互仍需在浏览器里点一遍。
function makeEl(tag) {
  const node = {
    tagName: tag,
    children: [],
    style: {},
    attributes: {},
    className: '',
    id: '',
    hidden: false,
    title: '',
    type: '',
    colSpan: 0,
    value: '',
    checked: false,
    _text: '',
    classList: {
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...kids) {
      this.children = kids;
    },
    addEventListener() {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    attachShadow() {
      this.shadowRoot = makeEl('#shadow');
      return this.shadowRoot;
    },
  };
  Object.defineProperty(node, 'textContent', {
    get() {
      return node._text;
    },
    set(v) {
      node._text = String(v);
    },
  });
  return node;
}

function loadPanel() {
  const body = makeEl('body');
  const document = {
    body,
    documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => body.children.find((c) => c.id === id) || null,
    addEventListener() {},
  };

  const settings = { langMode: 'auto', langOverride: '', record: true };
  const records = {
    RJ159832: {
      workno: 'RJ159832',
      title: 'テスト作品',
      plain: { minJpy: 275 },
      coupon: { minJpy: 275, minAt: 1793000000000, couponName: 'テスト券' },
      theory: { minJpy: 198 },
      samples: 12,
      lastSeenAt: 1793000000000,
    },
  };

  let menu = null;
  const sandbox = {
    console,
    setTimeout,
    document,
    CSSStyleSheet: undefined,
    confirm: () => true,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Blob: class {},
    GM_registerMenuCommand: (label, fn) => {
      menu = { label, fn };
    },
    PDP: {
      i18n: {
        LOCALES: [
          { code: 'ja-jp', label: '日本語' },
          { code: 'en-us', label: 'English' },
        ],
        resolveLocale: () => 'ja-jp',
        t: (locale, key) => key,
        formatMoney: (v) => `${v}円`,
        formatDate: () => '2026-11-04',
      },
      history: {
        getSettings: async () => settings,
        setSettings: async (patch) => Object.assign(settings, patch),
        getAll: async () => records,
        exportJson: async () => ({ records }),
        clearAll: async () => {
          for (const k of Object.keys(records)) delete records[k];
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'userscript/src/options-panel.js'), 'utf8'), sandbox, {
    filename: 'options-panel.js',
  });
  return { body, menu };
}

await testAsync('注册了菜单命令', async () => {
  const { menu } = loadPanel();
  assert.ok(menu, '未注册菜单命令');
  assert.ok(menu.label.includes('DLsite Coupon Plus'));
  assert.equal(typeof menu.fn, 'function');
});

await testAsync('打开面板构建出 mask/panel 结构', async () => {
  const { body, menu } = loadPanel();
  await menu.fn();
  const host = body.children.find((c) => c.id === 'pdp-settings-host');
  assert.ok(host, '未插入宿主节点');
  assert.equal(host.style.display, 'block');
  const root = host.shadowRoot;
  // 无 constructable stylesheet 时会先插一个 <style>，所以按类名找而不是按索引
  const mask = root.children.find((c) => c.className === 'mask');
  assert.ok(mask, '未生成 mask 节点');
  const panel = mask.children[0];
  assert.equal(panel.className, 'panel');
  // head + 3 个 section + actions
  assert.ok(panel.children.length >= 5, `panel 子节点只有 ${panel.children.length} 个`);
});

await testAsync('重复打开不重复插入宿主', async () => {
  const { body, menu } = loadPanel();
  await menu.fn();
  const host = body.children.find((c) => c.id === 'pdp-settings-host');
  await menu.fn();
  assert.equal(body.children.filter((c) => c.id === 'pdp-settings-host').length, 1);
  assert.equal(host.style.display, 'block');
});

console.log(`\n${passed} 项通过`);
