# DLsite Coupon Plus

在 DLsite 作品页与购物车页展示**券后价**、**历史价格曲线**与**多部购买/拆单对比**的浏览器扩展 + 油猴脚本 + 价格站。

> 本项目不是 DLsite 官方产品。「DLsite」为株式会社エイシス的商标，本项目仅在指示性意义上使用该名称。

## 仓库结构

```
extension/       Chrome MV3 扩展（3,723 行，含 14 语 UI）
userscript/      Tampermonkey 脚本源与构建产物
server/          Flask 价格站 + SQLite + 历史导入器
scripts/         构建与生成脚本（图标等）
tests/           回归测试与 fixture
docs/            计划书、评审记录、数据管线说明
```

## 扩展

```bash
# Chrome → chrome://extensions → 开启开发者模式 → 加载已解压的扩展 → 选择 extension/
```

依赖顺序固定，改动 `lib/` 后需按 `i18n → coupon → history → (content | cart → cart-content) → lowpos` 顺序检查：

```
i18n.js 14 语字典与语言探测 / coupon.js 券分类与整单计算
history.js 本机记录 / content.js 作品页面板 / cart.js 拆单优化器 / cart-content.js 购物车面板
lowpos.js 历史低位判定（挂在面板下方，不改 content.js，避免同步时被覆盖）
```

### 开发源在上游目录

插件仍以 `H:\Dlsite\dl-ext\price-db-plus` 为开发主副本，`extension/` 是发布镜像，两者内容保持一致。

```bash
python scripts/apply_upstream_patch.py   # 把仓库侧的改动（品牌/数据源/lowpos）回写到上游，自动备份
python scripts/sync_extension.py         # 上游 → 仓库（单向同步 + 校验）
python scripts/package_extension.py      # 校验引用与语法后打 zip
```

改插件的正确顺序：**改上游 → 回写补丁（如需）→ sync → build/package**。

## 油猴脚本

**一键安装**：<https://dlsite.momo-yu.com/dlsite-coupon-plus.user.js?v=2.1.0>（Tampermonkey 会识别 `.user.js` 后缀并弹出安装页）

> 链接带 `?v=` 是必须的：Cloudflare 对 `.js` 走 4 小时边缘缓存，不带版本号发版后会取到旧文件。

```bash
node userscript/build.mjs          # 产出 userscript/dist/dlsite-coupon-plus.user.js
node tests/test_userscript.mjs     # shim 语义 + 产物不变量 + 面板，19 项
```

构建只做三件事：注入元数据块、按依赖顺序拼接、校验产物。**不使用 `@require` 拉远程**（延迟、可被篡改、审核风险）。

结构：

```
userscript/src/shim.js           chrome.storage / runtime.sendMessage 的油猴实现（只覆盖扩展真实用到的 9 处调用）
userscript/src/options-panel.js  设置面板，Shadow DOM 隔离，样式不污染 DLsite
userscript/build.mjs             拼接与自检
```

设置入口在 Tampermonkey 的菜单命令里（`DLsite Coupon Plus — 設定 / Settings`）。

## 价格站

```bash
cd server
python -m venv .venv && .venv/Scripts/activate     # Windows
pip install -r requirements.txt
python import_history.py --limit 200                # 导入历史（可断点续跑）
python app.py                                       # 开发服务 http://127.0.0.1:8080
```

线上：**https://dlsite.momo-yu.com**（AWS Lightsail 东京 `18.178.213.148`，Cloudflare 代理）。
部署与运维见 `docs/DEPLOY.md`；数据来源与合规约束见 `docs/DATA.md`；对原计划的技术核验见 `docs/REVIEW.md`。

## 开发约定

- 测试脚本统一放 `tests/`，临时文件放 `temp/`（不得落 C 盘）。
- 采集与服务进程记录 PID，任务结束即关闭。
- 服务端不得请求 DLsite 的 `/*/mypage`、`/*/cart` 路径（robots 禁止），持券与购物车逻辑只能留在浏览器内。
- 提交前跑 `python tests/run_all.py`。

## 许可

代码 MIT（见 `LICENSE`）。数据来自 DLsite 公开接口与第三方价格追踪服务的公开数据，不随代码授权。
