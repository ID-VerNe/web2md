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

    // 2. AI 回答：从 turn 容器取第一份回答。
    // 用 [data-scope-id="turn"] 代替 root，因为 root 下 Google 会把
    // 回答+操作区重复渲染多份（不同交互状态），而 turn 容器只渲染一份。
    const turn = root.querySelector('[data-scope-id="turn"]') as HTMLElement | null;
    if (turn) {
      let text = turn.textContent?.replace(/\s+/g, " ").trim() || "";
      if (text) {
        // 回答正文起止锚点
        const answerStarts = ["收到", "您好", "好的", "当然", "是的"];
        let start = -1;
        for (const s of answerStarts) {
          const i = text.indexOf(s);
          if (i >= 0 && (start < 0 || i < start)) start = i;
        }
        // 操作区入口：回答后第一个"复制"即是操作区的复制按钮
        const actionStart = text.indexOf("复制", start >= 0 ? start : 0);
        if (start >= 0 && actionStart > start) {
          let answer = text.slice(start, actionStart).trim();
          answer = answer.replace(/\s+$/g, "").trim();
          if (answer) parts.push(`## A:\n\n${answer}`);
        }
      }
    }

    const result = parts.join("\n\n").trim();
    return result || null;
  },
};