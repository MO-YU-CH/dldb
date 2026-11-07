# 部署

## 主机

| 项 | 值 |
| --- | --- |
| 公网 IP | `<服务器 IP>`（AWS Lightsail，东京） |
| 域名 | `dlsite.momo-yu.com`（Cloudflare 代理，橙云） |
| 系统 | Ubuntu 24.04.4 LTS / 2 vCPU / 38 GB |
| 登录 | `ubuntu@<服务器 IP>`，密钥自备（如 `~/.ssh/dldb.pem`） |
| 应用目录 | `/home/ubuntu/dldb` |
| 数据库 | `/home/ubuntu/dldb/server/data/dlsite.db` |

> 注意：`18.187.213.148` 是错误 IP，不要再用。

## 进程与端口

| 服务 | 作用 | 端口 |
| --- | --- | --- |
| `dldb.service` | waitress 跑 Flask，4 线程 | `127.0.0.1:8080` |
| `dldb-refresh.service` | 滚动刷新 DLsite 价格，10 秒/次 | 无监听 |
| `caddy.service` | TLS 终止 + 反代，同时托管 `aws.momo-yu.com` | `0.0.0.0:80/443` |
| `dldb-backup.timer` | 每天 04:30 JST 做一次一致性快照 | 无监听 |

Caddy 的站点块追加在 `/etc/caddy/Caddyfile` 末尾（原文件已备份为 `Caddyfile.bak.<时间戳>`）。
**不要改动 `aws.momo-yu.com` 那个块**，它反代着 `127.0.0.1:10086` 的另一个服务。

证书由 Caddy 自动向 Let's Encrypt 申请（HTTP-01 经 Cloudflare 回源），续期自动完成。

## 部署 / 更新

```bash
bash deploy/deploy.sh          # 只更新代码，约 2 秒中断
bash deploy/deploy.sh --db     # 连数据库一起同步（会先做一致性快照）
```

`--db` 会先停 `dldb-refresh` 再替换数据库，避免刷新任务写入被覆盖。

## 常用运维

```bash
sudo systemctl status dldb dldb-refresh caddy
sudo journalctl -u dldb -n 50 --no-pager
sudo journalctl -u dldb-refresh -n 50 --no-pager
curl -s http://127.0.0.1:8080/healthz
sudo systemctl reload caddy          # 改完 Caddyfile 后
```

## 备份与恢复

每天 04:30 JST（服务器 UTC 19:30）由 `dldb-backup.timer` 触发一次快照，落在
`/home/ubuntu/dldb/server/data/backups/dlsite-YYYYmmdd-HHMMSS.db`，保留最近 **7 份**。

用的是 SQLite 的在线备份 API，不是 `cp`——库在 WAL 模式，直接拷主文件会漏掉 `-wal`
里未 checkpoint 的事务。

```bash
sudo systemctl start dldb-backup          # 手动跑一次
sudo journalctl -u dldb-backup -n 20      # 看结果
curl -s https://dlsite.momo-yu.com/healthz   # backups.count / age_hours
```

恢复：

```bash
sudo systemctl stop dldb dldb-refresh
cd ~/dldb/server/data
cp backups/dlsite-20261107-084852.db dlsite.db
rm -f dlsite.db-wal dlsite.db-shm
sudo systemctl start dldb dldb-refresh
curl -s http://127.0.0.1:8080/healthz
```

## 抓取并发控制

`dldb-campaign` 与 `dldb-refresh` 都会请求 DLsite，而 robots 的 `Crawl-delay: 10` 是
共享的——两个进程同时跑，实际频率会翻倍。因此：

- `dldb-campaign.service` 启动时 `touch data/.campaign_lock`，结束时删除
- `refresh.py` 每轮检查该文件，存在就休眠 60 秒让路
- 活动抓取结束后自动跑一次 `coupon_daily.py` 补算券后价

夜间的 `dldb-campaign.timer`（03:40 JST）与刷新任务因此不会叠加。

## 数据库调优

| 参数 | 值 | 理由 |
| --- | --- | --- |
| `cache_size` | -16384（每连接 16 MB） | waitress 4 线程最坏 64 MB，对 909 MB 机器安全；连接是每请求新建的，设太大等于按并发数乘 |
| `synchronous` | `NORMAL`（仅写连接） | WAL 下等价于「断电可能丢最后一个事务」，价格记录可接受；`FULL` 会让 10 秒一次的刷新每次都 fsync |
| `journal_mode` | `WAL` | 读不阻塞写，页面渲染不受刷新任务影响 |

可用 `DLDB_CACHE_KIB` 环境变量覆盖缓存大小。

## 缓存与日志清理

- Caddy 访问日志：`/var/log/caddy/dlsite.log`，单文件 10 MB 轮转，保留 5 份。
- 应用日志走 journald，无自建日志文件；`journalctl --vacuum-size=200M` 可手动压缩。
- 应用不生成缓存目录；SQLite 的 WAL 由 checkpoint 自动回收，无需手工清理。
- `temp/` 只在本地开发机使用，已在 `.gitignore` 中排除。

## Cloudflare 设置

- `dlsite.momo-yu.com` 的 A 记录指向 `<服务器 IP>`，代理状态 **橙云开启**。
- SSL/TLS 模式建议 **Full (strict)**：源站已是 Caddy 自动申请的合法证书。
- 若出现 522：先确认源站 `curl -sI http://127.0.0.1:8080/healthz` 是否 200，再核对 A 记录。

## 回滚

```bash
# 代码
git revert <commit> && bash deploy/deploy.sh

# Caddy
sudo cp /etc/caddy/Caddyfile.bak.<时间戳> /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
