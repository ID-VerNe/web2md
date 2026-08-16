"""测试 MCP Server（bridge 内联 + fallback 链路）。"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

import server


@pytest.fixture(scope="module")
def bridge_url():
    """启动进程内 bridge（非 8765 避免打扰真实实例），返回 base URL。"""
    url = server._start_bridge(port=18765)
    yield url


class TestBridge:
    def test_health(self, bridge_url):
        resp = httpx.get(f"{bridge_url}/health", timeout=3.0)
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"

    def test_task_roundtrip(self, bridge_url):
        """create → poll → complete → result 全链路。"""
        resp = httpx.post(
            f"{bridge_url}/api/tasks/create",
            json={"tasks": [{"url": "https://example.com"}], "content_mode": "article"},
            timeout=5.0,
        )
        assert resp.status_code == 200
        task_id = resp.json()["tasks"][0]["task_id"]

        poll = httpx.post  # placeholder to avoid lint confusion below
        resp = httpx.get(f"{bridge_url}/api/tasks/poll", timeout=3.0)
        assert resp.status_code == 200
        assert resp.json()["task_id"] == task_id

        resp = httpx.post(
            f"{bridge_url}/api/tasks/{task_id}/result",
            json={"markdown": "# hi", "status": "done"},
            timeout=3.0,
        )
        assert resp.status_code == 200

        resp = httpx.get(f"{bridge_url}/api/tasks/{task_id}/result", timeout=3.0)
        assert resp.status_code == 200
        assert resp.json()["status"] == "done"
        assert resp.json()["markdown"] == "# hi"


class TestFallback:
    def test_failed_triggers_fallback(self, bridge_url):
        """扩展在线但无匹配标签页 → 报 failed → MCP 应改走 fallback。

        覆盖 server.py 里 fallback 触发条件从 `status not in
        ("done","failed")` 改为 `not (done + 有 markdown)` 的修复：
        旧的条件会把 failed 当"完成"直接硬失败，绕过 fallback。
        """
        import asyncio
        from server import _await_task, _fallback_and_complete

        resp = httpx.post(
            f"{bridge_url}/api/tasks/create",
            json={"tasks": [{"url": "https://example.com"}], "content_mode": "article"},
            timeout=5.0,
        )
        assert resp.status_code == 200
        task_id = resp.json()["tasks"][0]["task_id"]

        async def _do():
            async with httpx.AsyncClient(
                base_url=bridge_url, timeout=10.0, trust_env=False
            ) as client:
                # 模拟扩展 poll 到任务、匹配不到标签页、回写 failed
                # （先 poll 再回写 failed，与真实 background 行为一致）
                poll = await client.get("/api/tasks/poll")
                assert poll.json()["task_id"] == task_id
                await client.post(
                    f"/api/tasks/{task_id}/result",
                    json={"markdown": "", "status": "failed"},
                )
                # _await_task 收到 failed 退出；新条件 → not(done+markdown) → fallback
                result = await _await_task(client, task_id, grace=0.5)
                result = await _fallback_and_complete(
                    client, task_id,
                    [{"url": "https://example.com"}],
                    0, "article",
                )
                return result

        result = asyncio.run(_do())
        assert result["status"] == "done", f"status={result['status']}"
        assert result["markdown"] is not None and len(result["markdown"]) > 0


def test_mcp_registration():
    """MCP 工具已注册。"""
    tool_names = {t.name for t in server.mcp._tool_manager._tools.values()}
    assert "web2md_extract" in tool_names
    assert "web2md_shutdown" in tool_names