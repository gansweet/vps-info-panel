// VPS信息面板 v2.0 — Cloudflare Workers + D1 单文件版（兼容原 cfmonitor.sh 探针协议）
const VERSION = '2.1.0';
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' } });
const now = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const rid = n => b64u(crypto.getRandomValues(new Uint8Array(n))).replace(/[-_]/g, 'x');
const hk = k => crypto.subtle.importKey('raw', enc.encode(k), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const sec = env => env.JWT_SECRET || 'change-me-please';
async function sign(env, p) { const h = b64u(enc.encode('{"alg":"HS256"}')), b = b64u(enc.encode(JSON.stringify(p))); return h + '.' + b + '.' + b64u(await crypto.subtle.sign('HMAC', await hk(sec(env)), enc.encode(h + '.' + b))); }
async function verify(env, t) { try { const [a, b, c] = t.split('.'); if (!await crypto.subtle.verify('HMAC', await hk(sec(env)), ub64(c), enc.encode(a + '.' + b))) return null; const p = JSON.parse(new TextDecoder().decode(ub64(b))); return p.exp > now() ? p : null; } catch { return null; } }
async function pbk(pw, salt) { const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']); return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, k, 256)); }

// ---------- D1 ----------
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS admin(username TEXT PRIMARY KEY,hash TEXT,salt TEXT)',
  'CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,api_key TEXT NOT NULL UNIQUE,created_at INTEGER,sort_order INTEGER DEFAULT 0,is_public INTEGER DEFAULT 1,notify INTEGER DEFAULT 1,expire_at INTEGER,down_notified INTEGER DEFAULT 0,load_notified INTEGER DEFAULT 0,exp_notified INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS metrics(server_id TEXT PRIMARY KEY,timestamp INTEGER,cpu TEXT,memory TEXT,disk TEXT,network TEXT,uptime INTEGER)',
  'CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY,url TEXT NOT NULL UNIQUE,name TEXT,added_at INTEGER,last_checked INTEGER,last_status TEXT DEFAULT \'PENDING\',last_code INTEGER,last_ms INTEGER,is_public INTEGER DEFAULT 1,down_notified INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS site_history(id INTEGER PRIMARY KEY AUTOINCREMENT,site_id TEXT,ts INTEGER,status TEXT,code INTEGER,ms INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_sh ON site_history(site_id,ts DESC)',
  'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT)',
  'CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER,level TEXT,type TEXT,message TEXT)'
];
const COLS = {
  servers: 'id,name,description,api_key,created_at,sort_order,is_public,notify,expire_at',
  metrics: 'server_id,timestamp,cpu,memory,disk,network,uptime',
  sites: 'id,url,name,added_at,last_checked,last_status,last_code,last_ms,is_public',
  site_history: 'site_id,ts,status,code,ms', settings: 'key,value', logs: 'ts,level,type,message'
};
const DEF = { title: 'VPS信息面板', github_url: '', theme: 'ocean', report_interval: '60', site_interval: '300', n_offline: '1', n_load: '1', n_expire: '1', load_th: '90' };
let ready = false;
async function ensure(env) {
  if (ready) return; ready = true;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  for (const [k, v] of Object.entries(DEF)) await env.DB.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').bind(k, v).run();
  if (!await env.DB.prepare('SELECT 1 FROM admin').first()) {
    const salt = rid(12), pw = env.ADMIN_PASSWORD || 'monitor2025!';
    await env.DB.prepare('INSERT INTO admin VALUES(?,?,?)').bind('admin', await pbk(pw, salt), salt).run();
  }
}
async function cfg(env) { const { results } = await env.DB.prepare('SELECT key,value FROM settings').all(); const o = {}; for (const r of results) o[r.key] = r.value; return o; }
const log = (env, level, type, msg) => env.DB.prepare('INSERT INTO logs(ts,level,type,message) VALUES(?,?,?,?)').bind(now(), level, type, msg).run().catch(() => { });

// ---------- 通知 ----------
async function notify(env, c, kind, text) {
  if (c['n_' + kind] === '0') return;
  const jobs = [];
  if (c.tg_token && c.tg_chat) jobs.push(fetch('https://api.telegram.org/bot' + c.tg_token + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: c.tg_chat, text }) }));
  if (c.webhook) jobs.push(fetch(c.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, kind, title: c.title, ts: now() }) }));
  if (c.rk && c.rto) jobs.push(fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.rk }, body: JSON.stringify({ from: c.rfrom || 'onboarding@resend.dev', to: [c.rto], subject: c.title + ' 通知', text }) }));
  const r = await Promise.allSettled(jobs);
  await log(env, r.some(x => x.status === 'rejected') ? 'warn' : 'info', 'notify', text);
}

// ---------- 定时任务：离线/负载/到期 + 网站检测 ----------
async function cron(env) {
  await ensure(env); const c = await cfg(env), t = now(), iv = +c.report_interval || 60;
  const { results: sv } = await env.DB.prepare('SELECT s.*,m.timestamp ts,m.cpu FROM servers s LEFT JOIN metrics m ON m.server_id=s.id').all();
  for (const s of sv) {
    if (!s.notify) continue;
    const off = !s.ts || t - s.ts > iv * 3 + 60;
    if (off && !s.down_notified && s.ts) { await env.DB.prepare('UPDATE servers SET down_notified=1 WHERE id=?').bind(s.id).run(); await notify(env, c, 'offline', '🔴 服务器离线：' + s.name); }
    if (!off && s.down_notified) { await env.DB.prepare('UPDATE servers SET down_notified=0 WHERE id=?').bind(s.id).run(); await notify(env, c, 'offline', '✅ 服务器恢复：' + s.name); }
    let cpu = 0; try { cpu = JSON.parse(s.cpu).usage_percent || 0; } catch { }
    const hi = !off && cpu >= (+c.load_th || 90);
    if (hi !== !!s.load_notified) { await env.DB.prepare('UPDATE servers SET load_notified=? WHERE id=?').bind(hi ? 1 : 0, s.id).run(); if (hi) await notify(env, c, 'load', '🔥 高负载：' + s.name + ' CPU ' + cpu + '%'); }
    if (s.expire_at && s.expire_at - t < 7 * 86400 && t - s.exp_notified > 86400) { await env.DB.prepare('UPDATE servers SET exp_notified=? WHERE id=?').bind(t, s.id).run(); await notify(env, c, 'expire', '⏰ 即将到期：' + s.name + '（' + new Date(s.expire_at * 1000).toISOString().slice(0, 10) + '）'); }
  }
  const { results: st } = await env.DB.prepare('SELECT * FROM sites WHERE last_checked IS NULL OR last_checked<?').bind(t - (+c.site_interval || 300)).all();
  await Promise.all(st.map(async s => {
    const t0 = Date.now(); let code = 0, ok = false;
    try { const r = await fetch(s.url, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'VPS-Info-Panel/' + VERSION } }); code = r.status; ok = code < 400; } catch { }
    const ms = Date.now() - t0, status = ok ? 'UP' : 'DOWN';
    await env.DB.batch([
      env.DB.prepare('UPDATE sites SET last_checked=?,last_status=?,last_code=?,last_ms=? WHERE id=?').bind(t, status, code, ms, s.id),
      env.DB.prepare('INSERT INTO site_history(site_id,ts,status,code,ms) VALUES(?,?,?,?,?)').bind(s.id, t, status, code, ms)]);
    if (!ok && !s.down_notified) { await env.DB.prepare('UPDATE sites SET down_notified=1 WHERE id=?').bind(s.id).run(); await notify(env, c, 'offline', '🔴 网站不可用：' + (s.name || s.url)); }
    if (ok && s.down_notified) { await env.DB.prepare('UPDATE sites SET down_notified=0 WHERE id=?').bind(s.id).run(); await notify(env, c, 'offline', '✅ 网站恢复：' + (s.name || s.url)); }
  }));
  if (t % 3600 < 60) await env.DB.batch([env.DB.prepare('DELETE FROM site_history WHERE ts<?').bind(t - 30 * 86400), env.DB.prepare('DELETE FROM logs WHERE ts<?').bind(t - 30 * 86400)]);
}

// ---------- API ----------
const num = x => (typeof x === 'string' ? parseFloat(x) : x) || 0;
const fix = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(num) : num(v)]));
const pj = s => { try { return JSON.parse(s); } catch { return null; } };
async function listServers(env, admin) {
  const { results } = await env.DB.prepare('SELECT s.id,s.name,s.description,s.is_public,s.notify,s.expire_at,s.sort_order' + (admin ? ',s.api_key' : '') + ',m.timestamp,m.cpu,m.memory,m.disk,m.network,m.uptime FROM servers s LEFT JOIN metrics m ON m.server_id=s.id WHERE s.is_public=1 OR ?=1 ORDER BY s.sort_order,s.name').bind(admin ? 1 : 0).all();
  return results.map(r => ({ ...r, cpu: pj(r.cpu), memory: pj(r.memory), disk: pj(r.disk), network: pj(r.network) }));
}
async function listSites(env, admin) {
  const { results } = await env.DB.prepare('SELECT id,url,name,last_checked,last_status,last_code,last_ms,is_public FROM sites WHERE is_public=1 OR ?=1 ORDER BY name,url').bind(admin ? 1 : 0).all();
  for (const s of results) { const h = await env.DB.prepare('SELECT status,ms,ts FROM site_history WHERE site_id=? ORDER BY ts DESC LIMIT 40').bind(s.id).all(); s.history = h.results.reverse(); }
  return results;
}
function promText(sv, st) {
  const t = now(), o = [];
  const g = (n, h, rows) => { o.push('# HELP ' + n + ' ' + h, '# TYPE ' + n + ' gauge'); rows.forEach(([l, v]) => o.push(n + '{' + l + '} ' + (+v || 0))); };
  const lb = s => 'id="' + s.id + '",name="' + String(s.name).replace(/["\\\n]/g, '_') + '"';
  g('vps_up', '1 if the agent reported recently', sv.map(s => [lb(s), s.timestamp && t - s.timestamp < 240 ? 1 : 0]));
  g('vps_cpu_usage_percent', 'CPU usage', sv.map(s => [lb(s), s.cpu?.usage_percent]));
  g('vps_load1', 'Load average 1m', sv.map(s => [lb(s), s.cpu?.load_avg?.[0]]));
  for (const k of ['memory', 'disk']) { g('vps_' + k + '_used_bytes', k + ' used', sv.map(s => [lb(s), s[k]?.used])); g('vps_' + k + '_total_bytes', k + ' total', sv.map(s => [lb(s), s[k]?.total])); }
  g('vps_network_upload_bytes_per_second', 'Upload speed', sv.map(s => [lb(s), s.network?.upload_speed]));
  g('vps_network_download_bytes_per_second', 'Download speed', sv.map(s => [lb(s), s.network?.download_speed]));
  g('vps_network_transmit_bytes_total', 'Total upload', sv.map(s => [lb(s), s.network?.total_upload]));
  g('vps_network_receive_bytes_total', 'Total download', sv.map(s => [lb(s), s.network?.total_download]));
  g('vps_uptime_seconds', 'Uptime', sv.map(s => [lb(s), s.uptime]));
  g('site_up', '1 if website is up', st.map(s => ['name="' + String(s.name || s.url).replace(/["\\\n]/g, '_') + '"', s.last_status === 'UP' ? 1 : 0]));
  g('site_response_ms', 'Website response time', st.map(s => ['name="' + String(s.name || s.url).replace(/["\\\n]/g, '_') + '"', s.last_ms]));
  return o.join('\n') + '\n';
}
async function dump(env) {
  const o = { app: 'vps-info-panel', version: VERSION, exported_at: now(), tables: {} };
  for (const k of Object.keys(COLS)) o.tables[k] = (await env.DB.prepare('SELECT ' + (k === 'metrics' || k === 'settings' ? COLS[k] : '*') + ' FROM ' + k).all()).results;
  o.tables.settings = o.tables.settings.filter(r => r.key !== 'ext_key'); return o;
}
async function doImport(env, T, mode) {
  if (T.monitored_sites) T.sites = (T.sites || []).concat(T.monitored_sites.map(r => ({ ...r, last_code: r.last_status_code, last_ms: r.last_response_time_ms }))); // 兼容旧版
  const tg = T.telegram_config && T.telegram_config[0]; if (tg && tg.bot_token) T.settings = (T.settings || []).concat([{ key: 'tg_token', value: tg.bot_token }, { key: 'tg_chat', value: tg.chat_id || '' }]);
  let n = 0;
  for (const [tb, rows] of Object.entries(T)) {
    if (!COLS[tb] || !Array.isArray(rows)) continue; const cols = COLS[tb].split(',');
    for (const r of rows) { const use = cols.filter(k => k in r); if (!use.length) continue; await env.DB.prepare('INSERT OR ' + mode + ' INTO ' + tb + '(' + use.join(',') + ') VALUES(' + use.map(() => '?').join(',') + ')').bind(...use.map(k => r[k] ?? null)).run(); n++; }
  }
  return n;
}
async function api(req, env, ctx, url) {
  const p = url.pathname, m = req.method, c = await cfg(env);
  // 探针接口（X-API-Key）
  let mm = p.match(/^\/api\/(config|report)\/([\w-]+)$/);
  if (mm) {
    const s = await env.DB.prepare('SELECT id,name,description,api_key FROM servers WHERE id=?').bind(mm[2]).first();
    if (!s || s.api_key !== req.headers.get('X-API-Key')) return J({ success: false, error: 'Invalid credentials' }, 401);
    const iv = +c.report_interval || 60;
    if (mm[1] === 'config' && m === 'GET') return J({ success: true, config: { report_interval: iv, enabled_metrics: ['cpu', 'memory', 'disk', 'network', 'uptime'], server_info: { id: s.id, name: s.name, description: s.description || '' } }, timestamp: now() });
    if (mm[1] === 'report' && m === 'POST') {
      const d = await req.json().catch(() => null);
      if (!d || !d.cpu || !d.memory || !d.disk || !d.network) return J({ success: false, error: 'Invalid data format' }, 400);
      await env.DB.prepare('INSERT OR REPLACE INTO metrics VALUES(?,?,?,?,?,?,?)').bind(s.id, now(), JSON.stringify(fix(d.cpu)), JSON.stringify(fix(d.memory)), JSON.stringify(fix(d.disk)), JSON.stringify(fix(d.network)), parseInt(d.uptime) || 0).run();
      return J({ success: true, interval: iv, data: { interval: iv } });
    }
  }
  if (p === '/api/public' && m === 'GET') {
    const adm = !!await who(req, env);
    return J({ settings: { title: c.title, github_url: c.github_url, theme: c.theme, report_interval: c.report_interval }, servers: await listServers(env, false), sites: await listSites(env, false), admin: adm, version: VERSION });
  }
  if (p === '/api/auth/login' && m === 'POST') {
    const b = await req.json().catch(() => ({})), a = await env.DB.prepare('SELECT * FROM admin WHERE username=?').bind(b.username || '').first();
    if (!a || await pbk(b.password || '', a.salt) !== a.hash) { await log(env, 'warn', 'auth', '登录失败：' + (b.username || '')); return J({ error: '用户名或密码错误' }, 401); }
    await log(env, 'info', 'auth', '管理员登录：' + a.username);
    return J({ token: await sign(env, { sub: a.username, exp: now() + 86400 }) });
  }
  // ---- 以下需要管理员 ----
  if (!p.startsWith('/api/admin/')) return J({ error: 'Not found' }, 404);
  const u = await who(req, env); if (!u) return J({ error: 'Unauthorized' }, 401);
  const body = ['POST', 'PUT'].includes(m) && !p.includes('/db/import') ? await req.json().catch(() => ({})) : {};
  if (p === '/api/admin/servers') {
    if (m === 'GET') return J({ servers: await listServers(env, true) });
    if (m === 'POST') { if (!body.name) return J({ error: '名称必填' }, 400); const id = rid(8), key = rid(24); await env.DB.prepare('INSERT INTO servers(id,name,description,api_key,created_at,is_public,notify,expire_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, body.name, body.description || '', key, now(), body.is_public === 0 ? 0 : 1, body.notify === 0 ? 0 : 1, body.expire_at || null).run(); await log(env, 'info', 'server', '添加服务器：' + body.name); return J({ id, api_key: key }); }
  }
  if ((mm = p.match(/^\/api\/admin\/servers\/([\w-]+)$/))) {
    if (m === 'PUT') { const k = ['name', 'description', 'is_public', 'notify', 'expire_at', 'sort_order'].filter(k => k in body); if (k.length) await env.DB.prepare('UPDATE servers SET ' + k.map(x => x + '=?').join(',') + ' WHERE id=?').bind(...k.map(x => body[x]), mm[1]).run(); return J({ ok: 1 }); }
    if (m === 'DELETE') { await env.DB.batch([env.DB.prepare('DELETE FROM metrics WHERE server_id=?').bind(mm[1]), env.DB.prepare('DELETE FROM servers WHERE id=?').bind(mm[1])]); await log(env, 'info', 'server', '删除服务器：' + mm[1]); return J({ ok: 1 }); }
  }
  if (p === '/api/admin/sites') {
    if (m === 'GET') return J({ sites: await listSites(env, true) });
    if (m === 'POST') { if (!/^https?:\/\//.test(body.url || '')) return J({ error: '请输入以 http(s):// 开头的网址' }, 400); await env.DB.prepare('INSERT OR IGNORE INTO sites(id,url,name,added_at,is_public) VALUES(?,?,?,?,?)').bind(rid(8), body.url, body.name || '', now(), body.is_public === 0 ? 0 : 1).run(); await log(env, 'info', 'site', '添加网站：' + body.url); return J({ ok: 1 }); }
  }
  if ((mm = p.match(/^\/api\/admin\/sites\/([\w-]+)$/))) {
    if (m === 'DELETE') { await env.DB.batch([env.DB.prepare('DELETE FROM site_history WHERE site_id=?').bind(mm[1]), env.DB.prepare('DELETE FROM sites WHERE id=?').bind(mm[1])]); return J({ ok: 1 }); }
    if (m === 'PUT') { await env.DB.prepare('UPDATE sites SET name=?,is_public=? WHERE id=?').bind(body.name || '', body.is_public ? 1 : 0, mm[1]).run(); return J({ ok: 1 }); }
  }
  if (p === '/api/admin/settings') {
    if (m === 'GET') return J({ settings: c });
    if (m === 'PUT') { for (const [k, v] of Object.entries(body)) if (/^\w{1,32}$/.test(k)) await env.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(k, String(v)).run(); await log(env, 'info', 'settings', '更新设置：' + Object.keys(body).join(',')); return J({ ok: 1 }); }
  }
  if (p === '/api/admin/notify/test' && m === 'POST') { const c2 = await cfg(env); await notify(env, { ...c2, n_offline: '1' }, 'offline', '🔔 ' + c2.title + ' 测试通知'); return J({ ok: 1 }); }
  if (p === '/api/admin/logs' && m === 'GET') return J({ logs: (await env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all()).results });
  if (p === '/api/admin/password' && m === 'POST') {
    const a = await env.DB.prepare('SELECT * FROM admin WHERE username=?').bind(u.sub).first();
    if (await pbk(body.old || '', a.salt) !== a.hash) return J({ error: '原密码错误' }, 400);
    if ((body.new || '').length < 8) return J({ error: '新密码至少 8 位' }, 400);
    const salt = rid(12); await env.DB.prepare('UPDATE admin SET hash=?,salt=? WHERE username=?').bind(await pbk(body.new, salt), salt, u.sub).run(); await log(env, 'info', 'auth', '修改密码'); return J({ ok: 1 });
  }
  if (p === '/api/admin/db/status' && m === 'GET') { const t = {}; for (const k of Object.keys(COLS)) t[k] = (await env.DB.prepare('SELECT COUNT(*) n FROM ' + k).first()).n; return J({ engine: 'Cloudflare D1 (SQLite)', tables: t, version: VERSION }); }
  if (p === '/api/admin/db/export' && m === 'GET') return new Response(JSON.stringify(await dump(env)), { headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="vps-info-' + now() + '.json"' } });
  if (p === '/api/admin/db/import' && m === 'POST') {
    const d = await req.json().catch(() => null); if (!d || !d.tables) return J({ error: '文件格式不正确' }, 400);
    const md = url.searchParams.get('mode') === 'overwrite' ? 'REPLACE' : 'IGNORE', n = await doImport(env, d.tables, md);
    await log(env, 'info', 'db', '导入数据 ' + n + ' 条（' + (md === 'REPLACE' ? '覆盖' : '跳过') + '重复）'); return J({ imported: n });
  }
  if (p === '/api/admin/db/remote' && m === 'POST') {   // 云端下载地址 → 导入 D1
    if (!/^https:\/\//.test(body.url || '')) return J({ error: '仅支持 https 下载地址' }, 400);
    try {
      const r = await fetch(body.url, { signal: AbortSignal.timeout(20000) }); if (!r.ok) return J({ error: 'HTTP ' + r.status }, 400);
      const d = await r.json().catch(() => null); if (!d || !d.tables) return J({ error: '文件格式不正确' }, 400);
      const n = await doImport(env, d.tables, body.mode === 'overwrite' ? 'REPLACE' : 'IGNORE'); await log(env, 'info', 'db', '云端导入 ' + n + ' 条'); return J({ imported: n });
    } catch (x) { return J({ error: String(x.message || x) }, 500); }
  }
  if (p.startsWith('/api/admin/db/ext/') && m === 'POST') {   // 外部数据库：Supabase / 任意 PostgREST
    const c2 = await cfg(env), base = (c2.ext_url || '').replace(/\/+$/, ''), op = p.split('/').pop();
    if (!base || !c2.ext_key) return J({ error: '请先填写并保存外部数据库地址与密钥' }, 400);
    const h = { apikey: c2.ext_key, authorization: 'Bearer ' + c2.ext_key, 'content-type': 'application/json' }, R = base + '/rest/v1/' + encodeURIComponent(c2.ext_table || 'vps_backup'), bad = async r => J({ error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) }, 400);
    try {
      if (op === 'test') { const r = await fetch(R + '?select=id&limit=1', { headers: h }); return r.ok ? J({ ok: 1 }) : bad(r); }
      if (op === 'push') { const r = await fetch(R + '?on_conflict=id', { method: 'POST', headers: { ...h, prefer: 'resolution=merge-duplicates' }, body: JSON.stringify([{ id: 'vps-info-panel', data: await dump(env), updated_at: new Date().toISOString() }]) }); if (!r.ok) return bad(r); await log(env, 'info', 'db', '已推送备份到外部数据库'); return J({ ok: 1 }); }
      if (op === 'pull') { const r = await fetch(R + '?id=eq.vps-info-panel&select=data', { headers: h }); if (!r.ok) return bad(r); const j = await r.json(); if (!j[0] || !j[0].data || !j[0].data.tables) return J({ error: '远端没有备份' }, 400); const n = await doImport(env, j[0].data.tables, url.searchParams.get('mode') === 'overwrite' ? 'REPLACE' : 'IGNORE'); await log(env, 'info', 'db', '从外部数据库导入 ' + n + ' 条'); return J({ imported: n }); }
    } catch (x) { return J({ error: String(x.message || x) }, 500); }
  }
  return J({ error: 'Not found' }, 404);
}
async function who(req, env) { const h = req.headers.get('authorization') || ''; return h.startsWith('Bearer ') ? verify(env, h.slice(7)) : null; }

// ---------- 入口 ----------
export default {
  async fetch(req, env, ctx) {
    try {
      await ensure(env); const url = new URL(req.url), p = url.pathname;
      if (p.startsWith('/api/')) return await api(req, env, ctx, url);
      if (p === '/metrics') { if (env.METRICS_TOKEN && url.searchParams.get('token') !== env.METRICS_TOKEN && req.headers.get('authorization') !== 'Bearer ' + env.METRICS_TOKEN) return new Response('unauthorized', { status: 401 }); const adm = !!env.METRICS_TOKEN; return new Response(promText(await listServers(env, adm), await listSites(env, adm)), { headers: { 'content-type': 'text/plain; version=0.0.4' } }); }
      if (p === '/install.sh') {
        const id = url.searchParams.get('id') || '', key = url.searchParams.get('key') || '', c = await cfg(env), repo = ((c.github_url.match(/github\.com\/([\w.-]+\/[\w.-]+)/) || [])[1] || '').replace(/\.git$/, '');
        if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(key) || !repo) return new Response('echo "请先在后台【系统设置】填写 GitHub 仓库地址，并检查 id/key"; exit 1\n', { status: 400 });
        return new Response('#!/bin/sh\nexport PANEL_URL=' + url.origin + ' SERVER_ID=' + id + ' API_KEY=' + key + ' REPO=' + repo + '\ncurl -fsSL https://raw.githubusercontent.com/' + repo + '/main/scripts/install.sh | sh\n', { headers: { 'content-type': 'text/x-shellscript' } });
      }
      if (p === '/favicon.svg') return new Response(LOGO, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public,max-age=86400' } });
      return new Response(HTML, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    } catch (e) { return J({ error: String(e && e.message || e) }, 500); }
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(cron(env)); }
};

// ---------- 前端 ----------
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M14 48 L32 14 L50 48" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 38 C22 54 42 54 56 34" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="3.5" stroke-linecap="round"><animate attributeName="stroke-dasharray" values="0 90;90 0" dur="2.4s" repeatCount="indefinite"/></path><circle cx="32" cy="14" r="3.5" fill="#fff"/></svg>';
const HTML = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VPS信息面板</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>
:root{--r:16px}
[data-theme=ocean][data-m=light]{--bg:linear-gradient(135deg,#e0f2fe,#f5fbff);--card:#ffffffd9;--tx:#0b2540;--mut:#5f7d99;--a:#1e88e5;--b:#06b6d4;--bd:#cfe3f5}
[data-theme=ocean][data-m=dark]{--bg:linear-gradient(135deg,#041424,#0a2e4d);--card:#0f2c47d9;--tx:#e6f3ff;--mut:#8fb2d0;--a:#4fc3f7;--b:#22d3ee;--bd:#1b4468}
[data-theme=star][data-m=light]{--bg:linear-gradient(135deg,#ede9fe,#faf7ff);--card:#ffffffd9;--tx:#241b4b;--mut:#7a6fa8;--a:#7c3aed;--b:#ec4899;--bd:#ddd3f7}
[data-theme=star][data-m=dark]{--bg:radial-gradient(circle at 20% 10%,#2a1a5e,#0a0620 60%);--card:#1a1240d9;--tx:#efeaff;--mut:#a89bd6;--a:#a78bfa;--b:#f472b6;--bd:#33266b}
[data-theme=forest][data-m=light]{--bg:linear-gradient(135deg,#dcfce7,#f6fff8);--card:#ffffffd9;--tx:#12301f;--mut:#5b8068;--a:#16a34a;--b:#84cc16;--bd:#c7e8d0}
[data-theme=forest][data-m=dark]{--bg:linear-gradient(135deg,#06150d,#0f2e1c);--card:#10301fd9;--tx:#e6fbe9;--mut:#8dbf9a;--a:#4ade80;--b:#a3e635;--bd:#1c4a2e}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);background-attachment:fixed;color:var(--tx);font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--a)}header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:14px 22px;position:sticky;top:0;backdrop-filter:blur(12px);background:var(--card);border-bottom:1px solid var(--bd);z-index:5}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px}.logo img{width:34px;height:34px}.sp{flex:1}
button,select,input,textarea{font:inherit;color:var(--tx);background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:7px 12px}button{cursor:pointer}button:hover{border-color:var(--a)}
button.on,button.pri{background:linear-gradient(90deg,var(--a),var(--b));color:#fff;border-color:transparent}button.dng{color:#e53935}
main{max-width:1280px;margin:0 auto;padding:20px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card,.box{background:var(--card);border:1px solid var(--bd);border-radius:var(--r);padding:16px;box-shadow:0 6px 24px #0000000d}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.stat b{display:block;font-size:24px}.stat span,.mut{color:var(--mut);font-size:12px}.rings{display:flex;justify-content:space-around;margin:12px 0}
.ring{width:72px;height:72px;border-radius:50%;display:grid;place-items:center;font-weight:700;position:relative}.ring:after{content:"";position:absolute;inset:7px;background:var(--card);border-radius:50%;z-index:0}.ring i{position:relative;z-index:1;font-style:normal;font-size:13px}
.ringl{text-align:center;font-size:12px;color:var(--mut)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#9e9e9e}.up{background:#22c55e;box-shadow:0 0 8px #22c55e}.dn{background:#ef4444}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--bd);white-space:nowrap}th{color:var(--mut);font-weight:500}.sc{overflow-x:auto}
.bar{height:6px;background:var(--bd);border-radius:6px;min-width:70px;overflow:hidden}.bar i{display:block;height:100%}.hist{display:flex;gap:2px;height:22px;align-items:flex-end}.hist i{flex:1;min-width:3px;border-radius:2px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;align-items:center}label{display:block;margin:10px 0 4px;color:var(--mut)}input[type=text],input[type=password],input[type=url],input[type=date],input[type=number],textarea{width:100%}
footer{text-align:center;color:var(--mut);padding:26px 0}code{background:var(--bd);padding:2px 6px;border-radius:6px;word-break:break-all}.tag{font-size:11px;padding:1px 8px;border-radius:20px;background:var(--bd)}
</style></head><body><div id="app"></div><script>
var T=localStorage.tk||'',LY=localStorage.ly||'card',P=null,S={};
function e(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fb(n){n=+n||0;var u=['B','KB','MB','GB','TB'],i=0;while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+u[i]}
function up(s){s=+s||0;var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'天'+h+'时':h?h+'时'+m+'分':m+'分'}
function on(s){return s.timestamp&&Date.now()/1000-s.timestamp<(+P.settings.report_interval||60)*3+30}
function col(p){return p>85?'#ef4444':p>65?'#f59e0b':'var(--a)'}
function bar(p){p=Math.min(100,+p||0);return '<div class="bar"><i style="width:'+p+'%;background:'+col(p)+'"></i></div>'}
function ring(p,l){p=Math.min(100,+p||0);return '<div><div class="ring" style="background:conic-gradient('+col(p)+' '+p*3.6+'deg,var(--bd) 0)"><i>'+p.toFixed(0)+'%</i></div><div class="ringl">'+l+'</div></div>'}
async function api(u,o){o=o||{};o.headers=Object.assign({'content-type':'application/json'},T?{authorization:'Bearer '+T}:{});if(o.body&&typeof o.body!='string')o.body=JSON.stringify(o.body);var r=await fetch(u,o),j=await r.json().catch(function(){return{}});if(r.status==401&&u.indexOf('/admin')>-1){T='';localStorage.tk='';location.hash='#login'}return j}
function mode(){var m=localStorage.md||'auto';return m=='auto'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):m}
function skin(){var h=document.documentElement;h.dataset.theme=localStorage.th||(P&&P.settings.theme)||'ocean';h.dataset.m=mode()}
function ver(){var t=document.title;document.title=(P&&P.settings.title)||'VPS信息面板'}
async function load(){P=await api('/api/public');skin();ver();route()}
function head(){var gh=P.settings.github_url;return '<header><a class="logo" href="#servers" style="text-decoration:none;color:inherit"><img src="/favicon.svg" alt="Amos">'+e(P.settings.title)+'</a><button class="'+(V()=='servers'?'on':'')+'" onclick="location.hash=\'#servers\'">🖥️ 服务器信息</button><button class="'+(V()=='sites'?'on':'')+'" onclick="location.hash=\'#sites\'">🌐 网站在线信息</button><span class="sp"></span><select onchange="localStorage.th=this.value;skin()" title="主题"><option value="ocean">🌊 海洋蓝</option><option value="star">🌌 星空</option><option value="forest">🌿 山野绿</option></select><select onchange="localStorage.md=this.value;skin()" title="模式"><option value="auto">🖥️ 跟随系统</option><option value="light">☀️ 浅色</option><option value="dark">🌙 深色</option></select>'+(gh?'<a href="'+e(gh)+'" target="_blank" rel="noopener" title="GitHub"><button>🐱</button></a>':'')+'<button title="后台设置" onclick="location.hash=\'#admin/servers\'">⚙️</button></header>'}
function V(){return (location.hash.slice(1)||'servers').split('/')[0]}
function foot(){return '<footer>'+e(P.settings.title)+' © '+new Date().getFullYear()+' · v'+P.version+'</footer>'}
function fix(){var s=document.querySelectorAll('header select');if(s[0])s[0].value=document.documentElement.dataset.theme;if(s[1])s[1].value=localStorage.md||'auto'}
function serversView(){
  var sv=P.servers,o=sv.filter(on).length,cpu=0,mu=0,mt=0,us=0,ds=0,tu=0,td=0;
  sv.forEach(function(s){if(on(s)){cpu+=s.cpu?s.cpu.usage_percent:0;us+=s.network?s.network.upload_speed:0;ds+=s.network?s.network.download_speed:0}mu+=s.memory?s.memory.used:0;mt+=s.memory?s.memory.total:0;tu+=s.network?s.network.total_upload:0;td+=s.network?s.network.total_download:0});
  var h='<div class="stats"><div class="card stat"><span>服务器总数</span><b>'+sv.length+'</b></div><div class="card stat"><span>🟢 在线 / 🔴 离线</span><b>'+o+' / '+(sv.length-o)+'</b></div><div class="card stat"><span>平均 CPU</span><b>'+(o?(cpu/o).toFixed(1):0)+'%</b></div><div class="card stat"><span>内存 '+fb(mu)+' / '+fb(mt)+'</span><b>'+(mt?(mu*100/mt).toFixed(0):0)+'%</b></div><div class="card stat"><span>实时 ↑ / ↓</span><b style="font-size:16px">'+fb(us)+'/s · '+fb(ds)+'/s</b></div><div class="card stat"><span>总流量 ↑ / ↓</span><b style="font-size:16px">'+fb(tu)+' · '+fb(td)+'</b></div></div>';
  h+='<div class="row"><button class="'+(LY=='card'?'on':'')+'" onclick="LY=\'card\';localStorage.ly=LY;route()">▦ 卡片</button><button class="'+(LY=='list'?'on':'')+'" onclick="LY=\'list\';localStorage.ly=LY;route()">☰ 列表</button></div>';
  if(!sv.length)return h+'<div class="box">暂无服务器，请前往 ⚙️ 后台添加。</div>';
  if(LY=='card')return h+'<div class="grid">'+sv.map(function(s){var a=on(s),c=s.cpu||{},m=s.memory||{},d=s.disk||{},n=s.network||{};return '<div class="card"><div class="row"><span class="dot '+(a?'up':'dn')+'"></span><b>'+e(s.name)+'</b><span class="sp"></span><span class="tag">'+(a?'在线':'离线')+'</span></div><div class="mut">'+e(s.description)+(a?' · 运行 '+up(s.uptime):'')+'</div><div class="rings">'+ring(a?c.usage_percent:0,'CPU')+ring(a?m.usage_percent:0,'内存')+ring(a?d.usage_percent:0,'磁盘')+'</div><div class="mut">负载 '+(c.load_avg||[0,0,0]).join(' / ')+'<br>↑ '+fb(n.upload_speed)+'/s  ↓ '+fb(n.download_speed)+'/s<br>总流量 ↑ '+fb(n.total_upload)+'  ↓ '+fb(n.total_download)+'</div></div>'}).join('')+'</div>';
  return h+'<div class="card sc"><table><tr><th>状态</th><th>名称</th><th>CPU</th><th>内存</th><th>磁盘</th><th>负载</th><th>网速 ↑/↓</th><th>总流量 ↑/↓</th><th>运行时间</th></tr>'+sv.map(function(s){var a=on(s),c=s.cpu||{},m=s.memory||{},d=s.disk||{},n=s.network||{};return '<tr><td><span class="dot '+(a?'up':'dn')+'"></span>'+(a?'在线':'离线')+'</td><td><b>'+e(s.name)+'</b></td><td>'+(+c.usage_percent||0).toFixed(1)+'%'+bar(c.usage_percent)+'</td><td>'+(+m.usage_percent||0).toFixed(1)+'% <span class="mut">'+fb(m.used)+'/'+fb(m.total)+'</span>'+bar(m.usage_percent)+'</td><td>'+(+d.usage_percent||0).toFixed(1)+'%'+bar(d.usage_percent)+'</td><td>'+(c.load_avg||[0]).join(' ')+'</td><td>'+fb(n.upload_speed)+'/s · '+fb(n.download_speed)+'/s</td><td>'+fb(n.total_upload)+' · '+fb(n.total_download)+'</td><td>'+up(s.uptime)+'</td></tr>'}).join('')+'</table></div>'}
function sitesView(){
  var st=P.sites,u=st.filter(function(s){return s.last_status=='UP'}).length;
  var h='<div class="stats"><div class="card stat"><span>网站总数</span><b>'+st.length+'</b></div><div class="card stat"><span>🟢 正常 / 🔴 异常</span><b>'+u+' / '+(st.length-u)+'</b></div><div class="card stat"><span>平均响应</span><b>'+(st.length?Math.round(st.reduce(function(a,s){return a+(s.last_ms||0)},0)/st.length):0)+' ms</b></div></div>';
  if(!st.length)return h+'<div class="box">暂无监测网站，请前往 ⚙️ 后台添加。</div>';
  return h+'<div class="grid">'+st.map(function(s){var ok=s.last_status=='UP';return '<div class="card"><div class="row"><span class="dot '+(ok?'up':s.last_status=='DOWN'?'dn':'')+'"></span><b>'+e(s.name||s.url)+'</b><span class="sp"></span><span class="tag">'+(ok?'正常':s.last_status=='DOWN'?'异常':'等待')+'</span></div><div class="mut"><a href="'+e(s.url)+'" target="_blank" rel="noopener">'+e(s.url)+'</a></div><div class="rings">'+ring(ok?100:0,'可用')+'<div><div class="ring" style="background:var(--bd)"><i>'+(s.last_ms||0)+'</i></div><div class="ringl">毫秒</div></div></div><div class="hist">'+s.history.map(function(x){return '<i title="'+x.ms+'ms" style="height:'+Math.max(25,Math.min(100,100-x.ms/30))+'%;background:'+(x.status=='UP'?'#22c55e':'#ef4444')+'"></i>'}).join('')+'</div><div class="mut">HTTP '+(s.last_code||'-')+' · '+(s.last_checked?new Date(s.last_checked*1000).toLocaleString():'尚未检测')+'</div></div>'}).join('')+'</div>'}
function loginView(){return '<main style="max-width:380px"><div class="card"><div class="logo"><img src="/favicon.svg" alt="Amos">管理员登录</div><label>用户名</label><input id="u" type="text" value="admin"><label>密码</label><input id="p" type="password" onkeydown="if(event.key==\'Enter\')doLogin()"><div class="row"><button class="pri" onclick="doLogin()">登录</button><button onclick="location.hash=\'#servers\'">返回主页</button></div><div id="msg" class="mut"></div></div></main>'}
async function doLogin(){var r=await api('/api/auth/login',{method:'POST',body:{username:$('u').value,password:$('p').value}});if(r.token){T=r.token;localStorage.tk=T;location.hash='#admin/servers'}else $('msg').textContent=r.error||'登录失败'}
function $(i){return document.getElementById(i)}
var TABS=[['servers','🖥️ 服务器信息'],['sites','🌐 网站信息'],['settings','⚙️ 系统设置'],['notify','🔔 通知管理'],['theme','🎨 主题'],['db','🗄️ 数据库管理'],['logs','📜 日志记录'],['account','👤 账户'],['about','ℹ️ 关于']];
function fld(k,l,t,v){return '<label>'+l+'</label><input id="f_'+k+'" type="'+(t||'text')+'" value="'+e(v)+'">'}
function chk(k,l,v){return '<label style="display:flex;gap:8px;align-items:center;color:var(--tx)"><input type="checkbox" id="f_'+k+'" '+(v!=='0'?'checked':'')+'>'+l+'</label>'}
async function saveF(keys,cb){var b={};keys.forEach(function(k){var x=$('f_'+k);b[k]=x.type=='checkbox'?(x.checked?'1':'0'):x.value});await api('/api/admin/settings',{method:'PUT',body:b});alert('已保存');if(cb)cb();load()}
async function admin(tab){
  if(!T){location.hash='#login';return}
  var h='<main><div class="tabs">'+TABS.map(function(t){return '<button class="'+(t[0]==tab?'on':'')+'" onclick="location.hash=\'#admin/'+t[0]+'\'">'+t[1]+'</button>'}).join('')+'<span class="sp"></span><button onclick="location.hash=\'#servers\'">🏠 返回主页</button><button class="dng" onclick="T=\'\';localStorage.tk=\'\';location.hash=\'#servers\'">🚪 退出登录</button></div><div id="pane"></div></main>';
  document.getElementById('app').innerHTML=head()+h+foot();fix();var pane=$('pane'),s=(await api('/api/admin/settings')).settings||{};
  if(tab=='servers'){var r=await api('/api/admin/servers');pane.innerHTML='<div class="box"><b>➕ 添加服务器</b><div class="row"><input id="n" placeholder="名称" type="text"><input id="d" placeholder="描述" type="text"><input id="x" type="date" title="到期日"><button class="pri" onclick="addSv()">添加</button></div></div><div class="box sc" style="margin-top:14px"><table><tr><th>名称</th><th>状态</th><th>公开</th><th>通知</th><th>到期</th><th>一键安装命令</th><th></th></tr>'+(r.servers||[]).map(function(v){var cmd='curl -fsSL "'+location.origin+'/install.sh?id='+v.id+'&key='+v.api_key+'" | sh';return '<tr><td>'+e(v.name)+'<div class="mut">ID: '+v.id+'</div></td><td>'+(on(v)?'🟢':'🔴')+'</td><td><input type="checkbox" '+(v.is_public?'checked':'')+' onchange="upSv(\''+v.id+'\',{is_public:this.checked?1:0})"></td><td><input type="checkbox" '+(v.notify?'checked':'')+' onchange="upSv(\''+v.id+'\',{notify:this.checked?1:0})"></td><td>'+(v.expire_at?new Date(v.expire_at*1000).toISOString().slice(0,10):'-')+'</td><td><code>'+e(cmd)+'</code> <button onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">复制</button></td><td><button class="dng" onclick="delSv(\''+v.id+'\')">删除</button></td></tr>'}).join('')+'</table></div>'}
  if(tab=='sites'){var r2=await api('/api/admin/sites');pane.innerHTML='<div class="box"><b>➕ 添加网站</b><div class="row"><input id="n" placeholder="名称" type="text"><input id="u2" placeholder="https://example.com" type="url"><button class="pri" onclick="addSite()">添加</button></div></div><div class="box sc" style="margin-top:14px"><table><tr><th>名称</th><th>网址</th><th>状态</th><th>响应</th><th></th></tr>'+(r2.sites||[]).map(function(v){return '<tr><td>'+e(v.name)+'</td><td>'+e(v.url)+'</td><td>'+(v.last_status=='UP'?'🟢':v.last_status=='DOWN'?'🔴':'⏳')+'</td><td>'+(v.last_ms||'-')+' ms</td><td><button class="dng" onclick="api(\'/api/admin/sites/'+v.id+'\',{method:\'DELETE\'}).then(route)">删除</button></td></tr>'}).join('')+'</table></div>'}
  if(tab=='settings')pane.innerHTML='<div class="box">'+fld('title','站点标题',0,s.title)+fld('github_url','GitHub 仓库地址（主页 🐱 与一键安装/升级使用）','url',s.github_url)+fld('report_interval','探针上报间隔（秒）','number',s.report_interval)+fld('site_interval','网站检测间隔（秒）','number',s.site_interval)+'<div class="row"><button class="pri" onclick="saveF([\'title\',\'github_url\',\'report_interval\',\'site_interval\'])">保存</button></div></div>';
  if(tab=='notify')pane.innerHTML='<div class="box"><b>📨 渠道</b>'+fld('tg_token','Telegram Bot Token',0,s.tg_token)+fld('tg_chat','Telegram Chat ID',0,s.tg_chat)+fld('webhook','Webhook URL（POST JSON）','url',s.webhook)+fld('rk','邮件：Resend API Key',0,s.rk)+fld('rfrom','发件人',0,s.rfrom)+fld('rto','收件人',0,s.rto)+'<hr><b>📋 规则（每台服务器可在“服务器信息”里单独开关通知）</b>'+chk('n_offline','离线 / 恢复 / 网站异常',s.n_offline)+chk('n_load','高负载',s.n_load)+chk('n_expire','到期提醒（7 天内）',s.n_expire)+fld('load_th','高负载 CPU 阈值（%）','number',s.load_th)+'<div class="row"><button class="pri" onclick="saveF([\'tg_token\',\'tg_chat\',\'webhook\',\'rk\',\'rfrom\',\'rto\',\'n_offline\',\'n_load\',\'n_expire\',\'load_th\'])">保存</button><button onclick="api(\'/api/admin/notify/test\',{method:\'POST\',body:{}}).then(function(){alert(\'已发送\')})">发送测试</button></div></div>';
  if(tab=='theme')pane.innerHTML='<div class="box"><b>🎨 默认主题（访客首次打开时使用）</b><div class="row">'+[['ocean','🌊 海洋蓝'],['star','🌌 星空'],['forest','🌿 山野绿']].map(function(t){return '<button class="'+(s.theme==t[0]?'on':'')+'" onclick="api(\'/api/admin/settings\',{method:\'PUT\',body:{theme:\''+t[0]+'\'}}).then(load)">'+t[1]+'</button>'}).join('')+'</div><p class="mut">访客也可在主页右上角自行切换主题与明暗模式。</p></div>';
  if(tab=='db'){var d=await api('/api/admin/db/status');pane.innerHTML='<div class="box"><b>🗄️ '+e(d.engine)+'</b><div class="row">'+Object.keys(d.tables||{}).map(function(k){return '<span class="tag">'+k+': '+d.tables[k]+'</span>'}).join('')+'</div></div><div class="box" style="margin-top:14px"><b>📤 导出</b><div class="row"><button class="pri" onclick="exportDb()">下载 JSON 备份</button></div><b>📥 导入（兼容旧版导出）</b><div class="row"><input type="file" id="imp" accept=".json"><select id="mode"><option value="skip">重复记录：跳过</option><option value="overwrite">重复记录：覆盖</option></select><button class="pri" onclick="importDb()">导入</button></div></div><div class="box" style="margin-top:14px"><b>🔌 外部数据库（Supabase / 任意 PostgREST）</b>'+fld('ext_url','项目地址（如 https://xxx.supabase.co）','url',s.ext_url)+fld('ext_key','API Key（需有写权限，如 service_role）','password',s.ext_key)+fld('ext_table','表名（默认 vps_backup）',0,s.ext_table||'vps_backup')+'<div class="row"><button class="pri" onclick="saveF([\'ext_url\',\'ext_key\',\'ext_table\'])">保存</button><button onclick="extAct(\'test\')">测试连接</button><button onclick="extAct(\'push\')">⬆️ 推送备份</button><button onclick="extAct(\'pull\')">⬇️ 拉取并导入</button></div><p class="mut">建表 SQL 见 README；导入时使用上方「跳过/覆盖」选项。</p></div><div class="box" style="margin-top:14px"><b>☁️ 云端下载导入</b><div class="row"><input id="ru" type="url" placeholder="https://…/backup.json"><button class="pri" onclick="remoteImp()">下载并导入</button></div></div>'}
  if(tab=='logs'){var l=await api('/api/admin/logs');pane.innerHTML='<div class="box sc"><table><tr><th>时间</th><th>级别</th><th>类型</th><th>内容</th></tr>'+(l.logs||[]).map(function(x){return '<tr><td>'+new Date(x.ts*1000).toLocaleString()+'</td><td>'+(x.level=='warn'?'⚠️':'ℹ️')+'</td><td>'+e(x.type)+'</td><td>'+e(x.message)+'</td></tr>'}).join('')+'</table></div>'}
  if(tab=='account')pane.innerHTML='<div class="box"><b>🔐 修改密码</b>'+fld('old','原密码','password','')+fld('new','新密码（至少 8 位）','password','')+'<div class="row"><button class="pri" onclick="chPw()">修改</button></div></div>';
  if(tab=='about')pane.innerHTML='<div class="box"><div class="logo"><img src="/favicon.svg" alt="Amos">VPS信息面板 v'+P.version+'</div><p>🚀 <b>技术架构</b>：Cloudflare Workers + D1（SQLite）· 原生前端 · 零依赖</p><p>📡 <b>核心能力</b>：服务器探针上报、网站可用性检测、三套现代主题、卡片/列表双视图</p><p>🛠️ <b>运维能力</b>：离线/高负载/到期通知（Telegram · Webhook · 邮件）、日志、数据库导入导出、<code>/metrics</code> Prometheus 指标</p><p>👥 <b>适用用户</b>：个人站长、小型团队、自建 VPS 玩家</p><div class="row"><button class="pri" onclick="chkUp()">🔄 检查更新</button><span id="upm" class="mut"></span></div></div>';
}
async function chkUp(){var m=(P.settings.github_url||'').match(/github\.com\/([\w.-]+\/[\w.-]+)/);if(!m){$('upm').textContent='请先在“系统设置”填写 GitHub 仓库地址';return}var r=await fetch('https://api.github.com/repos/'+m[1].replace(/\.git$/,'')+'/releases/latest').then(function(x){return x.json()}).catch(function(){return{}});$('upm').innerHTML=r.tag_name?('最新版本：'+e(r.tag_name)+(r.tag_name.replace(/^v/,'')==P.version?' ✅ 已是最新':' — <a target="_blank" rel="noopener" href="'+e(r.html_url)+'">查看更新说明</a>，将仓库 worker.js 覆盖部署即可（D1 数据保留）')):'未找到 Release，请在仓库发布 Release 后再试'}
async function addSv(){var x=$('x').value;await api('/api/admin/servers',{method:'POST',body:{name:$('n').value,description:$('d').value,expire_at:x?Math.floor(new Date(x).getTime()/1000):null}});route()}
async function upSv(i,b){await api('/api/admin/servers/'+i,{method:'PUT',body:b})}
async function delSv(i){if(confirm('确定删除该服务器？'))await api('/api/admin/servers/'+i,{method:'DELETE'}),route()}
async function addSite(){var r=await api('/api/admin/sites',{method:'POST',body:{name:$('n').value,url:$('u2').value}});if(r.error)alert(r.error);route()}
async function chPw(){var r=await api('/api/admin/password',{method:'POST',body:{old:$('f_old').value,new:$('f_new').value}});alert(r.error||'密码已修改')}
async function extAct(op){var r=await api('/api/admin/db/ext/'+op+'?mode='+$('mode').value,{method:'POST',body:{}});alert(r.error||(r.imported!=null?'已导入 '+r.imported+' 条':'成功'));route()}
async function remoteImp(){var r=await api('/api/admin/db/remote',{method:'POST',body:{url:$('ru').value,mode:$('mode').value}});alert(r.error||('已导入 '+r.imported+' 条'));route()}
async function exportDb(){var r=await fetch('/api/admin/db/export',{headers:{authorization:'Bearer '+T}}),a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download='vps-info-backup.json';a.click()}
async function importDb(){var f=$('imp').files[0];if(!f)return alert('请选择文件');var r=await api('/api/admin/db/import?mode='+$('mode').value,{method:'POST',body:await f.text()});alert(r.error||('已导入 '+r.imported+' 条'));route()}
async function route(){if(!P)return;var v=location.hash.slice(1)||'servers',a=v.split('/');skin();
  if(a[0]=='login'){document.getElementById('app').innerHTML=loginView();return}
  if(a[0]=='admin')return admin(a[1]||'servers');
  P=await api('/api/public');document.getElementById('app').innerHTML=head()+'<main>'+(a[0]=='sites'?sitesView():serversView())+'</main>'+foot();fix()}
window.addEventListener('hashchange',route);matchMedia('(prefers-color-scheme:dark)').addEventListener('change',skin);
load();setInterval(function(){if(V()=='servers'||V()=='sites')route()},30000);
</script></body></html>`;
