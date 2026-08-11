import { defineContentScript } from "wxt/utils/define-content-script";
import { debugDomStructure } from "@/utils/converter";
import { registerAll, match } from "@/utils/extractors";

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    // 注册站点专用提取器 + 通用兜底
    registerAll();

    // 检查黑名单
    chrome.storage.local.get("blacklist", (result) => {
      const blacklist: string[] = result.blacklist || [];
      const url = window.location.href;
      const matched = blacklist.some((rule) => {
        const pattern = rule.replace(/\*/g, ".*");
        return new RegExp(pattern).test(url);
      });
      if (matched) {
        console.log("web2md: blacklisted, skipping", url);
        return;
      }
    });

    chrome.runtime.onMessage.addListener(
      (
        message: any,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void
      ) => {
        if (message.type === "web2md_extract") {
          const contentMode = message.contentMode || "article";
          const url = window.location.href;
          const extractor = match(url);

          if (!extractor) {
            // 理论上不会走到这里（通用提取器永远匹配），防御兜底
            sendResponse({ markdown: document.body?.innerText || "", source: "fallback" });
            return true;
          }

          extractor
            .extract(document, { contentMode })
            .then((markdown) => {
              if (markdown) sendResponse({ markdown, source: extractor.id });
              else {
                // 专用提取返回 null/空 → 回退纯文本
                sendResponse({ markdown: document.body?.innerText || "", source: "fallback" });
              }
            })
            .catch(() =>
              sendResponse({ markdown: document.body?.innerText || "", source: "fallback" })
            );

          return true;
        }

        if (message.type === "web2md_debug_dom") {
          const structure = debugDomStructure(document, message.maxDepth || 6, message.maxChildren || 15);
          const title = document.title;
          const url = window.location.href;
          sendResponse({ title, url, structure });
          return true;
        }

        if (message.type === "web2md_clipboard" && message.text) {
          navigator.clipboard.writeText(message.text).catch(console.error);
          return true;
        }
      }
    );
  },
});