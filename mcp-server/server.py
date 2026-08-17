"""web2md — MCP Server（FastAPI bridge 已内联）。

Claude Code 通过 MCP 工具 web2md_extract 调用此服务。

架构（2026-08-14 重构）：
- 不再 fork uvicorn 子进程（旧 fastapi_mgr 方案），改为在 MCP server
  进程内用 uvicorn.Server + daemon 线程跑 FastAPI app。
- 好处：无端口抢注 / 孤儿进程 / 子进程管理复杂度；改代码后重启 MCP
  server 即生效。
- MCP 工具（web2md_extract / web2md_shutdown）与 HTTP 路由共享同一个
  进程内 TaskQueue。

注意：fastapi-bridge 目录名含连字符，不是合法 Python 包名，因此不能
写 `from fastapi_bridge.main import ...`。本文件把 fastapi-bridge/
加入 sys.path，再按顶层模块导入 main / models。
"""
from __future__ import annotations

import asyncio
import time
import threading
from pathlib import Path

import httpx

from fastmcp import FastMCP

# ── FastAPI bridge 内联 ──────────────────────────────────────────────
# 把 fastapi-bridge/ 加入 sys.path，按顶层模块引用其 main（含 FastAPI
# app 与 TaskQueue）。这样 Chrome 扩展的 HTTP 端点（8765）由本 MCP
# server 进程直接提供，不再需要独立子进程。

_BRIDGE_DIR = Path(__file__).resolve().parent.parent / "fastapi-bridge"
import sys as _sys
if str(_BRIDGE_DIR) not in _sys.path:
    _sys.path.insert(0, str(_BRIDGE_DIR))

import main as _bridge_main  # noqa: E402
bridge_app = _bridge_main.app
bridge_queue = _bridge_main.queue


def _check_health(port: int, timeout: float = 0.5) -> bool:
    """探测端口上是否已有健康的 web2md bridge 服务（多实例复用）。"""
    return _bridge_main.check_health(port, timeout=timeout)


# ── MCP Server ───────────────────────────────────────────────────────

mcp = FastMCP("web2md", instructions="将网页转为 Markdown 供 AI 阅读")

# 进程内 uvicorn 服务器（延迟启动）
_uvicorn_server: object | None = None
_uvicorn_lock = threading.Lock()


def _start_bridge(port: int = 8765) -> str:
    """确保 FastAPI 服务在本进程内运行，返回 base URL。

    若端口上已有健康服务（来自另一个 MCP 实例或上一次会话遗留），
    直接复用，不重复启动——解决多实例端口冲突。
    """
    global _uvicorn_server

    # 快速健康检查：端口上已有健康服务则直接复用
    if _check_health(port):
        return f"http://127.0.0.1:{port}"

    with _uvicorn_lock:
        # 双检锁定
        if _check_health(port):
            return f"http://127.0.0.1:{port}"

        import uvicorn
        config = uvicorn.Config(
            bridge_app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
        )
        server = uvicorn.Server(config)
        thread = threading.Thread(
            target=server.run, daemon=True, name="web2md-uvicorn")
        thread.start()
        _uvicorn_server = server

        # 等待就绪（轮询 /health）
        deadline = time.time() + 15.0
        while time.time() < deadline:
            if _check_health(port):
                return f"http://127.0.0.1:{port}"
            time.sleep(0.2)

        raise RuntimeError(
            f"web2md bridge not ready within 15s on 127.0.0.1:{port}")


def _write_result(
    title: str | None,
    markdown: str,
    output_dir: Path,
) -> Path:
    """将 Markdown 写入输出目录。"""
    ts = time.strftime("%Y%m%d-%H%M%S")
    safe_title = "untitled"
    if title:
        safe_title = "".join(
            c if c.isalnum() or c in " _-" else "_" for c in title)[:60]
    filename = f"{safe_title}-{ts}.md"
    filepath = output_dir / filename
    print(f"[web2md-diag] _write_result: markdown len={len(markdown)}, title={title!r}, path={filepath}")  # noqa: T201
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
               - task_type: "extract"（默认，提取页面）| "grok_ask"（向
                 Grok AI 提问；需要 prompt 字段，url 可省略）
               - prompt: task_type="grok_ask" 时的问题文本
        content_mode: "article"（仅正文）或 "full"（完整页面）
        output_mode: "separate"（每个任务独立文件）或 "merged"（合并文件）
        port: FastAPI 端口（默认 8765）

    Returns:
        写入的文件路径列表，每行一个
    """
    base_url = _start_bridge(port=port)
    output_dir = Path.cwd() / ".web2md"
    output_dir.mkdir(exist_ok=True)

    # trust_env=False：回环地址请求不走 HTTP 代理
    async with httpx.AsyncClient(
        base_url=base_url, timeout=10.0, trust_env=False
    ) as client:
        resp = await client.post("/api/tasks/create", json={
            "tasks": tasks,
            "content_mode": content_mode,
            "output_mode": output_mode,
        })
        resp.raise_for_status()
        task_data = resp.json()
        task_ids = [t["task_id"] for t in task_data["tasks"]]

        # 两阶段超时（2026-08-15）：
        # Phase 1 (5s)：检测扩展是否在线。5s 内任务进入 PROCESSING（有人
        #   poll）→ 扩展在线，进 Phase 2；仍 PENDING → 扩展离线 → 走 fallback。
        # Phase 2 (30s)：扩展在线，等它完成（done/failed）。X 的滚动提取
        #   ~10s，旧的单 5s 上限会误触发并发 fallback 冲掉扩展结果。
        #   超时或 failed → 走 fallback。
        file_paths = []
        for task_id in task_ids:
            result = await _await_task(client, task_id, grace=5.0)

            # Phase 2：5s 内扩展没 poll（None）或 poll 了但没出结果
            # （PROCESSING）→ 继续等最多 30s。扩展串行化后可能忙，
            # 5s 不够等它 poll 到新任务。
            if (result is None
                    or (result and result["status"] not in ("done", "failed"))):
                result = await _await_task(client, task_id, grace=30.0)

            # 只有扩展明确处理成功（done + 有 markdown）才算完成；
            # 否则（PENDING 超时 / failed / 空 markdown）都走 fallback
            # 兜底。旧逻辑把 failed 也算"完成"，导致扩展在线但匹配
            # 不到标签页时报 failed 并直接硬失败，绕过了 fallback。
            if not (result and result["status"] == "done"
                    and result.get("markdown")):
                if tasks[task_id_to_idx(task_ids, task_id)].get("task_type") == "grok_ask":
                    # grok_ask 无 HTTP 等价物（需要浏览器登录态 + 交互），
                    # fallback 无法兜底 → 正常运行失败
                    print("[web2md-diag] grok_ask failed, no fallback available", task_id)
                    file_paths.append(f"# {task_id}: grok_ask failed (extension busy/offline)")
                    continue
                result = await _fallback_and_complete(
                    client, task_id, tasks, task_id_to_idx(task_ids, task_id),
                    content_mode)

            if result and result["status"] == "done" and result.get("markdown"):
                fp = _write_result(
                    result.get("title"), result["markdown"], output_dir)
                file_paths.append(str(fp))
            else:
                file_paths.append(f"# {task_id}: failed or no result")

    return "\n".join(file_paths)


def task_id_to_idx(task_ids: list[str], task_id: str) -> int:
    return task_ids.index(task_id)


async def _await_task(
    client: httpx.AsyncClient, task_id: str, grace: float = 5.0,
) -> dict | None:
    """等 grace 秒，看 Chrome 扩展是否把任务做掉。

    返回最近一次拿到的 result（可能是 PENDING/PROCESSING/done/failed），
    或超时返回最后一次轮询的状态。调用方按 status 决定是否走 fallback。
    """
    deadline = time.time() + grace
    last_result: dict | None = None
    poll_count = 0
    while time.time() < deadline:
        r = await client.get(f"/api/tasks/{task_id}/result")
        poll_count += 1
        if r.status_code == 200:
            last_result = r.json()
            if last_result["status"] in ("done", "failed"):
                print(f"[web2md-diag] _await_task done grace={grace} polls={poll_count} status={last_result['status']} md_len={len(last_result.get('markdown') or '')}")  # noqa: T201
                return last_result
        await asyncio.sleep(0.5)
    print(f"[web2md-diag] _await_task timeout grace={grace} polls={poll_count} last_status={last_result['status'] if last_result else 'None'}")  # noqa: T201
    return last_result


async def _fallback_and_complete(
    client: httpx.AsyncClient,
    task_id: str,
    tasks: list[dict],
    idx: int,
    content_mode: str,
) -> dict:
    """Chrome 扩展未处理 → 同进程内 HTTP fallback 抓取并回写结果。"""
    from fallback import fallback_extract

    task = tasks[idx] if idx < len(tasks) else {}
    url = task.get("url")
    if not url:
        # 无 URL（纯 title 匹配场景），fallback 无法处理
        return {"task_id": task_id, "status": "failed",
                "markdown": None, "title": task.get("title"), "url": url}

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None, fallback_extract, url, content_mode)

    if result["success"]:
        await client.post(
            f"/api/tasks/{task_id}/result",
            json={"markdown": result["markdown"], "status": "done"},
        )
        return {
            "task_id": task_id, "status": "done",
            "markdown": result["markdown"],
            "title": result["title"], "url": url,
        }
    return {"task_id": task_id, "status": "failed",
            "markdown": None, "title": result.get("title"), "url": url}


@mcp.tool()
async def web2md_shutdown() -> str:
    """关闭 web2md 的 FastAPI bridge 服务。

    本进程内 bridge 是 daemon 线程，MCP server 退出时自动回收。
    此工具主要用于多实例场景下显式让本实例放弃 bridge 所有权。
    """
    global _uvicorn_server
    if _uvicorn_server is not None and _uvicorn_server.is_running():
        # uvicorn.Server.shutdown() 是协程，需要投到其事件循环
        try:
            loop = _uvicorn_server.loop
            if loop is not None:
                asyncio.run_coroutine_threadsafe(
                    _uvicorn_server.shutdown(), loop)
                return "web2md bridge shutdown initiated"
        except Exception:
            pass
    _uvicorn_server = None
    return "web2md bridge was not running (or already recycled)"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()