# 部署

## 主机

| 项 | 值 |
| --- | --- |
| 公网 IP | `18.178.213.148`（AWS Lightsail，东京） |
| 域名 | `dlsite.momo-yu.com`（Cloudflare 代理，橙云） |
| 系统 | Ubuntu 24.04.4 LTS / 2 vCPU / 38 GB |
| 登录 | `ubuntu@18.178.213.148`，密钥 `F:\downloads\LightsailDefaultKey-ap-northeast-1.pem` |
| 应用目录 | `/home/ubuntu/dldb` |
| 数据库 | `/home/ubuntu/dldb/server/data/dlsite.db` |

> 注意：`18.187.213.148` 是错误 IP，不要再用。

## 进程与端口

| 服务 | 作用 | 端口 |
| --- | --- | --- |
| `dldb.service` | waitress 跑 Flask，4 线程 | `127.0.0.1:8080` |
| `dldb-refresh.service` | 滚动刷新 DLsite 价格，10 秒/次 | 无监听 |
| `caddy.service` | TLS 终止 + 反代，同时托管 `aws.momo-yu.com` | `0.0.0.0:80/443` |

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

## 缓存与日志清理

- Caddy 访问日志：`/var/log/caddy/dlsite.log`，单文件 10 MB 轮转，保留 5 份。
- 应用日志走 journald，无自建日志文件；`journalctl --vacuum-size=200M` 可手动压缩。
- 应用不生成缓存目录；SQLite 的 WAL 由 checkpoint 自动回收，无需手工清理。
- `temp/` 只在本地开发机使用，已在 `.gitignore` 中排除。

## Cloudflare 设置

- `dlsite.momo-yu.com` 的 A 记录指向 `18.178.213.148`，代理状态 **橙云开启**。
- SSL/TLS 模式建议 **Full (strict)**：源站已是 Caddy 自动申请的合法证书。
- 若出现 522：先确认源站 `curl -sI http://127.0.0.1:8080/healthz` 是否 200，再核对 A 记录。

## 回滚

```bash
# 代码
git revert <commit> && bash deploy/deploy.sh

# Caddy
sudo cp /etc/caddy/Caddyfile.bak.<时间戳> /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
