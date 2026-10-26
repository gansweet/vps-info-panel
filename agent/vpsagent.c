// vpsagent.c — VPS信息面板 C 探针（Linux / macOS，依赖 libcurl）
// 用法：vpsagent -u https://面板 -s 服务器ID -k API密钥 [-i 秒] [-p]   （-p 仅输出 Prometheus 文本后退出）
// 也可用环境变量 WORKER_URL / SERVER_ID / API_KEY；容器内读宿主机：HOST_PROC=/host/proc
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <signal.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <curl/curl.h>
#ifdef __APPLE__
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <mach/mach.h>
#include <ifaddrs.h>
#include <net/if.h>
#endif
typedef unsigned long long u64;
typedef struct { double cpu, l[3]; u64 mt, mu, dt, du, rx, tx; long up; } M;
static const char *HP = "/proc";
static volatile int run = 1;
static u64 pt, pi_;
static char buf[4096];
static void stop(int s) { (void)s; run = 0; }
static double cpu_pct(u64 t, u64 i) { double r = 0; if (pt && t > pt) r = 100.0 * (1.0 - (double)(i - pi_) / (double)(t - pt)); pt = t; pi_ = i; return r < 0 ? 0 : r > 100 ? 100 : r; }

static void collect(M *m) {
  memset(m, 0, sizeof *m);
  struct statvfs v;
  if (statvfs("/", &v) == 0) { m->dt = (u64)v.f_blocks * v.f_frsize; m->du = m->dt - (u64)v.f_bfree * v.f_frsize; }
#ifdef __linux__
  char p[300], b[512]; FILE *f; u64 a[8] = {0}, mt = 0, ma = 0;
  snprintf(p, sizeof p, "%s/stat", HP);
  if ((f = fopen(p, "r"))) { if (fscanf(f, "cpu %llu %llu %llu %llu %llu %llu %llu %llu", a, a+1, a+2, a+3, a+4, a+5, a+6, a+7) >= 4) { u64 t = 0; for (int k = 0; k < 8; k++) t += a[k]; m->cpu = cpu_pct(t, a[3] + a[4]); } fclose(f); }
  snprintf(p, sizeof p, "%s/meminfo", HP);
  if ((f = fopen(p, "r"))) { while (fgets(b, sizeof b, f)) { sscanf(b, "MemTotal: %llu", &mt); sscanf(b, "MemAvailable: %llu", &ma); } fclose(f); }
  m->mt = mt * 1024; m->mu = (mt - ma) * 1024;
  snprintf(p, sizeof p, "%s/loadavg", HP);
  if ((f = fopen(p, "r"))) { if (fscanf(f, "%lf %lf %lf", m->l, m->l + 1, m->l + 2) != 3) m->l[0] = 0; fclose(f); }
  snprintf(p, sizeof p, "%s/uptime", HP);
  if ((f = fopen(p, "r"))) { double u = 0; if (fscanf(f, "%lf", &u) == 1) m->up = (long)u; fclose(f); }
  if (getenv("HOST_PROC")) snprintf(p, sizeof p, "%s/1/net/dev", HP); else snprintf(p, sizeof p, "%s/net/dev", HP);
  if ((f = fopen(p, "r"))) {
    while (fgets(b, sizeof b, f)) { char *c = strchr(b, ':'); if (!c) continue; *c = 0; char *n = b; while (*n == ' ') n++; if (!strcmp(n, "lo")) continue; u64 r, t; if (sscanf(c + 1, "%llu %*u %*u %*u %*u %*u %*u %*u %llu", &r, &t) == 2) { m->rx += r; m->tx += t; } }
    fclose(f);
  }
#elif defined(__APPLE__)
  double ld[3] = {0}; if (getloadavg(ld, 3) > 0) memcpy(m->l, ld, sizeof ld);
  host_cpu_load_info_data_t ci; mach_msg_type_number_t n = HOST_CPU_LOAD_INFO_COUNT;
  if (host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, (host_info_t)&ci, &n) == KERN_SUCCESS) { u64 t = 0; for (int k = 0; k < CPU_STATE_MAX; k++) t += ci.cpu_ticks[k]; m->cpu = cpu_pct(t, ci.cpu_ticks[CPU_STATE_IDLE]); }
  u64 mem = 0; size_t sz = sizeof mem; sysctlbyname("hw.memsize", &mem, &sz, 0, 0); m->mt = mem;
  vm_statistics64_data_t vs; mach_msg_type_number_t vn = HOST_VM_INFO64_COUNT; vm_size_t ps = 4096; host_page_size(mach_host_self(), &ps);
  if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vs, &vn) == KERN_SUCCESS) m->mu = mem - (u64)(vs.free_count + vs.inactive_count + vs.speculative_count) * ps;
  struct timeval bt; sz = sizeof bt; int mib[2] = {CTL_KERN, KERN_BOOTTIME};
  if (sysctl(mib, 2, &bt, &sz, 0, 0) == 0) m->up = time(0) - bt.tv_sec;
  struct ifaddrs *ifa, *q;
  if (getifaddrs(&ifa) == 0) { for (q = ifa; q; q = q->ifa_next) if (q->ifa_addr && q->ifa_addr->sa_family == AF_LINK && q->ifa_data && !(q->ifa_flags & IFF_LOOPBACK)) { struct if_data *d = q->ifa_data; m->rx += d->ifi_ibytes; m->tx += d->ifi_obytes; } freeifaddrs(ifa); }
#endif
}

static void prom(const M *m) {  // 与 node_exporter 命名兼容，可配合 textfile collector
  printf("node_load1 %.2f\nnode_load5 %.2f\nnode_load15 %.2f\nvps_cpu_usage_percent %.1f\n", m->l[0], m->l[1], m->l[2], m->cpu);
  printf("node_memory_MemTotal_bytes %llu\nnode_memory_MemAvailable_bytes %llu\n", m->mt, m->mt - m->mu);
  printf("node_filesystem_size_bytes{mountpoint=\"/\"} %llu\nnode_filesystem_avail_bytes{mountpoint=\"/\"} %llu\n", m->dt, m->dt - m->du);
  printf("node_network_receive_bytes_total %llu\nnode_network_transmit_bytes_total %llu\nnode_boot_time_seconds %ld\n", m->rx, m->tx, (long)time(0) - m->up);
}

static size_t wcb(char *p, size_t s, size_t n, void *u) { (void)u; size_t l = strlen(buf), k = s * n; if (l + k < sizeof buf - 1) { memcpy(buf + l, p, k); buf[l + k] = 0; } return s * n; }
static long http(const char *url, const char *key, const char *body) {
  CURL *c = curl_easy_init(); if (!c) return -1; buf[0] = 0;
  char k[256]; snprintf(k, sizeof k, "X-API-Key: %s", key);
  struct curl_slist *h = curl_slist_append(NULL, "Content-Type: application/json"); h = curl_slist_append(h, k);
  curl_easy_setopt(c, CURLOPT_URL, url); curl_easy_setopt(c, CURLOPT_HTTPHEADER, h); curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, wcb);
  curl_easy_setopt(c, CURLOPT_TIMEOUT, 20L); curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 10L); curl_easy_setopt(c, CURLOPT_USERAGENT, "vpsagent/2.1");
  if (body) curl_easy_setopt(c, CURLOPT_POSTFIELDS, body);
  long code = -1; if (curl_easy_perform(c) == CURLE_OK) curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &code);
  curl_slist_free_all(h); curl_easy_cleanup(c); return code;
}
static int jnum(const char *key, int def) { char *p = strstr(buf, key); if (!p) return def; p = strchr(p, ':'); int v = p ? atoi(p + 1) : def; return v >= 5 && v <= 3600 ? v : def; }

int main(int argc, char **argv) {
  const char *url = getenv("WORKER_URL"), *id = getenv("SERVER_ID"), *key = getenv("API_KEY"); int iv = 60, once = 0, o;
  if (getenv("HOST_PROC")) HP = getenv("HOST_PROC");
  while ((o = getopt(argc, argv, "u:s:k:i:p")) != -1) { if (o == 'u') url = optarg; else if (o == 's') id = optarg; else if (o == 'k') key = optarg; else if (o == 'i') iv = atoi(optarg); else if (o == 'p') once = 1; }
  M m; collect(&m);
  if (once) { sleep(1); collect(&m); prom(&m); return 0; }
  if (!url || !id || !key) { fprintf(stderr, "用法: %s -u URL -s ID -k KEY [-i 秒] [-p]\n", argv[0]); return 2; }
  signal(SIGTERM, stop); signal(SIGINT, stop); curl_global_init(CURL_GLOBAL_DEFAULT);
  char u[512], js[1024]; size_t ul = strlen(url); while (ul && url[ul - 1] == '/') ul--;
  snprintf(u, sizeof u, "%.*s/api/config/%s", (int)ul, url, id); if (http(u, key, NULL) == 200) iv = jnum("\"report_interval\"", iv);
  snprintf(u, sizeof u, "%.*s/api/report/%s", (int)ul, url, id);
  sleep(1); u64 prx = m.rx, ptx = m.tx; time_t pts = time(0);
  while (run) {
    collect(&m); time_t t = time(0); double dt = difftime(t, pts); if (dt < 1) dt = 1;
    u64 us = m.tx >= ptx ? (u64)((m.tx - ptx) / dt) : 0, ds = m.rx >= prx ? (u64)((m.rx - prx) / dt) : 0; prx = m.rx; ptx = m.tx; pts = t;
    double mp = m.mt ? 100.0 * m.mu / m.mt : 0, dp = m.dt ? 100.0 * m.du / m.dt : 0;
    snprintf(js, sizeof js, "{\"timestamp\":%ld,\"cpu\":{\"usage_percent\":%.1f,\"load_avg\":[%.2f,%.2f,%.2f]},\"memory\":{\"total\":%llu,\"used\":%llu,\"free\":%llu,\"usage_percent\":%.1f},\"disk\":{\"total\":%llu,\"used\":%llu,\"free\":%llu,\"usage_percent\":%.1f},\"network\":{\"upload_speed\":%llu,\"download_speed\":%llu,\"total_upload\":%llu,\"total_download\":%llu},\"uptime\":%ld}",
      (long)t, m.cpu, m.l[0], m.l[1], m.l[2], m.mt, m.mu, m.mt - m.mu, mp, m.dt, m.du, m.dt - m.du, dp, us, ds, m.tx, m.rx, m.up);
    long code = http(u, key, js);
    if (code == 200) iv = jnum("\"interval\"", iv); else fprintf(stderr, "上报失败 HTTP %ld\n", code);
    for (int k = 0; k < iv && run; k++) sleep(1);
  }
  return 0;
}
