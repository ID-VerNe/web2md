/// <reference types="wxt-vite-plugin" />

/** web2md — 标签页等待工具函数。

SPA 在 status=complete 后仍在异步渲染正文，固定等待抓到的是导航壳。
这些函数提供内容就绪轮询。
*/

// 通用内容容器选择器。注意：main/[role=main]/article 在部分 SPA
// （ModelScope）首屏导航壳里就存在且文本 >200，会误判为"内容就绪"。
// 命中站点的场景用 siteContentSelectors 覆盖，不用这一组。
export const GENERIC_CONTENT_SELECTORS = [
  "article", '[role="main"]', "main",
  ".repository-content", "#readme", ".markdown-body",
  "#content", ".mw-parser-output",
  ".post-content", ".entry-content",
];

/** 站点专用内容容器选择器。
 * 专属容器在渲染完成前不存在，天然是"内容就绪"信号。
 * 命中站点时只返回这些容器，不用通用选择器。 */
export function siteContentSelectors(url: string): string[] {
  try {
    const host = new URL(url).hostname;
    if (host.includes("modelscope.cn")) return [".ms-markdown-wrapper"];
    if (host.includes("huggingface.co")) return [".model-card-content.prose"];
    if (host.includes("github.com"))
      return ["article.markdown-body", ".repository-content", "#readme"];
    if (host.includes("npmjs.com")) return ["#readme"];
    if (
      host.includes("stackoverflow") ||
      host.includes("stackexchange") ||
      host.includes("serverfault") ||
      host.includes("superuser") ||
      host.includes("askubuntu") ||
      host.includes("mathoverflow")
    )
      return ["#question"];
    if (
      host.includes("google.com") &&
      new URL(url).searchParams.get("udm") === "50"
    )
      return [
        '[data-scope-id="turn"][data-complete="true"]:has(button[aria-label="复制文字"])',
      ];
    if (
      (host.includes("x.com") || host.includes("twitter.com")) &&
      new URL(url).pathname.startsWith("/i/grok")
    ) {
      return [
        'button[aria-label="复制文本"], button[aria-label="Copy text"]',
      ];
    }
  } catch {
    return [];
  }
  return [];
}

/** 等标签页 status === complete，再加 extraMs 给 SPA 渲染。 */
export function waitTabComplete(
  tabId: number,
  extraMs = 2000
): Promise<void> {
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

/** 轮询标签页中 selector 出现（SPA 惰性渲染）。 */
export async function waitForSelector(
  tabId: number,
  selector: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: (sel) => !!document.querySelector(sel),
        args: [selector],
      })
      .then((r) => !!r?.[0]?.result)
      .catch(() => false);
    if (found) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for selector ${selector}`);
}

/** 等内容容器出现且含 >200 字符文本。
 * 命中站点的容器渲染慢（ModelScope ~20s），单独给 30s 预算；
 * 通用页面 10s 足够。 */
export async function waitForContent(
  tabId: number,
  url: string,
  timeoutMs = 10000
): Promise<void> {
  const siteSelectors = siteContentSelectors(url);
  const selectors = siteSelectors.length
    ? siteSelectors
    : GENERIC_CONTENT_SELECTORS;
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
            if (!el) continue;
            const txt = (el.textContent || "").trim();
            if (txt.length > 200) return true;
            // 站点专用 icon-only 内容要素（如 Grok 的"复制文本"按钮）：
            // 文字在 aria-label，textContent 为空，存在即代表对话已渲染。
            if (
              el.tagName === "BUTTON" &&
              (el.getAttribute("aria-label") || "").length > 0
            ) {
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