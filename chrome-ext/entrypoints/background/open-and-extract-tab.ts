/// <reference types="wxt-vite-plugin" />

/** web2md — 无匹配标签页时，开一个后台隐藏标签页抓取。

配合 storage.session 记录已开 tabId，SW 重启时清理孤儿标签。
插件在线 + 无匹配 → 这条路；插件离线 → MCP 端超时后走 HTTP fallback。
*/

import { validateUrl, UnsafeUrlError, isRedirected } from "@/utils/url-validator";
import { isBlacklisted } from "./blacklist";
import { trackOrphanTab } from "./orphan-tabs";
import { forgetOrphanTab } from "./orphan-tabs";
import { waitTabComplete, waitForContent } from "./tab-utils";
import { extractFromTab } from "./extract-from-tab";

export async function openAndExtractTab(
  url: string,
  taskId: string,
  reportResult: (
    taskId: string,
    markdown: string | null,
    status?: string
  ) => Promise<void>
): Promise<void> {
  // 1. URL 安全校验（SSRF 防护，与 fallback.py validate_url 同口径）
  try {
    validateUrl(url);
  } catch (e) {
    console.log(
      "web2md: url rejected, task failed",
      taskId,
      url,
      (e as UnsafeUrlError).message
    );
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
    await trackOrbanTab(tabId, taskId, url);

    // 5. 等加载完成
    await waitTabComplete(tabId, 2000);

    // 5b. 等内容就绪：SPA 在 status=complete 后仍在渲染（GitHub README、
    // ModelScope 模型卡由客户端异步注入），固定等待抓到的是导航壳。
    await waitForContent(tabId, url, 10000);

    // 重定向校验：对比请求 URL 与 tab 最终 URL 的 pathname。
    const finalTab = await chrome.tabs.get(tabId);
    if (isRedirected(url, finalTab?.url)) {
      console.log(
        "[web2md-diag] redirected, task failed",
        { taskId, requested: url, final: finalTab?.url }
      );
      await reportResult(taskId, null, "failed");
      return;
    }

    // 6-8. 提取（content script 消息 + 兜底注入）
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
      await forgetOrphanTab(tabId);
    }
  }
}