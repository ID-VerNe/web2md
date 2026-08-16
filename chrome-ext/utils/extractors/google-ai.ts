/** web2md — Google AI Mode / AI Overview 搜索结果提取器。

Google AI Mode (udm=50) 是重 SPA，AI 对话渲染在 DOM 里但被大量
Google 内联 CSS/JS/跟踪代码包围。通用提取器返回 112KB 文本，其中
CSS+JS 占 100KB+，AI 对话正文只有约 4KB。

DOM 结构（已确认 2026-08-16）：
- 对话根容器：`[data-xid="aim-mars-turn-root"]`
  - 用户 query 在 `aria-label="复制"..."` 或 `<span jsname="y5v2y">` 中
  - AI 回答正文在 `[data-scope-id="turn"][data-complete="true"]` 内，
    该元素只渲染一份"回答+操作区"，不重复
  - 操作区文字（复制 / 分享公开链接 / 反馈按钮等）用 textContent 锚点切除
- 只匹配 udm=50（AI Mode）或 udm=7（AI Overview）的 Google 搜索 URL
 */

import type { Extractor, ExtractOptions } from "./types";

// 清理答案正文里的内联噪声：
// - `sn._setImageSrc(...)` 图片 base64 内联代码
// - `转到此商品的商品查看器对话框` 等占位
function cleanAnswer(s: string): string {
  let out = s;
  // 去掉内联图片 base64 代码块
  out = out.replace(/sn\._setImageSrc\([^)]*\)/g, "");
  // 去掉"转到此商品的商品查看器对话框"占位
  out = out.replace(/转到此商品的商品查看器对话框/g, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

// 收集 root 下、stopBefore 元素之前的所有可见文本（按 DOM 顺序）。
// TreeWalker 前序遍历，遇到 stopBefore 内部的文本节点时停止。
function collectTextBefore(root: HTMLElement, stopBefore: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  while (true) {
    const node = walker.nextNode();
    if (!node) break;
    if (stopBefore.contains(node)) break;
    const t = (node.textContent || "").trim();
    if (t) parts.push(t);
  }
  return parts.join(" ");
}

export const googleAiExtractor: Extractor = {
  id: "google-ai",

  match(url: string): boolean {
    try {
      const u = new URL(url);
      if (!u.hostname.includes("google.com")) return false;
      const udm = u.searchParams.get("udm");
      // 50 = AI Mode, 7 = AI Overview
      return udm === "50" || udm === "7";
    } catch {
      return false;
    }
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const root = doc.querySelector('[data-xid="aim-mars-turn-root"]') as HTMLElement | null;
    if (!root) return null;

    const parts: string[] = [];

    // 1. 用户 query：优先从 [jsname="y5v2y"] 取（query 文本容器，
    // 直接含纯文本），回退到复制按钮 aria-label `复制"测试"`。
    const qSpan = root.querySelector('[jsname="y5v2y"]');
    if (qSpan?.textContent) {
      const q = qSpan.textContent.trim();
      if (q) parts.push(`# Q: ${q}\n`);
    }
    if (!parts.length) {
      const copyBtns = root.querySelectorAll('[aria-label^="复制"]');
      for (const btn of Array.from(copyBtns)) {
        const label = (btn as HTMLElement).ariaLabel || "";
        const m = label.match(/复制["""](.+?)["""]/);
        if (m) {
          parts.push(`# Q: ${m[1]}\n`);
          break;
        }
      }
    }

    // 2. AI 回答：从 turn 容器取回答。
    // 用 [data-scope-id="turn"] 代替 root，因为 root 下 Google 会把
    // 回答+操作区重复渲染多份（不同交互状态），而 turn 容器只渲染一份。
    // 答案正文在 [data-scope-id="turn"] 内，但回答与操作区在同一个容器里，
    // 直接 textContent 会把操作区按钮文字混进来。改用 DOM 遍历：
    // 从 turn 内第一个文本节点开始收集，到遇到操作区容器
    // (`[data-ved]` 的复制/分享按钮所在区) 之前停止。
    const turn = root.querySelector('[data-scope-id="turn"]') as HTMLElement | null;
    if (turn) {
      // 操作区的入口标志：复制按钮 `button[aria-label="复制文字"]`
      // 它所在的是 [data-xid="Gd7Hsc"] 操作区容器。答案正文都在它之前。
      const actionZone = turn.querySelector('[data-xid="Gd7Hsc"]');
      let answer = "";
      if (actionZone && turn.contains(actionZone)) {
        // 取 turn 下、actionZone 之前的所有文本
        answer = collectTextBefore(turn, actionZone);
      } else {
        // 回退：用 textContent + 锚点切分
        let text = turn.textContent?.replace(/\s+/g, " ").trim() || "";
        const actionStart = text.indexOf("复制文字");
        const cut = actionStart >= 0 ? actionStart : text.indexOf("复制");
        const altCut = cut >= 0 ? cut : text.indexOf("分享公开链接");
        if (altCut > 0) answer = text.slice(0, altCut).trim();
      }
      // 清理图片 base64 内联代码 + 商品查看器占位
      answer = cleanAnswer(answer);
      if (answer) parts.push(`## A:\n\n${answer}`);

      // 3. 参考链接：从 turn 容器内提取带引用标注的链接 aria-label="来源名 (+N)..."
      const refs: string[] = [];
      const citeLinks = turn.querySelectorAll('a[aria-label*="(+"]');
      const seen = new Set<string>();
      for (const link of Array.from(citeLinks)) {
        const href = (link as HTMLAnchorElement).href;
        if (!href || !href.startsWith("http") || href.includes("google.com")) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const label = link.getAttribute("aria-label") || "";
        const m = label.match(/^(.+?)\s*\((\+\d+)\)/);
        if (m) {
          refs.push(`- ${m[1].trim()} [${m[2]}] - ${href}`);
        } else {
          refs.push(`- ${href}`);
        }
      }
      if (refs.length) {
        parts.push(`## References\n\n${refs.join("\n")}`);
      }
    }

    const result = parts.join("\n\n").trim();
    return result || null;
  },
};