/// <reference types="wxt-vite-plugin" />

/** web2md — 标签页匹配逻辑。 */

/** 按参数匹配一个已有标签页。匹配模式：
 * - "title"：精确或部分匹配标签页标题
 * - "url"：按 hostname + pathname 匹配 URL
 * - "auto"：URL 优先，其次标题 */
export async function matchTab(
  params: any
): Promise<chrome.tabs.Tab | null> {
  const matchMode = params?.match_mode || "auto";
  const title = params?.title;
  const url = params?.url;

  const allTabs = await chrome.tabs.query({});

  if (matchMode === "title" && title) {
    const exact = allTabs.find((t) => t.title === title);
    if (exact) return exact;
    const lower = title.toLowerCase();
    return (
      allTabs.find((t) => t.title && t.title.toLowerCase().includes(lower)) ??
      null
    );
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
      return (
        allTabs.find(
          (t) => t.title && t.title.toLowerCase().includes(lower)
        ) ?? null
      );
    }
  }

  return null;
}

/** 按 URL 匹配标签页：精确 match → hostname+pathname。 */
export function matchUrl(
  tabs: chrome.tabs.Tab[],
  url: string
): chrome.tabs.Tab | null {
  const exact = tabs.find((t) => t.url === url);
  if (exact) return exact;

  try {
    const targetUrl = new URL(url);
    const targetPath = targetUrl.pathname;

    return (
      tabs.find((t) => {
        try {
          if (!t.url) return false;
          const tu = new URL(t.url);
          return tu.hostname === targetUrl.hostname && tu.pathname === targetPath;
        } catch {
          return false;
        }
      }) ?? null
    );
  } catch {
    return tabs.find((t) => t.url && t.url.includes(url)) ?? null;
  }
}

/** 验证标签页中 content script 是否存活（ping 探测）。 */
export async function isContentScriptAlive(
  tabId: number
): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "web2md_ping",
    });
    return response?.pong === true;
  } catch {
    return false;
  }
}