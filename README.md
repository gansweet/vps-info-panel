# 🛰️ VPS信息面板 v2.0

Cloudflare Workers + D1 的 VPS 探针 / 网站在线信息面板。单文件 `worker.js`，零依赖，**兼容原版 `cfmonitor.sh` 探针**（旧探针无需改动）。

## ✨ 功能
- 🖥️ **服务器信息**：卡片（环形图为主）/ 列表（文字为主）两种视图；顶部汇总所有 VPS（在线数、平均 CPU、总内存、实时/总流量）
- 🌐 **网站在线信息**：状态、响应毫秒、最近 40 次检测历史条
- 🎨 三套主题 🌊海洋蓝 / 🌌星空 / 🌿山野绿 + 浅色/深色/跟随系统；🐱 GitHub 链接在后台设置；页脚年份自动更新
- ⚙️ 后台：服务器信息 · 网站信息 · 系统设置 · 通知管理（Telegram / Webhook / 邮件(Resend)；离线、高负载、到期；每台 VPS 单独开关）· 主题 · 数据库管理（导出 / 导入，重复记录可选跳过或覆盖，兼容旧版导出）· 日志记录 · 账户 · 关于（检查 GitHub 更新）
- 📈 Prometheus：`/metrics`（设置环境变量 `METRICS_TOKEN` 后需带 `?token=` 或 `Authorization: Bearer`）

## ☁️ 部署到 Cloudflare Workers（网页方式）
1. **创建 D1**：控制台 → 存储和数据库 → D1 → 创建数据库 `vps-info-db`
2. **创建 Worker**：Workers & Pages → 创建 → Hello World → 部署 → 编辑代码 → 清空后粘贴本仓库 `worker.js` → 部署
3. **绑定 D1**：Worker → 绑定 → D1 数据库 → 变量名 `DB`（大写）→ 选择 `vps-info-db`
4. **环境变量**：设置 → 变量和机密 → 添加密钥 `JWT_SECRET`（30 位以上随机串）；可选 `ADMIN_PASSWORD`（首次初始化密码）、`METRICS_TOKEN`
5. **Cron 触发器**：设置 → 触发事件 → 添加 Cron → `* * * * *`（每分钟；离线/负载/网站检测依赖它）
6. 打开 Worker 网址即可，表会**自动创建**。默认账号 `admin` / `monitor2025!`（或你设置的 `ADMIN_PASSWORD`），**登录后立即改密码**

命令行方式：改好 `wrangler.toml` 的 `database_id` 后 `npx wrangler d1 create vps-info-db && npx wrangler deploy`。
**Pages**：Pages 不支持 Cron，推荐使用 Workers；若坚持用 Pages Functions，需把 `worker.js` 放入 `functions/_middleware.js` 并另建 Cron Worker 触发。

## 📡 安装探针
后台 → 服务器信息 → 添加后复制「一键安装命令」到 VPS 执行。先在 **系统设置** 填好 GitHub 仓库地址（仓库根目录需有本仓库的 `cfmonitor.sh`）。

## 🐳 Docker
```bash
git clone <你的仓库> && cd vps-info-panel
# 编辑 docker-compose.yml 里的 JWT_SECRET
docker compose up -d --build   # 访问 http://IP:8787 ，数据在 ./data
```
## 🐧 Debian 本地部署
```bash
apt update && apt install -y curl git && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
npm i -g wrangler && cd vps-info-panel
JWT_SECRET=随机串 wrangler dev --ip 0.0.0.0 --port 8787 --persist-to ./data --test-scheduled &
# 定时任务（crontab -e）：
* * * * * curl -s http://127.0.0.1:8787/cdn-cgi/handler/scheduled >/dev/null
```
建议用 systemd 托管 `wrangler dev` 并加 Nginx/Caddy HTTPS 反代。

## 🔄 升级
仓库 Release 发布新版本 → 后台「关于」检查更新 → 用新 `worker.js` 覆盖部署，D1 数据保留。

## 🗄️ 备份 / 迁移
后台「数据库管理」导出 JSON；在新实例导入，选择「跳过」或「覆盖」重复记录。

---
# 📦 v2.1 新增

## 🔌 外部数据库（Supabase / PostgREST）与云端导入
后台 → 数据库管理 → 填写项目地址、API Key、表名 → **测试连接 / 推送备份 / 拉取并导入**。Supabase 的 SQL Editor 先执行：
```sql
create table if not exists vps_backup (id text primary key, data jsonb not null, updated_at timestamptz default now());
```
（任何兼容 PostgREST 的服务均可；密钥不会写入备份。）**云端下载导入**：填入任意 https 备份地址（本面板导出的 JSON，或旧版导出文件），选择跳过/覆盖即可。

## 🧩 探针（agent/vpsagent.c，C 语言）
- 采集 CPU/负载/内存/磁盘/网络/运行时间，按面板下发的间隔上报；`-p` 输出 node_exporter 风格的 Prometheus 文本（可接 textfile collector）
- 容器内读取宿主机：`docker run -d --pid host --network host -e HOST_PROC=/host/proc -v /proc:/host/proc:ro -e WORKER_URL=… -e SERVER_ID=… -e API_KEY=… <镜像>`（镜像用 `agent/Dockerfile` 构建）
- **发布二进制**：把仓库推到 GitHub，打标签 `git tag v2.1.0 && git push --tags`，`.github/workflows/build-agent.yml` 会构建 `vpsagent-linux-{amd64,arm64}`（静态链接）和 `vpsagent-darwin-{amd64,arm64}` 并创建 Release

## 🚀 一键安装（自动识别平台）
后台 → 服务器信息 → 复制安装命令（需先在「系统设置」填 GitHub 仓库地址）。脚本 `scripts/install.sh` 会：识别 Linux/macOS 与 amd64/arm64 → 下载 Release 二进制（失败则回退 Shell 探针 `cfmonitor.sh`）→ 配置自启：

| 场景 | 自启方式 |
|---|---|
| root + systemd | `systemd` 服务 |
| 非 root + systemd | `systemd --user` + `loginctl enable-linger` |
| macOS | `launchd`（root 用 LaunchDaemons，普通用户用 LaunchAgents） |
| 无 systemd / 容器 / 无 root | `crontab`（`@reboot` + 每分钟守护）；无 cron 则写入 `~/.profile` |

卸载：在安装命令前加 `UNINSTALL=1`（需手动设置 `PANEL_URL SERVER_ID API_KEY REPO` 环境变量后执行 `sh scripts/install.sh`）。

## 🧱 内嵌探针（放进你自己的程序里）
把文件复制到应用目录，主程序加一行即可，随程序启动，不阻塞退出：
```js
// Node ≥ 18：agents/vps-agent.js
require('./vps-agent').start({ url: 'https://面板地址', id: '服务器ID', key: 'API密钥' });
```
```python
# Python ≥ 3.7（纯标准库）：agents/vps_agent.py
import vps_agent; vps_agent.start("https://面板地址", "服务器ID", "API密钥")
```
也可只设环境变量 `VPS_URL / VPS_ID / VPS_KEY` 后无参调用 `start()`。

## 🗂️ 目录
`worker.js` 面板 · `wrangler.toml` · `Dockerfile` / `docker-compose.yml` 面板容器 · `agent/` C 探针与镜像 · `agents/` JS/Python 内嵌探针 · `scripts/install.sh` 安装器 · `cfmonitor.sh` 兼容 Shell 探针 · `.github/workflows/` 构建
> ⚠️ 提示：C 探针的 CI 静态链接构建与安装脚本各平台自启流程，请先在测试机跑通一遍再批量部署。
