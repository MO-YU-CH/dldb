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
