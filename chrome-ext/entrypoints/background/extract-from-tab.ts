/// <reference types="wxt-vite-plugin" />

/** web2md — 从标签页提取 markdown：content script 消息优先，兜底 executeScript。 */

/** 从已加载标签页提取 markdown。
 * requestedUrl 用于 content script 校验 JS 层重定向（SO 的
 * history.replaceState）。openAndExtractTab 传请求 URL；executeTask
 * 匹配已有 tab 时传 tab.url（匹配到的 tab 即目标，无需校验，传
 * undefined 跳过）。 */
export async function extractFromTab(
  tabId: number,
  requestedUrl?: string
): Promise<string | null> {
  let markdown: string | null = null;
  let csResponse: any = null;

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
        console.log("[web2md-diag] content script reported redirect", {
          tabId,
          requestedUrl,
        });
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
          const article =
            document.querySelector("article") ||
            document.querySelector('[role="main"]') ||
            document.querySelector("main");
          return article
            ? article.innerText || ""
            : document.body?.innerText || "";
        },
      });
      execResult = results?.[0]?.result;
      markdown = execResult || null;
    } catch (err) {
      execResult = { error: String(err) };
      console.error("web2md: executeScript fallback failed", err);
    }
  }

  // 诊断日志
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