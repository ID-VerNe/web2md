"""web2md fastapi-bridge 包。

提供 web2md 的 FastAPI app（Chrome 扩展通过 HTTP 连接）与任务队列。
2006-08-14 协调：MCP server 直接引用本包，不再 fork uvicorn 子进程。
"""