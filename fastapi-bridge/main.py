"""web2md — FastAPI 桥接服务。

API:
- GET  /health                    — 健康检查
- POST /api/tasks/create          — 创建任务
- GET  /api/tasks/poll            — 取下一个任务（插件调用）
- POST /api/tasks/{task_id}/result — 回写结果（插件调用）
- GET  /api/tasks/{task_id}/result — 读取结果（MCP 调用）
"""
from __future__ import annotations

import time

import uvicorn
import sys
from pathlib import Path

# 使本目录可作为顶层模块导入（目录名 fastapi-bridge 含连字符，非合法包名）
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from models import TaskStatus  # noqa: E402
from task_queue import TaskQueue  # noqa: E402

app = FastAPI(title="web2md-bridge", version="0.1.0")
queue = TaskQueue()

START_TIME = time.time()


# ── Pydantic 请求/响应模型 ──────────────────────────────

class TaskItem(BaseModel):
    title: str | None = None
    url: str | None = None
    match_mode: str = "auto"
    task_type: str = "extract"
    prompt: str | None = None
    tab_url: str | None = None  # 会话参数 URL（用于 google_ai_ask 追问复用）


class CreateTasksRequest(BaseModel):
    tasks: list[TaskItem]
    content_mode: str = "article"
    output_mode: str = "separate"


class CreateTasksResponse(BaseModel):
    queue_id: str
    tasks: list[dict]


class PollResponse(BaseModel):
    task_id: str | None = None
    type: str | None = None
    params: dict | None = None


class ResultResponse(BaseModel):
    task_id: str
    status: str
    markdown: str | None = None
    title: str | None = None
    url: str | None = None
    tab_url: str | None = None  # 扩展实际打开的标签 URL（含会话参数）


class HealthResponse(BaseModel):
    status: str
    uptime: float
    pending: int
    total: int


# ── API 端点 ────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(
        status="ok",
        uptime=time.time() - START_TIME,
        pending=queue.pending_count,
        total=queue.total_count,
    )


@app.post("/api/tasks/create", response_model=CreateTasksResponse)
def create_tasks(req: CreateTasksRequest):
    items = [t.model_dump() for t in req.tasks]
    tasks = queue.create_tasks(items)
    return CreateTasksResponse(
        queue_id="q_main",
        tasks=[t.to_dict() for t in tasks],
    )


@app.get("/api/tasks/poll", response_model=PollResponse)
def poll_task():
    """Chrome 扩展轮询待处理任务。

    poll 标记任务为 PROCESSING。若扩展不在线（无人 poll），任务会一直
    停在 PENDING/PROCESSING，由 MCP 工具端在超时后走 HTTP fallback。
    """
    task = queue.poll()
    if task is None:
        return PollResponse()
    return PollResponse(
        task_id=task.task_id,
        type=task.task_type.value,
        params={
            "title": task.title,
            "url": task.url,
            "match_mode": task.match_mode.value,
            "prompt": task.prompt,
            "tab_url": task.tab_url,
        },
    )


class WriteResultRequest(BaseModel):
    markdown: str
    status: str = "done"
    url: str | None = None  # 实际 tab URL（含 mstk 等会话参数）


@app.post("/api/tasks/{task_id}/result", response_model=dict)
def write_result(task_id: str, req: WriteResultRequest):
    """Chrome 扩展回写处理结果。"""
    ok = queue.complete_task(task_id, req.markdown, req.status, url=req.url)
    if not ok:
        raise HTTPException(status_code=404, detail="task not found")
    return {"status": "ok", "task_id": task_id}


@app.get("/api/tasks/{task_id}/result", response_model=ResultResponse)
def get_result(task_id: str):
    task = queue.get_result(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return ResultResponse(
        task_id=task.task_id,
        status=task.status.value,
        markdown=task.markdown,
        title=task.title,
        url=task.url,
        tab_url=task.tab_url,
    )


def main(port: int = 8765) -> None:
    """启动 FastAPI 服务（独立运行模式）。"""
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


def check_health(port: int = 8765, timeout: float = 0.5) -> bool:
    """探测端口上是否已有健康的 web2md bridge 服务。"""
    try:
        import httpx
        resp = httpx.get(f"http://127.0.0.1:{port}/health",
                         timeout=timeout, trust_env=False)
        return resp.status_code == 200
    except Exception:
        return False


if __name__ == "__main__":
    main()