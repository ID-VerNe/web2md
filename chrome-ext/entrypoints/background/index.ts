/// <reference types="wxt-vite-plugin" />

import { validateUrl, UnsafeUrlError, isRedirected } from "@/utils/url-validator";

export default defineBackground(() => {
  console.log("web2md background service worker loaded");

  const FASTAPI_HOST = "http://127.0.0.1";
  const DEFAULT_PORT = 8765;
  const HEALTH_ALARM = "web2md-health";
  const POLL_ALARM = "web2md-poll";

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
  });

  // 健康检查 alarm：每次 SW 启动都创建（幂等），不依赖 onInstalled。
  // onInstalled 在 chrome://extensions 手动 reload 时可能不触发，
  // 而 alarm 是 SW 启动后自动轮询的唯一入口，必须确保存在。
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.25 }); // 15s

  // SW 重启时清理孤儿标签：openAndExtractTab 开的后台标签若 SW 中途死掉，
  // 会留成孤儿。onStartup 时读 storage.session 的 orphan_* 记录逐个关闭。
  chrome.runtime.onStartup?.addListener(async () => {
    const all = await chrome.storage.session.get(null);
    const tabIds: number[] = [];
    for (const [key, val] of Object.entries(all)) {
      const m = key.match(/^orphan_(\d+)$/);
      if (m && val && typeof val === "object") tabIds.push(Number(m[1]));
    }
    for (const id of tabIds) {
      await chrome.tabs.remove(id).catch(() => {});
    }
    if (tabIds.length) {
      await chrome.storage.session.clear();
      console.log("web2md: cleaned orphan tabs on startup", tabIds.length);
    }
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "web2md-copy" && tab?.id) {
      if (await isBlacklisted(tab.url)) {
        console.log("web2md: blacklisted, skip copy", tab.url);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "web2md_extract", contentMode: "article" }, (response) => {
        if (response?.markdown) {
          chrome.tabs.sendMessage(tab!.id!, { type: "web2md_clipboard", text: response.markdown });
        }
      });
    }
    if (info.menuItemId === "web2md-send" && tab?.id) {
      if (await isBlacklisted(tab.url)) {
        console.log("web2md: blacklisted, skip send", tab.url);
        return;
      }
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

    // 串行化：上一个任务还在处理（开后台标签页 + 提取）就不取新任务，
    // 避免多个后台标签页并发导致 content script 消息错位、部分任务
    // 超时丢失结果。任务仍 PENDING → 下次 poll 再取。
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
        await executeTask(data.task_id, data.params);
      } finally {
        _busy = false;
      }
    } catch {
      // 轮询失败，可能是 FastAPI 挂了
      _busy = false;
    }
  }

  // ── 黑名单检查 ───────────────────────────────────

  async function isBlacklisted(url: string | undefined): Promise<boolean> {
    if (!url) return false;
    const result = await chrome.storage.local.get("blacklist");
    const rules: string[] = result.blacklist || [];
    return rules.some((rule) => {
      const pattern = rule.replace(/\*/g, ".*");
      return new RegExp(pattern).test(url);
    });
  }

  // ── 任务执行 ────────────────────────────────────

  // 验证标签页中 content script 是否存活。
  // 扩展重载后，已打开的标签页中的 content script 不会被重新注入，
  // 此时 matchUrl 仍可能匹配到旧标签页。如果 CS 无响应，视为不匹配，
  // 由调用方走 openAndExtractTab 开新标签页。
  async function isContentScriptAlive(tabId: number): Promise<boolean> {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "web2md_ping" });
      return response?.pong === true;
    } catch {
      return false;
    }
  }

  // 无匹配标签页时，开一个后台隐藏标签页抓取。
  // 配合 storage.session 记录已开 tabId，SW 重启时清理孤儿标签。
  // 插件在线 + 无匹配 → 这条路；插件离线 → MCP 端超时后走 HTTP fallback。
  async function openAndExtractTab(url: string, taskId: string): Promise<void> {
    // 1. URL 安全校验（SSRF 防护，与 fallback.py validate_url 同口径）
    try {
      validateUrl(url);
    } catch (e) {
      console.log("web2md: url rejected, task failed", taskId, url, (e as UnsafeUrlError).message);
      await reportResult(taskId, null, "failed");
      return;
    }

    // 2. 黑名单前置（在 content script 之外再拦一次）
    if (await isBlacklisted(url)) {
      console.log("web2md: blacklisted, task failed", taskId, url);
      await reportResult(taskId, null, "failed");
      return;
    }

    let tabId: number | undefined;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      if (!tabId) throw new Error("no tab id");

      // 4. 孤儿标签记录（SW 死掉时，下次启动能清理）
      await chrome.storage.session.set({
        [`orphan_${tabId}`]: { taskId, url, createdAt: Date.now() },
      });

      // 5. 等加载完成
      await waitTabComplete(tabId, 2000);

      // 5b. 等内容就绪：SPA（GitHub/React 等）在 status=complete 后
      // 仍在渲染，固定等待抓到的是导航壳。轮询常见内容容器出现且
      // 含 >200 字符文本再提取。SSR 页面立即满足。
      await waitForContent(tabId, url, 10000);

      // 重定向校验：对比请求 URL 与 tab 最终 URL 的 pathname。
      // 部分站点（Stack Overflow）对自动化/隐藏 tab 反制，把请求 URL
      // 重定向到另一个完全不同的页面（/questions/76161046 →
      // /questions/76152978）。这时提取到的是错误内容，比没有结果更糟
      // （污染数据），直接判 failed，不写回。
      // 合法 normalize（大小写归一、trailing slash、http→https）不影响，
      // 只比 normalize 后的 pathname，忽略 hash/query。
      const finalTab = await chrome.tabs.get(tabId);
      if (isRedirected(url, finalTab?.url)) {
        console.log(
          "[web2md-diag] redirected, task failed",
          { taskId, requested: url, final: finalTab?.url }
        );
        await reportResult(taskId, null, "failed");
        return;
      }

      // 6-8. 提取（content script 消息 + 兜底注入，与 executeTask 一致）
      const markdown = await extractFromTab(tabId, url);

      // 11. 回写结果
      await reportResult(taskId, markdown);
    } catch (err) {
      console.error("web2md: openAndExtractTab failed", taskId, err);
      await reportResult(taskId, null, "failed");
    } finally {
      // 9-10. 无论成败都关标签 + 清孤儿记录
      if (tabId !== undefined) {
        await chrome.tabs.remove(tabId).catch(() => {});
        await chrome.storage.session.remove(`orphan_${tabId}`).catch(() => {});
      }
    }
  }

  // 等标签页 status === complete，再加 extraMs 给 SPA 渲染
  function waitTabComplete(tabId: number, extraMs = 2000): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, extraMs);
      };
      const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
        if (id === tabId && info.status === "complete") finish();
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 可能已 complete
      chrome.tabs.get(tabId, (t) => {
        if (t?.status === "complete") finish();
      });
      // 超时兜底：60s 还没 complete 就放行（页面可能卡住）
      setTimeout(finish, 60000);
    });
  }

  // 通用内容容器选择器。注意：main/[role=main]/article 在部分 SPA
  // （ModelScope）首屏导航壳里就存在且文本 >200，会误判为“内容就绪”。
  // 命中站点的场景用 siteContentSelectors 覆盖，不用这一组。
  const GENERIC_CONTENT_SELECTORS = [
    "article", '[role="main"]', "main",
    ".repository-content", "#readme", ".markdown-body",
    "#content", ".mw-parser-output",
    ".post-content", ".entry-content",
  ];

  // 站点专用内容容器：SPA 在 status=complete 后仍异步渲染正文，
  // 通用选择器会命中导航壳导致提前提取。专属容器在渲染完成前不存在，
  // 天然是“内容就绪”信号；命中站点时只等这些容器。
  function siteContentSelectors(url: string): string[] {
    try {
      const host = new URL(url).hostname;
      if (host.includes("modelscope.cn")) return [".ms-markdown-wrapper"];
      if (host.includes("huggingface.co")) return [".model-card-content.prose"];
      if (host.includes("github.com")) return ["article.markdown-body", ".repository-content", "#readme"];
      if (host.includes("npmjs.com")) return ["#readme"];
      if (host.includes("stackoverflow") || host.includes("stackexchange") || host.includes("serverfault") || host.includes("superuser") || host.includes("askubuntu") || host.includes("mathoverflow")) return ["#question"];
      if (host.includes("google.com") && new URL(url).searchParams.get("udm") === "50") return ['[data-scope-id="turn"][data-complete="true"]:has(button[aria-label="复制文字"])'];
    } catch {
      return [];
    }
    return [];
  }

  // 等内容容器出现且含 >200 字符文本。SPA 在 status=complete 后仍
  // 在渲染（GitHub README、ModelScope 模型卡由客户端异步注入），固定
  // 等待抓到的是导航壳。SSR 页面（HN/Wikipedia）立即满足，0 等待。
  // 命中站点的容器渲染慢（ModelScope 卡片实测 ~20s），单独给 30s 预算；
  // 通用页面 10s 足够。
  async function waitForContent(tabId: number, url: string, timeoutMs = 10000): Promise<void> {
    const siteSelectors = siteContentSelectors(url);
    const selectors = siteSelectors.length ? siteSelectors : GENERIC_CONTENT_SELECTORS;
    const budget = siteSelectors.length ? 30000 : timeoutMs;
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      let hasContent = false;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sels: string[]) => {
            for (const sel of sels) {
              const el = document.querySelector(sel);
              if (el && el.textContent && el.textContent.trim().length > 200) {
                return true;
              }
            }
            return false;
          },
          args: [selectors],
        });
        hasContent = !!results?.[0]?.result;
      } catch {
        // 标签可能已关闭或无权限访问，不再等待
        return;
      }
      if (hasContent) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 从已加载标签页提取 markdown：content script 消息优先，兜底 executeScript
  // requestedUrl 用于 content script 校验 JS 层重定向（SO 的
  // history.replaceState）。openAndExtractTab 传请求 URL；executeTask
  // 匹配已有 tab 时传 tab.url（匹配到的 tab 即目标，无需校验，传
  // undefined 跳过）。
  async function extractFromTab(tabId: number, requestedUrl?: string): Promise<string | null> {
    let markdown: string | null = null;
    let csResponse: any = null; // 诊断：记录 content script 返回

  // content script 消息（重试 5 次），带上 expectedUrl 供 content script
    // 校验 JS 层重定向（SO 的 history.replaceState）。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: "web2md_extract",
          contentMode: "article",
          expectedUrl: requestedUrl,
        });
        csResponse = response;
        if (response?.source === "redirected") {
          // JS 层重定向：SO 把请求的问题 ID 换成了另一个。返回 null 让
          // 上层 reportResult(status=failed)，不写回错误页面内容。
          console.log("[web2md-diag] content script reported redirect", { tabId, requestedUrl });
          return null;
        }
        if (response?.markdown) {
          markdown = response.markdown;
          break;
        }
      } catch (e) {
        csResponse = { error: String(e) };
        if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
      }
    }

    // 兜底：编程式注入
    let execResult: any = null;
    if (!markdown) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const article = document.querySelector("article") ||
              document.querySelector('[role="main"]') || document.querySelector("main");
            return article ? article.innerText || "" : document.body?.innerText || "";
          },
        });
        execResult = results?.[0]?.result;
        markdown = execResult || null;
      } catch (err) {
        execResult = { error: String(err) };
        console.error("web2md: executeScript fallback failed", err);
      }
    }

    // 诊断：提取链路结果（临时，定位 HN/GitHub/Wikipedia 提取失败用）
    // 用 JSON.stringify 让字段值直接显示在 console 文本里，不用展开 Object
    const docTitle = (await chrome.tabs.get(tabId))?.title;
    console.log(
      "[web2md-diag] extractFromTab " +
        JSON.stringify({
          tabId,
          csSource: csResponse?.source ?? null,
          csExtractorLen: csResponse?.extractorLen ?? null,
          csExtractorError: csResponse?.extractorError ?? null,
          csMarkdownLen: csResponse?.markdown?.length ?? 0,
          csError: csResponse?.error ?? null,
          execLen: typeof execResult === "string" ? execResult.length : 0,
          finalLen: markdown?.length ?? 0,
          docTitle,
          preview: markdown ? markdown.slice(0, 200) : null,
        })
    );

    return markdown;
  }

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
    // 精确 URL 匹配
    const exact = tabs.find((t) => t.url === url);
    if (exact) return exact;

    try {
      const targetUrl = new URL(url);
      const targetPath = targetUrl.pathname;

      // 路径级匹配：同 hostname + 同 pathname
      return tabs.find((t) => {
        try {
          if (!t.url) return false;
          const tu = new URL(t.url);
          return tu.hostname === targetUrl.hostname && tu.pathname === targetPath;
        } catch {
          return false;
        }
      }) ?? null;
      // 不再做 hostname 模糊降级：同站任意标签页几乎一定不是目标页，
      // 匹配错标签会拿到无关内容。返回 null → openAndExtractTab 开新页。
    } catch {
      // URL 解析失败，退化到 includes（极少见）
      return tabs.find((t) => t.url && t.url.includes(url)) ?? null;
    }
  }

  async function executeTask(taskId: string, params: any) {
    const tab = await matchTab(params);
    if (!tab || !tab.id) {
      console.log("web2md: no matching tab for task", taskId, params);
      // 有 url → 自动开后台标签页抓取；无 url（纯 title 匹配）→ 报 failed
      const url = params?.url;
      if (url) {
        console.log("[web2md-diag] executeTask -> openAndExtractTab", { taskId, url });
        await openAndExtractTab(url, taskId);
      } else {
        await reportResult(taskId, null, "failed");
      }
      return;
    }

    if (await isBlacklisted(tab.url)) {
      console.log("web2md: blacklisted, task failed", taskId, tab.url);
      await reportResult(taskId, null, "failed");
      return;
    }

    // CS 存活性验证：扩展重载后旧标签页的 CS 不会被重新注入，
    // 匹配到但 CS 不通 → 视为不匹配，走 openAndExtractTab 开新标签页。
    if (!(await isContentScriptAlive(tab.id))) {
      console.log("web2md: stale tab (CS not alive), falling back to openAndExtractTab", { taskId, tabId: tab.id });
      const url = params?.url;
      if (url) {
        await openAndExtractTab(url, taskId);
      } else {
        await reportResult(taskId, null, "failed");
      }
      return;
    }

    // 复用 openAndExtractTab 的提取逻辑
    const markdown = await extractFromTab(tab.id);
    await reportResult(taskId, markdown);
  }

  async function reportResult(taskId: string, markdown: string | null, status = "done") {
    try {
      const resp = await fetch(`${FASTAPI_HOST}:${port}/api/tasks/${taskId}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: markdown ?? "",
          status: markdown ? status : "failed",
        }),
      });
      const text = await resp.text();
      console.log("[web2md-diag] reportResult", { taskId, status, markdownLen: (markdown ?? "").length, httpStatus: resp.status, body: text });
    } catch (err) {
      console.error("web2md: report result failed", err);
    }
  }
});