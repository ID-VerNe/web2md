"""web2md — 内存任务队列。

线程安全的 FIFO 任务队列，支持：
- 创建任务（批量）
- 取下一个待处理任务（poll，FIFO）
- 回写结果
- 按 task_id 查询结果
"""
from __future__ import annotations

import threading
from collections import deque
from typing import Any

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from models import Task, TaskStatus  # noqa: E402


class TaskQueue:
    """线程安全的内存任务队列。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tasks: dict[str, Task] = {}
        self._pending: deque[str] = deque()

    def create_tasks(self, items: list[dict[str, Any]]) -> list[Task]:
        """批量创建任务，返回已创建的 Task 列表。"""
        tasks: list[Task] = []
        with self._lock:
            for item in items:
                task = Task(
                    title=item.get("title"),
                    url=item.get("url"),
                    match_mode=item.get("match_mode", "auto"),
                    task_type=item.get("task_type", "extract"),
                    prompt=item.get("prompt"),
                )
                self._tasks[task.task_id] = task
                self._pending.append(task.task_id)
                tasks.append(task)
        return tasks

    def poll(self) -> Task | None:
        """取出下一个待处理任务（FIFO），将其状态置为 PROCESSING。"""
        with self._lock:
            while self._pending:
                task_id = self._pending.popleft()
                task = self._tasks.get(task_id)
                if task and task.status == TaskStatus.PENDING:
                    task.status = TaskStatus.PROCESSING
                    return task
            return None

    def complete_task(
        self, task_id: str, markdown: str, status: str = "done",
    ) -> bool:
        """回写任务结果。"""
        import time
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return False
            task.markdown = markdown
            task.status = TaskStatus(status)
            task.completed_at = time.time()
            return True

    def get_result(self, task_id: str) -> Task | None:
        """按 task_id 查询任务（含结果）。"""
        with self._lock:
            return self._tasks.get(task_id)

    def get_all_tasks(self) -> list[Task]:
        """返回所有任务（用于调试/管理）。"""
        with self._lock:
            return list(self._tasks.values())

    @property
    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending)

    @property
    def total_count(self) -> int:
        with self._lock:
            return len(self._tasks)