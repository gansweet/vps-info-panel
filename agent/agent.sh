#!/bin/sh
# VPS信息面板 极简 Shell 探针（Linux；依赖 sh + awk + curl/wget）。无需编译，C 探针不可用时自动回退使用。
U="${WORKER_URL%/}"; I="$SERVER_ID"; K="$API_KEY"; IV="${INTERVAL:-60}"
if [ -z "$U" ] || [ -z "$I" ] || [ -z "$K" ]; then echo "缺少 WORKER_URL / SERVER_ID / API_KEY" >&2; exit 2; fi
[ "$1" = "-V" ] && { echo "sh-2.2.0"; exit 0; }
post() {
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 20 -H "X-API-Key: $K" -H "Content-Type: application/json" -d "$1" "$U/api/report/$I"
  else wget -qO- -T 20 --header="X-API-Key: $K" --header="Content-Type: application/json" --post-data="$1" "$U/api/report/$I"; fi
}
cpu() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat; }
net() { awk -F'[: ]+' 'NF>10&&$2!="lo"&&$3~/^[0-9]+$/{r+=$3;t+=$11}END{print r+0,t+0}' /proc/net/dev; }
set -- $(cpu); PT=$1; PI=$2; set -- $(net); PR=$1; PX=$2; PS=$(date +%s); sleep 2
while :; do
  set -- $(cpu); T=$1; ID=$2
  CPU=$(awk -v t="$T" -v pt="$PT" -v i="$ID" -v pi="$PI" 'BEGIN{d=t-pt;printf "%.1f",(d>0?100*(1-(i-pi)/d):0)}'); [ -z "$CPU" ] && CPU=0; PT=$T; PI=$ID
  set -- $(net); R=$1; X=$2; N=$(date +%s); DT=$((N-PS)); [ "$DT" -lt 1 ] && DT=1
  DL=$(( (R-PR)/DT )); UL=$(( (X-PX)/DT )); [ "$DL" -lt 0 ] && DL=0; [ "$UL" -lt 0 ] && UL=0; PR=$R; PX=$X; PS=$N
  set -- $(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}/^SwapTotal/{st=$2}/^SwapFree/{sf=$2}END{print t*1024,(t-a)*1024,st*1024,(st-sf)*1024}' /proc/meminfo); MT=$1; MU=$2; ST=$3; SU=$4
  set -- $(df -Pk / | awk 'NR==2{print $2*1024,$3*1024}'); DTT=$1; DU=$2
  set -- $(cat /proc/loadavg); L1=$1; L5=$2; L15=$3
  UP=$(cut -d. -f1 /proc/uptime)
  JS=$(awk -v ts="$N" -v cpu="$CPU" -v l1="$L1" -v l5="$L5" -v l15="$L15" -v mt="$MT" -v mu="$MU" -v dt="$DTT" -v du="$DU" -v ul="$UL" -v dl="$DL" -v tx="$X" -v rx="$R" -v up="$UP" -v st="$ST" -v su="$SU" 'BEGIN{printf "{\"timestamp\":%.0f,\"cpu\":{\"usage_percent\":%s,\"load_avg\":[%s,%s,%s]},\"memory\":{\"total\":%.0f,\"used\":%.0f,\"free\":%.0f,\"usage_percent\":%.1f},\"disk\":{\"total\":%.0f,\"used\":%.0f,\"free\":%.0f,\"usage_percent\":%.1f},\"network\":{\"upload_speed\":%.0f,\"download_speed\":%.0f,\"total_upload\":%.0f,\"total_download\":%.0f},\"uptime\":%.0f,\"ext\":{\"v\":\"sh-2.2.0\",\"swap\":{\"total\":%.0f,\"used\":%.0f}}}",ts,cpu,l1,l5,l15,mt,mu,mt-mu,(mt?100*mu/mt:0),dt,du,dt-du,(dt?100*du/dt:0),ul,dl,tx,rx,up,st,su}')
  RESP=$(post "$JS" 2>/dev/null) && { V=$(printf '%s' "$RESP" | sed -n 's/.*"interval":\([0-9]*\).*/\1/p'); [ -n "$V" ] && [ "$V" -ge 5 ] && IV=$V; } || echo "上报失败" >&2
  [ -n "$ONCE" ] && exit 0
  sleep "$IV"
done
