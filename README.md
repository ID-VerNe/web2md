# web2md

网页转 Markdown，让 AI 能直接读。

通过 Chrome 插件 + FastAPI 桥接 + MCP 的三层架构，让 Claude Code 能直接抓取浏览器当前页面转为 Markdown，同时支持右键菜单手动复制。

## 项目结构

```
web2md/
├── mcp-server/          # Python MCP Server — Claude Code 通过它调用
├── fastapi-bridge/      # Python FastAPI — 任务队列 + fallback 抓取
├── chrome-ext/          # Chrome 插件 (MV3 + React + WXT)
└── .plan/               # 设计方案文档
```

## 快速开始

见各模块的 README。