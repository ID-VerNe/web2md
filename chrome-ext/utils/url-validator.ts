/** web2md — SW 级 URL 校验（SSRF 防护）。

校验规则与 fastapi-bridge/fallback.py 的 validate_url 一致：
- 仅允许 http / https
- 拒绝字面量回环 / RFC 1918 私网 / 链路本地等禁止 IP
- 域名不做 DNS 解析（SW 中不可靠），接受域名级 SSRF 残留风险，
  由浏览器沙箱 + 黑名单 + 用户已登录的 profile 做后续防御

时间线：2026-08-15 添加，对应 multi-lens-review 的 SSRF 发现。
*/

export class UnsafeUrlError extends Error {}

// 禁止的数字 IP 段（与 fallback.py 的 BLOCKED_NETWORKS 一致）
const BLOCKED_NETWORKS: { mask: string; check: (ip: number) => boolean }[] = [
  // IPv4 用 int 做范围判断
  { mask: "127.0.0.0/8", check: (ip) => (ip & 0xff000000) === 0x7f000000 },
  { mask: "10.0.0.0/8", check: (ip) => (ip & 0xff000000) === 0x0a000000 },
  { mask: "172.16.0.0/12", check: (ip) => (ip & 0xfff00000) === 0xac100000 },
  { mask: "192.168.0.0/16", check: (ip) => (ip & 0xffff0000) === 0xc0a80000 },
  { mask: "169.254.0.0/16", check: (ip) => (ip & 0xffff0000) === 0xa9fe0000 },
  { mask: "0.0.0.0/8", check: (ip) => (ip & 0xff000000) === 0x00000000 },
  { mask: "224.0.0.0/4", check: (ip) => (ip & 0xf0000000) === 0xe0000000 },
  { mask: "240.0.0.0/4", check: (ip) => (ip & 0xf0000000) === 0xf0000000 },
];

function ipv4ToInt(parts: number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isIpBlocked(host: string): boolean {
  // 仅处理带点的纯数字 IPv4；IPv6 不处理（SW 环境少，且浏览器沙箱兜底）
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), parseInt(m[4])];
  if (parts.some((p) => p > 255)) return false; // 不是合法 IP，可能是域名
  const ip = ipv4ToInt(parts);
  return BLOCKED_NETWORKS.some((n) => n.check(ip));
}

/**
 * 校验 URL，返回原 URL 或抛 UnsafeUrlError。
 * - 仅允许 http / https
 * - 字面量 IP 落在禁止段内则拒绝（127.0.0.1, 10.x, 192.168.x 等）
 * - 域名不做 DNS 解析，放行后由浏览器沙箱保护
 */
export function validateUrl(url: string): string {
  if (!url) throw new UnsafeUrlError("empty url");

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError("cannot parse url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError(`scheme not allowed: ${parsed.protocol}`);
  }

  const host = parsed.hostname;
  if (!host) throw new UnsafeUrlError("no host");

  if (isIpBlocked(host)) {
    throw new UnsafeUrlError(`ip not allowed: ${host}`);
  }

  return url;
}

/**
 * 判断 tab 最终 URL 是否相对请求 URL 发生了"实质性"重定向。
 *
 * 只比较 normalize 后的 hostname + pathname，忽略：
 * - protocol（http→https 合法）
 * - 大小写归一（host/path 大小写不敏感）
 * - trailing slash（/a/b 与 /a/b/ 等价）
 * - query / hash（站点常加跟踪参数、缓存 key）
 *
 * hostname 变 = 跨域重定向（如知乎跳登录页），pathname 变 = 同站换页
 * （SO 把 /questions/76161046 → /questions/76152978）。任一变化都判为
 * 重定向，避免把错误页面内容当结果写回。
 *
 * finalUrl 为空（tab 已关 / 取不到）时保守返回 false，不误判。
 */
export function isRedirected(requestedUrl: string, finalUrl?: string): boolean {
  if (!finalUrl) return false;
  const a = safeParse(requestedUrl);
  const b = safeParse(finalUrl);
  if (!a || !b) return false;
  const aPath = normalizePath(a);
  const bPath = normalizePath(b);
  return a.hostname.toLowerCase() !== b.hostname.toLowerCase()
    || aPath !== bPath;
}

function safeParse(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function normalizePath(u: URL): string {
  // 去掉 trailing slash，统一小写
  let p = u.pathname.toLowerCase();
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}