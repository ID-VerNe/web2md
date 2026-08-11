"""测试 MCP Server（fastapi_mgr + server）。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

DIR = Path(__file__).resolve().parent
if str(DIR) not in sys.path:
    sys.path.insert(0, str(DIR))

from fastapi_mgr import FastAPIManager


class TestFastAPIManager:
    def test_find_bridge_dir(self):
        """能找到 fastapi-bridge 目录。"""
        mgr = FastAPIManager()
        assert mgr._bridge_dir.exists()
        assert (mgr._bridge_dir / "main.py").exists()

    def test_start_and_stop(self):
        """启动/停止 FastAPI 子进程。"""
        mgr = FastAPIManager(port=18765)  # 用非常规端口避免冲突
        try:
            ok = mgr.start()
            assert ok, "FastAPI should start"
            assert mgr.is_running()

            import httpx
            resp = httpx.get("http://127.0.0.1:18765/health", timeout=3.0)
            assert resp.status_code == 200
        finally:
            mgr.stop()

        assert not mgr.is_running()

    def test_context_manager(self):
        """上下文管理器应能正常启动和停止。"""
        with FastAPIManager(port=18766) as mgr:
            assert mgr.is_running()
        assert not mgr.is_running()

    def test_double_start(self):
        """重复启动应返回 True（已在运行）。"""
        mgr = FastAPIManager(port=18767)
        try:
            ok1 = mgr.start()
            ok2 = mgr.start()
            assert ok1 and ok2
        finally:
            mgr.stop()