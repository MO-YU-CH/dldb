// 自前の価格 DB (dlsite.momo-yu.com) の lookup API を代行する。
//
// content script から直接叩くと CORS の制約を受けるため、background が fetch して
// 結果だけを返す。レスポンスは短時間メモリに置き、同じ作品を開き直したときの
// 往復を減らす (Service Worker が落ちればキャッシュも消えるが、それで問題ない)。
'use strict';

const API_BASE = 'https://dlsite.momo-yu.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { expiresAt, value }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'lookup') {
    return undefined;
  }
  lookup(message.store, message.id).then(sendResponse);
  // 非同期に sendResponse を呼ぶことを伝える (これが無いとチャネルが閉じる)
  return true;
});

async function lookup(store, id) {
  if (!store || !id) {
    return { ok: true, status: 400, data: null };
  }
  const key = `${store}:${id}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }

  const url = `${API_BASE}/api/lookup/${encodeURIComponent(store)}/${encodeURIComponent(id)}`;
  let result;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      result = { ok: true, status: res.status, data: null };
    } else {
      result = { ok: true, status: res.status, data: await res.json() };
    }
  } catch (e) {
    // ネットワーク断は「データ無し」と区別して返す
    return { ok: false };
  }

  if (result.data) {
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
    if (cache.size > 200) {
      // 素朴な上限。古い順に捨てる
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }
  return result;
}
