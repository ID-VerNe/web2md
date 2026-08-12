"""web2md — FastAPI 子进程管理器。

启动/停止 FastAPI 桥接服务，管理与子进程之间的通信。
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path


class FastAPIManager:
    """管理 FastAPI 子进程的生命周期。"""

    def __init__(self, port: int = 8765) -> None:
        self.port = port
        self._process: subprocess.Popen | None = None
        self._bridge_dir = self._find_bridge_dir()

    def _find_bridge_dir(self) -> Path:
        """找到 fastapi-bridge 目录。"""
        # 从当前文件位置向上找
        path = Path(__file__).resolve().parent.parent / "fastapi-bridge"
        if path.exists():
            return path
        # 从 CWD 找
        cwd = Path.cwd() / "fastapi-bridge"
        if cwd.exists():
            return cwd
        raise FileNotFoundError("Cannot find fastapi-bridge/ directory")

    def start(self, timeout: float = 5.0) -> bool:
        """启动 FastAPI 子进程。"""
        if self._process and self._process.poll() is None:
            return True  # 已在运行

        env = os.environ.copy()
        env["PYTHONPATH"] = str(self._bridge_dir)

        self._process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app",
             "--host", "127.0.0.1", "--port", str(self.port),
             "--log-level", "warning"],
            cwd=str(self._bridge_dir),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # 等待服务就绪
        import httpx
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                # trust_env=False：回环地址请求不走 HTTP 代理（避免代理 502）
                resp = httpx.get(f"http://127.0.0.1:{self.port}/health",
                                 timeout=1.0, trust_env=False)
                if resp.status_code == 200:
                    return True
            except Exception:
                pass
            time.sleep(0.2)

        return False

    def stop(self) -> None:
        """停止 FastAPI 子进程。"""
        if self._process and self._process.poll() is None:
            if sys.platform == "win32":
                self._process.terminate()
            else:
                self._process.send_signal(signal.SIGTERM)
            try:
                self._process.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()
        self._process = None

    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def __enter__(self) -> "FastAPIManager":
        self.start()
        return self

    def __exit__(self, *args) -> None:
        self.stop()