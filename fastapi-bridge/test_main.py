"""测试 FastAPI 桥接服务（models + queue + main）。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# 确保本目录在 path 中，可直接 import 模块名
DIR = Path(__file__).resolve().parent
if str(DIR) not in sys.path:
    sys.path.insert(0, str(DIR))

from models import Task, TaskStatus, MatchMode  # noqa: E402
from task_queue import TaskQueue  # noqa: E402
from main import app  # noqa: E402


# ── models 测试 ───────────────────────────────────────

class TestTask:
    def test_create_defaults(self):
        task = Task()
        assert task.status == TaskStatus.PENDING
        assert task.match_mode == MatchMode.AUTO
        assert task.markdown is None
        assert task.completed_at is None
        assert len(task.task_id) == 12

    def test_create_with_title_and_url(self):
        task = Task(title="test", url="https://example.com", match_mode="title")
        assert task.title == "test"
        assert task.url == "https://example.com"
        assert task.match_mode == MatchMode.TITLE

    def test_to_dict(self):
        task = Task(title="t", url="https://x.com")
        d = task.to_dict()
        assert d["title"] == "t"
        assert d["url"] == "https://x.com"
        assert d["status"] == "pending"
        assert d["match_mode"] == "auto"
        assert "task_id" in d
        assert "created_at" in d

    def test_to_dict_includes_none_title(self):
        task = Task()
        d = task.to_dict()
        assert d["title"] is None

    def test_task_id_is_12_chars(self):
        """task_id 必须是 12 字符十六进制。"""
        task = Task()
        assert len(task.task_id) == 12
        # 十六进制字符校验
        assert all(c in "0123456789abcdef" for c in task.task_id)
        # 每次创建不同
        assert Task().task_id != task.task_id

    def test_match_mode_auto_by_default(self):
        task = Task()
        assert task.match_mode == MatchMode.AUTO


# ── queue 测试 ────────────────────────────────────────

class TestTaskQueue:
    def setup_method(self):
        from task_queue import TaskQueue
        self.q = TaskQueue()

    def test_create_one_task(self):
        tasks = self.q.create_tasks([{"title": "hello"}])
        assert len(tasks) == 1
        assert tasks[0].title == "hello"
        assert self.q.total_count == 1
        assert self.q.pending_count == 1

    def test_create_multiple_tasks(self):
        tasks = self.q.create_tasks([
            {"title": "a"},
            {"title": "b"},
        ])
        assert len(tasks) == 2
        assert self.q.pending_count == 2

    def test_poll_returns_fifo(self):
        self.q.create_tasks([
            {"title": "first"},
            {"title": "second"},
        ])
        t1 = self.q.poll()
        t2 = self.q.poll()
        assert t1 is not None and t1.title == "first"
        assert t2 is not None and t2.title == "second"

    def test_poll_marks_processing(self):
        self.q.create_tasks([{"title": "x"}])
        task = self.q.poll()
        assert task is not None
        assert task.status == TaskStatus.PROCESSING

    def test_poll_returns_none_when_empty(self):
        assert self.q.poll() is None

    def test_poll_does_not_return_processing_tasks(self):
        self.q.create_tasks([{"title": "x"}])
        self.q.poll()
        assert self.q.poll() is None

    def test_complete_task(self):
        self.q.create_tasks([{"title": "x"}])
        task = self.q.poll()
        assert task is not None
        ok = self.q.complete_task(task.task_id, "# hello")
        assert ok is True
        result = self.q.get_result(task.task_id)
        assert result is not None
        assert result.markdown == "# hello"
        assert result.status == TaskStatus.DONE

    def test_complete_nonexistent_task(self):
        ok = self.q.complete_task("nonexistent", "md")
        assert ok is False

    def test_get_result_returns_none_for_missing(self):
        assert self.q.get_result("missing") is None

    def test_get_all_tasks(self):
        self.q.create_tasks([{"title": "a"}, {"title": "b"}])
        assert len(self.q.get_all_tasks()) == 2


# ── main (FastAPI) 测试 ───────────────────────────────

class TestFastAPI:
    def setup_method(self):
        self.client = TestClient(app)
        # 清空队列（每个测试独立）
        import main as m
        from task_queue import TaskQueue
        m.queue = TaskQueue()

    def test_health(self):
        resp = self.client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "uptime" in data
        assert "pending" in data
        assert "total" in data

    def test_create_tasks(self):
        resp = self.client.post("/api/tasks/create", json={
            "tasks": [
                {"title": "Paper 1", "url": "https://arxiv.org/abs/1234"},
                {"title": "Paper 2", "url": "https://arxiv.org/abs/5678"},
            ],
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["queue_id"] == "q_main"
        assert len(data["tasks"]) == 2
        assert data["tasks"][0]["title"] == "Paper 1"

    def test_poll_returns_task(self):
        self.client.post("/api/tasks/create", json={
            "tasks": [{"title": "Test", "url": "https://example.com"}],
        })
        resp = self.client.get("/api/tasks/poll")
        assert resp.status_code == 200
        data = resp.json()
        assert data["task_id"] is not None
        assert data["type"] == "extract"
        assert data["params"]["title"] == "Test"

    def test_poll_empty_when_no_tasks(self):
        resp = self.client.get("/api/tasks/poll")
        assert resp.status_code == 200
        assert resp.json()["task_id"] is None

    def test_write_and_read_result(self):
        # 创建并 poll 出 task
        cr = self.client.post("/api/tasks/create", json={
            "tasks": [{"title": "X", "url": "https://x.com"}],
        }).json()
        task_id = cr["tasks"][0]["task_id"]
        self.client.get("/api/tasks/poll")

        # 回写结果
        wr = self.client.post(f"/api/tasks/{task_id}/result", json={
            "markdown": "# Hello\n\nWorld",
            "status": "done",
        })
        assert wr.status_code == 200

        # 读取结果
        rr = self.client.get(f"/api/tasks/{task_id}/result")
        assert rr.status_code == 200
        rdata = rr.json()
        assert rdata["markdown"] == "# Hello\n\nWorld"
        assert rdata["status"] == "done"
        assert rdata["title"] == "X"

    def test_write_result_nonexistent_task(self):
        resp = self.client.post("/api/tasks/nonexistent/result", json={
            "markdown": "md",
        })
        assert resp.status_code == 404

    def test_get_result_nonexistent_task(self):
        resp = self.client.get("/api/tasks/nonexistent/result")
        assert resp.status_code == 404