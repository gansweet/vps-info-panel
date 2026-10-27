# 🛰️ VPS信息面板 v2.2

Cloudflare Workers + D1 的 VPS 探针 / 网站在线信息面板。单文件 `worker.js`，零依赖；探针为 **C 语言静态单文件**（Push 模式），并提供 Shell / Node / Python 三种回退或内嵌探针。

## ✨ 功能一览
| 模块 | 说明 |
|---|---|
| 🖥️ 服务器信息 | 卡片（环形图为主）/ 列表（文字为主）；分组筛选；点击进入详情（系统、负载、Swap、磁盘 IO、TCP/进程、端口状态、延迟、SSH 失败、OOM、24h 趋势图） |
| 🌐 网站在线信息 | 状态、响应毫秒、图标(Favicon/Emoji)、分类、近 40 次检测历史条 |
| 🎨 界面 | 右上角悬浮菜单：🎨 主题（🌊海洋蓝/🌌星空/🌿山野绿）、🌓 模式（跟随系统/浅/深）、🐱 GitHub、⚙️ 设置（登录/后台）；登录为居中动感对话框；后台左侧悬浮菜单 |
| ➕ 添加服务器 | 对话框：名称、分组、区域(带国旗)、到期日、流量上限、端口探测、延迟目标；创建后自动出现**可复制的一键安装命令**；支持编辑 / 删除 / 查看密钥，卡片或列表展示 |
| 🔔 通知 | Telegram / Webhook / 邮件(Resend)；离线、恢复、高负载、到期、网站异常；每台服务器可单独开关 |
| 🗄️ 数据库 | D1；JSON 导出 / 导入（重复记录可选跳过或覆盖，兼容旧版）；外部库（Supabase / 任意 PostgREST）推送与拉取；云端下载地址导入 |
| 📈 Prometheus | `/metrics`（设置 `METRICS_TOKEN` 后需 `?token=` 或 Bearer） |

默认后台账号：**`amos` / `sweet`**（首次登录后请立刻在「账户」改密码，并设置强 `JWT_SECRET`）。从旧版升级时，若旧账号仍是默认的 `admin / monitor2025!`，会自动迁移为 `amos / sweet`；自己改过密码的账号不受影响。数据库表结构启动时自动升级，旧数据保留。

## ☁️ 部署到 Cloudflare Workers
1. **创建 D1**：控制台 → 存储和数据库 → D1 → 创建 `vps-info-db`
2. **创建 Worker**：Workers & Pages → 创建 → Hello World → 部署 → 编辑代码 → 清空并粘贴 `worker.js` → 部署
3. **绑定 D1**：Worker → 绑定 → 添加 D1 数据库，变量名 **`DB`**（大写）
4. **变量**：设置 → 变量和机密 → 添加密钥 `JWT_SECRET`（30 位以上随机串）；可选 `ADMIN_PASSWORD`（仅首次初始化）、`METRICS_TOKEN`
5. **Cron**：设置 → 触发事件 → 添加 Cron `* * * * *`（离线/负载/网站检测依赖它）
6. 打开 Worker 网址，表自动创建。命令行方式：改好 `wrangler.toml` 的 `database_id` 后 `npx wrangler deploy`。

> Pages 不支持 Cron，建议使用 Workers。更新版本时直接用新的 `worker.js` 覆盖即可，D1 数据保留。

## 🚀 安装探针
后台 → 服务器信息 → ➕ 添加服务器 → 创建后复制弹出的命令，在 VPS 上执行：
```bash
curl -fsSL "https://你的面板/install.sh?id=服务器ID&key=API密钥" | sh
```
> ⚠️ 命令里的 URL **必须加引号**（`&` 会被 shell 当成后台符）。面板生成的命令已带引号。

安装器自动：识别 Linux/macOS 与 amd64/arm64 → 下载 C 探针（面板 `/dl/...` 跳转到你的 GitHub Release）→ 若没有 Release，**自动回退到面板内置的 Shell 探针**（Linux，只需 sh+awk+curl/wget）→ 配置自启：

| 场景 | 自启方式 |
|---|---|
| root + systemd | systemd 服务 |
| 非 root + systemd | `systemd --user` + `loginctl enable-linger` |
| macOS | launchd（root: LaunchDaemons；用户: LaunchAgents） |
| 无 systemd / 容器 / 无 root | `crontab`（`@reboot` + 每分钟守护）；无 cron 则写入 `~/.profile` / `~/.bashrc` |

卸载：`curl -fsSL "…同一条链接…" | UNINSTALL=1 sh`。重复执行安装命令是安全的（幂等）。

### C 探针（`agent/vpsagent.c`）
Push 模式（VPS 主动上报，穿透 NAT/防火墙）；采集 CPU(用户/内核)、负载、内存、Swap、磁盘、磁盘 IO、网络、TCP 连接、进程数、OOM、SSH 失败登录、端口存活、TCP 延迟；**面板下发**上报间隔/端口/延迟目标；**断网时写入 30 条环形缓冲，恢复后补发**；Linux 静态链接单文件（仅 OpenSSL，无 libcurl）。`-p` 输出 node_exporter 风格 Prometheus 文本。参数：`-u -s -k -i -t 端口 -L host:port -I(跳过证书校验) -p -V`。

### 发布探针二进制（GitHub Actions）
1. 把整个项目推到你的 GitHub 仓库，并在后台「系统设置」填写仓库地址
2. **仓库 Settings → Actions → General → Workflow permissions 选 “Read and write permissions”**（否则发布步骤 403）
3. 推送 `agent/` 的改动（或打标签 `git tag v2.2.0 && git push --tags`，或在 Actions 页面手动 Run workflow）→ 自动构建 `vpsagent-linux-{amd64,arm64}`、`vpsagent-darwin-{amd64,arm64}` 并发布到 Release（`agent-latest` 滚动版 / 标签版）
4. 仓库需公开（或安装的 VPS 能访问 Release）；私有仓库请改用 Shell 回退探针

### Docker 运行探针
```bash
docker build -t vpsagent agent/
docker run -d --name vpsagent --restart unless-stopped --pid host --network host \
  -e HOST_PROC=/host/proc -e HOST_ROOT=/host/root -v /proc:/host/proc:ro -v /:/host/root:ro \
  -e WORKER_URL=https://你的面板 -e SERVER_ID=ID -e API_KEY=KEY vpsagent
```

### 内嵌探针（放进你自己的程序）
```js
require('./vps-agent').start({ url: 'https://面板', id: 'ID', key: 'KEY' });   // agents/vps-agent.js，Node ≥ 18
```
```python
import vps_agent; vps_agent.start("https://面板", "ID", "KEY")                  # agents/vps_agent.py，纯标准库
```
也可只设环境变量 `VPS_URL / VPS_ID / VPS_KEY` 后无参调用。

## 🔌 外部数据库（Supabase / PostgREST）
Supabase SQL Editor 执行：
```sql
create table if not exists vps_backup (id text primary key, data jsonb not null, updated_at timestamptz default now());
```
后台 → 数据库管理 → 填项目地址、有写权限的 Key（如 service_role）、表名 → 测试连接 / 推送备份 / 拉取并导入（备份不含该密钥）。「云端下载导入」可填任意 https 的备份 JSON 地址。

## 🐳 Docker 运行面板（本地 D1）
```bash
cp docker-compose.yml docker-compose.local.yml   # 修改 JWT_SECRET
docker compose -f docker-compose.local.yml up -d --build    # http://IP:8787 ，数据在 ./data
```
## 🐧 Debian 本地部署
```bash
apt update && apt install -y curl git && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
npm i -g wrangler && cd vps-info-panel
JWT_SECRET=随机串 wrangler dev --ip 0.0.0.0 --port 8787 --persist-to ./data --test-scheduled &
( crontab -l; echo '* * * * * curl -s http://127.0.0.1:8787/cdn-cgi/handler/scheduled >/dev/null' ) | crontab -
```
建议用 systemd 托管并加 Nginx/Caddy HTTPS 反代（探针上报需要 HTTPS 时尤其如此）。

## 🛠️ 故障排查
- **安装命令报 400/404**：v2.2 已修复（v2.1 在未填 GitHub 仓库时返回 400）。确认命令 URL 带引号；`curl -i` 看响应体
- **没有 Release 也能装**：自动回退 Shell 探针；想用 C 探针请先完成上面的 Actions 发布
- **Actions 失败**：看日志第一处红色；最常见是 Workflow permissions 不是 Read and write
- **离线/负载通知不触发**：检查 Cron 是否已添加（每分钟）
- **探针 TLS 校验失败**（极简系统缺 CA 证书）：安装 `ca-certificates`，或临时 `INSECURE=1`

## 🧪 测试与目录
`node tests/smoke.mjs`（54 项：接口、导入导出、探针端到端含断网补发、前端渲染；需 Node ≥ 22.5 与 `gcc -o /tmp/vpsagent agent/vpsagent.c`）· `bash tests/installer-test.sh`（root 与普通用户的安装/重装/卸载，需 root）。
改动 `src/ui.html` / `scripts/install.sh` / `agent/agent.sh` 后运行 `python3 scripts/embed.py` 重新内嵌进 `worker.js`。
目录：`worker.js` · `src/ui.html` · `agent/{vpsagent.c,agent.sh,Dockerfile}` · `agents/` · `scripts/` · `tests/` · `cfmonitor.sh`（旧版 Shell 探针，兼容保留）· `.github/workflows/`

## ⚠️ 已知限制
网站 SSL 证书剩余天数暂未实现（Workers 无法读取证书）；流量上限条按“开机以来累计”估算；C 探针的 TLS 分支与 macOS 构建只能在 GitHub Actions 中验证；未做 gzip 压缩（单次上报约 1.5 KB）。
