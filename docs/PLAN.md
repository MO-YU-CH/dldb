# 計画書 — 価格DB+ 券後最安 → Git / 油猴 / Web サービス / DLsite アフィリエイト

> **交付对象**：执行此计划的 AI 或开发者。
> **本文档性质**：交接文档。第 1 章是**已实测确认的事实档案**，请直接采用，不要重新逆向。
> 第 1 章以外的内容都是**待执行计划**，尚未发生，不要当成已完成状态。

---

## 0. 目标与成功定义

把本地加载的 Chrome 扩展（现有 2,900 行、136 KB、v1.1.0）扩展为四件产物：

| # | 产物 | 成功标准 |
| --- | --- | --- |
| 1 | GitHub 仓库 | 公开可访问，含 LICENSE / PRIVACY，构建脚本可复现 |
| 2 | 油猴脚本 | Tampermonkey 一键安装，作品页 + 购物车页功能与扩展一致 |
| 3 | 价格网站 | 公开可访问、有实质内容、每日更新、可被联盟审核接受 |
| 4 | DLsite 联盟 | 申请通过，aff 链接接入网站（扩展内接入需先取得书面许可） |


---

## 1. 事实档案（已实测，直接使用）

### 1.1 现有资产

根目录：`H:\Dlsite\dl-ext\price-db-plus`

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `manifest.json` | 38 | MV3；2 组 content_scripts（作品页 / 购物车页） |
| `lib/i18n.js` | 778 | 14 语言字典、DLsite 语言探测、金额与日期格式化 |
| `lib/coupon.js` | 401 | 券分类、条件匹配、整单计算、币种与金额解析 |
| `lib/cart.js` | 308 | 购物车读取、持券拉取、拆单优化器 |
| `lib/history.js` | 167 | 三条记录线（最低价 / 理论最低 / 无券）持久化 |
| `content.js` | 689 | 作品页面板：券后价、双档最低价、组合明细、多部试算 |
| `cart-content.js` | 263 | 购物车面板：一起买 vs 拆单对比 + 操作步骤 |
| `options.html` + `options.js` | 114 + 173 | 设置页：语言模式、记录开关、六列记录表、导出/清空 |
| `background.js` | 49 | 代理 `price.maenohou.com` 请求（绕 CORS） |
| `README.md` | 71 | 用户文档 |

依赖顺序（打包时必须保持）：`lib/i18n.js → lib/coupon.js → lib/history.js → (作品页: content.js | 购物车页: lib/cart.js → cart-content.js)`

### 1.2 已确认的接口

**① インディー価格DB 价格历史**
```
GET https://price.maenohou.com/api/lookup/dlsite/{workno}
→ { workId, url, title, circle, platforms: [{
      platform, platformId,
      current: { price, basePrice, discountRate, isOnSale, couponRate, recordedAt },
      stats:   { minPrice, minPriceAt, maxPrice, firstSeenAt, points },
      history: [["YYYY-MM-DD", price], ...]
   }] }
404 = 该作品未被收录（很常见，必须有降级路径）
```

**② 作品精确数据**
```
GET https://www.dlsite.com/{site}/api/=/product.json?workno={RJ|BJ|VJ...}
→ [ { price(JPY), official_price, currency_price:{JPY,CNY,USD,...},
      custom_genres:[{genre_key,lang}], options:"JPN#DLP", work_type:"MNG",
      maker_id, series_id, is_bulkbuy, bulkbuy_*, has_specified_volume_set,
      specified_volume_sets } ]
```
`{site}` = maniax / home / girls / bl / pro / books / app / ai …

**③ 公开券池**
```
GET https://www.dlsite.com/home/api/=/coupon.json?cdn_cache=1   → 538 张（全池）
    ...?type=guest&cdn_cache=1                                  → 13 张（访客券）
键为**单数**：issue / condition
```

**④ 我的持券（需登录态）**
```
GET https://www.dlsite.com/{site}/mypage/coupon/list/ajax
→ [ { coupon_id, coupon_name, discount_type, discount,
      issues, conditions,          ← 注意是**复数**，与 ③ 不同
      is_multiple_use, is_limited_exceeded, limit_date, condition_info, end_date } ]
```
实测账号 11 张券，全部 `is_multiple_use: true`。

**⑤ 汇率**
```
GET https://www.dlsite.com/{site}/api/=/exchangeConfig.json
→ { data: { JPY:1, CNY:23.7161, USD:158.42, ... } }   1 外币 = N 日元
```

**⑥ 购物车**
```
GET https://www.dlsite.com/{site}/cart
行：li.cart_list_item[data-workno][data-price][data-maker-id][data-custom-genres]
    [data-work-type][data-work-options][data-site-id][data-official_price]
    ← 全部字段都在 data-* 上，**不要解析文本**
移入稍后再买：a.link_move_later  → /{site}/cart/ajax/=/mode/move_to_buylater/product_id/{workno}.html
删除：        a.link_delete      → /{site}/cart/ajax/=/mode/cart_remove/product_id/{workno}.html
合计：#cart_right_total（#_total_count 件数、.work_price_base 金额、.work_price_suffix 币种）
```
两者均为 **GET**，可直接 fetch 调用。

### 1.3 已确认的 DOM 选择器

| 用途 | 选择器 |
| --- | --- |
| 券后价（官方） | `.coupon_available dd.total .work_price_base` |
| 当前价 | `#work_price .work_buy_content .work_price_base` |
| 定価（划线） | `#work_price .strike` |
| 币种后缀 | `.work_price_suffix`（文本：`円` / `RMB` / `RM` / `Rp` …） |
| 个人券名 | `.coupon_available .coupon_name` |
| 加入购物车按钮 | `.btn_cart` |
| 券选择弹层 | `.global_overlay_content.type_coupon_select` |

### 1.4 已确认的业务规则

1. **券作用在折扣后价格上**：定価 1,980 → 社团折扣 10% → 1,782 → 券 −300 → **1,482**（与页面「一番お得なクーポン利用価格」一致）。
2. **定额券按整单只扣一次**，不是每件都扣。
3. **券分类**（决定是否计入「最低价」）：
   - `newuser`：券名含 `新規ユーザー` / `ユーザー登録特典` / `新用户`，或 id 前缀 `ad_lp_` / `marketing_register` → **不计入最低价**，只进理论最低
   - `qualified`：`issue` 存在且不只是 `regist_present`（即 `product_id` / `baitai` / `specific_route` / `price_sum`）→ 只进理论最低
   - `campaign`：其余（含限时活动券）→ 进最低价
4. **本数门槛**：`condition.post_condition.count`（如「3作品以上購入で利用可」）。券面说明「割引対象作品を3作品以上ご購入の場合、全てに割引」→ **只对对象作品打折，且对象作品数量要够**。
5. **官方多部折扣规则**（[出处](https://cs.dlsite.com/hc/ja/articles/17909850923801)）：まとめ買い / セット割 一旦成立，**其他折扣全部作废**；セット割 按**定価**计算；但券在它们之后**仍可扣减**。
6. **购物车两个硬约束**：无部分结算 UI → 拆单只能「移到稍后再买 → 结算 → 移回」；**一次结算只能用一张券**（内部名 `selectedCoupon` 是单数）。
7. **百分比券逐件取整再相加**（务必照此实现，勿用总额折算）：小计 1,408 円（220 + 704 + 484）用 15% 券 → 页面 **1,198 円**；
   `floor(1408 × 0.85) = 1,196`（错），`Σ(price − floor(price × 15 / 100)) = 187 + 598 + 411 = 1,198`（对）。
   即 `applyToItems(coupon, items)`，**不是** `applyOrder(coupon, total)`。定额券仍整单只扣一次。

实测校验值（可用于回归）：
- `RJ319607`：880 円，券后 580 円（300 円 OFF 券）→ 中文界面 24.46 RMB / 37.11 RMB
- `BJ078576` 定価 1,100 円；4 件拆单场景：一起买 2,618 円 vs 拆 3+1 → **968 円**
- 3 件小计 1,408 円 + 15% 券 → **1,198 円**（逐件取整，与总额法差 2 円）

### 1.5 不可依赖 / 需降级的点

- `price.maenohou.com` 的 `/api/` 在其 `robots.txt` 中为 `Disallow`。当前用法是用户代理请求，但**迁移到网站服务端抓取时必须先取得授权或改为自建数据**。
- 券池 538 张里只有 15 张是 `regist_present`（人人可领），其余需资格；`type` 参数除 `guest` 外都被忽略。
- DLsite 语言不能靠 cookie `locale`（切换后不更新），必须用 `?locale=` → `<html lang>` → cookie → 浏览器语言 的顺序。

---

## 2. 阶段计划

### P0 — 仓库化（0.5 天）

1. 建 GitHub 仓库（建议名 `dlsite-coupon-plus`），目录：
   ```
   extension/        ← 现有 price-db-plus 全部内容
   userscript/       ← 构建脚本 + 源 + dist
   web/              ← 价格站
   docs/             ← 计划书、架构、隐私政策
   LICENSE           ← MIT（与 maenohou 的依赖边界见 §4）
   PRIVACY.md        ← 隐私政策（必须，联盟与分发都要）
   README.md         ← 对外介绍（替换现有 README 或移入 extension/）
   ```
2. **公开前必须完成的两件事**（否则构成侵权）：
   - 改名：现有名称 `価格DB+ 券後最安` 含原作者品牌「価格DB」→ 改为自有名称（如 `DLsite 券後価格`）
   - 换图标：`icons/*.png` 是从原扩展直接复制的（SHA256 `C30D1AF2…` 与原扩展完全一致）→ 自绘替换
3. 写 `PRIVACY.md`：说明只在本机 `chrome.storage.local` 存价格记录、不上传、可导出可清空（当前实现即如此）。
4. 验收：`git clone` 后按 README 能加载扩展并看到面板。

### P1 — 油猴脚本化（1~2 天）

1. 建 `userscript/src/shim.js` 兼容层，把扩展用到的 Chrome API 映射到 GM：

   | 扩展 | 油猴 |
   | --- | --- |
   | `chrome.storage.local.get/set` | `GM_getValue` / `GM_setValue`（包成 Promise） |
   | `chrome.runtime.sendMessage({type:'lookup'})` | `GM_xmlhttpRequest` 直连 `price.maenohou.com` |
   | `options.html` 整页 | `GM_registerMenuCommand` + 注入式设置浮层 |
   | `chrome.runtime.lastError` | 不存在，改为 Promise reject |

   要点：现有代码只用 DOM 读取、不碰 `window.dlsite`，因此**不受 Tampermonkey 沙箱限制**，无需 `unsafeWindow`。

2. 元数据块：
   ```js
   // ==UserScript==
   // @name         DLsite 券後価格
   // @namespace    https://<你的域名>/
   // @version      1.0.0
   // @match        https://www.dlsite.com/*/work/=/product_id/*
   // @match        https://www.dlsite.com/*/cart
   // @grant        GM_getValue
   // @grant        GM_setValue
   // @grant        GM_xmlhttpRequest
   // @grant        GM_registerMenuCommand
   // @connect      price.maenohou.com
   // @run-at       document-idle
   // ==/UserScript==
   ```

3. 构建：`userscript/build.mjs` 按 §1.1 的依赖顺序拼接 + 注入元数据块 → `dist/dlsite-coupon-plus.user.js`。**不要用 `@require` 拉远程**（延迟、可被篡改、审核风险）。

4. 验收清单：
   - 作品页面板显示券后价，数值与页面「一番お得なクーポン利用価格」一致
   - 切 `?locale=ja_JP` / `?locale=en_US` 面板语言跟随
   - 购物车面板给出拆单对比；点开有操作步骤
   - 关闭浏览器重开，记录仍在（GM 存储）
   - 菜单命令能改语言 / 清空记录

### P2 — 价格网站（3~5 天）

1. 技术栈建议：Next.js (App Router) + Postgres(Supabase) 或 SvelteKit + SQLite；部署 Vercel / Cloudflare Pages。
2. **数据来源（关键决策，勿用全站爬虫）**：
   - 主：入库作品按需刷新 —— 服务端定时拉 `product.json` + `coupon.json` + `exchangeConfig.json` 自己算券后价（算法可直接移植 `lib/coupon.js`）
   - 辅：插件/脚本**可选匿名上报** `{workno, couponJpy, at}`（默认关闭，需显式 opt-in；不带任何用户标识）
3. 建议表结构：
   ```
   works(id, workno, site, title, circle, maker_id, work_type, custom_genres jsonb,
         price_jpy, official_price_jpy, updated_at)
   price_samples(id, workno, price_jpy, coupon_jpy, coupon_id, recorded_at)
   coupons(id, coupon_id, name, discount_type, discount, conditions jsonb, end_date)
   ```
4. 页面：`/works/{workno}`（价格表 + 券后价曲线 + 当前券）、`/search`、`/ranking`、`/about`（免责：非 DLsite 官方）。
5. 必备：`robots.txt`、隐私政策页、免责声明、sitemap。
6. 验收：Lighthouse 性能 ≥ 85、移动端可用、数据每日更新有日志。

### P3 — DLsite 联盟（申请 1 天 + 审核）

前置事实（已核实）：
- 申请入口在 DLsite マイページ →「アフィリエイトを始めよう」；**申请主体是公开网站**，不批情形包括：网站未公开、内容不明、需登录才能看主内容、无断上传站/图片まとめ站（[说明](https://cs.dlsite.com/hc/ja/articles/15794909031705)）
- **自购不产生报酬**（通过自己链接购买自己拿不到佣金）
- 素材规则：可用紹介/サムネ/サンプル图，只能等比缩放、禁改纵横比；`a` 的 href 不得修改（[说明](https://cs.dlsite.com/hc/ja/articles/42945439321113)）

执行：
1. 网站上线并至少有 N 个作品页可访问后再申请（空站会被拒）
2. 拿到 affiliate ID 后：**生成链接的格式以后台提供的为准，不要猜**
3. 接入点：网站作品卡片、`/works/{workno}` 的购买按钮
4. **扩展/脚本内是否可展示 aff 链接属于未明确覆盖的灰区**（条款只写主页/博客/SNS）→ 动工前向 DLsite 事务局书面确认（问法：`ブラウザ拡張機能内にアフィリエイトリンクを表示する利用は規約上可能でしょうか`）
5. 合规红线：禁绝对化/虚假表述（景表法）、禁自购刷单、禁诱导点击

### P4 — 分发与运营

1. GitHub Pages 做落地页 + 一键安装（`dist/*.user.js` 的 raw 链接）
2. Greasy Fork 投稿：运行在成人站点的脚本需标注 adult content（其 code-rules 页面被 Cloudflare 拦截，投稿前请人工复核）
3. 收集反馈渠道（GitHub Issues），写更新日志
4. 埋点：**最小化**，不采集个人数据；只用服务端访问日志

---

## 3. 代码要点（防止自由发挥）

- 券分类正则可直接复用 `lib/coupon.js` 的 `NEW_USER_PATTERN`，**不要改动**（已用实测券集验证）
- 币种后缀匹配数组**必须保持长前缀在前**（`RMB` 在 `RM` 之前，`NT$` 在 `$` 之前）
- 金额解析规则：分隔符后恰好 3 位且只出现一次 → 千分位（`100.894` IDR），否则小数（`4,53` EUR）
- 券后价**以页面 DOM 为权威**，本地计算仅用于补券名；两者差 ≤ 1 円才算吻合
- 购物车拆单：商品 ≤ 9 件穷举划分（贝尔数 21,147），> 9 件走贪心
- 面板一律 `createElement` + `textContent`，**禁用 innerHTML**（CSP 与审核）

---

## 4. 雷区清单（每条都踩过）

1. `window.dlsite` 在 content script 隔离世界读不到 → 语言只能靠 `?locale=` / `<html lang>`
2. cookie `locale` 切换语言时不更新，排在判定链**最后**
3. `RMB` 含 `RM`，币种匹配顺序错会把人民币识别成林吉特（曾出现 ¥29.68 被显示成 MYR 4.53）
4. 公开券池 `issue.product_id` **可能是字符串**而非数组；`issue.specific_route` 也是资格券，放行会把 880 円误算成 176 円
5. `condition.product_all` 是**作品号数组**，不是布尔
6. 我的持券接口用**复数** `issues` / `conditions`，公开券池用单数 → 必须归一化
7. `specified_volume_sets` / `is_bulkbuy` 在普通作品上极罕见（扫 184 个新作 0 命中）→ 做防御性解析即可，重心放在券的本数门槛
8. 券后价 DOM 由 Vue 客户端渲染，`document_idle` 时可能还没出现 → 必须轮询等待（现有实现等 6 秒）
9. 购物车页同一商品可能在 DOM 出现两次（桌面/移动布局）→ 读取时按 workno 去重
10. 图标与名称侵权：`icons/*.png` 与原扩展 SHA256 相同，公开前必须替换
11. 验证扩展内部函数时，页面主世界看不到 `PDP`，需 CDP `Page.createIsolatedWorld` 注入
12. `curl` 直接读 DLsite 页面可拿到 Vue 模板，但**券后价等数值必须真实浏览器渲染后才存在**
13. **购物车行的 `data-custom-genres` 恒为空数组**，且 `data-work-options` 与作品页不一致（实测 RJ01745012：购物车 `RegionHiddenFilter` vs product.json `CHI_HANS#CHI#DLP`）→ 只读购物车 DOM 会让**所有 `custom_genre` 券失效**（曾导致 30% 同人券识别不到、误报"拆单不会更便宜"）。必须用 `product.json` 补 `customGenres` / `options`，但**价格必须保留购物车的 `data-price`**（那是组合折扣后的实付价）。
14. 购物车商品标题：第一个 `a[href*="product_id"]` 常是无文本的缩略图链接，取标题要遍历到有文本的那个，否则会退化成作品号并重复显示。

---

## 5. 交付物清单

- [ ] GitHub 仓库（含 LICENSE / PRIVACY / README / 构建脚本）
- [ ] `dist/dlsite-coupon-plus.user.js`（单文件，可一键安装）
- [ ] 网站（域名 + 部署 + 每日更新任务）
- [ ] `docs/` 内的架构说明与联盟确认记录
- [ ] 回归测试脚本（用 §1.4 的两个校验值）

## 6. 交接须知

1. **先读 §1，不要重新逆向** DLsite。§1 之外的接口/字段，用之前必须自己验证。
2. 不要修改 §1.4 已验证的算法常量与匹配顺序。
3. 任何"联盟链接格式""报酬率常规值"以 DLsite 后台/官方回复为准，本文档不提供猜测值。
4. 涉及用户数据的功能默认关闭，且必须在 `PRIVACY.md` 写明。
