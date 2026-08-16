/** web2md — Stack Overflow / Stack Exchange 问答页提取器。

SO/SE 是 Q&A 结构：一个问题 + 多个回答 + 投票 + 侧栏（Related
Questions、Hot Network Questions）+ 顶部 signup modal 内联 JSON。
通用提取器把投票数、评论、侧栏链接、signup modal 的 StackExchange
初始化 JSON 全部抓进来，正文淹没在噪声中（实测 67KB 大半是噪声）。

结构（已确认）：
- 问题容器：`#question`（含 .post-layout：左侧投票 + 中间 .postcell
  的 .js-post-body 正文）
- 回答：`.answer`（每个含同样 .post-layout 结构）
  - accepted answer：`.answer.accepted-answer`
- 正文：`.js-post-body`（已渲染的 markdown HTML）
- 投票数：`.js-vote-count`
- 作者/时间：.user-info / .relativetime

只处理问题页（/questions/{id}/），列表页、用户页、tag 页等交给通用
提取器。同时覆盖 stackexchange.com 子站（serverfault、superuser、
mathoverflow 等）。
 */

import type { Extractor, ExtractOptions } from "./types";

export const stackexchangeExtractor: Extractor = {
  id: "stackexchange",

  match(url: string): boolean {
    // stackoverflow.com/questions/{id} 或 *.stackexchange.com/questions/{id}
    // 也覆盖 serverfault.com / superuser.com / mathoverflow.net 等官方子站
    return /^https?:\/\/(?:[^/]*\.)?(?:stackoverflow|stackexchange|serverfault|superuser|askubuntu|mathoverflow|stackapps)\.(?:com|net|org)\/questions\/\d+/.test(url);
  },

  async extract(doc: Document, _opts?: ExtractOptions): Promise<string | null> {
    const question = doc.querySelector("#question") as HTMLElement | null;
    if (!question) return null;

    const parts: string[] = [];

    // 问题标题
    const title =
      doc.querySelector("#question-header a")?.textContent?.trim()
      || doc.querySelector("#question-header h1")?.textContent?.trim()
      || "";
    if (title) parts.push(`# ${title}\n`);

    // 问题正文
    const qBody = question.querySelector(".js-post-body") as HTMLElement | null;
    const qVotes = question.querySelector(".js-vote-count")?.textContent?.trim() || "0";
    if (qBody) {
      const qMd = await convertBody(qBody);
      if (qMd) {
        parts.push(`## Question (${qVotes} votes)\n\n${qMd}\n`);
      }
    }

    // 回答：accepted 优先置顶，其余按 DOM 顺序
    const answers = Array.from(doc.querySelectorAll(".answer")) as HTMLElement[];
    if (answers.length) {
      parts.push(`## Answers\n`);
      // accepted answer 排前
      answers.sort((a, b) => {
        const aAcc = a.classList.contains("accepted-answer") ? 0 : 1;
        const bAcc = b.classList.contains("accepted-answer") ? 0 : 1;
        return aAcc - bAcc;
      });
      for (let i = 0; i < answers.length; i++) {
        const ans = answers[i];
        const aBody = ans.querySelector(".js-post-body") as HTMLElement | null;
        if (!aBody) continue;
        const aVotes = ans.querySelector(".js-vote-count")?.textContent?.trim() || "0";
        const isAccepted = ans.classList.contains("accepted-answer");
        const label = isAccepted ? " (accepted)" : "";
        const aMd = await convertBody(aBody);
        if (aMd) {
          parts.push(`### Answer ${i + 1}${label} (${aVotes} votes)\n\n${aMd}\n`);
        }
      }
    }

    const result = parts.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
    return result || null;
  },
};

async function convertBody(body: HTMLElement): Promise<string | null> {
  try {
    const mod = await import("dom-to-semantic-markdown");
    const converter = (mod as any).domToSemanticMarkdown || (mod as any).default;
    if (typeof converter === "function") {
      let result = converter(body, {});
      result = result.replace(/\n{4,}/g, "\n\n\n").trim();
      return result || null;
    }
  } catch {
    // fallback 到纯文本
  }
  return body.innerText?.trim() || null;
}