# 数据管线

## 1. 三层数据来源

| 层 | 来源 | 作用 | 运行时是否依赖外部 |
| --- | --- | --- | --- |
| 历史 | 第三方价格追踪服务的公开数据，一次性导入 | 建站初期就有曲线可看 | 否 |
| 刷新 | DLsite `product.json`（公开接口） | 每天追加当日价格点 | 否（由本站任务主动拉取） |
| 上报 | 扩展/脚本匿名上报（未实现，默认关闭） | 提高长尾覆盖率 | 否 |

**关键约束**：页面渲染只读本站 SQLite，任何请求都不向第三方转发。第三方接口只在导入阶段使用一次。

## 2. 导入器（import_history.py）

三段式，任一段中断都可续跑：

```
sitemap   → 抓 sitemap-works/1..5.xml，把作品页 URL（UUID）入队
resolve   → 抓作品页，从 JSON-LD 的 "sku" 字段取出作品号（RJ/BJ/VJ…）
fetch     → GET /api/lookup/dlsite/{workno} 取历史，写 works / price_samples
```

实测规模（2026-11-04）：

- sitemap 五个分片合计 **20,384** 条作品页 URL
- 每件作品需要 2 次请求（页面 + 接口）
- 4 线程、单连接 0.4s（另加 0~50% 抖动）：实测解析约 **2.5 件/秒**、取数约 **1 件/秒**，全量 ≈ 6~8 小时
- 单件历史点数：新作 1 点，半年期作品约 80 点，最长实测 218 点

`--batch` 控制每轮「解析 → 取值」的批量（默认 200），保证任何时刻中断，库里都是可用的一部分，而不是一堆待解析 URL。

```bash
python server/import_history.py --stage all --batch 200 --delay 0.4
python server/import_history.py --stats
```

## 3. 每日刷新（refresh.py）

DLsite `robots.txt` 明确 `Crawl-delay: 10`，即单进程每天最多约 8,640 次请求。

因此 **2 万件作品不可能一天刷完一遍**。采用的策略是滚动刷新：

```
ORDER BY updated_at ASC LIMIT N   → 最久未刷新的优先
```

按 10 秒间隔常驻，约 8,600 次/天，整个库 2~3 天轮一遍。这是当前规模下的物理上限，不是实现偷懒。

```bash
python server/refresh.py --once --limit 50   # 冒烟
python server/refresh.py --loop              # 常驻
```

## 4. 合规红线（来自 robots.txt 与利用規約）

| 路径 | 状态 | 约束 |
| --- | --- | --- |
| `/*/mypage` | Disallow | 持券接口只能由用户浏览器调用，服务端永不请求 |
| `/*/cart` | Disallow | 拆单对比只在扩展内做，网站不提供 |
| `/*search/result` | Disallow | 站内搜索用本地 SQLite，不代理 DLsite 搜索 |
| `/*work/image/sample/` | Disallow | 不抓图；页面因此不显示封面，只用文字与曲线 |
| `/api/`（本站） | 自设 Disallow | 接口不对外索引，避免被抓成镜像 |

## 5. 表结构

```sql
works(workno PK, title, circle, url, site, current_price, base_price,
      discount_rate, min_price, min_at, max_price, first_seen, points, updated_at)

price_samples(workno, day, price, PRIMARY KEY(workno, day))   -- 一天一个点

crawl_queue(page_url PK, workno, status, tries, note, updated_at)
  status: new → ready → done / missing / no_sku / page_error
```

`price_samples` 用 `WITHOUT ROWID` + 复合主键，200 万点约占 60–80 MB。

## 6. 券后价与「历史低位」

网站回答「现在是不是低价」用的是券后价，不是标价。

| 环节 | 实现 |
| --- | --- |
| 券池 | `server/data/coupons.json`，`refresh.py` 启动时与每 6 小时拉取公开券池（539 张） |
| 计算 | `server/coupons.py`，按扩展 `lib/coupon.js` 的口径移植：rate 券按单品向下取整、price 券整单一次、券作用在折扣后价格上 |
| 范围 | 只用「谁都能领」的券（campaign）。`newuser` 与 `qualified`（凭购买资格/渠道）不计入，避免虚报低价 |
| 判定 | `server/pricing.py`：券后价 ≤ 历史最低 → 「处于历史最低」；严格低于 → 进「新低榜」；否则给出「比过去 N% 的记录日更便宜」 |
| 缓存 | 榜单结果缓存 5 分钟；券池按文件 mtime 热加载 |

两点必须说清的口径差异：

1. **公开券池 ≠ 用户能拿到的全部券。** 个人持券（我的页面）可能更低，例如 `RJ319607` 实测 880 → 580 靠的是账号券，公开池复现不出来。所以站上标的最低价比用户实际可能拿到的略保守。
2. **历史序列不含券。** 导入的历史是历史售价，券后价只在「当前」这一端参与比较。因此「新低」的判定是：当前券后价低于历史最低售价——这个方向是成立的，反过来（历史券后价）没有数据。

## 7. 按需入库（补书籍区）

第三方 sitemap 只覆盖同人（RJ）与视频（VJ），书籍区（BJ）**一条都没有**——队列 20,384 条里 BJ 数量为 0。这类作品在扩展面板里既没有曲线，也没有「查看完整价格趋势」链接。

现在改为**首次访问时现场取一次**：

```
api/lookup 或 /works/<id> 未命中
  → GET https://www.dlsite.com/{site}/api/=/product.json?workno=<id>
  → 写 works（1 个价格点）+ price_samples（今天）
  → 此后由 refresh.py 照常滚动刷新
```

护栏（都在 `server/ondemand.py`）：

| 项 | 值 |
| --- | --- |
| 作品号白名单 | `^[A-Z]{2}\d{6,10}$`，避免被当作任意 URL 代理 |
| 请求节奏 | 全局串行，最小间隔 2 秒 |
| 失败缓存 | 1 小时（避免反复打不存在的作品） |
| 每日上限 | 500 件，防止被枚举作品号刷库 |
| 开关 | `DLDB_ONDEMAND=0` 可整体关闭（测试默认关闭） |

代价要说清：新入库的作品只有**当天 1 个价格点**，所以既画不出曲线，也不该宣称「历史最低」。样本不足 5 天时，定位信息一律不显示。

## 7.5 覆盖策略：不追求全库轮询

DLsite 官方 sitemap（robots 里列出）显示 maniax 一个分区就有 **434,024 件**作品
（44 个分片 × 1 万条），我方库里 20,226 件只占 4.7%。

按 robots 的 `Crawl-delay: 10`（8,640 请求/天）和单件接口，全库轮询一轮需要 **50 天**。
所以站点不追求"全库定期刷新"，改成三层：

| 层 | 范围 | 方式 | 新鲜度 |
| --- | --- | --- | --- |
| A 活动内 | 促销期十几万件 | 活动页 50 件/请求（含价格、套装） | 小时~天级 |
| B 热库 | 2~3 万件 | `product.json` 轮转 | 2~3 天 |
| C 长尾 | 40 万+ | **按需**：首次被访问时现场补 | 访问即最新 |

C 层是关键，也是插件"历史最低"能用的前提：`ondemand.ingest()` 在首次访问时
同时做两件事——从 DLsite 取当前价与套装字段，从第三方历史接口补齐历史序列。
实测冷启动 1.94 秒返回 6 个价格点；第三方命中率约 7/10，未命中时只记当天。

## 8. 券后价的每日回填

券后价 = f(价格, 券池)，两样我们本地都有，所以**不需要访问 DLsite**：
`coupon_daily.py` 每天用 `works.current_price` + 最新券池，为全部作品写一条券后价。
实测 20,226 部约 **3.7 秒**。

写入时有两条规则：

1. 当天已有价格行 → 只更新 `coupon_price`，**券按那一行的价格算**，不按 `works.current_price`
2. 当天没有行 → 插入价格行，但 `carried = 1`

`carried` 表示「价格是沿用上次实测值，不是当天观测」。价格图表、`min/max/points` 只认
`carried = 0`；券后历史两者都认（券后价本身是按当天价格算出来的，仍然有效）。

## 9. 活动（セール）数据

### 接口（都是从 app.js / 页面结构里找出来的，实测可用）

| 用途 | 端点 | 实测 |
| --- | --- | --- |
| 活动索引 | `/{site}/api/=/campaignBanner.json?cdn_cache=1` | 当前 4 条，含 `start/end/url`，key 在 url 里 |
| 活动商品 | `/{site}/campaign/discount?key=<key>&page=N` | 服务端分页，**50 件/页**；第 1/30/150 页零重合 |
| 价格核对 | `/{site}/api/=/product.json?workno=` | 抽样 5 件，活动页价格与单件接口 **5/5 一致** |

`campaignBanner` 里的条目不一定带 key（纯宣传页），没有 key 的直接跳过。

### 为什么值得做

活动页每张卡片同时带作品号、标题、现价、定価（划掉价在 `span.strike` 里）。
**一次请求 = 50 件作品的价格更新**，而单件接口是 1 请求/件，效率差 50 倍。

### 已实现

`server/campaigns.py`：

```
--banners            列出活动中 key 与起止
--key <key> --pages N [--verify K] [--save]
--all --pages N --save    扫描 campaignBanner 里的全部活动，跳过已结束的
```

落到两张表：

```sql
campaigns(key, site, start, end, updated_at)
campaign_works(key, workno, day, price, base)   -- 最近一次看到的参加状态
```

活动页读到的价格是**真实观测**，写 `price_samples` 时 `carried=0`，并调用
`db.recompute_stats()` 重算 min/max/points。

定时：`dldb-campaign.timer` 每天 03:40 JST，单页间隔 10 秒，最多 400 页。

### 套装活动（自选组合 / セット割）

**不要翻页枚举参加作品。** 页面显示「対象作品 180,517件」——按 50 件/页算要 3,610 页、
每页 10 秒就是 10 小时，不可行。

正确做法：`product.json` 里本来就有 `bulkbuy_start` / `bulkbuy_end`，
**非空即代表这件作品参加套装活动**，还带起止时间。

| 作品 | bulkbuy_start/end | 套装对象 |
| --- | --- | --- |
| RJ01258201 | 2026-10-30 ~ 11-12 | 是 |
| RJ01451504 | 同上 | 是 |
| RJ159832 | 空 | 否 |

所以活动侧只需要知道**规则**（几件、几折）：抓活动页 1 页解析「3本以上60%OFF」→
`min_items=3, rate=60`，存进 `campaigns`。18 万件的名单交给单件接口。

卡片解析（`parse_bulkbuy`）保留，用于人工核对，不再用于日常抓取。

**计价规则（关键）**：套装折扣与单品折扣**取较大者，不叠加**。

```
有效价 = 定価 × (1 − max(单品折扣率, 套装折扣率))
券后价 = 有效价 − 券
```

实测：定価 880、单品 30%OFF、套装 60%OFF → 有效价 352；再叠 25% 券 → **264**。
如果按 30% + 60% 叠加会算成 246，是错的。

官方依据（DLsite 帮助中心「捆綁購買と打折套裝的區別」）：

> 打折套装的折扣率是**相对于定价**制定的；若购买超出指定数量的打折套装作品，
> 则**优先以打折套装的折扣计算金额（其他打折不被计入其中）**

第三方实测攻略亦写明「系统自动适用定价折扣率较高的一方」，
「促销 30% × 捆绑 60% = 实际 90%」不会发生。

**仍有一处边界未定论**：当单品折扣率**高于**套装（如单品 90%、套装 60%）时，
官方措辞是「套装价优先」，第三方攻略是「取较高者」。本站按**较高者**实现
（对用户更有利，也更符合"不让用户多付钱"的常识），但这一支需要登录账号在
购物车实测才能确认。

套装价 DLsite 页面不显示（只显示 616 这种单品价），所以这一层完全由本站计算。
券作用在套装价上——DLsite 自身不做这个叠加，这是本站的额外口径。

落库时：`campaigns.kind='bulkbuy'`、`min_items`、`rate`；`campaign_works` 存参与名单；
`works.discount_rate` 由卡片价与定価反推（如 616/880 → 30），避免丢掉单品折扣。

### 已知限制

- 套装页没有总件数字段，靠翻到空页/重复页停止；`--pages` 上限 400
- 只能发现 `campaignBanner` 里露出的活动
- 活动页没有总件数字段，只能翻到空页或重复页为止，因此设了页数上限
- 只能发现 `campaignBanner` 里露出的活动；没有 banner 的活动仍要靠单件扫描撞见

## 10. 已知问题

1. **`no_sku`**：少数作品页没有 JSON-LD（实测 ~2%）。这类页面会被标为 `no_sku` 跳过，后续可从 DLsite sitemap 反向补齐。
2. **`marketing_register` 券判定**：扩展代码只判 `ad_lp_` 前缀，文档要求同时判 `marketing_register`。导入的历史价格不涉及券，但接券后价时需修正，否则最低价会偏高。
3. **站点 URL 分区**：导入接口不返回分区，靠作品号前缀推断（RJ→maniax、BJ→books、VJ→pro）。个别跨区作品可能跳到错误分区，DLsite 一般会自行重定向。
