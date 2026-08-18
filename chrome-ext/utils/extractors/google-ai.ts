/** web2md — Google AI Mode / AI Overview 搜索结果提取器。

Google AI Mode (udm=50) 是重 SPA，AI 对话渲染在 DOM 里但被大量
Google 内联 CSS/JS/跟踪代码包围。通用提取器返回 112KB 文本，其中
CSS+JS 占 100KB+，AI 对话正文只有约 4KB。

DOM 结构（已确认 2026-08-17，含多轮对话）：
- 对话根容器：`[data-xid="aim-mars-turn-root"]`
- 每轮对话为一个 `[data-scope-id="turn"][data-complete="true"]` 容器
  - 用户 query 在 `<h2 class="iMqumd">您说：xxx</h2>` 或 `<span jsname="y5v2y">` 中
  - AI 回答正文在 `[data-scope-id="turn"]` 内，[data-xid="Gd7Hsc"] 操作区之前
  - 操作区文字（复制文字 / 复制 / 修改等）用 DOM 遍历切除
- 多轮对话时，`[data-scope-id="turn"]` 有多个，按 DOM 顺序依次排列
- 只匹配 udm=50（AI Mode）或 udm=7（AI Overview）的 Google 搜索 URL
 */

import type { Extractor, ExtractOptions } from "./types";

// 清理答案正文里的内联噪声
function cleanAnswer(s: string): string {
  let out = s;
  out = out.replace(/sn\._setImageSrc\([^)]*\)/g, "");
  out = out.replace(/转到此商品的商品查看器对话框/g, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

// 收集 root 下、stopBefore 元素之前的所有可见文本（按 DOM 顺序）。
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

/** 从单个 turn 容器提取一轮 Q&A。 */
function extractTurn(turn: HTMLElement): string | null {
  const parts: string[] = [];

  // 1. 用户 query：优先从 h2.iMqumd（"您说：xxx"）取
  const h2 = turn.querySelector("h2.iMqumd");
  if (h2?.textContent) {
    const q = h2.textContent.replace(/^您说：/, "").trim();
    if (q) parts.push(`# Q: ${q}\n`);
  }

  // 回退：从 [jsname="y5v2y"] 取
  if (!parts.length) {
    const qSpan = turn.querySelector('[jsname="y5v2y"]');
    if (qSpan?.textContent) {
      const q = qSpan.textContent.trim();
      if (q) parts.push(`# Q: ${q}\n`);
    }
  }

  // 再回退：从复制按钮 aria-label 取
  if (!parts.length) {
    const copyBtns = turn.querySelectorAll('[aria-label^="复制"]');
    for (const btn of Array.from(copyBtns)) {
      const label = (btn as HTMLElement).ariaLabel || "";
      const m = label.match(/复制["""](.+?)["""]/);
      if (m) {
        parts.push(`# Q: ${m[1]}\n`);
        break;
      }
    }
  }

  // 2. AI 回答：操作区之前的文本
  const actionZone = turn.querySelector('[data-xid="Gd7Hsc"]');
  let answer = "";
  if (actionZone && turn.contains(actionZone)) {
    answer = collectTextBefore(turn, actionZone);
  } else {
    let text = turn.textContent?.replace(/\s+/g, " ").trim() || "";
    const actionStart = text.indexOf("复制文字");
    const cut = actionStart >= 0 ? actionStart : text.indexOf("复制");
    const altCut = cut >= 0 ? cut : text.indexOf("分享公开链接");
    if (altCut > 0) answer = text.slice(0, altCut).trim();
  }
  answer = cleanAnswer(answer);
  if (answer) parts.push(`## A:\n\n${answer}`);

  // 3. 参考链接：从 turn 容器内提取带引用标注的链接
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

  const result = parts.join("\n\n").trim();
  return result || null;
}

export const googleAiExtractor: Extractor = {
  id: "google-ai",

  match(url: string): boolean {
    try {
      const u = new URL(url);
      if (!u.hostname.includes("google.com")) return false;
      const udm = u.searchParams.get("udm");
      return udm === "50" || udm === "7";
    } catch {
      return false;
    }
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const root = doc.querySelector('[data-xid="aim-mars-turn-root"]') as HTMLElement | null;
    if (!root) return null;

    // 收集所有 turn 容器（多轮对话）
    const turns = root.querySelectorAll('[data-scope-id="turn"]');
    if (!turns.length) return null;

    const allParts: string[] = [];
    for (const turn of Array.from(turns)) {
      const turnResult = extractTurn(turn as HTMLElement);
      if (turnResult) allParts.push(turnResult);
    }

    const result = allParts.join("\n\n---\n\n").trim();
    return result || null;
  },
};