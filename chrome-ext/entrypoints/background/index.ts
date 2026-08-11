/// <reference types="wxt-vite-plugin" />

export default defineBackground(() => {
  console.log("web2md background service worker loaded");

  const FASTAPI_HOST = "http://127.0.0.1";
  const DEFAULT_PORT = 8765;
  const HEALTH_ALARM = "web2md-health";
  const POLL_ALARM = "web2md-poll";

  let port = DEFAULT_PORT;
  let fastapiOnline = false;

  // 加载端口配置
  chrome.storage.local.get("port", (result) => {
    if (result.port) port = Number(result.port);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.port) port = Number(changes.port.newValue);
  });

  // ── 右键菜单 ────────────────────────────────────

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: "web2md-copy",
      title: "复制为 Markdown",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "web2md-send",
      title: "发送到 FastAPI",
      contexts: ["page"],
    });
    // 启动健康检查 alarm
    chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.25 }); // 15s
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "web2md-copy" && tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "web2md_extract", contentMode: "article" }, (response) => {
        if (response?.markdown) {
          chrome.tabs.sendMessage(tab!.id!, { type: "web2md_clipboard", text: response.markdown });
        }
      });
    }
    if (info.menuItemId === "web2md-send" && tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "web2md_extract", contentMode: "article" }, async (response) => {
        if (response?.markdown) {
          const p = await chrome.storage.local.get("port").then(r => r.port || DEFAULT_PORT);
          try {
            await fetch(`${FASTAPI_HOST}:${p}/api/tasks/create`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tasks: [{ title: tab.title, url: tab.url, match_mode: "auto" }],
                contentMode: "article",
              }),
            });
          } catch (err) {
            console.error("web2md: send to fastapi failed", err);
          }
        }
      });
    }
  });

  // ── Alarm 驱动 ──────────────────────────────────

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === HEALTH_ALARM) {
      await handleHealthCheck();
    } else if (alarm.name === POLL_ALARM) {
      await handlePoll();
    }
  });

  async function handleHealthCheck() {
    try {
      const resp = await fetch(`${FASTAPI_HOST}:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      fastapiOnline = resp.ok;

      if (fastapiOnline) {
        // FastAPI 在线 → 启动 1s 轮询 alarm
        chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 / 60 });
      } else {
        // 离线 → 关闭轮询 alarm
        chrome.alarms.clear(POLL_ALARM);
      }
    } catch {
      fastapiOnline = false;
      chrome.alarms.clear(POLL_ALARM);
    }
  }

  async function handlePoll() {
    if (!fastapiOnline) {
      chrome.alarms.clear(POLL_ALARM);
      return;
    }

    try {
      const resp = await fetch(`${FASTAPI_HOST}:${port}/api/tasks/poll`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.task_id) return;

      // 有任务 → 执行
      await executeTask(data.task_id, data.params);
    } catch {
      // 轮询失败，可能是 FastAPI 挂了
    }
  }

  // ── 任务执行 ────────────────────────────────────

  async function matchTab(params: any): Promise<chrome.tabs.Tab | null> {
    const matchMode = params?.match_mode || "auto";
    const title = params?.title;
    const url = params?.url;

    const allTabs = await chrome.tabs.query({});

    if (matchMode === "title" && title) {
      const exact = allTabs.find((t) => t.title === title);
      if (exact) return exact;
      const lower = title.toLowerCase();
      return allTabs.find((t) => t.title && t.title.toLowerCase().includes(lower)) ?? null;
    }

    if (matchMode === "url" && url) {
      return matchUrl(allTabs, url);
    }

    if (matchMode === "auto") {
      if (url) {
        const matched = matchUrl(allTabs, url);
        if (matched) return matched;
      }
      if (title) {
        const lower = title.toLowerCase();
        return allTabs.find((t) => t.title && t.title.toLowerCase().includes(lower)) ?? null;
      }
    }

    return null;
  }

  function matchUrl(tabs: chrome.tabs.Tab[], url: string): chrome.tabs.Tab | null {
    const exact = tabs.find((t) => t.url === url);
    if (exact) return exact;

    try {
      const targetUrl = new URL(url);
      const targetPath = targetUrl.pathname;

      const pathMatch = tabs.find((t) => {
        try {
          if (!t.url) return false;
          const tu = new URL(t.url);
          return tu.hostname === targetUrl.hostname && tu.pathname === targetPath;
        } catch { return false; }
      });
      if (pathMatch) return pathMatch;

      const hostMatch = tabs.find((t) => {
        try {
          if (!t.url) return false;
          const tu = new URL(t.url);
          return tu.hostname === targetUrl.hostname;
        } catch { return false; }
      });
      if (hostMatch) return hostMatch;
    } catch {
      return tabs.find((t) => t.url && t.url.includes(url)) ?? null;
    }

    return null;
  }

  async function executeTask(taskId: string, params: any) {
    const tab = await matchTab(params);
    if (!tab || !tab.id) {
      console.log("web2md: no matching tab for task", taskId, params);
      await reportResult(taskId, null, "failed");
      return;
    }

    let markdown: string | null = null;

    // 尝试 content script 消息（重试 5 次）
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "web2md_extract",
          contentMode: "article",
        });
        if (response?.markdown) {
          markdown = response.markdown;
          break;
        }
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
      }
    }

    // 兜底：编程式注入
    if (!markdown) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const article = document.querySelector("article") ||
              document.querySelector('[role="main"]') || document.querySelector("main");
            return article ? article.innerText || "" : document.body?.innerText || "";
          },
        });
        markdown = results?.[0]?.result || null;
      } catch (err) {
        console.error("web2md: executeScript fallback failed", err);
      }
    }

    await reportResult(taskId, markdown);
  }

  async function reportResult(taskId: string, markdown: string | null, status = "done") {
    try {
      await fetch(`${FASTAPI_HOST}:${port}/api/tasks/${taskId}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: markdown ?? "",
          status: markdown ? status : "failed",
        }),
      });
    } catch (err) {
      console.error("web2md: report result failed", err);
    }
  }
});