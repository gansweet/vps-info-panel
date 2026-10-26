// vps-agent.js — 内嵌探针（Node ≥ 18，零依赖）。
// 用法：const agent = require('./vps-agent'); agent.start({ url, id, key });  （或环境变量 VPS_URL / VPS_ID / VPS_KEY）
const os = require('os'), fs = require('fs');
let prev = null, pn = null, timer = null;
const cpuT = () => { let i = 0, t = 0; for (const c of os.cpus()) { for (const k in c.times) t += c.times[k]; i += c.times.idle; } return { i, t }; };
function net() { try { let rx = 0, tx = 0; for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) { const [n, r] = l.trim().split(':'); if (!r || n === 'lo') continue; const f = r.trim().split(/\s+/); rx += +f[0]; tx += +f[8]; } return { rx, tx }; } catch { return { rx: 0, tx: 0 }; } }
function disk() { try { const s = fs.statfsSync('/'), t = s.blocks * s.bsize, f = s.bfree * s.bsize; return { total: t, used: t - f, free: f, usage_percent: t ? +((t - f) * 100 / t).toFixed(1) : 0 }; } catch { return { total: 0, used: 0, free: 0, usage_percent: 0 }; } }
function snapshot() {
  const c = cpuT(), n = net(), now = Date.now(); let cpu = 0, up = 0, dn = 0;
  if (prev && c.t > prev.t) cpu = +(100 * (1 - (c.i - prev.i) / (c.t - prev.t))).toFixed(1);
  if (pn && now > pn.now) { up = Math.max(0, Math.round((n.tx - pn.tx) * 1000 / (now - pn.now))); dn = Math.max(0, Math.round((n.rx - pn.rx) * 1000 / (now - pn.now))); }
  prev = c; pn = { ...n, now };
  const mt = os.totalmem(), mf = os.freemem(), l = os.loadavg();
  return { timestamp: Math.floor(now / 1000), cpu: { usage_percent: cpu, load_avg: l.map(x => +x.toFixed(2)) }, memory: { total: mt, used: mt - mf, free: mf, usage_percent: +((mt - mf) * 100 / mt).toFixed(1) }, disk: disk(), network: { upload_speed: up, download_speed: dn, total_upload: n.tx, total_download: n.rx }, uptime: Math.floor(os.uptime()) };
}
function start(o = {}) {
  const url = (o.url || process.env.VPS_URL || '').replace(/\/+$/, ''), id = o.id || process.env.VPS_ID, key = o.key || process.env.VPS_KEY;
  if (!url || !id || !key) { console.warn('[vps-agent] 缺少 url/id/key，已跳过'); return; }
  let iv = o.interval || 60; snapshot();
  const tick = async () => {
    try { const r = await fetch(url + '/api/report/' + id, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-Key': key }, body: JSON.stringify(snapshot()), signal: AbortSignal.timeout(15000) }); const j = await r.json().catch(() => ({})); if (j.interval >= 5) iv = j.interval; } catch (e) { console.warn('[vps-agent]', e.message); }
    timer = setTimeout(tick, iv * 1000); timer.unref();
  };
  timer = setTimeout(tick, 2000); timer.unref();   // unref：不阻止主程序退出
}
const stop = () => clearTimeout(timer);
module.exports = { start, stop, snapshot };
