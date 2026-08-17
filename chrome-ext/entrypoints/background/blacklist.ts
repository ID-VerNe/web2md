/// <reference types="wxt-vite-plugin" />

/** web2md — 黑名单检查。 */

/** 黑名单命中检查：把规则中 * 通配符转成正则。
 * 规则示例：`*://*.google.com/*`、`example.com/*` */
export async function isBlacklisted(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const result = await chrome.storage.local.get("blacklist");
  const rules: string[] = result.blacklist || [];
  return rules.some((rule) => {
    const pattern = rule.replace(/\*/g, ".*");
    return new RegExp(pattern).test(url);
  });
}