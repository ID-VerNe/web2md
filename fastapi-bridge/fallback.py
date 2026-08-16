"""web2md — Fallback 抓取模块。

当插件无法匹配标签页时，由 FastAPI 直接 HTTP 抓取 URL 并转 Markdown。

流程:
1. 校验 URL（仅 http/https，拒绝回环/私网/链路本地地址）
2. httpx 请求 URL → HTML（不走代理环境变量）
3. readability-lxml 提取正文（仅 article 模式）
4. html2text 转 Markdown
"""
from __future__ import annotations

import ipaddress
import socket
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
from models import ContentMode


class UnsafeURLError(ValueError):
    """URL 不在允许的范围内（非 http/https 或指向内网）。"""


# 禁止访问的地址段（回环 / RFC 1918 私网 / 链路本地 / 组播 / 保留 / IPv6 等价段）。
# 不用 ipaddress.is_private：后者把 198.18.0.0/15 等代理拦截段也标为
# private，会误杀走代理的环境。
BLOCKED_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),       # 回环
    ipaddress.ip_network("10.0.0.0/8"),        # RFC 1918
    ipaddress.ip_network("172.16.0.0/12"),     # RFC 1918
    ipaddress.ip_network("192.168.0.0/16"),    # RFC 1918
    ipaddress.ip_network("169.254.0.0/16"),    # 链路本地
    ipaddress.ip_network("0.0.0.0/8"),         # 本网络
    ipaddress.ip_network("224.0.0.0/4"),       # 组播
    ipaddress.ip_network("240.0.0.0/4"),       # 保留
    ipaddress.ip_network("::1/128"),           # IPv6 回环
    ipaddress.ip_network("fc00::/7"),          # 唯一本地地址
    ipaddress.ip_network("fe80::/10"),         # 链路本地
    ipaddress.ip_network("ff00::/8"),          # 组播
    ipaddress.ip_network("::/128"),            # 未指定
]


def _ip_is_blocked(ip: ipaddress._BaseAddress) -> bool:
    """单个 IP 是否落在禁止段内。"""
    return any(ip in net for net in BLOCKED_NETWORKS)


def _host_is_blocked(host: str) -> bool:
    """域名解析后的所有 IP 是否任一落在禁止段内（防 DNS rebinding 到内网）。

    解析失败也保守拒绝。
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return True
    for info in infos:
        ip_str = info[4][0].split("%", 1)[0]  # 去掉 IPv6 zone id
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if _ip_is_blocked(ip):
            return True
    return False


def validate_url(url: str) -> str:
    """校验 URL scheme 与目标主机，返回原 URL 或抛 UnsafeURLError。

    - 仅允许 http / https
    - 字面量 IP 直接判；域名解析后判，防 DNS rebinding 到内网
    """
    if not url:
        raise UnsafeURLError("empty url")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise UnsafeURLError(f"scheme not allowed: {parsed.scheme!r}")
    host = parsed.hostname
    if not host:
        raise UnsafeURLError("no host")
    try:
        ip = ipaddress.ip_address(host)
        if _ip_is_blocked(ip):
            raise UnsafeURLError(f"ip not allowed: {host}")
    except ValueError:
        if _host_is_blocked(host):
            raise UnsafeURLError(f"host resolves to private address: {host}")
    return url


def fetch_html(url: str, timeout: float = 15.0) -> str | None:
    """HTTP GET 请求 URL，返回 HTML 字符串。

    trust_env=False：不走 HTTP_PROXY/HTTPS_PROXY 等环境变量，避免代理 SSRF。
    跟随重定向但每次重定向后重新校验目标 URL。
    """
    try:
        validate_url(url)
    except UnsafeURLError:
        return None

    try:
        with httpx.Client(
            timeout=timeout, trust_env=False, follow_redirects=True,
        ) as client:
            resp = client.get(url)
            # 重定向后最终 URL 也要校验
            if resp.url:
                try:
                    validate_url(str(resp.url))
                except UnsafeURLError:
                    return None
            resp.raise_for_status()
            return resp.text
    except (httpx.HTTPError, UnsafeURLError):
        return None


def extract_article(html: str) -> str | None:
    """用 readability-lxml 提取文章正文 HTML。"""
    try:
        from readability import Document
    except ImportError:
        return None

    try:
        doc = Document(html)
        body = doc.summary()
        return body
    except Exception:
        return None


def html_to_markdown(html: str) -> str:
    """用 html2text 将 HTML 转为 Markdown。"""
    import html2text

    h = html2text.HTML2Text()
    h.body_width = 0        # 不自动换行
    h.ignore_links = False
    h.ignore_images = False
    h.ignore_emphasis = False
    h.protect_links = True
    h.unicode_snob = True   # 保留 Unicode
    return h.handle(html)


def extract_full_page(html: str, title: str | None = None) -> str:
    """将整个 HTML 转为 Markdown（含导航等）。"""
    return html_to_markdown(html)


def fallback_extract(
    url: str,
    content_mode: str = "article",
    timeout: float = 15.0,
) -> dict:
    """完整 fallback 流程。

    返回:
    {
        "success": bool,
        "markdown": str | None,
        "title": str | None,
        "error": str | None,
    }
    """
    html = fetch_html(url, timeout=timeout)
    if html is None:
        return {"success": False, "markdown": None, "title": None,
                "error": f"Failed to fetch {url}"}

    # 提取标题
    title = None
    try:
        from lxml.html import fromstring
        root = fromstring(html)
        title_el = root.find(".//title")
        if title_el is not None and title_el.text:
            title = title_el.text.strip()
    except Exception:
        pass

    try:
        if content_mode == ContentMode.ARTICLE:
            article_html = extract_article(html)
            if article_html:
                markdown = html_to_markdown(article_html)
            else:
                # readability 提取失败，回退到全文
                markdown = extract_full_page(html, title)
        else:
            markdown = extract_full_page(html, title)

        return {"success": True, "markdown": markdown, "title": title,
                "error": None}
    except Exception as e:
        return {"success": False, "markdown": None, "title": title,
                "error": str(e)}