#!/usr/bin/env node
// 把扩展源码拼成单文件油猴脚本。
//
// 只做三件事：注入元数据块、按依赖顺序拼接、校验产物。
// 刻意不用 @require 拉远程——延迟、可被篡改、审核风险。
//
//   node userscript/build.mjs

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const OUT_DIR = join(HERE, 'dist');
const OUT_FILE = join(OUT_DIR, 'dlsite-coupon-plus.user.js');

const VERSION = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;

// 顺序即依赖：PDP 命名空间由 i18n 起头，其余挂在上面
const SOURCES = [
  ['userscript/src/shim.js', 'Chrome API 兼容层'],
  ['extension/lib/i18n.js', '14 语字典与语言判定'],
  ['extension/lib/coupon.js', '券分类与整单计算'],
  ['extension/lib/history.js', '本机价格记录'],
  ['extension/content.js', '作品页面板'],
  ['extension/lib/lowpos.js', '历史低位判定（面板下方）'],
  ['extension/lib/couponlist.js', '条件付きクーポン一覧'],
  ['extension/lib/cart.js', '购物车拆单优化器'],
  ['extension/cart-content.js', '购物车面板'],
  ['userscript/src/options-panel.js', '设置面板（Shadow DOM）'],
];

const META = `// ==UserScript==
// @name         DLsite Coupon Plus
// @name:ja      DLsite Coupon Plus 券後価格
// @namespace    https://dlsite.momo-yu.com/
// @version      ${VERSION}
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
`;

const BANNER = `/*
 * DLsite Coupon Plus v${VERSION}
 * 单文件构建产物，请勿直接编辑；改动请改 extension/ 或 userscript/src/ 后重新构建。
 * 数据源：https://dlsite.momo-yu.com （本脚本不在运行时请求第三方价格服务）
 * 许可：MIT。本项目非 DLsite 官方产品。
 */
`;

const parts = [META, BANNER];
const manifestRows = [];

for (const [rel, note] of SOURCES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`缺少源文件：${rel}`);
    process.exit(1);
  }
  const code = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  parts.push(`\n// ---------------------------------------------------------------- ${note}\n// ${rel}\n${code}`);
  manifestRows.push(`//   ${rel.padEnd(34)} ${code.split('\n').length} 行`);
}

const bundle = parts.join('') + '\n';

// 产物自检：不允许出现远程 @require，必须只依赖本站域名
const problems = [];
if (/^\/\/\s*@require\b/m.test(bundle)) problems.push('出现了 @require');
if (!bundle.includes("https://dlsite.momo-yu.com")) problems.push('缺少本站数据源');
if (bundle.includes('price.maenohou.com')) problems.push('仍引用第三方接口');
if (problems.length) {
  console.error('构建失败：' + problems.join('；'));
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, bundle, 'utf8');

const bytes = Buffer.byteLength(bundle, 'utf8');
const lines = bundle.split('\n').length;
const sha = createHash('sha256').update(bundle).digest('hex').slice(0, 16);

console.log(`构建完成 v${VERSION}`);
console.log(`  产物 ${relative(ROOT, OUT_FILE)}`);
console.log(`  体积 ${(bytes / 1024).toFixed(1)} KB / ${lines} 行 / sha256:${sha}`);
console.log('  组成：');
for (const row of manifestRows) console.log(row);
