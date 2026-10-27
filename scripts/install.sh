#!/bin/sh
# VPS信息面板 探针一键安装 v2.2：自动识别 Linux/macOS 与 amd64/arm64；root / 非 root 均可；卸载：UNINSTALL=1
# 由面板 /install.sh?id=..&key=.. 输出（已自动带上 PANEL_URL / SERVER_ID / API_KEY）。
main() {
set -e
: "${PANEL_URL:?缺少 PANEL_URL}" "${SERVER_ID:?缺少 SERVER_ID}" "${API_KEY:?缺少 API_KEY}"
OS=$(uname -s | tr 'A-Z' 'a-z'); M=$(uname -m)
case "$M" in x86_64|amd64) A=amd64;; aarch64|arm64) A=arm64;; *) A=$M;; esac
if [ "$(id -u)" = 0 ]; then ROOT=1; D=/opt/vpsagent; else ROOT=0; D="$HOME/.local/share/vpsagent"; fi
BIN="$D/vpsagent"; RUN="$D/run.sh"
dl() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"; else echo "需要 curl 或 wget" >&2; return 1; fi; }
stop_all() { if [ -f "$D/pid" ]; then kill "$(cat "$D/pid")" 2>/dev/null || true; fi; pkill -f "$BIN" 2>/dev/null || true; rm -f "$D/pid"; }

if [ "$UNINSTALL" = 1 ]; then
  stop_all
  if [ "$ROOT" = 1 ]; then systemctl disable --now vpsagent 2>/dev/null || true; rm -f /etc/systemd/system/vpsagent.service; launchctl unload /Library/LaunchDaemons/com.vpsinfo.agent.plist 2>/dev/null || true; rm -f /Library/LaunchDaemons/com.vpsinfo.agent.plist; fi
  systemctl --user disable --now vpsagent 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/vpsagent.service"
  launchctl unload "$HOME/Library/LaunchAgents/com.vpsinfo.agent.plist" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/com.vpsinfo.agent.plist"
  (crontab -l 2>/dev/null | grep -v vpsagent | crontab -) 2>/dev/null || true
  rm -rf "$D"; echo "✅ 已卸载"; return 0
fi

mkdir -p "$D"; stop_all
# 1) 预编译 C 探针（面板 /dl/ 会跳转到 GitHub Release）；2) 回退：面板内置的 Shell 探针（仅 Linux）
if dl "$PANEL_URL/dl/vpsagent-$OS-$A" "$BIN.tmp" && chmod +x "$BIN.tmp" && "$BIN.tmp" -V >/dev/null 2>&1; then
  mv -f "$BIN.tmp" "$BIN"; KIND="C 探针"
elif [ "$OS" = linux ] && dl "$PANEL_URL/agent.sh" "$BIN.tmp" && chmod +x "$BIN.tmp"; then
  mv -f "$BIN.tmp" "$BIN"; KIND="Shell 探针（未找到预编译二进制，已回退）"
else
  rm -f "$BIN.tmp"; echo "❌ 当前平台 $OS-$A 没有可用探针：请先在 GitHub 构建 Release，或改用 Linux" >&2; return 1
fi

cat > "$D/agent.env" <<EOF
SERVER_ID=$SERVER_ID
API_KEY=$API_KEY
WORKER_URL=$PANEL_URL
EOF
chmod 600 "$D/agent.env"
cat > "$RUN" <<EOF
#!/bin/sh
if [ -f "$D/pid" ] && kill -0 "\$(cat "$D/pid")" 2>/dev/null; then exit 0; fi
set -a; . "$D/agent.env"; set +a
nohup "$BIN" >"$D/agent.log" 2>&1 &
echo \$! > "$D/pid"
EOF
chmod +x "$RUN"

if [ "$OS" = darwin ]; then
  if [ "$ROOT" = 1 ]; then PL=/Library/LaunchDaemons/com.vpsinfo.agent.plist; else mkdir -p "$HOME/Library/LaunchAgents"; PL="$HOME/Library/LaunchAgents/com.vpsinfo.agent.plist"; fi
  cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.vpsinfo.agent</string><key>ProgramArguments</key><array><string>$BIN</string></array><key>EnvironmentVariables</key><dict><key>SERVER_ID</key><string>$SERVER_ID</string><key>API_KEY</key><string>$API_KEY</string><key>WORKER_URL</key><string>$PANEL_URL</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
  launchctl unload "$PL" 2>/dev/null || true; launchctl load "$PL"; MODE=launchd
elif [ "$ROOT" = 1 ] && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/vpsagent.service <<EOF
[Unit]
Description=VPS Info Panel Agent
After=network-online.target
[Service]
EnvironmentFile=$D/agent.env
ExecStart=$BIN
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload; systemctl enable --now vpsagent; MODE=systemd
elif [ "$ROOT" = 0 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/vpsagent.service" <<EOF
[Unit]
Description=VPS Info Panel Agent
[Service]
EnvironmentFile=$D/agent.env
ExecStart=$BIN
Restart=always
RestartSec=10
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload; systemctl --user enable --now vpsagent
  loginctl enable-linger "$(id -un)" 2>/dev/null || true; MODE=systemd-user
else
  sh "$RUN"
  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v "$RUN"; echo "@reboot $RUN"; echo "* * * * * $RUN") | crontab -; MODE=cron
  else
    for F in "$HOME/.profile" "$HOME/.bashrc"; do grep -q "$RUN" "$F" 2>/dev/null || echo "[ -x $RUN ] && $RUN >/dev/null 2>&1" >> "$F"; done; MODE=profile
  fi
fi
echo "✅ 已安装：$KIND（$OS-$A，自启：$MODE），目录：$D"
}
main "$@"
