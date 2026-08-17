/** web2md — X AI (Grok) 对话页提取器 (x.com/i/grok)。

提取策略（2026-08-17 祖先链探测确认）：
- AI 回答行：从"复制文本"按钮向上，爬到第一个含 min-height style 的
  祖先。min-height 是 X 布局计算生成的稳定特征（回答行 div 恒有
  style="min-height: Npx"），不是易变的 r-xx hash class。
- 回答文本：回答行的 textContent。操作区按钮（重新生成/复制文本/分享/
  喜欢/不喜欢）是 icon-only，文字在 aria-label 不在 textContent，天然不混入。
- 用户 query：回答行的前一个兄弟元素（对话按 Q1 A1 Q2 A2 ... 交替）。
- 多轮对话：每个回答行各有自己的复制按钮和 min-height，seen 去重。

注册顺序注意：x-ai 必须在 x.ts 之前——x.ts 的 match（x.com/ 前缀匹配）
会吞掉 /i/grok URL。
*/

import type { Extractor, ExtractOptions } from "./types";

const COPY_BTN = 'button[aria-label="复制文本"], button[aria-label="Copy text"]';

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// 从"复制文本"按钮向上，找到第一个含 min-height style 的祖先 = 该轮 AI 回答行
function climbToAnswerRow(btn: HTMLElement): HTMLElement | null {
  let node = btn;
  while (node && node.parentElement) {
    if ((node.getAttribute("style") || "").includes("min-height")) return node;
    node = node.parentElement;
  }
  return null;
}

export const xAiExtractor: Extractor = {
  id: "x-ai",

  match(url: string): boolean {
    return /(?:x\.com|twitter\.com)\/i\/grok/.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const btns = Array.from(doc.querySelectorAll(COPY_BTN)) as HTMLElement[];
    if (!btns.length) return null;

    const parts: string[] = [];
    const seen = new Set<HTMLElement>();

    for (const btn of btns) {
      const row = climbToAnswerRow(btn);
      if (!row || seen.has(row)) continue;
      seen.add(row);

      // 用户 query：回答行的前一个兄弟元素
      let qEl = row.previousElementSibling as HTMLElement | null;
      while (qEl && (!qEl.textContent?.trim() || qEl.contains(row))) {
        qEl = qEl.previousElementSibling as HTMLElement | null;
      }
      const q = qEl ? cleanText(qEl.textContent || "") : "";

      // AI 回答：回答行 textContent（按钮文字在 aria-label，不混入）
      const answer = cleanText(row.textContent || "");

      if (!q && !answer) continue;
      parts.push(`# Q: ${q || "(空)"}\n\n## A:\n\n${answer}`);
    }

    return parts.join("\n\n").trim() || null;
  },
};