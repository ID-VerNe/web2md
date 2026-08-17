/// <reference types="wxt-vite-plugin" />

/** web2md — 孤儿标签页跟踪。

扩展自动打开的后台标签页（openAndExtractTab / openGrokAndAsk）若在
SW 中途死亡时未关闭，会留成孤儿。这里记录开过的 tabId 到
storage.session，SW 下次启动时逐个清理。
*/

interface OrphanInfo {
  taskId: string;
  url: string;
  createdAt: number;
}

/** 记录一个由本扩展打开的标签页（用于 SW 重启后的孤儿清理）。 */
export async function trackOrphanTab(
  tabId: number, taskId: string, url: string
): Promise<void> {
  await chrome.storage.session.set({
    [`orphan_${tabId}`]: { taskId, url, createdAt: Date.now() },
  });
}

/** 清除孤儿记录（正常关闭标签页后调用）。 */
export async function forgetOrphanTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(`orphan_${tabId}`).catch(() => {});
}

/** SW 启动时清理上次崩溃遗留的孤儿标签页。 */
export async function cleanupOrphanTabs(): Promise<void> {
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
}