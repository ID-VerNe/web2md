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
import re
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


# ── 代码行清洗（JS/CSS 检测）──────────────────────────────────────────

# 按行特征检测 JS/CSS 代码的规则。命中任一即判定为代码行，从输出中删除。
CODE_PATTERNS = [
    # 行首 JS 声明/控制流
    r"^(function\b|function\s*\w*\s*\()",
    r"^(var\s+|let\s+|const\s+)",
    r"^(if\s*\(|for\s*\(|while\s*\(|do\s*\{|switch\s*\()",
    r"^(return\s|throw\s|try\s*\{|catch\s*\(|finally\s*\{)",
    r"^(async\s+function|async\s+\(|await\s+)",
    r"^(class\s+\w+|new\s+\w+\s*\(|import\s+|export\s+)",
    r"^(typeof\s+|delete\s+|void\s+|yield\s+)",
    # 行首 JS API / DOM 操作
    r"^(document\.|window\.|globalThis\.|self\.|console\.|location\.|history\.)",
    r"^(alert\(|confirm\(|prompt\(|fetch\(|setTimeout\(|setInterval\(|clearTimeout\(|clearInterval\()",
    r"^(JSON\.|Math\.|Date\.|Promise\.|Array\.|Object\.|String\.|Number\.|Boolean\.|RegExp\.|Error\.|Map\.|Set\.|WeakMap\.|WeakSet\.|Symbol\.)",
    r"^httpRequest\s*=",
    r"^httpRequest\.[a-zA-Z]+\(",
    # jQuery
    r"^(\$\(|jQuery\(|\$\.(get|post|ajax|on|each|map|extend|when|Deferred)\(|_\$)",
    # 行中 JS 特征
    r"(addEventListener\(|removeEventListener\(|querySelector\(|querySelectorAll\(|getElementById\(|getElementsBy|createElement\(|appendChild\(|insertBefore\(|setAttribute\(|getAttribute\()",
    r"(innerHTML\s*=|outerHTML\s*=|textContent\s*=|innerText\s*=)",
    r"(\.submit\(\)|\.click\(\)|\.focus\(\)|\.blur\(\)|\.preventDefault\(\)|\.stopPropagation\(\))",
    r"(\$\s*\(|\.css\s*\(|\.animate\s*\(|\.slide|\.fade|\.ajax)",
    r"(XMLHttpRequest|ActiveXObject|FormData|FileReader|Blob|ArrayBuffer)",
    r"(_satellite\[|_satellite\.|adobeDataLayer|dataLayer\.push)",
    # CSS 选择器规则
    r"^[.#][-\w]+\s*\{",
    r"^[a-zA-Z][-\w]*\s*\{[^}]*$",
    r"^\s*\{[^}]*\}$",
    # CSS 声明行（如 line-height: 1.5;）
    r"^[a-zA-Z-]+\s*:\s*[^;{}]+;*$",
    # 注释行（// ... 或 /* ... */）
    r"^\s*//.*$",
    r"^\s*/\*",
    r"^\s*\*/",
    # 独立括号/闭包残行：} }); })(); }, 10); (function(){...})() 等
    r"^\s*[}\])]\s*[;,\)\d\s]*\)*\s*;*\s*$",
    r"^\s*\}\)\s*\(\s*\)\s*;?\s*$",
    r"^\s*\}\s*\)\s*;?\s*$",
    # 函数调用语句（以 ; 结尾的调用）
    r"^[a-z_]\w*\s*\([^)]*\)\s*;\s*$",
    # 行中 CSS 选择器：#id{...} 或 .class{...}（userscript 等注入的 CSS 文本）
    r"#[a-zA-Z][-\w]*\{",
    r"\.[a-zA-Z][-\w]*\{",
    # CSS 特有属性（几乎不会出现在自然语言中）
    r"z-index:\s*\d+",
    r"box-sizing:\s*border-box",
    r"-webkit-",
    r"-moz-",
]

# 预编译正则，加快批量检测
COMPILED_PATTERNS = [re.compile(p) for p in CODE_PATTERNS]


def _is_code_line(line: str) -> bool:
    """判断单行文本是否为 JS/CSS 代码。"""
    t = line.strip()
    if not t:
        return False
    # 极短行只检查括号/分号行
    if len(t) < 3:
        return bool(re.match(r"^[{}();)\]\[\]]+$", t))
    # 跳过纯数字行、纯 URL 行
    if re.fullmatch(r"[\d\s,.!?]+", t):
        return False
    if re.match(r"^https?://\S+$", t):
        return False
    for pat in COMPILED_PATTERNS:
        if pat.search(t):
            return True
    # 高密度代码符号检测：{ } ( ) ; 占比超过字母数的 25%
    code_chars = len(re.findall(r"[{}();]", t))
    alpha_chars = len(re.findall(r"[a-zA-Z]", t))
    if code_chars >= 2 and alpha_chars > 0 and code_chars > alpha_chars * 0.25:
        return True
    # 长代码行、行尾分号
    if len(t) > 30 and t.endswith(";") and re.search(r"[{}()]", t):
        return True
    return False


def clean_code_lines(text: str) -> str:
    """从 Markdown 文本中移除所有看起来像 JS/CSS 代码的行。"""
    if not text:
        return text
    lines = text.split("\n")
    cleaned = [ln for ln in lines if not _is_code_line(ln)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(cleaned)).strip()


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

        # 清除混入的 JS/CSS 代码行
        markdown = clean_code_lines(markdown)

        return {"success": True, "markdown": markdown, "title": title,
                "error": None}
    except Exception as e:
        return {"success": False, "markdown": None, "title": title,
                "error": str(e)}