// vpsagent.c v2.2 — VPS信息面板 C 探针（Push 模式；Linux 静态单文件 / macOS）
// 用法：vpsagent -u https://面板 -s 服务器ID -k API密钥 [-i 秒] [-t 22,80] [-L host:port] [-I] [-p] [-V]
// 环境变量：WORKER_URL / SERVER_ID / API_KEY；容器内读宿主机：HOST_PROC=/host/proc；INSECURE=1 跳过证书校验
// 特性：JSON 上报 · 断网环形缓冲(30 条)恢复后补发 · 端口/延迟探测 · 面板下发配置(间隔/端口/目标) · 无 libcurl（Linux 仅需 OpenSSL，可静态链接）
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <signal.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/utsname.h>
#include <sys/socket.h>
#include <netdb.h>
#ifdef __APPLE__
#include <sys/sysctl.h>
#include <mach/mach.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <curl/curl.h>
#elif defined(USE_OPENSSL)
#include <openssl/ssl.h>
#endif
#define VER "2.2.0"
typedef unsigned long long u64;
typedef struct { double cpu, cu, cs, l[3]; u64 mt, mu, st, su, dt, du, rx, tx, dr, dw, oom; long up; int procs, tcp, ncpu; } M;
static const char *HP = "/proc";
static volatile int run = 1;
static u64 pt, pi_, pu_, ps_;
static char buf[8192];
static int insecure, pl[16], npl;
static const char *HR = "";   // HOST_ROOT：容器内挂载宿主机根目录（如 /host/root）时用于磁盘与日志
static void stop(int s) { (void)s; run = 0; }
static void sanit(char *s) { for (; *s; s++) if (*s == '"' || *s == '\\' || (unsigned char)*s < 32) *s = ' '; }
static void cpu_calc(M *m, u64 t, u64 i, u64 u, u64 s) {
  if (pt && t > pt) { double d = (double)(t - pt), v = 100.0 * (1.0 - (double)(i - pi_) / d); m->cpu = v < 0 ? 0 : v > 100 ? 100 : v; m->cu = 100.0 * (double)(u - pu_) / d; m->cs = 100.0 * (double)(s - ps_) / d; }
  pt = t; pi_ = i; pu_ = u; ps_ = s;
}
static int lines(const char *p) { FILE *f = fopen(p, "r"); if (!f) return 0; int n = 0, c; while ((c = fgetc(f)) != EOF) if (c == '\n') n++; fclose(f); return n > 0 ? n - 1 : 0; }
static int is_disk(const char *n) {
  size_t l = strlen(n);
  if (!strncmp(n, "nvme", 4) || !strncmp(n, "mmcblk", 6)) return !strchr(n + 4, 'p');
  if ((!strncmp(n, "sd", 2) || !strncmp(n, "vd", 2) || !strncmp(n, "xvd", 3) || !strncmp(n, "hd", 2)) && l >= 3) return !(n[l - 1] >= '0' && n[l - 1] <= '9');
  return 0;
}
static int ssh_fail(void) {
  static char b[131073]; const char *fs[] = {"/var/log/auth.log", "/var/log/secure", NULL};
  for (int k = 0; fs[k]; k++) {
    char pp[300]; snprintf(pp, sizeof pp, "%s%s", HR, fs[k]); FILE *f = fopen(pp, "r"); if (!f) continue;
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, sz > 131072 ? sz - 131072 : 0, SEEK_SET);
    size_t n = fread(b, 1, 131072, f); fclose(f); b[n] = 0; int c = 0;
    for (char *p = b; (p = strstr(p, "Failed password")); p++) c++;
    for (char *p = b; (p = strstr(p, "Invalid user")); p++) c++;
    return c;
  }
  return -1;
}
static int tcp_try(const char *host, int port, int ms, double *rtt) {
  struct addrinfo h, *r; char ps[8]; memset(&h, 0, sizeof h); snprintf(ps, sizeof ps, "%d", port); h.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, ps, &h, &r)) return 0;
  int ok = 0; struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a);
  int fd = socket(r->ai_family, r->ai_socktype, 0);
  if (fd >= 0) {
    fcntl(fd, F_SETFL, O_NONBLOCK); int c = connect(fd, r->ai_addr, r->ai_addrlen);
    if (c == 0) ok = 1; else if (errno == EINPROGRESS) { struct pollfd p = {fd, POLLOUT, 0}; if (poll(&p, 1, ms) > 0) { int e = 0; socklen_t l = sizeof e; getsockopt(fd, SOL_SOCKET, SO_ERROR, &e, &l); ok = !e; } }
    close(fd);
  }
  freeaddrinfo(r); clock_gettime(CLOCK_MONOTONIC, &b); if (rtt) *rtt = (b.tv_sec - a.tv_sec) * 1000.0 + (b.tv_nsec - a.tv_nsec) / 1e6;
  return ok;
}
static void collect(M *m) {
  memset(m, 0, sizeof *m); struct statvfs v;
  if (statvfs(*HR ? HR : "/", &v) == 0) { m->dt = (u64)v.f_blocks * v.f_frsize; m->du = m->dt - (u64)v.f_bfree * v.f_frsize; }
  m->ncpu = (int)sysconf(_SC_NPROCESSORS_ONLN);
#ifdef __linux__
  char p[300], b[512]; FILE *f; u64 a[8] = {0}, mt = 0, ma = 0, st = 0, sf = 0;
  snprintf(p, sizeof p, "%s/stat", HP);
  if ((f = fopen(p, "r"))) { if (fscanf(f, "cpu %llu %llu %llu %llu %llu %llu %llu %llu", a, a+1, a+2, a+3, a+4, a+5, a+6, a+7) >= 4) { u64 t = 0; for (int k = 0; k < 8; k++) t += a[k]; cpu_calc(m, t, a[3] + a[4], a[0] + a[1], a[2] + a[5] + a[6]); } fclose(f); }
  snprintf(p, sizeof p, "%s/meminfo", HP);
  if ((f = fopen(p, "r"))) { while (fgets(b, sizeof b, f)) { sscanf(b, "MemTotal: %llu", &mt); sscanf(b, "MemAvailable: %llu", &ma); sscanf(b, "SwapTotal: %llu", &st); sscanf(b, "SwapFree: %llu", &sf); } fclose(f); }
  m->mt = mt * 1024; m->mu = (mt - ma) * 1024; m->st = st * 1024; m->su = (st - sf) * 1024;
  snprintf(p, sizeof p, "%s/loadavg", HP);
  if ((f = fopen(p, "r"))) { if (fscanf(f, "%lf %lf %lf %*d/%d", m->l, m->l + 1, m->l + 2, &m->procs) < 3) m->l[0] = 0; fclose(f); }
  snprintf(p, sizeof p, "%s/uptime", HP);
  if ((f = fopen(p, "r"))) { double u = 0; if (fscanf(f, "%lf", &u) == 1) m->up = (long)u; fclose(f); }
  snprintf(p, sizeof p, "%s/vmstat", HP);
  if ((f = fopen(p, "r"))) { while (fgets(b, sizeof b, f)) sscanf(b, "oom_kill %llu", &m->oom); fclose(f); }
  snprintf(p, sizeof p, "%s/diskstats", HP);
  if ((f = fopen(p, "r"))) { char n[64]; u64 sr, sw; while (fgets(b, sizeof b, f)) if (sscanf(b, "%*u %*u %63s %*u %*u %llu %*u %*u %*u %llu", n, &sr, &sw) == 3 && is_disk(n)) { m->dr += sr * 512; m->dw += sw * 512; } fclose(f); }
  const char *nd = getenv("HOST_PROC") ? "1/net" : "net";
  snprintf(p, sizeof p, "%s/%s/dev", HP, nd);
  if ((f = fopen(p, "r"))) {
    while (fgets(b, sizeof b, f)) { char *c = strchr(b, ':'); if (!c) continue; *c = 0; char *n = b; while (*n == ' ') n++; if (!strcmp(n, "lo")) continue; u64 r, t; if (sscanf(c + 1, "%llu %*u %*u %*u %*u %*u %*u %*u %llu", &r, &t) == 2) { m->rx += r; m->tx += t; } }
    fclose(f);
  }
  snprintf(p, sizeof p, "%s/%s/tcp", HP, nd); m->tcp = lines(p); snprintf(p, sizeof p, "%s/%s/tcp6", HP, nd); m->tcp += lines(p);
#elif defined(__APPLE__)
  double ld[3] = {0}; if (getloadavg(ld, 3) > 0) memcpy(m->l, ld, sizeof ld);
  host_cpu_load_info_data_t ci; mach_msg_type_number_t n = HOST_CPU_LOAD_INFO_COUNT;
  if (host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, (host_info_t)&ci, &n) == KERN_SUCCESS) { u64 t = 0; for (int k = 0; k < CPU_STATE_MAX; k++) t += ci.cpu_ticks[k]; cpu_calc(m, t, ci.cpu_ticks[CPU_STATE_IDLE], ci.cpu_ticks[CPU_STATE_USER] + ci.cpu_ticks[CPU_STATE_NICE], ci.cpu_ticks[CPU_STATE_SYSTEM]); }
  u64 mem = 0; size_t sz = sizeof mem; sysctlbyname("hw.memsize", &mem, &sz, 0, 0); m->mt = mem;
  vm_statistics64_data_t vs; mach_msg_type_number_t vn = HOST_VM_INFO64_COUNT; vm_size_t ps = 4096; host_page_size(mach_host_self(), &ps);
  if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vs, &vn) == KERN_SUCCESS) m->mu = mem - (u64)(vs.free_count + vs.inactive_count + vs.speculative_count) * ps;
  struct timeval bt; sz = sizeof bt; int mib[2] = {CTL_KERN, KERN_BOOTTIME};
  if (sysctl(mib, 2, &bt, &sz, 0, 0) == 0) m->up = time(0) - bt.tv_sec;
  struct ifaddrs *ifa, *q;
  if (getifaddrs(&ifa) == 0) { for (q = ifa; q; q = q->ifa_next) if (q->ifa_addr && q->ifa_addr->sa_family == AF_LINK && q->ifa_data && !(q->ifa_flags & IFF_LOOPBACK)) { struct if_data *d = q->ifa_data; m->rx += d->ifi_ibytes; m->tx += d->ifi_obytes; } freeifaddrs(ifa); }
#endif
}
static void prom(const M *m) {
  printf("node_load1 %.2f\nnode_load5 %.2f\nnode_load15 %.2f\nvps_cpu_usage_percent %.1f\n", m->l[0], m->l[1], m->l[2], m->cpu);
  printf("node_memory_MemTotal_bytes %llu\nnode_memory_MemAvailable_bytes %llu\nnode_memory_SwapTotal_bytes %llu\nnode_memory_SwapFree_bytes %llu\n", m->mt, m->mt - m->mu, m->st, m->st - m->su);
  printf("node_filesystem_size_bytes{mountpoint=\"/\"} %llu\nnode_filesystem_avail_bytes{mountpoint=\"/\"} %llu\n", m->dt, m->dt - m->du);
  printf("node_network_receive_bytes_total %llu\nnode_network_transmit_bytes_total %llu\nnode_disk_read_bytes_total %llu\nnode_disk_written_bytes_total %llu\n", m->rx, m->tx, m->dr, m->dw);
  printf("node_boot_time_seconds %ld\nnode_vmstat_oom_kill %llu\nnode_sockstat_TCP_inuse %d\n", (long)time(0) - m->up, m->oom, m->tcp);
}

// ---------- HTTP(S) ----------
#ifdef __APPLE__
static size_t wcb(char *p, size_t s, size_t n, void *u) { (void)u; size_t l = strlen(buf), k = s * n; if (l + k < sizeof buf - 1) { memcpy(buf + l, p, k); buf[l + k] = 0; } return s * n; }
static long http(const char *url, const char *key, const char *body) {
  CURL *c = curl_easy_init(); if (!c) return -1; buf[0] = 0; char k[300]; snprintf(k, sizeof k, "X-API-Key: %s", key);
  struct curl_slist *h = curl_slist_append(NULL, "Content-Type: application/json"); h = curl_slist_append(h, k);
  curl_easy_setopt(c, CURLOPT_URL, url); curl_easy_setopt(c, CURLOPT_HTTPHEADER, h); curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, wcb);
  curl_easy_setopt(c, CURLOPT_TIMEOUT, 20L); curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 10L); curl_easy_setopt(c, CURLOPT_USERAGENT, "vpsagent/" VER);
  if (insecure) curl_easy_setopt(c, CURLOPT_SSL_VERIFYPEER, 0L);
  if (body) curl_easy_setopt(c, CURLOPT_POSTFIELDS, body);
  long code = -1; if (curl_easy_perform(c) == CURLE_OK) curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
  curl_slist_free_all(h); curl_easy_cleanup(c); return code;
}
static void tls_init(void) { curl_global_init(CURL_GLOBAL_DEFAULT); }
#else
#ifdef USE_OPENSSL
static SSL_CTX *ctx;
static void tls_init(void) {
  OPENSSL_init_ssl(0, NULL); ctx = SSL_CTX_new(TLS_client_method()); if (!ctx) return;
  if (insecure) { SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL); return; }
  SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
  const char *cf[] = {getenv("SSL_CERT_FILE"), "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem", "/etc/ssl/ca-bundle.pem", "/etc/ssl/certs/ca-bundle.crt", NULL};
  int ok = 0; for (int i = 0; cf[i] && !ok; i++) if (cf[i] && access(cf[i], R_OK) == 0 && SSL_CTX_load_verify_locations(ctx, cf[i], NULL) == 1) ok = 1;
  if (!ok) SSL_CTX_set_default_verify_paths(ctx);
}
#else
static void tls_init(void) {}
#endif
static long http(const char *url, const char *key, const char *body) {
  const char *p = url; int port, tls = 0; char hp[256], host[256], path[512];
  if (!strncmp(p, "https://", 8)) { tls = 1; p += 8; port = 443; } else if (!strncmp(p, "http://", 7)) { p += 7; port = 80; } else return -1;
  const char *sl = strchr(p, '/'); size_t hl = sl ? (size_t)(sl - p) : strlen(p); if (hl == 0 || hl >= sizeof hp) return -1;
  memcpy(hp, p, hl); hp[hl] = 0; snprintf(path, sizeof path, "%s", sl ? sl : "/");
  char *co = strrchr(hp, ':'); if (co) { *co = 0; port = atoi(co + 1); } snprintf(host, sizeof host, "%s", hp);
  struct addrinfo h, *r; char ps[8]; memset(&h, 0, sizeof h); snprintf(ps, sizeof ps, "%d", port); h.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, ps, &h, &r)) return -1;
  int fd = -1; struct timeval tv = {15, 0};
  for (struct addrinfo *a = r; a; a = a->ai_next) { fd = socket(a->ai_family, a->ai_socktype, 0); if (fd < 0) continue; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv); if (connect(fd, a->ai_addr, a->ai_addrlen) == 0) break; close(fd); fd = -1; }
  freeaddrinfo(r); if (fd < 0) return -1;
#ifdef USE_OPENSSL
  SSL *ssl = NULL;
  if (tls) {
    if (!ctx || !(ssl = SSL_new(ctx))) { close(fd); return -1; }
    SSL_set_fd(ssl, fd); SSL_set_tlsext_host_name(ssl, host); if (!insecure) SSL_set1_host(ssl, host);
    if (SSL_connect(ssl) != 1) { fprintf(stderr, "TLS 握手/证书校验失败（可设置 INSECURE=1 或 -I 跳过校验）\n"); SSL_free(ssl); close(fd); return -1; }
  }
#else
  if (tls) { fprintf(stderr, "此构建不含 TLS，请使用 http:// 或带 -DUSE_OPENSSL 重新编译\n"); close(fd); return -1; }
#endif
  char req[4096]; int n = snprintf(req, sizeof req, "%s %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: vpsagent/" VER "\r\nAccept: application/json\r\nX-API-Key: %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s", body ? "POST" : "GET", path, hp, key, body ? strlen(body) : 0, body ? body : "");
  long code = -1; size_t tot = 0; int ok = 1;
  for (int off = 0; off < n && ok;) {
#ifdef USE_OPENSSL
    int w = ssl ? SSL_write(ssl, req + off, n - off) : (int)send(fd, req + off, n - off, 0);
#else
    int w = (int)send(fd, req + off, n - off, 0);
#endif
    if (w <= 0) ok = 0; else off += w;
  }
  while (ok && tot < sizeof buf - 1) {
#ifdef USE_OPENSSL
    int g = ssl ? SSL_read(ssl, buf + tot, (int)(sizeof buf - 1 - tot)) : (int)recv(fd, buf + tot, sizeof buf - 1 - tot, 0);
#else
    int g = (int)recv(fd, buf + tot, sizeof buf - 1 - tot, 0);
#endif
    if (g <= 0) break;
    tot += g;
  }
  buf[tot] = 0;
#ifdef USE_OPENSSL
  if (ssl) { SSL_shutdown(ssl); SSL_free(ssl); }
#endif
  close(fd);
  if (ok && sscanf(buf, "HTTP/%*s %ld", &code) == 1) { char *b = strstr(buf, "\r\n\r\n"); if (b) memmove(buf, b + 4, strlen(b + 4) + 1); else buf[0] = 0; }
  return code;
}
#endif
static int jnum(const char *key, int def) { char *p = strstr(buf, key); if (!p) return def; p = strchr(p, ':'); int v = p ? atoi(p + 1) : def; return v >= 5 && v <= 3600 ? v : def; }
static int jstr(const char *key, char *out, size_t n) {
  char *p = strstr(buf, key); out[0] = 0; if (!p) return 0; p = strchr(p + strlen(key), ':'); if (!p) return 0; p++; while (*p == ' ') p++;
  if (*p != '"') return 0;
  p++; size_t i = 0; while (*p && *p != '"' && i < n - 1) out[i++] = *p++; out[i] = 0; return 1;
}
static void parse_ports(const char *s) { npl = 0; while (*s && npl < 16) { while (*s && (*s < '0' || *s > '9')) s++; if (!*s) break; int v = atoi(s); if (v > 0 && v < 65536) pl[npl++] = v; while (*s >= '0' && *s <= '9') s++; } }

// ---------- 断网缓冲 ----------
#define QN 30
static char *q[QN]; static int qh, qn;
static void qpush(const char *js) {
  char *c = malloc(strlen(js) + 16); if (!c) return; strcpy(c, "{\"replay\":1,"); strcat(c, js + 1);
  if (qn == QN) { free(q[qh]); qh = (qh + 1) % QN; qn--; } q[(qh + qn) % QN] = c; qn++;
}
static void osname(char *o, size_t n) {
  struct utsname u; uname(&u); snprintf(o, n, "%s", u.sysname); FILE *f = fopen("/etc/os-release", "r"); char b[256];
  if (f) { while (fgets(b, sizeof b, f)) if (!strncmp(b, "PRETTY_NAME=", 12)) { char *v = b + 12; size_t l = strlen(v); while (l && (v[l-1] == '\n' || v[l-1] == '"')) v[--l] = 0; if (*v == '"') v++; strncpy(o, v, n - 1); o[n - 1] = 0; break; } fclose(f); }
  sanit(o);
}

int main(int argc, char **argv) {
  const char *url = getenv("WORKER_URL"), *id = getenv("SERVER_ID"), *key = getenv("API_KEY"), *ping = NULL; int iv = 60, once = 0, o; char pcfg[128] = "", tcfg[128] = "";
  if (getenv("HOST_PROC")) HP = getenv("HOST_PROC");
  if (getenv("HOST_ROOT")) HR = getenv("HOST_ROOT");
  if (getenv("INSECURE") && getenv("INSECURE")[0] == '1') insecure = 1;
  while ((o = getopt(argc, argv, "u:s:k:i:t:L:pIV")) != -1) {
    if (o == 'u') url = optarg; else if (o == 's') id = optarg; else if (o == 'k') key = optarg; else if (o == 'i') iv = atoi(optarg);
    else if (o == 't') parse_ports(optarg); else if (o == 'L') ping = optarg; else if (o == 'p') once = 1; else if (o == 'I') insecure = 1; else if (o == 'V') { puts(VER); return 0; }
  }
  M m; collect(&m);
  if (once) { sleep(1); collect(&m); prom(&m); return 0; }
  if (!url || !id || !key) { fprintf(stderr, "用法: %s -u URL -s ID -k KEY [-i 秒] [-t 端口列表] [-L host:port] [-I] [-p] [-V]\n", argv[0]); return 2; }
  if (ping) snprintf(tcfg, sizeof tcfg, "%s", ping);
  signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN); tls_init();
  struct utsname un; uname(&un); char host[128], osn[160], kern[128]; gethostname(host, sizeof host); sanit(host); osname(osn, sizeof osn); snprintf(kern, sizeof kern, "%s", un.release); sanit(kern);
  char uc[512], ur[512], js[3072]; size_t ul = strlen(url); while (ul && url[ul - 1] == '/') ul--;
  snprintf(uc, sizeof uc, "%.*s/api/config/%s", (int)ul, url, id); snprintf(ur, sizeof ur, "%.*s/api/report/%s", (int)ul, url, id);
  sleep(1); u64 prx = m.rx, ptx = m.tx, pdr = m.dr, pdw = m.dw; time_t pts = time(0); int rounds = 0, cfg_ok = 0;
  while (run) {
    if (!cfg_ok || rounds % 10 == 0) {   // 配置获取失败时每轮重试，成功后每 10 轮刷新一次
      cfg_ok = http(uc, key, NULL) == 200;
      if (cfg_ok) { iv = jnum("\"report_interval\"", iv); if (jstr("\"ports\"", pcfg, sizeof pcfg)) parse_ports(pcfg); if (!ping) jstr("\"ping_target\"", tcfg, sizeof tcfg); }
    }
    rounds++; collect(&m); time_t t = time(0); double dt = difftime(t, pts); if (dt < 1) dt = 1;
#define RATE(c, p) ((c) >= (p) ? (u64)(((c) - (p)) / dt) : 0)
    u64 us = RATE(m.tx, ptx), ds = RATE(m.rx, prx), rb = RATE(m.dr, pdr), wb = RATE(m.dw, pdw); prx = m.rx; ptx = m.tx; pdr = m.dr; pdw = m.dw; pts = t;
    char pj[400] = ""; for (int k = 0; k < npl; k++) { char e[48]; snprintf(e, sizeof e, "%s{\"p\":%d,\"up\":%d}", k ? "," : "", pl[k], tcp_try("127.0.0.1", pl[k], 800, NULL)); strncat(pj, e, sizeof pj - strlen(pj) - 1); }
    double rtt = -1; if (tcfg[0]) { char th[128]; snprintf(th, sizeof th, "%s", tcfg); char *c = strrchr(th, ':'); int pp = 443; if (c) { *c = 0; pp = atoi(c + 1); } double r2; if (tcp_try(th, pp, 2000, &r2)) rtt = r2; }
    double mp = m.mt ? 100.0 * m.mu / m.mt : 0, dp = m.dt ? 100.0 * m.du / m.dt : 0;
    snprintf(js, sizeof js, "{\"timestamp\":%ld,\"cpu\":{\"usage_percent\":%.1f,\"load_avg\":[%.2f,%.2f,%.2f]},\"memory\":{\"total\":%llu,\"used\":%llu,\"free\":%llu,\"usage_percent\":%.1f},\"disk\":{\"total\":%llu,\"used\":%llu,\"free\":%llu,\"usage_percent\":%.1f},\"network\":{\"upload_speed\":%llu,\"download_speed\":%llu,\"total_upload\":%llu,\"total_download\":%llu},\"uptime\":%ld,"
      "\"ext\":{\"v\":\"" VER "\",\"host\":\"%s\",\"os\":\"%s\",\"kernel\":\"%s\",\"ncpu\":%d,\"cpu_user\":%.1f,\"cpu_sys\":%.1f,\"swap\":{\"total\":%llu,\"used\":%llu},\"disk_io\":{\"read_bps\":%llu,\"write_bps\":%llu},\"procs\":%d,\"tcp\":%d,\"oom\":%llu,\"ssh_failed\":%d,\"ping_ms\":%.1f,\"ports\":[%s]}}",
      (long)t, m.cpu, m.l[0], m.l[1], m.l[2], m.mt, m.mu, m.mt - m.mu, mp, m.dt, m.du, m.dt - m.du, dp, us, ds, m.tx, m.rx, m.up,
      host, osn, kern, m.ncpu, m.cu, m.cs, m.st, m.su, rb, wb, m.procs, m.tcp, m.oom, ssh_fail(), rtt, pj);
    int ok = 1; while (qn && ok && run) { if (http(ur, key, q[qh]) == 200) { free(q[qh]); qh = (qh + 1) % QN; qn--; } else ok = 0; }
    long code = ok ? http(ur, key, js) : -1;
    if (code == 200) iv = jnum("\"interval\"", iv); else { qpush(js); fprintf(stderr, "上报失败(HTTP %ld)，已缓存 %d 条待补发\n", code, qn); }
    for (int k = 0; k < iv && run; k++) sleep(1);
  }
  return 0;
}
