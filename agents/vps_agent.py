"""vps_agent.py — 内嵌探针（纯标准库，Python ≥ 3.7）。
用法： import vps_agent; vps_agent.start("https://面板地址", "服务器ID", "API密钥")
或设置环境变量 VPS_URL / VPS_ID / VPS_KEY 后直接 vps_agent.start()。以守护线程运行，不阻塞主程序。"""
import json, os, shutil, threading, time, urllib.request

_prev = {}

def _read(p):
    try:
        with open(p) as f:
            return f.read()
    except OSError:
        return ""

def _cpu():
    s = _read("/proc/stat").split("\n")[0].split()
    if len(s) > 5:
        v = list(map(int, s[1:9])); t, i = sum(v), v[3] + v[4]; p = _prev.get("c"); _prev["c"] = (t, i)
        return round(100 * (1 - (i - p[1]) / (t - p[0])), 1) if p and t > p[0] else 0.0
    return round(min(100.0, os.getloadavg()[0] / (os.cpu_count() or 1) * 100), 1)

def _mem():
    d = {}
    for l in _read("/proc/meminfo").split("\n"):
        k, _, v = l.partition(":")
        if v.strip(): d[k] = int(v.split()[0]) * 1024
    try: t = d.get("MemTotal") or os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError): t = 0
    a = d.get("MemAvailable", 0); u = t - a if a else 0
    return {"total": t, "used": u, "free": t - u, "usage_percent": round(u * 100 / t, 1) if t else 0}

def _net():
    rx = tx = 0
    for l in _read("/proc/net/dev").split("\n")[2:]:
        n, _, r = l.partition(":")
        if r and n.strip() != "lo":
            f = r.split(); rx += int(f[0]); tx += int(f[8])
    return rx, tx

def snapshot():
    now = time.time(); rx, tx = _net(); p = _prev.get("n"); _prev["n"] = (rx, tx, now); up = dn = 0
    if p and now > p[2]: up = max(0, int((tx - p[1]) / (now - p[2]))); dn = max(0, int((rx - p[0]) / (now - p[2])))
    du = shutil.disk_usage("/"); l = os.getloadavg()
    try: boot = int(float(_read("/proc/uptime").split()[0]))
    except (IndexError, ValueError): boot = 0
    return {"timestamp": int(now), "cpu": {"usage_percent": _cpu(), "load_avg": [round(x, 2) for x in l]}, "memory": _mem(),
            "disk": {"total": du.total, "used": du.used, "free": du.free, "usage_percent": round(du.used * 100 / du.total, 1) if du.total else 0},
            "network": {"upload_speed": up, "download_speed": dn, "total_upload": tx, "total_download": rx}, "uptime": boot}

def _loop(url, sid, key, iv):
    snapshot(); time.sleep(2)
    while True:
        try:
            req = urllib.request.Request(url + "/api/report/" + sid, json.dumps(snapshot()).encode(), {"Content-Type": "application/json", "X-API-Key": key})
            with urllib.request.urlopen(req, timeout=15) as r:
                v = json.loads(r.read().decode()).get("interval", iv); iv = v if isinstance(v, int) and v >= 5 else iv
        except Exception as e:
            print("[vps_agent]", e)
        time.sleep(iv)

def start(url=None, server_id=None, api_key=None, interval=60):
    url = (url or os.environ.get("VPS_URL", "")).rstrip("/"); sid = server_id or os.environ.get("VPS_ID"); key = api_key or os.environ.get("VPS_KEY")
    if not (url and sid and key):
        print("[vps_agent] 缺少 url/id/key，已跳过"); return None
    t = threading.Thread(target=_loop, args=(url, sid, key, interval), daemon=True, name="vps-agent"); t.start(); return t
