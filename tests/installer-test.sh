#!/bin/bash
# 安装器联调：本地起面板(node:sqlite) → root 安装 → 幂等重装 → 卸载 → 普通用户安装/卸载。需 root、curl、node≥22.5。
cd "$(dirname "$0")/.."
SEED=1 DL_DIR=/tmp/dl node tests/serve.mjs 8798 > /tmp/serve.log 2>&1 &
SRV=$!
for i in 1 2 3 4 5 6 7 8; do grep -q SEED /tmp/serve.log && break; sleep 1; done
ID=$(awk '/SEED/{print $2}' /tmp/serve.log); KEY=$(awk '/SEED/{print $3}' /tmp/serve.log); U="http://127.0.0.1:8798/install.sh?id=$ID&key=$KEY"
alive() { pgrep -f "[v]psagent$" >/dev/null && echo yes || echo no; }
reported() { curl -s http://127.0.0.1:8798/api/public | python3 -c "import sys,json;s=json.load(sys.stdin)['servers'][0];print('已上报' if s['timestamp'] else '未上报', s['ext'] and s['ext'].get('v'))"; }
echo "== root 安装 =="; curl -fsSL "$U" | timeout 60 sh; sleep 7; reported; stat -c '密钥文件权限 %a' /opt/vpsagent/agent.env; echo "进程存活: $(alive)"
echo "== 重复安装（幂等）=="; curl -fsSL "$U" | timeout 60 sh | tail -1; sleep 1; echo "进程数: $(pgrep -fc '[v]psagent$')"
echo "== 卸载 =="; curl -fsSL "$U" | UNINSTALL=1 timeout 60 sh; sleep 1; [ -d /opt/vpsagent ] && echo "目录仍在" || echo "目录已删除"; echo "进程存活: $(alive)"
echo "== 普通用户安装 =="; id tester >/dev/null 2>&1 || useradd -m tester
su tester -s /bin/sh -c "curl -fsSL '$U' | timeout 60 sh"; sleep 7; reported; echo "进程存活: $(alive)"; su tester -s /bin/sh -c 'echo "自启登记(.profile/.bashrc):"; grep -c vpsagent ~/.profile ~/.bashrc 2>/dev/null; crontab -l 2>/dev/null | grep vpsagent'
su tester -s /bin/sh -c "curl -fsSL '$U' | UNINSTALL=1 timeout 60 sh"; sleep 1; echo "卸载后进程存活: $(alive)"
echo "== C 探针分支（/dl 提供二进制）=="; mkdir -p /tmp/dl && cp "${VPSAGENT_BIN:-/tmp/vpsagent}" /tmp/dl/vpsagent-linux-amd64
curl -fsSL "$U" | timeout 60 sh; sleep 8; reported; echo "进程数: $(pgrep -fc '[v]psagent$')"; curl -fsSL "$U" | UNINSTALL=1 timeout 60 sh; sleep 1; echo "卸载后进程存活: $(alive)"
rm -rf /tmp/dl; kill $SRV 2>/dev/null; echo FINISHED
