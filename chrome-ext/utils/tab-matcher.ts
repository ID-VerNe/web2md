/** web2md — 标签页匹配工具。

封装 chrome.tabs API，提供统一匹配接口。
*/

export interface MatchParams {
  title?: string;
  url?: string;
  match_mode?: "title" | "url" | "auto";
}

/**
 * 按 match_mode 匹配标签页。
 * - "title": 先精确匹配标题，再模糊匹配
 * - "url": 先精确匹配 URL，再通配匹配
 * - "auto": URL 优先，其次标题
 */
export async function matchTab(params: MatchParams): Promise<chrome.tabs.Tab | null> {
  const mode = params.match_mode || "auto";

  if (mode === "title" && params.title) {
    const exact = await chrome.tabs.query({ title: params.title });
    if (exact.length > 0) return exact[0];
    return fuzzyMatchTitle(params.title);
  }

  if (mode === "url" && params.url) {
    const exact = await chrome.tabs.query({ url: params.url });
    if (exact.length > 0) return exact[0];
    return fuzzyMatchUrl(params.url);
  }

  if (mode === "auto") {
    if (params.url) {
      const exact = await chrome.tabs.query({ url: params.url });
      if (exact.length > 0) return exact[0];
    }
    if (params.title) {
      const exact = await chrome.tabs.query({ title: params.title });
      if (exact.length > 0) return exact[0];
      return fuzzyMatchTitle(params.title);
    }
  }

  return null;
}

async function fuzzyMatchTitle(title: string): Promise<chrome.tabs.Tab | null> {
  const all = await chrome.tabs.query({});
  const lower = title.toLowerCase();
  return all.find(
    (t) => t.title && t.title.toLowerCase().includes(lower)
  ) ?? null;
}

async function fuzzyMatchUrl(url: string): Promise<chrome.tabs.Tab | null> {
  const all = await chrome.tabs.query({});
  try {
    const host = new URL(url).hostname;
    return all.find((t) => t.url && t.url.includes(host)) ?? null;
  } catch {
    return all.find((t) => t.url && t.url.includes(url)) ?? null;
  }
}