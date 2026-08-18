/// <reference types="wxt-vite-plugin" />

/** web2md — background service worker 入口。

职责：健康检查、任务轮询、任务分发。
所有具体逻辑拆分到独立模块。
*/

import { validateUrl } from "@/utils/url-validator";
import { isBlacklisted } from "./blacklist";
import { cleanupOrphanTabs } from "./orphan-tabs";
import { matchTab, isContentScriptAlive } from "./tab-matcher";
import { extractFromTab } from "./extract-from-tab";
import { openAndExtractTab } from "./open-and-extract-tab";
import { openGrokAndAsk } from "./grok-task";
import { openGoogleAiAsk } from "./google-ai-task";
import { reportResult } from "./report-result";
import {
  FASTAPI_HOST,
  DEFAULT_PORT,
  HEALTH_ALARM,
  POLL_ALARM,
  POLL_PERIOD_MIN,
} from "./constants";

export default defineBackground(() => {
  console.log("web2md background service worker loaded");

  let port = DEFAULT_PORT;
  let fastapiOnline = false;
  let _busy = false; // 串行化：一次只处理一个任务

  // 加载端口配置
  chrome.storage.local.get("port", (result) => {
    if (result.port) port = Number(result.port);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.port) port = Number(changes.port.newValue);
  });

  // 包装 reportResult 闭包，注入 port 参数
  const rr = (taskId: string, markdown: string | null, status = "done", tabUrl?: string) =>
    reportResult(FASTAPI_HOST, port, taskId, markdown, status, tabUrl);

  // 包装 openAndExtractTab 闭包
  const oet = (url: string, taskId: string) =>
    openAndExtractTab(url, taskId, rr);

  // 确保目标标签页已注入 content script。
  // 扩展在 chrome://extensions 重载后，既有标签页不会自动重注入静态
  // content script，此时 sendMessage 会报 "Receiving end does not exist"。
  // 先 ping 探测，未存活则用 scripting.executeScript 按需注入。
  async function ensureContentScript(tabId: number): Promise<boolean> {
    if (await isContentScriptAlive(tabId)) return true;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-scripts/content.js"],
      });
      console.log("web2md: injected content script on demand, tab", tabId);
      return true;
    } catch (err) {
      console.error("web2md: inject content script failed", err);
      return false;
    }
  }

  // ── 右键菜单 ──────────────────────────────────────

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
  });

  // 健康检查 alarm：每次 SW 启动都创建（幂等）。
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.05 }); // 3s

  // SW 启动时立即执行一次健康检查，不等第一个 alarm 触发。
  // 解决首次使用的冷启动延迟：Service Worker 冷启动后最快 3s 才触发
  // alarm，但此时 MCP 可能已经在等任务完成。立即触发健康检查可以
  // 让扩展在首次任务创建前就完成 FastAPI 连接检测，进入轮询状态。
  handleHealthCheck();

  // SW 重启时清理孤儿标签
  chrome.runtime.onStartup?.addListener(cleanupOrphanTabs);

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "web2md-copy" && tab?.id) {
      if (await isBlacklisted(tab.url)) {
        console.log("web2md: blacklisted, skip copy", tab.url);
        return;
      }
      if (!(await ensureContentScript(tab.id))) return;
      chrome.tabs.sendMessage(
        tab.id,
        { type: "web2md_extract", contentMode: "article" },
        (response) => {
          if (response?.markdown) {
            chrome.tabs.sendMessage(tab!.id!, {
              type: "web2md_clipboard",
              text: response.markdown,
            });
          }
        }
      );
    }
    if (info.menuItemId === "web2md-send" && tab?.id) {
      if (await isBlacklisted(tab.url)) {
        console.log("web2md: blacklisted, skip send", tab.url);
        return;
      }
      if (!(await ensureContentScript(tab.id))) return;
      chrome.tabs.sendMessage(
        tab.id,
        { type: "web2md_extract", contentMode: "article" },
        async (response) => {
          if (response?.markdown) {
            const p = await chrome.storage.local
              .get("port")
              .then((r) => r.port || DEFAULT_PORT);
            try {
              await fetch(`${FASTAPI_HOST}:${p}/api/tasks/create`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  tasks: [
                    { title: tab.title, url: tab.url, match_mode: "auto" },
                  ],
                  contentMode: "article",
                }),
              });
            } catch (err) {
              console.error("web2md: send to fastapi failed", err);
            }
          }
        }
      );
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
        chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MIN });
      } else {
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

    if (_busy) return;

    try {
      const resp = await fetch(`${FASTAPI_HOST}:${port}/api/tasks/poll`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.task_id) return;

      _busy = true;
      try {
        await executeTask(data.task_id, data.params, data.type);
      } finally {
        _busy = false;
      }
    } catch {
      _busy = false;
    }
  }

  // ── 任务执行 ────────────────────────────────────

  async function executeTask(
    taskId: string,
    params: any,
    taskType?: string
  ) {
    // google_ai_ask 任务：向 Google AI Mode 提问（多轮追问）
    if (taskType === "google_ai_ask" || params?.task_type === "google_ai_ask") {
      await openGoogleAiAsk(taskId, params, rr);
      return;
    }

    // grok_ask 任务：向 Grok AI 提问
    if (taskType === "grok_ask" || params?.task_type === "grok_ask") {
      await openGrokAndAsk(taskId, params, rr);
      return;
    }

    const tab = await matchTab(params);
    if (!tab || !tab.id) {
      console.log("web2md: no matching tab for task", taskId, params);
      const url = params?.url;
      if (url) {
        console.log("[web2md-diag] executeTask -> openAndExtractTab", {
          taskId,
          url,
        });
        await oet(url, taskId);
      } else {
        await rr(taskId, null, "failed");
      }
      return;
    }

    if (await isBlacklisted(tab.url)) {
      console.log("web2md: blacklisted, task failed", taskId, tab.url);
      await rr(taskId, null, "failed");
      return;
    }

    // CS 存活性验证
    if (!(await isContentScriptAlive(tab.id))) {
      console.log(
        "web2md: stale tab (CS not alive), falling back to openAndExtractTab",
        { taskId, tabId: tab.id }
      );
      const url = params?.url;
      if (url) {
        await oet(url, taskId);
      } else {
        await rr(taskId, null, "failed");
      }
      return;
    }

    const markdown = await extractFromTab(tab.id);
    await rr(taskId, markdown);
  }
});