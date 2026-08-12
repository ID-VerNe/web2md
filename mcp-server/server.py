"""web2md — MCP Server。

Claude Code 通过 MCP 工具 web2md_extract 调用此服务。
"""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import httpx
from fastmcp import FastMCP

from fastapi_mgr import FastAPIManager

# 创建 MCP 服务器
mcp = FastMCP("web2md", instructions="将网页转为 Markdown 供 AI 阅读")

# 全局 FastAPI 管理器（延迟初始化）
_fastapi: FastAPIManager | None = None
_fastapi_lock = asyncio.Lock()


async def _ensure_fastapi(port: int = 8765) -> str:
    """确保 FastAPI 已启动，返回 base URL。"""
    global _fastapi
    async with _fastapi_lock:
        if _fastapi is None:
            _fastapi = FastAPIManager(port=port)
        if not _fastapi.is_running():
            ok = _fastapi.start()
            if not ok:
                raise RuntimeError("Failed to start FastAPI bridge")
        return f"http://127.0.0.1:{port}"


def _write_result(
    title: str | None,
    markdown: str,
    output_dir: Path,
) -> Path:
    """将 Markdown 写入 .web2md/ 目录。"""
    import time as t
    ts = t.strftime("%Y%m%d-%H%M%S")
    safe_title = "untitled"
    if title:
        safe_title = "".join(c if c.isalnum() or c in " _-" else "_" for c in title)[:60]
    filename = f"{safe_title}-{ts}.md"
    filepath = output_dir / filename
    filepath.write_text(markdown, encoding="utf-8")
    return filepath


@mcp.tool()
async def web2md_extract(
    tasks: list[dict],
    content_mode: str = "article",
    output_mode: str = "separate",
    port: int = 8765,
) -> str:
    """将网页转为 Markdown。

    通过 Chrome 插件（优先）或 HTTP fallback（插件不可用时）抓取页面内容，
    转为 Markdown 并写入本地文件。

    Args:
        tasks: 任务列表，每项包含 {title?, url?, match_mode?}
               - title: 页面标题（用于匹配标签页）
               - url: 页面 URL
               - match_mode: "title" | "url" | "auto"（默认 auto）
        content_mode: "article"（仅正文）或 "full"（完整页面）
        output_mode: "separate"（每个任务独立文件）或 "merged"（合并文件）
        port: FastAPI 端口（默认 8765）

    Returns:
        写入的文件路径列表，每行一个
    """
    base_url = await _ensure_fastapi(port=port)
    output_dir = Path.cwd() / ".web2md"
    output_dir.mkdir(exist_ok=True)

    # 创建任务
    # trust_env=False：回环地址请求不走 HTTP 代理
    async with httpx.AsyncClient(base_url=base_url, timeout=10.0, trust_env=False) as client:
        resp = await client.post("/api/tasks/create", json={
            "tasks": tasks,
            "content_mode": content_mode,
            "output_mode": output_mode,
        })
        resp.raise_for_status()
        task_data = resp.json()
        task_ids = [t["task_id"] for t in task_data["tasks"]]

        # 等待所有任务完成（最多 60s）
        file_paths = []
        for task_id in task_ids:
            deadline = time.time() + 60
            result = None
            while time.time() < deadline:
                r = await client.get(f"/api/tasks/{task_id}/result")
                if r.status_code == 200:
                    result = r.json()
                    if result["status"] in ("done", "failed"):
                        break
                await asyncio.sleep(0.5)

            if result and result["status"] == "done" and result.get("markdown"):
                fp = _write_result(result.get("title"), result["markdown"], output_dir)
                file_paths.append(str(fp))
            else:
                file_paths.append(f"# {task_id}: failed or no result")

    return "\n".join(file_paths)


@mcp.tool()
async def web2md_shutdown() -> str:
    """关闭 web2md 的 FastAPI 后端服务。"""
    global _fastapi
    if _fastapi:
        _fastapi.stop()
        _fastapi = None
        return "FastAPI bridge stopped"
    return "FastAPI bridge was not running"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()