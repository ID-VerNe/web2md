"""web2md — Fallback 抓取模块。

当插件无法匹配标签页时，由 FastAPI 直接 HTTP 抓取 URL 并转 Markdown。

流程:
1. httpx 请求 URL → HTML
2. readability-lxml 提取正文（仅 article 模式）
3. html2text 转 Markdown
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
from models import ContentMode


def fetch_html(url: str, timeout: float = 15.0) -> str | None:
    """HTTP GET 请求 URL，返回 HTML 字符串。"""
    try:
        resp = httpx.get(url, timeout=timeout, follow_redirects=True)
        resp.raise_for_status()
        return resp.text
    except httpx.HTTPError:
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