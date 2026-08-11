"""web2md — Task 数据模型。

Task 是插件与 FastAPI 之间传递的最小工作单元。
"""
from __future__ import annotations

import enum
import time
import uuid


class TaskStatus(str, enum.Enum):
    """任务状态机。"""
    PENDING = "pending"       # 已创建，等待插件/fallback 处理
    PROCESSING = "processing"  # 已被插件取走，正在转换
    DONE = "done"             # 已完成，结果已写入
    FAILED = "failed"         # 处理失败


class MatchMode(str, enum.Enum):
    """标签页匹配模式。"""
    TITLE = "title"   # 按标题匹配
    URL = "url"       # 按 URL 匹配
    AUTO = "auto"     # 自动（URL 优先，其次标题）


class ContentMode(str, enum.Enum):
    """内容模式。"""
    FULL = "full"      # 完整页面
    ARTICLE = "article"  # 仅正文


class Task:
    """内存中的一个任务。"""

    __slots__ = (
        "task_id", "title", "url", "match_mode",
        "status", "markdown", "created_at", "completed_at",
    )

    def __init__(
        self,
        title: str | None = None,
        url: str | None = None,
        match_mode: str = "auto",
    ) -> None:
        self.task_id = uuid.uuid4().hex[:12]
        self.title = title
        self.url = url
        self.match_mode = MatchMode(match_mode)
        self.status = TaskStatus.PENDING
        self.markdown: str | None = None
        self.created_at = time.time()
        self.completed_at: float | None = None

    def to_dict(self) -> dict:
        """序列化为可 JSON 化的字典。"""
        return {
            "task_id": self.task_id,
            "title": self.title,
            "url": self.url,
            "match_mode": self.match_mode.value,
            "status": self.status.value,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }