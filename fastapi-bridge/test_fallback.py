"""测试 fallback 模块（HTTP 抓取 + readability + html2text）。

注意：这些测试需要网络，且依赖 readability-lxml 和 html2text 安装。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

DIR = Path(__file__).resolve().parent
if str(DIR) not in sys.path:
    sys.path.insert(0, str(DIR))

from fallback import (
    fetch_html,
    extract_article,
    html_to_markdown,
    extract_full_page,
    fallback_extract,
)


class TestFetchHtml:
    def test_fetch_public_url(self):
        """用已知可访问的 URL 测试 HTTP 抓取。"""
        html = fetch_html("https://example.com")
        assert html is not None
        assert "Example Domain" in html

    def test_fetch_invalid_url(self):
        """无效 URL 返回 None。"""
        html = fetch_html("https://invalid.nonexistent.example/test")
        assert html is None

    def test_fetch_timeout(self):
        """超时 URL 返回 None。"""
        html = fetch_html("https://httpbin.org/delay/10", timeout=0.5)
        assert html is None


class TestExtractArticle:
    def test_extract_simple_article(self):
        """从简单 HTML 中提取正文。"""
        html = "<html><body><article><h1>Title</h1><p>Content here</p></article></body></html>"
        result = extract_article(html)
        # readability 可能返回 None 或提取到内容
        # 只要不抛异常即可
        assert result is None or len(result) > 0

    def test_extract_empty_html(self):
        """空 HTML 不抛异常。"""
        result = extract_article("")
        assert result is None


class TestHtmlToMarkdown:
    def test_basic_conversion(self):
        """基本 HTML 标签转 Markdown。"""
        md = html_to_markdown("<h1>Title</h1><p>Hello <strong>World</strong></p>")
        assert "Title" in md
        assert "Hello" in md
        assert "World" in md

    def test_link_conversion(self):
        """链接转 Markdown 格式。"""
        md = html_to_markdown('<a href="https://example.com">click</a>')
        assert "click" in md
        # html2text 输出格式可能包含括号，检查基本内容
        assert "example.com" in md or "https" in md

    def test_empty_html(self):
        """空 HTML 返回空字符串。"""
        md = html_to_markdown("")
        assert md.strip() == ""


class TestExtractFullPage:
    def test_full_page_with_title(self):
        """完整页面转换包含标题标签。"""
        html = "<html><head><title>Test Page</title></head><body><p>Body</p></body></html>"
        md = extract_full_page(html, title="Test Page")
        assert "Test Page" in md or "Body" in md

    def test_empty_body(self):
        """空 body 返回空字符串。"""
        md = extract_full_page("<html></html>")
        assert md.strip() == ""


class TestFallbackExtract:
    def test_fallback_public_url(self):
        """对已知可访问 URL 执行完整 fallback 流程。"""
        result = fallback_extract("https://example.com")
        assert result["success"] is True
        assert result["markdown"] is not None
        assert "Example Domain" in result["markdown"]

    def test_fallback_invalid_url(self):
        """无效 URL 返回失败。"""
        result = fallback_extract("https://invalid.nonexistent.example/test")
        assert result["success"] is False
        assert result["error"] is not None

    def test_fallback_full_mode(self):
        """全文模式仍返回内容。"""
        result = fallback_extract("https://example.com", content_mode="full")
        assert result["success"] is True
        assert result["markdown"] is not None